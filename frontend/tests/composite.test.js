import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeRgb, paintChannel, channelLimits, NO_DATA_RGB } from '../lib/composite.js';
import { colormap } from '../lib/colormaps.js';

const ramp = (length, scale = 1, offset = 0) => Float32Array.from({ length }, (_, i) => offset + i * scale);
const options = { stretch: 'linear', scaleMode: 'minmax', contrast: 50, brightness: 50, fillMaskedCores: false, neutralSky: false };

test('each channel is scaled on its own, so very different flux levels still fill 0–255', () => {
  const r = ramp(16, 1000, 5000), g = ramp(16, 0.01), b = ramp(16, -1);
  const { rgba, limits } = compositeRgb({ r, g, b }, 4, options);
  assert.deepEqual([rgba[0], rgba[1], rgba[2], rgba[3]], [0, 0, 255, 255]);
  assert.deepEqual([rgba[60], rgba[61], rgba[62], rgba[63]], [255, 255, 0, 255]);
  assert.deepEqual(limits[0], { low: 5000, high: 20000 });
});

test('a channel without data paints 0; a pixel without data anywhere is no-data', () => {
  const r = ramp(4), g = ramp(4), b = ramp(4);
  r[1] = Number.NaN;
  for (const grid of [r, g, b]) grid[2] = Number.NaN;
  const { rgba } = compositeRgb({ r, g, b }, 2, options);
  assert.equal(rgba[4], 0);
  assert.ok(rgba[5] > 0);
  assert.deepEqual([...rgba.slice(8, 11)], [...NO_DATA_RGB]);
});

test('a missing grid leaves its channel dark; mismatched grids are rejected', () => {
  const { rgba } = compositeRgb({ r: ramp(4), g: null, b: null }, 2, options);
  assert.equal(rgba[12], 255); assert.equal(rgba[13], 0); assert.equal(rgba[14], 0);
  assert.throws(() => compositeRgb({ r: ramp(4), g: ramp(9) }, 2, options), /share one grid/);
  assert.throws(() => compositeRgb({}, 2, options), /at least one channel/);
});

test('by default the composite puts every channel’s black point at its sky, so the background is neutral', () => {
  // Same sky noise, very different star brightness: without this the faint
  // channel's sky would sit brighter and tint the whole background.
  const sky = Array.from({ length: 99 }, (_, i) => (i % 3) - 1);
  const r = Float32Array.from([...sky, 10]), g = Float32Array.from([...sky, 1000]);
  const { rgba, limits } = compositeRgb({ r, g, b: null }, 10, { ...options, neutralSky: undefined, scaleMode: 'minmax' });
  assert.equal(limits[0].low, 0); assert.equal(limits[1].low, 0);
  assert.equal(rgba[4], rgba[5]);
  assert.equal(rgba[396], 255); assert.equal(rgba[397], 255);
});

test('single-detector panels use the colour table and ignore manual limits', () => {
  const { rgba } = paintChannel(ramp(4), colormap('grayscale'), { ...options, width: 2 });
  assert.deepEqual([...rgba.slice(12, 15)], [255, 255, 255]);
  const limits = channelLimits(ramp(100), { scaleMode: 'manual' });
  assert.ok(limits.high > limits.low);
  assert.deepEqual(channelLimits(new Float32Array(4).fill(Number.NaN)), { low: 0, high: 1 });
});
