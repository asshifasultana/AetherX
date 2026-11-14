import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { updateIndex, compareProducts, discoverCollections, fetchTargetProducts } from '../../scripts/observation-index.mjs';
import { createIndexStore, createIndexedSearch, indexedResponse, indexStatus, INDEX_MAX_AGE_MS } from '../lib/index-store.js';
import { parseCsv, normalizeRow, validateSearch, MAX_RESULTS, SearchError } from '../lib/observations.js';

const raw = parseCsv(await readFile(new URL('./fixtures/irsa-sample.csv', import.meta.url), 'utf8'));
const products = raw.map(normalizeRow);
const target = { name: 'Test target', raDeg: 133.795129, decDeg: -7.245147 };
const targets = { test: target }, collections = ['spherex_qr2', 'spherex_qr3'];
const params = (extra = {}) => new URLSearchParams({ raDeg: target.raDeg, decDeg: target.decDeg, ...extra });
async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'spherex-index-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('spherex-index-test-')) throw new Error('Unsafe test cleanup path.');
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}
const setup = (directory, overrides = {}) => ({ directory, targets, discover: async () => collections, fetchProducts: async () => structuredClone(products), ...overrides });

test('initial publication creates complete snapshots; repeated runs are idempotent', async t => {
  const directory = await workspace(t); let clock = Date.parse('2026-11-04T00:00:00Z');
  const first = await updateIndex(setup(directory, { now: () => clock }));
  assert.equal(first.totalObservations, 3); assert.equal(first.changes.added, 3);
  const store = createIndexStore({ directory }); assert.equal((await store.snapshot(first.targets[0])).products.length, 3);
  const snapshotFile = path.join(directory, first.targets[0].snapshot);
  await utimes(snapshotFile, new Date(1000), new Date(1000));
  clock += 86400000;
  const second = await updateIndex(setup(directory, { now: () => clock }));
  assert.deepEqual(second.changes, { added: 0, revised: 0, removed: 0, unchanged: 3 });
  assert.equal(second.targets[0].hash, first.targets[0].hash);
  assert.equal(second.lastChangedAt, first.lastChangedAt); assert.notEqual(second.lastSuccessfulCheckAt, first.lastSuccessfulCheckAt);
  assert.equal((await readdir(path.join(directory, 'snapshots'))).length, 1);
  assert.equal((await stat(snapshotFile)).mtimeMs, 1000);
});
test('historical metadata revisions, new exposures and withdrawals are distinguished', async t => {
  const directory = await workspace(t); await updateIndex(setup(directory));
  const revised = { ...products[0], quality: { ...products[0].quality, archiveFlag: 'junk', status: 'reported' } };
  const added = { ...products[2], observationId: '2026W40_1A_0001_1', productId: 'new-product' };
  const next = await updateIndex(setup(directory, { fetchProducts: async () => [revised, products[1], added] }));
  assert.deepEqual(next.changes, { added: 1, revised: 1, removed: 1, unchanged: 1 });
  assert.equal(next.totalObservations, 3);
});
test('new releases and reprocessed files replace preferred records without duplicates', () => {
  const newer = { ...products[0], productId: 'qr3-file', release: 'QR3', collection: 'spherex_qr3', processingVersion: 'l2b-v27-2026-271' };
  assert.deepEqual(compareProducts([products[0]], [products[0], newer, newer]), { added: 0, revised: 1, removed: 0, unchanged: 0 });
  assert.deepEqual(compareProducts([newer], [products[0], newer]), { added: 0, revised: 0, removed: 0, unchanged: 1 });
});
test('a failed target never publishes another target’s partial changes or advances successful-check time', async t => {
  const directory = await workspace(t); const two = { first: target, second: { ...target, raDeg: 20 } };
  const first = await updateIndex(setup(directory, { targets: two }));
  let calls = 0;
  await assert.rejects(updateIndex(setup(directory, { targets: two, fetchProducts: async () => { if (++calls === 2) throw new Error('IRSA unavailable'); return products.slice(0, 1); } })), /IRSA unavailable/);
  const failed = await createIndexStore({ directory }).manifest();
  assert.equal(failed.status, 'error'); assert.equal(failed.lastSuccessfulCheckAt, first.lastSuccessfulCheckAt);
  assert.deepEqual(failed.targets, first.targets); assert.equal(failed.totalObservations, first.totalObservations);
  assert.equal((await readdir(path.join(directory, 'snapshots'))).length, 2);
});
test('suspicious empty updates preserve old data unless explicitly permitted', async t => {
  const directory = await workspace(t); await updateIndex(setup(directory));
  await assert.rejects(updateIndex(setup(directory, { fetchProducts: async () => [] })), /unexpectedly returned zero/);
  assert.equal((await createIndexStore({ directory }).manifest()).totalObservations, 3);
  const removed = await updateIndex(setup(directory, { fetchProducts: async () => [], allowEmpty: true }));
  assert.equal(removed.totalObservations, 0); assert.equal(removed.changes.removed, 3);
});
test('overlapping update jobs cannot write the index simultaneously', async t => {
  const directory = await workspace(t); let release, started;
  const beginning = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = updateIndex(setup(directory, { discover: async () => { started(); await gate; return collections; } }));
  await beginning;
  await assert.rejects(updateIndex(setup(directory)), /already running/);
  release(); await first;
});
test('collection discovery excludes calibration datasets and accepts future releases', async () => {
  const names = await discoverCollections({ fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://irsa.ipac.caltech.edu/TAP/sync');
    assert.match(init.body.get('QUERY'), /SELECT DISTINCT collection FROM spherex\.observation/);
    return new Response('collection\r\nspherex_dr1\r\nspherex_dr1_cal\r\nspherex_dr1_deep\r\nspherex_qr3\r\nspherex_qr4_deep\r\nunrelated\r\n');
  } });
  assert.deepEqual(names, ['spherex_dr1', 'spherex_dr1_deep', 'spherex_qr3', 'spherex_qr4_deep']);
  await assert.rejects(discoverCollections({ fetchImpl: async () => new Response('err', { status: 503 }) }), /discovery failed/);
  await assert.rejects(discoverCollections({ fetchImpl: async () => new Response('<html>error</html>') }), /No public/);
});
test('archive pagination is exhausted and repeated cursors reject incomplete updates', async () => {
  const page = Array(MAX_RESULTS + 1).fill(raw[0]); let calls = 0;
  const complete = await fetchTargetProducts(target, collections, { query: async () => ++calls === 1 ? page : [raw[1]] });
  assert.equal(calls, 2); assert.equal(complete.length, 2);
  await assert.rejects(fetchTargetProducts(target, collections, { query: async () => page }), /pagination did not advance/);
});
test('scheduled index supports release/date/detector filters and keeps raw release variants', async t => {
  const directory = await workspace(t);
  const qr3 = { ...products[0], release: 'QR3', collection: 'spherex_qr3', productId: 'qr3', processingVersion: 'l2b-v27-2026-271', accessUrl: products[0].accessUrl.replace('/qr2/', '/qr3/') };
  await updateIndex(setup(directory, { fetchProducts: async () => [...products, qr3] }));
  const store = createIndexStore({ directory });
  const service = createIndexedSearch({ store, liveFactory: () => async () => { throw new SearchError('IRSA unavailable'); } });
  const all = await service(params()); assert.equal(all.source.kind, 'scheduled-index'); assert.equal(all.count, 3);
  assert.equal(all.observations.find(o => o.detector === 3 && o.observationId === products[0].observationId).release, 'QR3');
  const qr2 = await service(params({ release: 'qr2', detector: '3', startDate: '2025-05-05', endDate: '2025-05-05' }));
  assert.equal(qr2.count, 1); assert.ok(qr2.observations.every(o => o.release === 'QR2' && o.detector === 3));
  assert.equal((await service(params({ endDate: '2020-01-01' }))).count, 0);
});
test('custom coordinates always use live search; stale snapshots try live before honest fallback', async t => {
  const directory = await workspace(t), clock = Date.parse('2026-11-04T00:00:00Z');
  await updateIndex(setup(directory, { now: () => clock }));
  const store = createIndexStore({ directory }); let calls = 0;
  const service = createIndexedSearch({ store, now: () => clock + INDEX_MAX_AGE_MS + 1, liveFactory: () => async () => { calls++; throw new SearchError('offline'); } });
  const fallback = await service(params()); assert.equal(calls, 1); assert.equal(fallback.source.stale, true); assert.ok(fallback.warnings.some(w => w.includes('newer observations')));
  const continuation = await service(params({ cursor: Buffer.from(raw[0].uri).toString('base64url'), indexVersion: fallback.source.indexHash }));
  assert.equal(continuation.source.indexHash, fallback.source.indexHash); assert.equal(calls, 1);
  await assert.rejects(service(params({ raDeg: 42 })), /offline/); assert.equal(calls, 2);
});
test('checksum corruption triggers live fallback and index-version changes reject mixed pagination', async t => {
  const directory = await workspace(t); const manifest = await updateIndex(setup(directory));
  const store = createIndexStore({ directory });
  const service = createIndexedSearch({ store, liveFactory: () => async () => ({ source: { kind: 'live' }, count: 99 }) });
  await assert.rejects(service(params({ indexVersion: 'a'.repeat(64), cursor: Buffer.from(raw[0].uri).toString('base64url') })), { status: 409 });
  await writeFile(path.join(directory, manifest.targets[0].snapshot), '{}');
  const coldService = createIndexedSearch({ store: createIndexStore({ directory }), liveFactory: () => async () => ({ source: { kind: 'live' } }) });
  assert.equal((await coldService(params())).source.kind, 'live');
});
test('snapshot pagination uses a consistent cursor and does not duplicate boundary rows', async () => {
  const items = Array.from({ length: MAX_RESULTS + 2 }, (_, i) => ({ ...products[0], observationId: `obs-${i}`, productId: `p-${i}`, accessUrl: `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/${String(i).padStart(6, '0')}.fits` }));
  const entry = { id: 'test', checkedAt: new Date().toISOString(), hash: 'a'.repeat(64) };
  const manifest = { collections, status: 'ready', lastSuccessfulCheckAt: entry.checkedAt };
  const first = indexedResponse({ products: items }, entry, manifest, validateSearch(params()));
  assert.equal(first.count, MAX_RESULTS); assert.ok(first.nextCursor);
  const last = indexedResponse({ products: items }, entry, manifest, validateSearch(params({ cursor: first.nextCursor })));
  assert.equal(last.count, 2); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.observations, ...last.observations].map(o => o.productId)).size, items.length);
  assert.equal(indexStatus({ ...manifest, targets: [], totalObservations: items.length }).totalObservations, items.length);
});

