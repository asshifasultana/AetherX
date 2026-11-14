import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { assessPixelQuality, detectSingleExposureGlitches, MASKED_FLAG_BITS, QUALITY_FLAGS, summarizeExposureSamples } from '../lib/pixel-quality.js';
import { createPixelQualityHandler } from '../api/pixel-quality.js';

test('flag definitions expose named categories while retaining bright-source and motion flags', () => {
  assert.ok(QUALITY_FLAGS.some(flag => flag.name === 'TRANSIENT' && flag.category === 'transient'));
  assert.ok(QUALITY_FLAGS.some(flag => flag.name === 'PERSIST' && flag.category === 'correction'));
  for (const retained of [1, 15, 21, 25]) assert.equal(MASKED_FLAG_BITS.includes(retained), false);
});

test('pixel quality distinguishes valid dim samples, missing data, masked samples and detector gaps', () => {
  assert.equal(assessPixelQuality({ covered: true, value: 0.00001, flags: 0 }).state, 'valid');
  assert.equal(assessPixelQuality({ covered: true, value: null, flags: 0 }).state, 'missing_data');
  assert.equal(assessPixelQuality({ covered: true, value: 1, flags: 1 << 10 }).state, 'masked');
  assert.equal(assessPixelQuality({ covered: false, value: null, flags: 0 }).state, 'outside_coverage');
  assert.equal(assessPixelQuality({ covered: true, value: 1, flags: 0, flagsAvailable: false }).state, 'unassessed');
});

test('exposure counts never count missing, uncovered or masked samples as valid', () => {
  const counts = summarizeExposureSamples([
    { covered: true, value: 0.00001, flags: 0, flagsAvailable: true },
    { covered: true, value: 1, flags: 1 << 10, flagsAvailable: true },
    { covered: true, value: null, flags: 1 << 9, flagsAvailable: true },
    { covered: false, value: null, flags: 0, flagsAvailable: true }
  ]);
  assert.deepEqual(counts, { examined: 4, valid: 1, masked: 1, missing: 1, uncovered: 1, flaggedIncluded: 0, unassessed: 0, glitches: 0 });
});

test('single-exposure transient check rejects one strong outlier only within the same OBSID', () => {
  const samples = [4, 4.1, 40, 100].map((signal, index) => ({
    covered: true, value: signal, flags: 0, flagsAvailable: true, signal, noise: 0.02,
    visitId: index === 3 ? 'different-visit' : 'same-visit'
  }));
  assert.deepEqual(detectSingleExposureGlitches(samples), [2]);
  const counts = summarizeExposureSamples(samples, true, new Set([2]));
  assert.equal(counts.glitches, 1);
  assert.equal(counts.valid, 3);
});

test('pixel quality API publishes policy and validates assessment requests', async t => {
  const server = createServer(createPixelQualityHandler());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const policy = await fetch(base);
  assert.equal(policy.status, 200);
  assert.ok((await policy.json()).maskedFlagBits.includes(10));
  const valid = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ covered: true, value: null, flags: 1 << 9, flagsAvailable: true, maskEnabled: true, detectGlitches: true, samples: [{ covered: true, value: null, flags: 1 << 9, flagsAvailable: true }], activeSampleIndex: 0 }) });
  const result = await valid.json();
  assert.equal(result.state, 'missing_data');
  assert.equal(result.exposureCounts.valid, 0);
  const invalid = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
});
