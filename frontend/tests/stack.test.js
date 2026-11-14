import test from 'node:test';
import assert from 'node:assert/strict';
import { medianStack } from '../lib/stack.js';

test('median stack excludes masked, missing, and uncovered NaN samples per pixel', () => {
  const result = medianStack([
    Float32Array.from([1, 8, NaN, 3]),
    Float32Array.from([3, NaN, 5, 3]),
    Float32Array.from([100, 12, 7, NaN])
  ]);
  assert.deepEqual([...result.values], [3, 10, 6, 3]);
  assert.deepEqual([...result.counts], [3, 2, 2, 2]);
  assert.equal(result.validPixelContributions, 9);
  assert.equal(result.coveredPixels, 4);
});

test('median stack rejects mismatched grid sizes', () => {
  assert.throws(() => medianStack([[1, 2], [1]]), /equal-sized/);
});
