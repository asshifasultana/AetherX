import test from 'node:test';
import assert from 'node:assert/strict';
import { binSpectrum, binsToCsv } from '../lib/spectrum-bins.js';
import { assessSaturation } from '../lib/photometry.js';
import { DETECTOR_CHANNELS } from '../lib/detectors.js';

const sample = (detector, wavelengthUm, fluxMicroJy, extra = {}) => ({ detector, wavelengthUm, fluxMicroJy, errorMicroJy: 1, ...extra });

test('points fall into their detector channel and give a median per channel', () => {
  const centre = DETECTOR_CHANNELS[3][8];
  const bins = binSpectrum([sample(4, centre, 10), sample(4, centre + 0.001, 12), sample(4, centre - 0.001, 100), sample(1, 0.75, 5)]);
  assert.equal(bins.length, 2);
  assert.deepEqual(bins.map(bin => [bin.detector, bin.channel, bin.n]), [[1, 0, 1], [4, 8, 3]]);
  assert.equal(bins[1].fluxMicroJy, 12);
  assert.equal(bins[1].centreUm, centre);
  // Robust error: MAD of [10, 12, 100] is 2, so 1.2533 × 1.4826 × 2 / √3.
  assert.ok(Math.abs(bins[1].errorMicroJy - 1.2533 * 1.4826 * 2 / Math.sqrt(3)) < 1e-9);
  // One point: its own error.
  assert.equal(bins[0].errorMicroJy, 1);
});

test('likely-saturated points are left out of the median unless asked for', () => {
  const centre = DETECTOR_CHANNELS[1][3];
  const points = [sample(2, centre, 50), sample(2, centre, 52), sample(2, centre, 5, { likelySaturated: true })];
  const [bin] = binSpectrum(points);
  assert.equal(bin.n, 2); assert.equal(bin.saturatedCount, 1); assert.equal(bin.fluxMicroJy, 51);
  assert.equal(binSpectrum(points, { includeSaturated: true })[0].fluxMicroJy, 50);
  const [onlySaturated] = binSpectrum([sample(2, centre, 5, { likelySaturated: true })]);
  assert.equal(onlySaturated.n, 0); assert.ok(Number.isNaN(onlySaturated.fluxMicroJy));
});

test('points outside every channel or without numbers are ignored; CSV has one row per bin', () => {
  const bins = binSpectrum([sample(1, 3.3, 1), sample(4, Number.NaN, 1), sample(9, 1, 1), sample(6, 4.7, 2)]);
  assert.equal(bins.length, 1);
  const csv = binsToCsv(bins, { target: 'Star "A"' }).split('\r\n');
  assert.equal(csv.length, 2);
  assert.match(csv[0], /^target,detector,channel/);
  assert.match(csv[1], /^"Star ""A""",6,/);
});

test('saturation rule: any near-saturated or nonlinear aperture pixel, or a mostly lost core', () => {
  assert.equal(assessSaturation({}), false);
  assert.equal(assessSaturation({ overflowPixels: 1 }), true);
  assert.equal(assessSaturation({ nonlinearPixels: 2 }), true);
  assert.equal(assessSaturation({ lostCoreFraction: 0.2 }), false);
  assert.equal(assessSaturation({ lostCoreFraction: 0.35 }), true);
});
