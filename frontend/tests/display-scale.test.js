import test from 'node:test';
import assert from 'node:assert/strict';
import { zscale, scaleLimits, stretchFraction, toneMapper, differenceMapper, gaussianSmooth, formatValue } from '../lib/display-scale.js';
import { colormap, COLORMAP_NAMES } from '../lib/colormaps.js';
import { combineStack, medianStack } from '../lib/stack.js';
import { assessPixelQuality, maskBitsFor, DEFAULT_MASK_BITS, MASKED_FLAG_BITS, isValidMaskBits } from '../lib/pixel-quality.js';

// Deterministic noise around a sky level, with a few very bright "stars".
function field(n = 4000) {
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const values = Float32Array.from({ length: n }, () => 10 + (random() + random() + random() - 1.5));
  for (let i = 0; i < 20; i++) values[i * 97] = 5000;
  values[3] = NaN;
  return values;
}

test('ZScale centres on the sky and ignores bright stars', () => {
  const { low, high } = zscale(field());
  assert.ok(low > 7 && low < 10, `low ${low}`); assert.ok(high > 10 && high < 14, `high ${high}`);
  const minmax = scaleLimits(field(), 'minmax');
  assert.equal(minmax.high, 5000);
  const percentile = scaleLimits(field(), 'p99.5');
  assert.ok(percentile.high < 5000 && percentile.low < percentile.high);
  assert.deepEqual(scaleLimits(field(), 'manual', { low: 1, high: 2 }), { low: 1, high: 2 });
  assert.notDeepEqual(scaleLimits(field(), 'manual', { low: 2, high: 1 }), { low: 2, high: 1 }, 'an inverted manual range falls back');
});

test('stretches are monotonic and tone mapping honours brightness, contrast and invert', () => {
  for (const stretch of ['linear', 'sqrt', 'asinh', 'log']) {
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) { const value = stretchFraction(t, stretch); assert.ok(value >= previous, stretch); previous = value; }
  }
  const base = toneMapper({ low: 0, high: 1, stretch: 'linear', contrast: 50, brightness: 50 });
  assert.equal(base(0), 0); assert.equal(base(1), 255); assert.equal(base(0.5), 128);
  assert.ok(toneMapper({ low: 0, high: 1, stretch: 'linear', contrast: 50, brightness: 70 })(0.5) > 128);
  assert.equal(toneMapper({ low: 0, high: 1, stretch: 'linear', contrast: 50, brightness: 50, invert: true })(0), 255);
  const equalised = toneMapper({ low: 0, high: 1, stretch: 'histeq', contrast: 50, brightness: 50 }, [1, 2, 3, 4]);
  assert.ok(equalised(3) > equalised(2));
});

test('difference mapping is symmetric around zero', () => {
  const map = differenceMapper(2, 10);
  assert.equal(map(0), 128);
  assert.equal(map(1e9), 255); assert.equal(map(-1e9), 0);
  assert.ok(Math.abs(map(4) + map(-4) - 255) <= 1);
  assert.ok(map(4) > 128 && map(-4) < 128);
});

test('NaN-aware smoothing keeps gaps and preserves a flat field', () => {
  const values = new Float32Array(25).fill(3); values[12] = NaN;
  const smoothed = gaussianSmooth(values, 5, 1);
  assert.ok(Number.isNaN(smoothed[12]));
  assert.ok(Math.abs(smoothed[0] - 3) < 1e-6 && Math.abs(smoothed[6] - 3) < 1e-6);
  assert.equal(formatValue(0.000012), '1.20e-5'); assert.equal(formatValue(12.3456), '12.3'); assert.equal(formatValue(NaN), '—');
});

test('colour maps are distinct 256-level tables', () => {
  for (const name of COLORMAP_NAMES) assert.equal(colormap(name).length, 768);
  assert.notDeepEqual(colormap('inferno'), colormap('magma'));
  assert.deepEqual([...colormap('grayscale').slice(765)], [255, 255, 255]);
});

test('stack statistics: clipped mean rejects an outlier and max ignores gaps', () => {
  const images = [[1, NaN], [1.1, 2], [0.9, 5], [1, 3], [100, NaN]].map(values => Float32Array.from(values));
  const median = medianStack(images), clipped = combineStack(images, { statistic: 'clipped-mean' }), max = combineStack(images, { statistic: 'max' });
  assert.ok(Math.abs(median.values[0] - 1) < 1e-6);
  assert.ok(Math.abs(clipped.values[0] - 1) < 1e-6, `clipped ${clipped.values[0]}`);
  assert.equal(max.values[1], 5); assert.equal(max.counts[1], 3);
  assert.equal(combineStack(images, { statistic: 'bogus' }).statistic, 'median');
});

test('category masks reproduce the default policy and can relax or extend it', () => {
  assert.equal(maskBitsFor(), DEFAULT_MASK_BITS);
  assert.equal(DEFAULT_MASK_BITS, MASKED_FLAG_BITS.reduce((mask, bit) => mask | (2 ** bit), 0) >>> 0);
  const transientOnly = maskBitsFor(['transient']);
  assert.ok(transientOnly & 1); assert.equal(transientOnly & (2 ** 10), 0, 'HOT is a detector flag');
  assert.ok(maskBitsFor([]) & (2 ** 9), 'missing data is always masked');
  const withCaution = maskBitsFor(['caution']);
  assert.ok(withCaution & (2 ** 25)); assert.equal(withCaution & (2 ** 21), 0, 'SOURCE is never maskable');
  const hot = { covered: true, value: 1, flags: 2 ** 10 };
  assert.equal(assessPixelQuality(hot).state, 'masked');
  assert.equal(assessPixelQuality({ ...hot, maskBits: transientOnly }).state, 'valid');
  assert.equal(isValidMaskBits(DEFAULT_MASK_BITS), true); assert.equal(isValidMaskBits(2 ** 31), false); assert.equal(isValidMaskBits(1.5), false);
});