test('fresh presets use live results, including empty results, without loading snapshots', async t => {
  const directory = await workspace(t); await updateIndex(setup(directory));
  const store = createIndexStore({ directory }); let calls = 0;
  const service = createIndexedSearch({ store: { ...store, snapshot: async () => { throw new Error('Snapshot should not be read'); } }, liveFactory: () => async () => {
    calls++; return { source: { kind: 'live' }, observations: [], count: 0 };
  } });
  const result = await service(params()); assert.equal(result.source.kind, 'live'); assert.equal(result.count, 0); assert.equal(calls, 1);
});

test('fresh fallback is labelled and only upstream failures can select it', async t => {
  const directory = await workspace(t); const clock = Date.now(); await updateIndex(setup(directory, { now: () => clock }));
  const store = createIndexStore({ directory });
  const service = status => createIndexedSearch({ store, now: () => clock, liveFactory: () => async () => { throw new SearchError('failed', status); } });
  for (const status of [502, 504]) {
    const fallback = await service(status)(params({ refresh: 'live' })); assert.equal(fallback.source.fallback, true); assert.equal(fallback.source.stale, false);
    assert.ok(fallback.warnings.some(w => w.includes('Live IRSA search was unavailable')));
    const empty = await service(status)(params({ endDate: '2020-01-01', refresh: 'live' })); assert.equal(empty.count, 0); assert.equal(empty.source.fallback, true);
  }
  for (const status of [400, 409, 503, 500]) await assert.rejects(service(status)(params({ refresh: 'live' })), { status });
  await assert.rejects(service(502)(params({ cursor: Buffer.from(raw[0].uri).toString('base64url') })), { status: 502 });
  await assert.rejects(service(502)(params({ raDeg: 'invalid' })), { status: 400 });
});

