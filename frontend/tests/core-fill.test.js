import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPsfCore, gridPsf } from '../lib/core-fill.js';
import { fillMaskedHoles } from '../lib/display-scale.js';
import { prepareImage, readFits } from '../lib/fits-engine.js';
import { makeFits } from './fixtures/fits-builder.js';

const WIDTH = 31, SKY = 10;
const gaussian = sigma => (sx, sy) => (du, dv) => Math.exp(-(du * du + dv * dv) / (2 * sigma * sigma));

// A Gaussian star on a flat sky with a little deterministic texture.
function starField({ cx = 15.25, cy = 14.75, amplitude = 1000, sigma = 1.1 } = {}) {
  const values = new Float32Array(WIDTH * WIDTH);
  for (let y = 0; y < WIDTH; y++) for (let x = 0; x < WIDTH; x++) {
    values[y * WIDTH + x] = SKY + 0.2 * Math.sin(x * 1.3 + y * 0.7) + amplitude * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
  }
  return values;
}
const maskAt = (values, offsets, at) => {
  const masked = Float32Array.from(values), hole = offsets.map(([dx, dy]) => at + dy * WIDTH + dx);
  for (const index of hole) masked[index] = NaN;
  return { masked, hole };
};
const rimMaxOf = (masked, hole) => Math.max(...hole.flatMap(at => [-1, 1, -WIDTH, WIDTH, -WIDTH - 1, -WIDTH + 1, WIDTH - 1, WIDTH + 1]
  .map(step => masked[at + step]).filter(Number.isFinite)));

test('a masked star core is rebuilt from the PSF fitted to its wings', () => {
  const truth = starField(), centre = 15 * WIDTH + 15;
  for (const offsets of [[[0, 0]], [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]]) {
    const { masked, hole } = maskAt(truth, offsets, centre);
    const fit = fitPsfCore(masked, WIDTH, hole, gaussian(1.1), { rimMax: rimMaxOf(masked, hole) });
    assert.ok(fit, `fit accepted for a ${hole.length}-pixel hole`);
    const peak = fit.values[0], expected = truth[centre];
    assert.ok(Math.abs(peak - expected) / (expected - SKY) < 0.05, `peak ${peak} vs ${expected}`);
    assert.ok(Math.abs(fit.offset - SKY) < 1, `offset ${fit.offset}`);
    const filled = fillMaskedHoles(masked, WIDTH, { psf: gaussian(1.1) });
    assert.ok(Math.abs(filled[centre] - expected) / (expected - SKY) < 0.05, 'fillMaskedHoles uses the PSF fit');
  }
});

test('without a usable PSF fit the hole falls back to the rim fill', () => {
  const truth = starField(), centre = 15 * WIDTH + 15;
  const { masked, hole } = maskAt(truth, [[0, 0]], centre);
  const rim = fillMaskedHoles(masked, WIDTH);
  const flat = () => () => 1; // degenerate: amplitude and sky offset cannot be separated
  assert.equal(fitPsfCore(masked, WIDTH, hole, flat, { rimMax: rimMaxOf(masked, hole) }), null);
  assert.deepEqual(fillMaskedHoles(masked, WIDTH, { psf: flat }), rim);
  assert.ok(rim[centre] < truth[centre], 'the rim fill underestimates the peak');
});

test('holes in plain sky never call the PSF', () => {
  const values = new Float32Array(WIDTH * WIDTH).fill(SKY);
  for (let i = 0; i < values.length; i++) values[i] += 0.3 * Math.sin(i * 0.37);
  values[15 * WIDTH + 15] = NaN;
  let calls = 0;
  const psf = (...args) => { calls++; return gaussian(1)(...args); };
  const filled = fillMaskedHoles(values, WIDTH, { psf });
  assert.equal(calls, 0);
  assert.ok(Math.abs(filled[15 * WIDTH + 15] - SKY) < 0.5);
});

test('gridPsf blends the native PSF the way bilinear resampling does', () => {
  const native = () => (dx, dy) => (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 ? 1 : 0); // all light in one pixel
  const frame = { gx: 0, gy: 0, x: 100.25, y: 200, j: [1, 0, 0, 1] };
  const psf = gridPsf(native, frame)(0, 0);
  // The star sits in native pixel 100. A grid pixel a quarter-pixel away blends
  // 75% of that pixel with 25% of its empty neighbour.
  assert.ok(Math.abs(psf(-0.25, 0) - 1) < 1e-9, 'on the native pixel centre');
  assert.ok(Math.abs(psf(0, 0) - 0.75) < 1e-9, 'a quarter pixel off');
  assert.ok(Math.abs(psf(0.75, 0)) < 1e-9, 'on the empty neighbour');
  assert.equal(gridPsf(null, frame), null);
  assert.equal(gridPsf(native, null), null);
});

test('projections carry a grid-to-detector frame at native scale', () => {
  const bytes = makeFits();
  const image = prepareImage(readFits(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), { raDeg: 359.999, decDeg: 4.69 }, { fovArcmin: 1, hideBadPixels: true });
  const { psfFrame } = image.projection;
  assert.ok(psfFrame && psfFrame.j.every(Number.isFinite));
  const [a, b, c, d] = psfFrame.j;
  assert.ok(Math.abs(Math.abs(a * d - b * c) - 1) < 0.05, `scale ${a * d - b * c}`);
  assert.ok(psfFrame.x > 0 && psfFrame.y > 0);
});
