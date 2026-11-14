import test from 'node:test';
import assert from 'node:assert/strict';
import { differenceImage } from '../lib/difference.js';
import { plantInto } from '../lib/planted-lab.js';
import { mulberry32 } from '../lib/recovery.js';

function noisePlane(width, sigma, seed) {
  const rng = mulberry32(seed), values = new Float32Array(width * width);
  for (let i = 0; i < values.length; i++) values[i] = sigma * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  return values;
}

test('a planted 15σ source is significant and the difference noise is about √2 × the frame noise', () => {
  const width = 64, reference = noisePlane(width, 1, 1);
  const current = plantInto(noisePlane(width, 1, 2), width, { x: 30, y: 20 }, 15);
  const diff = differenceImage({ current, reference, width });
  assert.ok(Math.abs(diff.sigma - Math.SQRT2) < 0.15, `sigma ${diff.sigma}`);
  assert.equal(diff.significant[20 * width + 30], 1);
  assert.equal(diff.threshold, 5);
  assert.ok(diff.brighter >= 1);
});

test('frames with no shared finite pixel give null', () => {
  const a = new Float32Array(16).fill(NaN), b = new Float32Array(16).fill(1);
  assert.equal(differenceImage({ current: b, reference: a, width: 4 }), null);
});
