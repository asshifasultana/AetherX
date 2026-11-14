import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobs, pollUntil, describeDone } from '../lib/background-jobs.js';

const settled = () => new Promise(resolve => setTimeout(resolve, 0));

test('pollUntil retries until a value arrives, and gives up at the deadline', async () => {
  let calls = 0, clock = 0;
  const pause = async ms => { clock += ms; };
  const value = await pollUntil(async () => (++calls < 3 ? undefined : { checked: true }), { intervalMs: 1000, timeoutMs: 10_000, now: () => clock, pause });
  assert.deepEqual(value, { checked: true });
  assert.equal(calls, 3);
  clock = 0;
  await assert.rejects(pollUntil(async () => undefined, { intervalMs: 1000, timeoutMs: 2500, now: () => clock, pause }), /timed out/);
});

test('a background job reports its result once, and a duplicate joins the running one', async () => {
  const done = [];
  const jobs = createJobs({ onDone: entry => done.push(entry) });
  let finish;
  const first = jobs.start('jpl:1', 'Known-asteroid check (JPL) for spot 1', () => new Promise(resolve => { finish = resolve; }), { spot: 1 });
  const again = jobs.start('jpl:1', 'Known-asteroid check (JPL) for spot 1', async () => 'never');
  assert.equal(again.id, first.id);
  assert.equal(again.joined, true);
  assert.deepEqual(jobs.running(), [{ id: first.id, label: 'Known-asteroid check (JPL) for spot 1' }]);
  await settled();
  finish({ checked: true, count: 0 });
  await settled(); await settled();
  assert.equal(done.length, 1);
  assert.equal(done[0].ok, true);
  assert.equal(done[0].spot, 1);
  assert.deepEqual(done[0].result, { checked: true, count: 0 });
  assert.equal(jobs.running().length, 0);
  assert.match(describeDone(done[0]), /^\[Background result job-1\] Known-asteroid check \(JPL\) for spot 1 finished after \d+ s: \{"checked":true,"count":0\}$/);
});

test('failed jobs report the error; cancelled jobs report nothing', async () => {
  const done = [];
  const jobs = createJobs({ onDone: entry => done.push(entry) });
  jobs.start('gaia:2', 'Star check', async () => { throw new Error('Gaia lookup failed.'); });
  jobs.start('stack', 'Deep stack', signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))));
  jobs.cancelAll();
  for (let i = 0; i < 4; i++) await settled();
  assert.equal(done.length, 0, 'cancelAll silences both, including the one that failed in the same tick');
  jobs.start('gaia:3', 'Star check', async () => { throw new Error('Gaia lookup failed.'); });
  for (let i = 0; i < 4; i++) await settled();
  assert.equal(done.length, 1);
  assert.equal(done[0].ok, false);
  assert.match(describeDone(done[0]), /Gaia lookup failed/);
});