test('missing or corrupt fallback never masks an upstream error', async t => {
  const directory = await workspace(t);
  const offline = () => async () => { throw new SearchError('IRSA offline'); };
  const store = createIndexStore({ directory });
  await assert.rejects(createIndexedSearch({ store, liveFactory: offline })(params()), /IRSA offline/);
  const manifest = await updateIndex(setup(directory));
  await writeFile(path.join(directory, manifest.targets[0].snapshot), '{}');
  const service = createIndexedSearch({ store, liveFactory: offline });
  await assert.rejects(service(params()), /IRSA offline/);
  await assert.rejects(service(params({ indexVersion: manifest.targets[0].hash })), { status: 409 });
});

 test('fresh fixed-position snapshots avoid live TAP and are not outage fallbacks', async t => {
  const directory = await workspace(t); const clock = Date.now(); await updateIndex(setup(directory, { now: () => clock }));
  let calls = 0;
  const service = createIndexedSearch({ store: createIndexStore({ directory }), now: () => clock, liveFactory: () => async () => { calls++; throw new Error('Unexpected TAP'); } });
  const result = await service(params());
  assert.equal(calls, 0); assert.equal(result.source.kind, 'scheduled-index'); assert.equal(result.source.fallback, false);
  assert.ok(!result.warnings.some(w => w.includes('Live IRSA search was unavailable')));
});
