import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteCache, createCacheBudget, assertStackBudget } from '../lib/image-resources.js';
import { ImageScheduler } from '../lib/image-scheduler.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('decoded and rendered caches share an LRU byte budget', () => {
  const budget = createCacheBudget(16), decoded = new ByteCache(budget), rendered = new ByteCache(budget);
  decoded.set('a', new Float32Array(2)); rendered.set('b', new Uint32Array(2)); decoded.get('a');
  rendered.set('c', new Uint32Array(2));
  assert.ok(decoded.has('a')); assert.ok(!rendered.has('b')); assert.equal(budget.bytes, 16);
  decoded.clear(); assert.equal(budget.bytes, 8);
  rendered.set('large', new Uint8Array(100)); assert.ok(!rendered.has('large'));
});
test('stack preflight accepts normal views and refuses excessive requests without changing inputs', () => {
  const frames = Array.from({ length: 16 }, () => ({ exposures: Array(8).fill({}) }));
  assert.ok(assertStackBudget(frames, 16));
  assert.ok(assertStackBudget(Array.from({ length: 80 }, () => ({ exposures: Array(4).fill({}) })), 16));
  assert.throws(() => assertStackBudget(frames, 300), { name: 'ImageBudgetError' });
  assert.equal(frames.length, 16); assert.equal(frames[0].exposures.length, 8);
});
test('shared scheduler bounds concurrency and prioritizes selected frames', async () => {
  const scheduler = new ImageScheduler(2), gate = deferred(), order = [];
  let active = 0, peak = 0;
  const run = name => async () => { order.push(name); peak = Math.max(peak, ++active); await gate.promise; active--; return name; };
  const jobs = [scheduler.run('a', run('a')), scheduler.run('b', run('b')), scheduler.run('prefetch', run('prefetch'), { priority: 2 }), scheduler.run('selected', run('selected'), { priority: 0 })];
  await tick(); assert.equal(peak, 2); gate.resolve();
  await Promise.all(jobs); assert.deepEqual(order, ['a', 'b', 'selected', 'prefetch']);
});
test('deduplicated subscribers cancel independently; last subscriber cancels upstream', async () => {
  const scheduler = new ImageScheduler(1), gate = deferred(), one = new AbortController(), two = new AbortController();
  let calls = 0, upstream;
  const work = async signal => { calls++; upstream = signal; await gate.promise; return 42; };
  const a = scheduler.run('same', work, { signal: one.signal });
  const b = scheduler.run('same', work, { signal: two.signal, priority: 0 });
  one.abort(); await assert.rejects(a, { name: 'AbortError' }); await tick();
  assert.equal(calls, 1); assert.equal(upstream.aborted, false);
  gate.resolve(); assert.equal(await b, 42);
  const c = new AbortController(), hold = deferred();
  const pending = scheduler.run('cancel', async signal => { upstream = signal; await hold.promise; }, { signal: c.signal });
  await tick(); c.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(upstream.aborted, true); hold.resolve();
});
