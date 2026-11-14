import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBackground } from '../lib/background.js';

test('background estimate resists a few bright sources and ignores invalid pixels', () => {
  const result = estimateBackground([10, 10.1, 9.9, 10.05, 9.95, 10.02, 9.98, 10, 10, 10, 900, 1200, NaN]);
  assert.ok(Math.abs(result.level - 10) < 0.1);
  assert.ok(result.used < result.total);
});

test('background estimate returns a safe result for empty data', () => {
  assert.deepEqual(estimateBackground([NaN, Infinity]), { level: 0, noise: 0, used: 0, total: 0 });
});
