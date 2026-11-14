import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { createSearchService } from '../lib/observations.js';
import { createSearchResources } from '../lib/resources.js';
import { createSearchStore, defaultSearchStore, cacheRowKey, FRESH_RECENT_MS, STALE_MS } from '../lib/search-store.js';
import { createMovingSearch } from '../api/moving-observations.js';
import { createObservationsHandler } from '../api/observations.js';
import { refreshSearchCache } from '../../scripts/refresh-search-cache.mjs';

const fixture = await readFile(new URL('./fixtures/irsa-sample.csv', import.meta.url), 'utf8');
const valid = (extra = {}) => new URLSearchParams({ raDeg: '133.795129', decDeg: '-7.245147', ...extra });
const HOUR = 3600000, DAY = 24 * HOUR;

// In-memory stand-in for Supabase's PostgREST API, covering the filters the store uses.
function fakeSupabase(now = () => Date.now()) {
  const rows = new Map(), calls = [];
  const matches = (row, query) => [...query].every(([field, filter]) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(field)) return true;
    const split = filter.indexOf('.'), op = filter.slice(0, split), value = filter.slice(split + 1);
    if (op === 'eq') return String(row[field]) === value;
    if (op === 'gte') return Date.parse(row[field]) >= Date.parse(value);
    if (op === 'lt') return Date.parse(row[field]) < Date.parse(value);
    throw new Error('Unsupported filter ' + op);
  });
  async function fetchImpl(href, init = {}) {
    const url = new URL(href), method = init.method || 'GET', query = url.searchParams;
    calls.push({ method, url, headers: init.headers });
    assert.equal(url.pathname, '/rest/v1/search_cache');
    const selected = () => [...rows.values()].filter(row => matches(row, query));
    if (method === 'GET') {
      let list = selected();
      if (query.get('order')) { const [column] = query.get('order').split('.'); list.sort((a, b) => Date.parse(a[column]) - Date.parse(b[column])); }
      if (query.get('limit')) list = list.slice(0, Number(query.get('limit')));
      return Response.json(structuredClone(list));
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      rows.set(body.key, { last_used_at: new Date(now()).toISOString(), ...rows.get(body.key), ...body });
      return new Response(null, { status: 201 });
    }
    if (method === 'PATCH') { for (const row of selected()) Object.assign(row, JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (method === 'DELETE') { for (const row of selected()) rows.delete(row.key); return new Response(null, { status: 204 }); }
    throw new Error('Unexpected method ' + method);
  }
  return { rows, calls, fetchImpl };
}
const storeFor = (supabase, now, key = 'sb_secret_test') => createSearchStore({ url: 'https://example.supabase.co/', key, fetchImpl: supabase.fetchImpl, now });

test('the store sends the right credentials and turns every failure into a miss', async () => {
  assert.equal(defaultSearchStore({}), null);
  assert.equal(defaultSearchStore({ SUPABASE_URL: 'https://example.supabase.co' }), null);
  assert.ok(defaultSearchStore({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret_x' }));
  const supabase = fakeSupabase();
  const secret = storeFor(supabase, Date.now);
  assert.equal(await secret.get('observations', ['a']), null);
  assert.equal(supabase.calls[0].headers.apikey, 'sb_secret_test');
  assert.equal(supabase.calls[0].headers.Authorization, undefined);
  await storeFor(supabase, Date.now, 'eyJlegacy').get('observations', ['a']);
  assert.equal(supabase.calls[1].headers.Authorization, 'Bearer eyJlegacy');
  assert.equal(await secret.put('observations', ['a'], { query: '' }, { count: 1 }), true);
  assert.equal(supabase.rows.get(cacheRowKey('observations', ['a'])).result.count, 1);
  const failing = [async () => new Response('down', { status: 500 }), async () => { throw new Error('offline'); },
    (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))];
  for (const fetchImpl of failing) {
    const store = createSearchStore({ url: 'https://example.supabase.co', key: 'k', fetchImpl, readTimeoutMs: 20, writeTimeoutMs: 20 });
    assert.equal(await store.get('observations', ['a']), null);
    assert.equal(await store.put('observations', ['a'], {}, {}), false);
  }
});

test('a saved star search survives a restart, expires, and covers an IRSA outage', async () => {
  let clock = Date.parse('2026-11-08T00:00:00Z'), irsaCalls = 0, irsaDown = false;
  const now = () => clock, supabase = fakeSupabase(now), store = storeFor(supabase, now);
  const irsa = async () => { irsaCalls++; return irsaDown ? new Response('Unavailable', { status: 503 }) : new Response(fixture); };
  const fresh = () => createSearchService({ now, store, fetchImpl: irsa, resources: createSearchResources() });

  const first = await fresh()(valid());
  assert.equal(irsaCalls, 1); assert.equal(first.count, 3); assert.equal(supabase.rows.size, 1);
  const row = [...supabase.rows.values()][0];
  assert.equal(row.kind, 'observations'); assert.equal(row.params.query, valid().toString());

  // A new process (deploy, cold start) gets the saved copy without asking IRSA.
  const restarted = await fresh()(valid());
  assert.equal(irsaCalls, 1); assert.equal(restarted.cached, true); assert.equal(restarted.source.sharedCache, true);
  assert.equal(restarted.source.retrievedAt, first.source.retrievedAt);

  clock += FRESH_RECENT_MS + 1;
  await fresh()(valid());
  assert.equal(irsaCalls, 2, 'searches covering recent dates are refreshed after 36 hours');

  clock += FRESH_RECENT_MS + DAY; irsaDown = true;
  const stale = await fresh()(valid());
  assert.equal(stale.source.stale, true);
  assert.ok(stale.warnings.some(w => w.startsWith('IRSA was unavailable')));

  clock += STALE_MS;
  await assert.rejects(fresh()(valid()), { status: 502 });
});

test('a broken cache never blocks a search, and concurrent searches share one lookup', async () => {
  const broken = createSearchStore({ url: 'https://example.supabase.co', key: 'k', fetchImpl: async () => { throw new Error('offline'); } });
  const live = await createSearchService({ store: broken, fetchImpl: async () => new Response(fixture), resources: createSearchResources() })(valid());
  assert.equal(live.count, 3);
  const supabase = fakeSupabase(), store = storeFor(supabase, Date.now);
  const service = createSearchService({ store, fetchImpl: async () => new Response(fixture), resources: createSearchResources() });
  await Promise.all([service(valid()), service(valid()), service(valid())]);
  assert.equal(supabase.calls.filter(call => call.method === 'GET').length, 1);
  assert.equal(supabase.calls.filter(call => call.method === 'POST').length, 1);
});

test('reading an entry records its use at most hourly', async () => {
  let clock = Date.parse('2026-11-08T00:00:00Z');
  const now = () => clock, supabase = fakeSupabase(now), store = storeFor(supabase, now);
  await store.put('observations', ['a'], {}, { count: 1 });
  await store.get('observations', ['a']);
  assert.equal(supabase.calls.filter(call => call.method === 'PATCH').length, 0);
  clock += 2 * HOUR;
  await store.get('observations', ['a']); await new Promise(resolve => setImmediate(resolve));
  assert.equal(supabase.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal([...supabase.rows.values()][0].last_used_at, new Date(clock).toISOString());
});

// MOST and Horizons stand-ins for one exposure of 3I/ATLAS.
const fields = ['observationid', 'planeid', 'productid', 'mjd_start', 'mjd_end', 'exposure_time', 'uri'];
const widths = [24, 12, 12, 24, 24, 18, 128];
const line = (values, edge) => edge + values.map((v, i) => String(v).padEnd(widths[i])).join(edge) + edge;
const uri = 'ibe/data/spherex/qr2/level2/2025W33/l2b-v20-2025-265/1/exampleD1_spx_test.fits';
const most = () => [line(fields, '|'), line(fields.map(() => 'char'), '|'), line(['observation-1', 'p1', 'D1', 60898, 60898 + 120 / 86400, 120, uri], ' ')].join('\n');
const horizons = (points, center) => `Target body name: ATLAS (C/2025 N1) {source: JPL#55}
Center body name: ${center}
$$SOE
${points.map(jd => `${jd}, , , 10, 1,`).join('\n')}
$$EOE`;
function upstream(center = 'SPHEREx (spacecraft) (-163182)') {
  const counter = { calls: 0 };
  counter.fetchImpl = async url => {
    counter.calls++;
    if (url.hostname.startsWith('irsa')) return new Response(most());
    return Response.json({ result: horizons(url.searchParams.get('TLIST').slice(1, -1).split(' '), center) });
  };
  return counter;
}
const comet = () => new URLSearchParams({ object: '3I/ATLAS', startDate: '2025-08-11', endDate: '2025-08-11' });

test('comet searches are shared across restarts; failed trajectories are not saved', async () => {
  const supabase = fakeSupabase(), store = storeFor(supabase, Date.now), archive = upstream();
  const first = await createMovingSearch({ store, fetchImpl: archive.fetchImpl, resources: createSearchResources() })(comet());
  const calls = archive.calls;
  assert.equal(first.solution, 'JPL#55'); assert.equal(supabase.rows.size, 1);
  assert.equal([...supabase.rows.values()][0].params.object, '3I');
  const again = await createMovingSearch({ store, fetchImpl: archive.fetchImpl, resources: createSearchResources() })(comet());
  assert.equal(archive.calls, calls); assert.equal(again.cache.shared, true);
  assert.deepEqual(again.exposures, first.exposures);

  const earthOnly = upstream('Earth (399)'), empty = fakeSupabase();
  const failed = await createMovingSearch({ store: storeFor(empty, Date.now), fetchImpl: earthOnly.fetchImpl, resources: createSearchResources() })(comet());
  assert.ok(failed.trajectoryError); assert.equal(empty.rows.size, 0);
});

test('the daily job re-runs only what can have changed and removes unused rows', async () => {
  const now = Date.parse('2026-11-08T05:00:00Z'), iso = time => new Date(time).toISOString();
  const supabase = fakeSupabase(() => now), store = storeFor(supabase, () => now);
  const seed = (name, kind, query, result = {}, { used = now - DAY, extra = {} } = {}) =>
    supabase.rows.set(name, { key: name, kind, params: { query: new URLSearchParams(query).toString(), collections: ['spherex_qr2'], ...extra }, result, saved_at: iso(now - 3 * DAY), checked_at: iso(now - 3 * DAY), last_used_at: iso(used) });
  seed('star-recent', 'observations', { raDeg: '1', decDeg: '2' });
  seed('star-old', 'observations', { raDeg: '1', decDeg: '2', endDate: '2025-05-31' });
  seed('star-page-2', 'observations', { raDeg: '1', decDeg: '2', cursor: 'abc' });
  seed('star-failing', 'observations', { raDeg: '9', decDeg: '2' });
  seed('comet-same', 'moving', { object: '3I', endDate: '2025-08-11' }, { solution: 'JPL#55' }, { extra: { object: '3I' } });
  seed('comet-revised', 'moving', { object: 'C/2024 X', endDate: '2025-08-11' }, { solution: 'JPL#1' }, { extra: { object: 'C/2024 X' } });
  seed('comet-recent', 'moving', { object: '3I', endDate: '2026-11-01' }, { solution: 'JPL#55' }, { extra: { object: '3I' } });
  seed('forgotten', 'observations', { raDeg: '5', decDeg: '5' }, {}, { used: now - 10 * DAY });

  const reruns = [];
  const observationsFactory = ({ store: writer }) => async query => {
    if (query.get('raDeg') === '9') throw new Error('IRSA timed out');
    reruns.push('star ' + query.get('endDate'));
    await writer.put('observations', [query.toString()], {}, { refreshed: true });
    return {};
  };
  const movingFactory = ({ store: writer }) => async query => {
    if (!writer) return { solution: query.get('object') === '3I' ? 'JPL#55' : 'JPL#2' };
    reruns.push('comet ' + query.get('object') + ' ' + query.get('endDate'));
    await writer.put('moving', [query.toString()], {}, { refreshed: true });
    return {};
  };
  const logs = [];
  const counts = await refreshSearchCache({ store, now, observationsFactory, movingFactory, log: message => logs.push(message) });

  assert.deepEqual(counts, { checked: 7, refreshed: 3, unchanged: 1, skipped: 2, failed: 1 });
  assert.deepEqual(reruns.sort(), ['comet 3I 2026-11-01', 'comet C/2024 X 2025-08-11', 'star null']);
  assert.equal(supabase.rows.get('comet-same').checked_at, iso(now));
  assert.equal(supabase.rows.get('star-old').checked_at, iso(now - 3 * DAY));
  assert.equal(supabase.rows.has('forgotten'), false);
  // Refresh writes keep the visitor-driven last-used time.
  for (const row of supabase.rows.values()) if (row.result.refreshed) assert.equal(row.last_used_at, iso(now));
  assert.ok(logs.some(message => message.includes('IRSA timed out')));
});

test('search responses are gzipped when the client accepts it', async () => {
  const payload = { observations: Array.from({ length: 200 }, (_, i) => ({ observationId: 'obs-' + i, detector: 1 })), source: { kind: 'live' } };
  const server = createServer(createObservationsHandler(async () => payload)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const request = encoding => new Promise((resolve, reject) => get({ port: server.address().port, host: '127.0.0.1', path: '/api/observations', headers: encoding ? { 'Accept-Encoding': encoding } : {} }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject));
    const zipped = await request('gzip, br');
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(zipped.body)), payload);
    const plain = await request();
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(plain.body), payload);
  } finally { server.close(); }
});
