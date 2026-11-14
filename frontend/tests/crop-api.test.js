import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCropHandler, cropCacheControl, encodeCrop, validateCrop } from '../api/crop.js';
import { decodeCrop, loadViaProxy } from '../lib/crop-codec.js';
import { createFitsRangeLoader } from '../lib/range-fits.js';
import { createWorkGate } from '../lib/resources.js';
import { makeFits } from './fixtures/fits-builder.js';

const accessUrl = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/test.fits';
const target = { raDeg: 359.999, decDeg: 4.69 };
const query = (extra = {}) => new URLSearchParams({ url: accessUrl, raDeg: target.raDeg, decDeg: target.decDeg, fovArcmin: 1, flags: 1, ...extra });
const rangeLoader = bytes => createFitsRangeLoader({ read: async (_, a, b) => new Uint8Array(bytes.subarray(a, b + 1)) });
async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}/api/crop`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function sameImage(actual, expected) {
  assert.deepEqual(actual.values, expected.values);
  assert.deepEqual(actual.flags, expected.flags);
  assert.deepEqual(actual.variance, expected.variance);
  for (const key of ['width', 'height', 'sourceX', 'sourceY']) assert.equal(actual[key], expected[key]);
  assert.deepEqual(actual.header, expected.header);
  assert.deepEqual(actual.matrix, expected.matrix);
}

test('crop validation accepts only archive products and bounded geometry', () => {
  assert.equal(validateCrop(query({ decDeg: '4.69e-7' })).decDeg, 4.69e-7);
  for (const extra of [{ url: 'https://evil.example/x.fits' }, { raDeg: 360 }, { decDeg: 91 }, { fovArcmin: 31 }, { fovArcmin: 'x' }, { flags: 2 }, { revision: 'a\nb' }])
    assert.throws(() => validateCrop(query(extra)), /valid|range|option|cropped|revision/i);
});

test('proxy payload round-trips to exactly the direct range-loader result', async () => {
  for (const settings of [{ flags: '1', variance: '0' }, { flags: '0', variance: '0' }]) {
    const bytes = makeFits(), gate = createWorkGate({ rss: () => 0, slots: 4 });
    await withServer(createCropHandler({ load: rangeLoader(bytes), gate }), async endpoint => {
      const response = await fetch(`${endpoint}?${query(settings)}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), cropCacheControl(''));
      const direct = await rangeLoader(bytes)(accessUrl, target, { fovArcmin: 1, hideBadPixels: settings.flags === '1', includeFlags: settings.flags === '1' });
      const proxied = decodeCrop(await response.arrayBuffer());
      sameImage(proxied, direct);
      assert.equal(proxied.flags === null, settings.flags === '0');
    });
  }
});

test('successful crops are CDN-cacheable, immutably when the revision is pinned', async () => {
  const bytes = makeFits();
  await withServer(createCropHandler({ load: rangeLoader(bytes), gate: createWorkGate({ rss: () => 0 }) }), async endpoint => {
    const pinned = await fetch(`${endpoint}?${query({ revision: '2025-08-22T03:14:15Z' })}`);
    assert.equal(pinned.status, 200);
    assert.match(pinned.headers.get('cache-control'), /^public, .*s-maxage=31536000.*immutable/);
    const unpinned = await fetch(`${endpoint}?${query()}`);
    assert.match(unpinned.headers.get('cache-control'), /^public, .*s-maxage=86400/);
    assert.doesNotMatch(unpinned.headers.get('cache-control'), /immutable/);
    assert.equal(pinned.headers.get('vary'), 'Accept-Encoding');
  });
});

test('proxy reports coverage as 422, archive failures as 502, and busy as 503', async () => {
  const bytes = makeFits();
  await withServer(createCropHandler({ load: rangeLoader(bytes), gate: createWorkGate({ rss: () => 0 }) }), async endpoint => {
    const response = await fetch(`${endpoint}?${query({ raDeg: 180, decDeg: 0 })}`);
    assert.equal(response.status, 422); assert.match((await response.json()).error, /coverage/);
    assert.equal(response.headers.get('cache-control'), 'no-store', 'errors are never cached');
    assert.equal((await fetch(`${endpoint}?${query({ fovArcmin: 99 })}`)).status, 400);
  });
  await withServer(createCropHandler({ load: async () => { throw new Error('S3 request failed (503).'); }, gate: createWorkGate({ rss: () => 0 }) }), async endpoint => {
    assert.equal((await fetch(`${endpoint}?${query()}`)).status, 502);
  });
  await withServer(createCropHandler({ load: rangeLoader(bytes), gate: { acquire() { throw Object.assign(new Error('busy'), { status: 503, retryAfter: 5 }); } } }), async endpoint => {
    const response = await fetch(`${endpoint}?${query()}`);
    assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '5');
  });
});

test('client proxy loader falls back on outages, surfaces coverage errors and skips wide fields', async () => {
  const bytes = makeFits(), settings = { fovArcmin: 1, hideBadPixels: true };
  const direct = await rangeLoader(bytes)(accessUrl, target, settings);
  const payload = { proxyUrl: 'https://viewer.test/api/crop', accessUrl, target, settings, revision: 'r1' };
  let requested;
  const image = await loadViaProxy(payload, undefined, async url => { requested = url; return new Response(encodeCrop(direct)); });
  sameImage(image, direct);
  assert.equal(requested.searchParams.get('revision'), 'r1'); assert.equal(requested.searchParams.get('flags'), '1');
  let busy = 0;
  sameImage(await loadViaProxy(payload, undefined, async () => ++busy === 1 ? new Response('busy', { status: 503 }) : new Response(encodeCrop(direct))), direct);
  assert.equal(busy, 2, 'a busy proxy is retried before falling back');
  busy = 0;
  assert.equal(await loadViaProxy(payload, undefined, async () => { busy++; return new Response('down', { status: 503 }); }), null);
  assert.equal(busy, 3);
  assert.equal(await loadViaProxy(payload, undefined, async () => new Response('down', { status: 502 })), null);
  assert.equal(await loadViaProxy(payload, undefined, async () => { throw new TypeError('network'); }), null);
  assert.equal(await loadViaProxy(payload, undefined, async () => new Response('not a crop')), null);
  await assert.rejects(loadViaProxy(payload, undefined, async () => Response.json({ error: 'No detector coverage for this field.' }, { status: 422 })), /coverage/);
  let called = false;
  assert.equal(await loadViaProxy({ ...payload, settings: { fovArcmin: 60 } }, undefined, async () => { called = true; }), null);
  assert.equal(await loadViaProxy({ ...payload, proxyUrl: '' }, undefined, async () => { called = true; }), null);
  assert.equal(called, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadViaProxy(payload, controller.signal, async (_, { signal }) => { signal.throwIfAborted(); }), { name: 'AbortError' });
});
