import test from 'node:test';
import assert from 'node:assert/strict';
import { zscale, scaleLimits, stretchFraction, toneMapper, differenceMapper, gaussianSmooth, formatValue, fillMaskedHoles, robustStats, subtractLargeScale } from '../lib/display-scale.js';
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

test('Noise-based limits sit just below the sky and keep bright stars unclipped', () => {
  const values = field();
  const { low, high, sigma } = scaleLimits(values, 'noise');
  assert.ok(sigma > 0.3 && sigma < 0.7, `sigma ${sigma}`);
  assert.ok(low > 8 && low < 10, `low ${low}`);
  assert.equal(high, 5000);
  const { median } = robustStats(Float64Array.from([1, 2, 3, 4, 100]));
  assert.equal(median, 3);
});

test('Noise-softened asinh grades bright stars instead of clipping them', () => {
  const limits = { low: 0, high: 1000, sigma: 1 };
  const level = toneMapper({ ...limits, stretch: 'asinh', contrast: 50, brightness: 50 });
  const levels = [3, 30, 300, 900].map(level);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] > levels[i - 1], `levels ${levels}`);
  assert.ok(levels[2] < 255, 'a star at 30% of the range is not white');
  // Without a noise level the legacy fixed curve is used.
  assert.equal(toneMapper({ low: 0, high: 1, stretch: 'asinh', contrast: 50 })(0.5), Math.round(stretchFraction(0.5, 'asinh') * 255));
});

test('Masked star cores are filled from their rim; edges and large gaps stay empty', () => {
  const width = 9, values = new Float32Array(81).fill(1);
  for (const [x, y] of [[4, 4], [5, 4], [4, 5]]) values[y * width + x] = NaN; // interior core
  for (let x = 0; x < width; x++) values[x] = NaN; // missing top row touches the edge
  for (const at of [3 * width + 3, 3 * width + 4, 3 * width + 5]) values[at] = 50; // bright rim
  const filled = fillMaskedHoles(values, width);
  assert.notEqual(filled, values);
  for (const [x, y] of [[4, 4], [5, 4], [4, 5]]) assert.ok(filled[y * width + x] >= 1, `filled ${x},${y}`);
  assert.ok(filled[4 * width + 4] > 1, 'pixels next to the bright rim take its brightness');
  for (let x = 0; x < width; x++) assert.ok(Number.isNaN(filled[x]), 'edge gap is left as no data');
  assert.ok(Number.isNaN(values[4 * width + 4]), 'input is not modified');
  const covered = new Uint8Array(81).fill(1); covered[4 * width + 4] = 0;
  assert.ok(Number.isNaN(fillMaskedHoles(values, width, { covered })[4 * width + 4]), 'holes with uncovered pixels stay empty');
  assert.ok(Number.isNaN(fillMaskedHoles(values, width, { maxHole: 2 })[4 * width + 4]), 'holes larger than maxHole stay empty');
  const clean = new Float32Array(81).fill(1);
  assert.equal(fillMaskedHoles(clean, width), clean);
});

// A grid with unit noise, built from a deterministic generator.
function noisyGrid(width, fn) {
  let seed = 3; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Float32Array.from({ length: width * width }, (_, i) => fn(i % width, Math.floor(i / width)) + (random() + random() + random() - 1.5) * 2);
}
const medianWhere = (values, width, pick) => {
  const sample = [];
  for (let i = 0; i < values.length; i++) if (pick(i % width, Math.floor(i / width))) sample.push(values[i]);
  return robustStats(Float64Array.from(sample).sort()).median;
};

test('background flattening leaves no negative moat around a bright star with a halo', () => {
  const width = 98;
  const star = noisyGrid(width, (x, y) => { const r = Math.hypot(x - 49, y - 49); return 3000 * Math.exp(-r * r / 2) + 400 / (1 + (r / 8) ** 2.5); });
  const flat = subtractLargeScale(star, width, 16);
  for (const [inner, outer] of [[15, 25], [25, 35], [35, 45]]) {
    const ring = medianWhere(flat, width, (x, y) => { const r = Math.hypot(x - 49, y - 49); return r >= inner && r < outer; });
    assert.ok(ring > -1, `ring ${inner}–${outer} px is not over-subtracted (median ${ring.toFixed(2)})`);
  }
});

test('background flattening still removes a curved sky gradient', () => {
  const width = 98;
  const sky = noisyGrid(width, (x, y) => 0.5 * x - 0.3 * y + 0.002 * (x - 49) ** 2);
  const flat = subtractLargeScale(sky, width, 16);
  assert.ok(Math.abs(medianWhere(flat, width, () => true)) < 0.3, 'whole field near zero');
  for (const [x0, y0] of [[0, 0], [88, 0], [0, 88], [88, 88]]) {
    const corner = medianWhere(flat, width, (x, y) => x >= x0 && x < x0 + 10 && y >= y0 && y < y0 + 10);
    // Block levels are clamped half a block from the edge, so corners keep a
    // few units of the 0.5/px slope; the unmasked version left 7–12 here.
    assert.ok(Math.abs(corner) < 6, `corner (${x0}, ${y0}) residual ${corner.toFixed(2)}`);
  }
});
