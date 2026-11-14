import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createWorkGate, createSearchResources } from '../lib/resources.js';
import { createSearchService } from '../lib/observations.js';
import { createObservationsHandler } from '../api/observations.js';

const fixture = await readFile(new URL('./fixtures/irsa-sample.csv', import.meta.url), 'utf8');
const params = (ra = 1) => new URLSearchParams({ raDeg: ra, decDeg: 0 });

test('cache evicts by LRU and aggregate bytes, skips oversized entries and expires', () => {
  const state = createSearchResources({ maxEntries: 2, maxBytes: 12 });
  state.set('a', 'aaa', 100, 0); state.set('b', 'bbb', 100, 0);
  assert.equal(state.get('a', 1), 'aaa');
  state.set('c', 'ccc', 100, 1);
  assert.equal(state.get('b', 1), null); assert.equal(state.get('a', 1), 'aaa');
  state.set('d', 'ddddddd', 100, 1);
  assert.equal(state.get('a', 1), null); assert.equal(state.get('c', 1), null);
  state.set('oversized', 'x'.repeat(20), 100, 1);
  assert.equal(state.get('oversized', 1), null); assert.equal(state.get('d', 100), null);
});

test('default cache retains eight entries and at most eight MiB across variants', () => {
  const state = createSearchResources();
  for (let i = 0; i < 9; i++) state.set(i, i, 100, 0);
  assert.equal(state.get(0, 1), null); assert.equal(state.get(1, 1), 1);
  const large = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 8; i++) state.set(`large-${i}`, large, 100, 0);
  assert.equal(state.get('large-0', 1), null);
  assert.equal(state.get('large-7', 1), large);
});

test('RSS admission rejects work at threshold; releases are idempotent', () => {
  let rss = 320 * 1024 * 1024;
  const gate = createWorkGate({ rss: () => rss });
  assert.throws(() => gate.acquire(), { status: 503, retryAfter: 5 });
  rss = 0; const release = gate.acquire();
  assert.throws(() => gate.acquire(), { status: 503 });
  release(); release(); gate.acquire()();
});

test('collection variants share admission, cache keys, and cancellation preserves other waiters', async () => {
  const state = createSearchResources({ gate: createWorkGate({ rss: () => 0 }) });
  let finish, calls = 0;
  const fetchImpl = async () => { calls++; await new Promise(resolve => { finish = resolve; }); return new Response(fixture); };
  const a = createSearchService({ resources: state, collections: ['spherex_qr2'], fetchImpl });
  const b = createSearchService({ resources: state, collections: ['spherex_qr3'], fetchImpl });
  const controller = new AbortController();
  const first = a(params(), { signal: controller.signal });
  const second = a(params());
  controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(b(params()), { status: 503 });
  await assert.rejects(a(params(2)), { status: 503 });
  finish(); await second; assert.equal(calls, 1);
  assert.equal((await a(params())).cached, true);
  const differentCollection = b(params()); finish(); await differentCollection;
  assert.equal(calls, 2);
});

test('last waiter disconnect cancels metadata work and frees admission', async () => {
  let signal;
  const state = createSearchResources({ gate: createWorkGate({ rss: () => 0 }) });
  const service = createSearchService({ resources: state, fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const request = service(params(), { signal: controller.signal });
  controller.abort(); await assert.rejects(request, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setImmediate(resolve));
  state.gate.acquire()();
});

test('empty responses are cached and API overload includes Retry-After without querying IRSA', async () => {
  let calls = 0;
  const state = createSearchResources({ gate: createWorkGate({ rss: () => 0 }) });
  const service = createSearchService({ resources: state, fetchImpl: async () => { calls++; return new Response('obs_id,energy_bandpassname\n'); } });
  assert.equal((await service(params())).count, 0);
  assert.equal((await service(params())).cached, true); assert.equal(calls, 1);
  const release = state.gate.acquire();
  const server = createServer(createObservationsHandler(service));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/observations?${params(2)}`);
    assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '5');
    assert.match((await response.json()).error, /busy/); assert.equal(calls, 1);
  } finally { release(); await new Promise(resolve => server.close(resolve)); }
});
