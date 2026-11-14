import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { validateSearch, buildQuery, observationQueries, parseCsv, normalizeRow, deduplicate, mjdToIso, queryArchive, createSearchService, MAX_RESULTS, scienceUrl } from '../lib/observations.js';
import { createObservationsHandler } from '../api/observations.js';
import { createAppServer } from '../server.mjs';
import { preferredProducts } from '../observation-products.js';

const fixture = await readFile(new URL('./fixtures/irsa-sample.csv', import.meta.url), 'utf8');
const rows = parseCsv(fixture);
const valid = (extra = {}) => new URLSearchParams({ raDeg: '133.795129', decDeg: '-7.245147', ...extra });

test('real IRSA fixture preserves observation identity, units, times and provenance', () => {
  const item = normalizeRow(rows[0]);
  assert.equal(item.observationId, '2025W19_1B_0116_1');
  assert.equal(item.detector, 3); assert.equal(item.release, 'QR2');
  assert.equal(item.processingVersion, 'l2b-v20-2025-241'); assert.equal(item.pipelineVersion, '6.4');
  assert.equal(item.observedStartUtc, '2025-05-05T16:48:02.419Z');
  assert.equal(item.wavelengthMinUm, 1.6301); assert.equal(item.wavelengthMaxUm, 2.4346);
  assert.equal(item.quality.status, 'not-reported'); assert.equal(item.quality.archiveFlag, null);
  assert.equal(item.quality.pixelAssessment, 'not-assessed'); assert.equal(item.quality.calibrationLevel, 2);
  assert.match(item.accessUrl, /^https:\/\/irsa.ipac.caltech.edu\/ibe\/data\/spherex\/qr2\/level2\//);
});
test('coordinates, release and detector input cannot alter the query', () => {
  for (const raDeg of ['', ' ', '360', '-1', 'NaN', '0);DROP TABLE x', 'Infinity', '0x10']) assert.throws(() => validateSearch(valid({ raDeg })), { status: 400 });
  for (const decDeg of ['-90.01', '90.01', 'foo']) assert.throws(() => validateSearch(valid({ decDeg })), { status: 400 });
  for (const detector of ['0', '7', '1.5', "1' OR 1=1"]) assert.throws(() => validateSearch(valid({ detector })), { status: 400 });
  assert.throws(() => validateSearch(valid({ release: "qr3') OR 1=1" })), { status: 400 });
  assert.equal(validateSearch(valid({ raDeg: '0', decDeg: '-90' })).decDeg, -90);
  assert.equal(validateSearch(valid({ decDeg: '+90' })).decDeg, 90);
});
test('inclusive UTC dates include overlapping exposures and reject impossible dates', () => {
  const search = validateSearch(valid({ startDate: '2025-05-05', endDate: '2025-05-05', detector: '3', release: 'qr2' }));
  assert.equal(search.endMjd - search.startMjd, 1);
  const query = buildQuery(search);
  assert.match(query, /CONTAINS\(POINT\('ICRS',133.795129,-7.245147\),p.poly\)/);
  assert.match(query, /p.time_bounds_upper>=/); assert.match(query, /p.time_bounds_lower</);
  assert.match(query, /IN \('D3','SPHEREx-D3'\)/); assert.doesNotMatch(query, /spherex_qr3/);
  for (const extra of [{ startDate: '2025-02-30' }, { endDate: '2025-13-01' }, { startDate: '2025-06-01', endDate: '2025-05-01' }]) assert.throws(() => validateSearch(valid(extra)), { status: 400 });
});
test('Barnard’s Star uses distinct archive pointings on either side of a window boundary', () => {
  const params = valid({ raDeg: '269.4521', decDeg: '4.6934', targetId: 'barnard', startDate: '2025-09-07', endDate: '2025-09-09' });
  const now = Date.parse('2025-10-01');
  const queries = observationQueries(validateSearch(params), { now });
  assert.equal(queries.length, 2);
  assert.match(queries[0], /p\.time_bounds_lower<60926/);
  assert.match(queries[1], /p\.time_bounds_lower>=60926/);
  assert.notEqual(queries[0].match(/POINT\([^)]+\)/)[0], queries[1].match(/POINT\([^)]+\)/)[0]);
  params.set('decDeg', '4.7');
  assert.match(observationQueries(validateSearch(params), { now })[0], /POINT\('ICRS',269\.4521,4\.7\)/);
});
test('MJD epoch, zero, and missing values are handled without inventing dates', () => {
  assert.equal(mjdToIso(40587), '1970-01-01T00:00:00.000Z');
  assert.equal(mjdToIso(0), '1858-11-17T00:00:00.000Z');
  for (const value of ['', null, undefined, 'bad']) assert.equal(mjdToIso(value), null);
  const item = normalizeRow({ ...rows[0], t_exptime: '', em_min: '', quality_flag: 'junk' });
  assert.equal(item.exposureSeconds, null); assert.equal(item.wavelengthMinUm, null); assert.equal(item.quality.archiveFlag, 'junk');
});
test('CSV supports quotes, commas, CRLF and embedded newlines; incomplete tables fail', () => {
  assert.deepEqual(parseCsv('\uFEFFobs_id,note\r\na,"x, y"\r\nb,"a ""quote""\nand newline"\r\n'), [{ obs_id: 'a', note: 'x, y' }, { obs_id: 'b', note: 'a "quote"\nand newline' }]);
  assert.throws(() => parseCsv('obs_id,note\na,"unfinished'));
  assert.throws(() => parseCsv('obs_id,note\na,b,c'));
  assert.throws(() => parseCsv('unexpected\n1'));
  assert.deepEqual(parseCsv('obs_id,note\n'), []);
});
test('duplicate release/deep memberships retain the preferred product without merging detectors', () => {
  const older = { ...rows[0], uri: rows[0].uri.replaceAll('v20-2025-241', 'v9-2025-240') };
  const latest = { ...rows[0], uri: rows[0].uri.replaceAll('v20-2025-241', 'v21-2025-242') };
  assert.equal(deduplicate([older, rows[0], latest]).length, 1);
  assert.equal(deduplicate([older, rows[0], latest])[0].processingVersion, 'l2b-v21-2025-242');
  const qr3 = { ...older, obs_collection: 'spherex_qr3', uri: older.uri.replace('/qr2/', '/qr3/') };
  assert.equal(deduplicate([latest, qr3])[0].release, 'QR3');
  assert.equal(deduplicate(rows).length, 3);
  assert.throws(() => deduplicate([{ ...rows[0], energy_bandpassname: 'unknown' }]), { status: 502 });
});
test('science URLs reject unrelated hosts, traversal and non-science paths', () => {
  for (const uri of ['https://evil.example/x.fits', 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/../x.fits', 'http://localhost/a', '/etc/passwd']) assert.equal(scienceUrl(uri), null);
});
test('TAP XML errors and HTTP failures never turn into empty results', async () => {
  await assert.rejects(queryArchive('test', { fetchImpl: async () => new Response('<VOTABLE><INFO name="QUERY_STATUS" value="ERROR">bad query</INFO></VOTABLE>') }), { status: 502 });
  let attempts = 0;
  await assert.rejects(queryArchive('test', { fetchImpl: async () => { attempts++; return new Response('Unavailable', { status: 503 }); } }), { status: 502, code: 'IRSA_UNAVAILABLE' });
  assert.equal(attempts, 2);
});
test('transient network failure is retried and upstream timeout is explicit', async () => {
  let attempts = 0;
  const data = await queryArchive('test', { fetchImpl: async () => { if (++attempts === 1) throw new Error('reset'); return new Response(fixture); } });
  assert.equal(data.length, 3); assert.equal(attempts, 2);
  await assert.rejects(queryArchive('test', { timeoutMs: 10, fetchImpl: async (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }), { status: 504 });
});
test('successful searches are cached, expire, coalesce and preserve source time', async () => {
  let calls = 0, clock = 1000000;
  const service = createSearchService({ now: () => clock, fetchImpl: async () => { calls++; return new Response(fixture); } });
  const [first, concurrent] = await Promise.all([service(valid()), service(valid())]);
  assert.equal(calls, 1); assert.equal(first.count, 3); assert.equal(concurrent.count, 3);
  assert.equal((await service(valid())).cached, true);
  assert.equal(first.source.retrievedAt, new Date(clock).toISOString());
  clock += 900001; await service(valid()); assert.equal(calls, 2);
});
test('empty and truncated results are explicit; failed searches are not cached', async () => {
  const empty = await createSearchService({ fetchImpl: async () => new Response('obs_id,energy_bandpassname\n') })(valid());
  assert.equal(empty.count, 0); assert.equal(empty.truncated, false);
  const [header, line] = fixture.trim().split(/\r?\n/);
  const huge = header + '\n' + Array(MAX_RESULTS + 1).fill(line).join('\n');
  const truncated = await createSearchService({ fetchImpl: async () => new Response(huge) })(valid());
  assert.equal(truncated.truncated, true); assert.ok(truncated.warnings.some(w => w.includes('incomplete')));
  assert.ok(truncated.nextCursor);
  const nextQuery = buildQuery(validateSearch(valid({ cursor: truncated.nextCursor })));
  assert.match(nextQuery, /a.uri>'ibe\/data\/spherex\/qr2\/level2\//);
  assert.match(nextQuery, /ORDER BY a.uri ASC/);
  for (const cursor of ["' OR 1=1", Buffer.from("ibe/data/spherex/qr2/level2/a.fits' OR 1=1").toString('base64url')]) assert.throws(() => validateSearch(valid({ cursor })), { status: 400 });
  let calls = 0;
  const service = createSearchService({ fetchImpl: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(service(valid())); await assert.rejects(service(valid())); assert.equal(calls, 4);
});
test('merging archive batches preserves latest versions and chronological order', () => {
  const old = normalizeRow(rows[0]);
  const newer = { ...old, processingVersion: 'l2b-v21-2025-242', productId: 'newer' };
  const merged = preferredProducts([...rows.map(normalizeRow), newer]);
  assert.equal(merged.length, 3); assert.equal(merged[0].productId, 'newer');
  assert.ok(merged.every((item, index) => index === 0 || item.startMjd >= merged[index - 1].startMjd));
});
async function withServer(handler, run) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('HTTP search endpoint validates input and returns JSON/method errors', async () => {
  const service = createSearchService({ fetchImpl: async () => new Response(fixture) });
  await withServer(createObservationsHandler(service), async base => {
    const invalid = await fetch(base + '/api/observations?raDeg=360&decDeg=0'); assert.equal(invalid.status, 400);
    const invalidData = await invalid.json();
    assert.match(invalidData.error, /RA/); assert.equal(Object.hasOwn(invalidData, 'code'), false);
    const response = await fetch(base + '/api/observations?' + valid()); assert.equal(response.status, 200); assert.equal((await response.json()).count, 3);
    const method = await fetch(base + '/api/observations', { method: 'POST' }); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
  });
});

test('HTTP search endpoint identifies IRSA outages and a later retry can succeed', async () => {
  let attempts = 0;
  const service = createSearchService({ fetchImpl: async () => ++attempts <= 2 ? new Response('Unavailable', { status: 503 }) : new Response(fixture) });
  await withServer(createObservationsHandler(service), async base => {
    const url = base + '/api/observations?' + valid({ raDeg: '101.287155333', decDeg: '-16.716115861' });
    const failed = await fetch(url);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'IRSA is temporarily unavailable. Please retry.', code: 'IRSA_UNAVAILABLE' });
    assert.equal(attempts, 2);
    const retry = await fetch(url);
    assert.equal(retry.status, 200); assert.equal((await retry.json()).count, 3);
    assert.equal(attempts, 3);
  });
});
test('local server serves the UI and routes API errors without exposing private modules', async () => {
  const server = createAppServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/observations-ui.js')).status, 200);
    assert.equal((await fetch(base + '/lib/pixel-quality.js')).status, 200);
    assert.equal((await fetch(base + '/lib/rice.js')).status, 200);
    assert.equal((await fetch(base + '/lib/background.js')).status, 200);
    assert.equal((await fetch(base + '/lib/stack.js')).status, 200);
    for (const path of ['/lib/observations.js', '/api/observations.js', '/server.mjs', '/tests/fixtures/irsa-sample.csv']) assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base + '/api/observations?raDeg=invalid&decDeg=0')).status, 400);
    assert.equal((await fetch(base + '/api/observation-quality?url=http://localhost')).status, 400);
    assert.equal((await fetch(base + '/api/pixel-quality')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
