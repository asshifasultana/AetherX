import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCutoutHandler, MAX_CUTOUT_BYTES, clearLegacyCutoutCache, validateCutout } from '../api/cutout.js';
import { createWorkGate } from '../lib/resources.js';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const prefix = Buffer.alloc(80, 32); prefix.write('SIMPLE  ');
const params = new URLSearchParams({ url: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/example.fits', raDeg: 1, decDeg: 2, fovArcmin: 16 });
const waitFor = async condition => { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Condition timed out'); };
async function withServer(fetchImpl, run, options = {}) {
  const gate = createWorkGate({ rss: () => 0 });
  const server = createServer(createCutoutHandler(fetchImpl, { gate, cleanup: async () => {}, ...options }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}/api/cutout?${params}`, gate); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('DR1 science products can be cut out; calibration and other paths cannot', () => {
  const dr1 = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W39_2A/l2b-v27-2026-239/1/level2_2025W39_2A_0373_1D1_spx_l2b-v27-2026-239.fits';
  assert.equal(validateCutout(new URLSearchParams({ url: dr1, raDeg: 1, decDeg: 2, fovArcmin: 16 })).url, dr1);
  for (const url of [dr1.replace('/dr1/', '/dr1_cal/'), dr1.replace('/level2/', '/level1/')]) assert.throws(() => validateCutout(new URLSearchParams({ url, raDeg: 1, decDeg: 2, fovArcmin: 16 })));
});

test('aligned fallback pads the detector cutout while ordinary API requests keep their requested size', async () => {
  let requested;
  await withServer(async url => { requested = url.searchParams.get('size'); return new Response(prefix); }, async url => {
    let response = await fetch(url + '&aligned=1'); assert.equal(response.status, 200); await response.arrayBuffer();
    assert.equal(requested, `${16 * Math.SQRT2 + 1}arcmin`);
    response = await fetch(url + '&aligned=invalid'); assert.equal(response.status, 400); await response.json();
  });
});

test('cutouts stream before completion, preserve bytes, and hold admission for slow transfers', async () => {
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  await withServer(async url => {
    assert.equal(url.searchParams.get('center'), '1,2'); assert.equal(url.searchParams.get('size'), '16arcmin');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(prefix.subarray(0, 4)); controller.enqueue(prefix.subarray(4));
      await completed; controller.enqueue(Buffer.from('science')); controller.close();
    } }));
  }, async url => {
    const response = await fetch(url), reader = response.body.getReader();
    const first = await reader.read(); assert.equal(Buffer.from(first.value).toString(), prefix.toString());
    assert.equal(response.headers.get('x-cutout-cache'), null);
    assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
    const busy = await fetch(url); assert.equal(busy.status, 503); assert.equal(busy.headers.get('retry-after'), '5');
    finish(); const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    assert.equal(Buffer.concat(chunks).toString(), 'science');
    assert.equal((await fetch(url)).status, 200);
  });
});

test('invalid and incomplete signatures fail before headers and leave capacity available', async () => {
  let calls = 0;
  await withServer(async () => new Response(++calls === 1 ? Buffer.alloc(80) : calls === 2 ? 'SIMPLE  ' : prefix), async url => {
    for (let i = 0; i < 2; i++) { const response = await fetch(url); assert.equal(response.status, 502); assert.match(response.headers.get('content-type'), /json/); await response.json(); }
    const valid = await fetch(url); assert.equal(valid.status, 200); await valid.arrayBuffer();
  });
});

test('declared oversized cutouts are cancelled without downloading original images', async () => {
  let cancelled = false;
  await withServer(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '70000000' } }), async url => {
    const response = await fetch(url); assert.equal(response.status, 413);
    assert.match((await response.json()).error, /smaller field of view/); assert.equal(cancelled, true);
  });
});

test('unknown-length oversized transfers and upstream failures terminate FITS streams', async () => {
  for (const failEarly of [false, true]) {
    let cancelled = false, sent = 0;
    await withServer(async () => new Response(new ReadableStream({
      async pull(controller) {
        if (!sent) { controller.enqueue(prefix); sent += prefix.length; return; }
        if (failEarly) { await new Promise(resolve => setTimeout(resolve, 20)); controller.error(new Error('upstream reset')); return; }
        controller.enqueue(new Uint8Array(64 * 1024)); sent += 64 * 1024;
      }, cancel() { cancelled = true; }
    })), async url => {
      await assert.rejects(async () => { const response = await fetch(url); await response.arrayBuffer(); });
      if (!failEarly) { assert.ok(sent > MAX_CUTOUT_BYTES); assert.equal(cancelled, true); }
    });
  }
});

test('client disconnect cancels upstream and frees the transfer slot', async () => {
  let signal, cancelled = false;
  await withServer(async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(prefix); }, cancel() { cancelled = true; } }));
  }, async (url, gate) => {
    const controller = new AbortController(); const response = await fetch(url, { signal: controller.signal });
    await response.body.getReader().read(); controller.abort();
    await waitFor(() => signal.aborted && cancelled);
    await new Promise(resolve => setTimeout(resolve, 10)); gate.acquire()();
  });
});

test('timeout cancels stalled header reads and releases admission', async () => {
  let cancelled = false;
  await withServer(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), async (url, gate) => {
    const response = await fetch(url); assert.equal(response.status, 504); await response.json();
    assert.equal(cancelled, true); gate.acquire()();
  }, { timeoutMs: 20 });
});

test('legacy cleanup removes only the app cache and streaming writes no replacement files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spherex-cache-cleanup-'));
  const oldTemp = process.env.TEMP, oldTmp = process.env.TMP, oldTmpdir = process.env.TMPDIR;
  try {
    const legacy = path.join(directory, 'spherex-cutouts-v1');
    await mkdir(legacy); await writeFile(path.join(legacy, 'old.fits'), prefix);
    const unrelated = path.join(directory, 'keep.txt'); await writeFile(unrelated, 'keep');
    process.env.TEMP = directory; process.env.TMP = directory; process.env.TMPDIR = directory;
    await clearLegacyCutoutCache();
    await assert.rejects(access(legacy)); await access(unrelated);
    await withServer(async () => new Response(prefix), async url => { const response = await fetch(url); await response.arrayBuffer(); });
    await assert.rejects(access(legacy)); await access(unrelated);
  } finally {
    for (const [name, value] of [['TEMP', oldTemp], ['TMP', oldTmp], ['TMPDIR', oldTmpdir]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('spherex-cache-cleanup-')) throw new Error('Unsafe cleanup path');
    await rm(resolved, { recursive: true, force: true });
  }
});
