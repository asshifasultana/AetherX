import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotList, spotRadius, MIN_SPOT_RADIUS_ARCSEC, MAX_SPOT_RADIUS_ARCSEC } from '../lib/spots.js';
import { encodeViewState, decodeViewState, viewStateSignature } from '../url-state.js';
import { validateToolCall } from '../lib/agent-tools.js';

test('spots are points by default and can become areas and back', () => {
  const list = createSpotList();
  const point = list.add({ raDeg: 10, decDeg: 5 });
  assert.equal(point.radiusArcsec, null);
  const area = list.add({ raDeg: 11, decDeg: 5, radiusArcsec: 120.4 });
  assert.equal(area.radiusArcsec, 120);
  assert.equal(list.resize(point.n, 60).radiusArcsec, 60);
  assert.equal(list.resize(area.n, 0).radiusArcsec, null);
  assert.equal(list.resize(42, 60), null);
});

test('moving a spot keeps its number, size and origin', () => {
  const list = createSpotList();
  const area = list.add({ raDeg: 11, decDeg: 5, radiusArcsec: 120 }, { origin: 'agent', label: 'region' });
  assert.deepEqual(list.move(area.n, { raDeg: 361, decDeg: 6 }), { ...area, raDeg: 1, decDeg: 6 });
  assert.equal(list.move(area.n, { raDeg: 1, decDeg: 95 }), null);
  assert.equal(list.move(7, { raDeg: 1, decDeg: 6 }), null);
});

test('spot radii are clamped to one pixel and half the widest field', () => {
  assert.equal(spotRadius(1), MIN_SPOT_RADIUS_ARCSEC);
  assert.equal(spotRadius(99999), MAX_SPOT_RADIUS_ARCSEC);
  assert.equal(spotRadius(null), null);
  assert.equal(spotRadius('abc'), null);
  assert.equal(spotRadius(-5), null);
});

test('share links round-trip area spots and stay short for points', () => {
  const state = { markRaDeg: 10, markDecDeg: 5, markRadiusArcsec: 90, extraSpots: [{ raDeg: 11, decDeg: 6 }, { raDeg: 12, decDeg: 7, radiusArcsec: 300 }] };
  const query = encodeViewState(state);
  assert.match(query, /mr=90/);
  assert.match(query, /spots=11%2C6%3B12%2C7%2C300/);
  const { state: decoded, issues } = decodeViewState(query);
  assert.equal(issues.length, 0);
  assert.equal(decoded.markRadiusArcsec, 90);
  assert.deepEqual(decoded.extraSpots, [{ raDeg: 11, decDeg: 6 }, { raDeg: 12, decDeg: 7, radiusArcsec: 300 }]);
  assert.doesNotMatch(encodeViewState({ markRaDeg: 10, markDecDeg: 5 }), /mr=/);
  assert.notEqual(viewStateSignature({ ...state, markRadiusArcsec: 91 }), viewStateSignature(state));
});

test('a bad area size in a link falls back to a point and is reported', () => {
  const { state, issues } = decodeViewState('mra=10&mdec=5&mr=wide');
  assert.equal(state.markRaDeg, 10);
  assert.equal(state.markRadiusArcsec, null);
  assert.equal(issues.length, 1);
});

test('the guide can mark areas and resize spots within limits', () => {
  assert.equal(validateToolCall('mark_spot', { raDeg: 1, decDeg: 2 }).args.radiusArcsec, undefined);
  assert.equal(validateToolCall('mark_spot', { raDeg: 1, decDeg: 2, radius_arcsec: 240 }).args.radiusArcsec, 240);
  assert.equal(validateToolCall('mark_spot', { raDeg: 1, decDeg: 2, radius_arcsec: 5000 }).ok, false);
  assert.deepEqual(validateToolCall('resize_spot', { spot: 2, radius_arcsec: 60 }).args, { spot: 2, radiusArcsec: 60 });
  assert.deepEqual(validateToolCall('resize_spot', { spot: 2, radius_arcsec: 0 }).args, { spot: 2, radiusArcsec: null });
  assert.equal(validateToolCall('resize_spot', { spot: 12, radius_arcsec: 60 }).ok, false);
});

import { measureAt, apertureFor, circleOverlap } from '../lib/photometry.js';
import { encodeCrop } from '../api/crop.js';
import { DEFAULT_MASK_BITS } from '../lib/pixel-quality.js';
import { createCase, applyEvidence, summarize, createCaseBook } from '../lib/case-file.js';

// A flat 1 MJy/sr sky with a uniform +2 disc of radius 10 pixels in the middle.
function discCrop({ maskEvery = 0 } = {}) {
  const size = 200, center = 100, values = new Float32Array(size * size).fill(1), flags = new Uint32Array(size * size), variance = new Float32Array(size * size).fill(0.01);
  const bit = DEFAULT_MASK_BITS & -DEFAULT_MASK_BITS;
  let inside = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (Math.hypot(x - center, y - center) > 10) continue;
    values[y * size + x] = 3; inside++;
    if (maskEvery && inside % maskEvery === 0) flags[y * size + x] = bit;
  }
  const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 10, CRVAL2: 5, CRPIX1: center + 1, CRPIX2: center + 1, CD1_1: -6.15 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 6.15 / 3600, BUNIT: 'MJy/sr' };
  return { image: { values, flags, variance, width: size, height: size, header, sourceX: 0, sourceY: 0 }, inside };
}
const serve = (image, seen = []) => async url => { seen.push(new URL(url, 'http://x').searchParams.get('fovArcmin')); const bytes = encodeCrop(image); return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; };
const observation = { accessUrl: 'https://irsa.ipac.caltech.edu/x.fits', detector: 1, observedStartUtc: '2025-08-21T00:00:00Z' };
const position = { raDeg: 10, decDeg: 5 };

test('a point keeps the small aperture and crop; an area grows both', () => {
  assert.deepEqual(apertureFor(null), { area: false, radius: 1.5, inner: 4.5, outer: 8, fovArcmin: 3 });
  const area = apertureFor(61.5);
  assert.equal(area.radius, 10); assert.equal(area.inner, 15); assert.equal(area.outer, 20);
  assert.equal(apertureFor(900).fovArcmin, 30);
});

test('an area measures the total light inside the circle above the local sky', async () => {
  const { image, inside } = discCrop(), seen = [];
  const point = await measureAt(observation, position, null, { wavelength: false, fetchImpl: serve(image, seen) });
  const area = await measureAt(observation, position, null, { wavelength: false, radiusArcsec: 61.5, fetchImpl: serve(image, seen) });
  assert.deepEqual(seen, ['3', '5']);
  assert.equal(area.pixelsUsed, inside); assert.equal(area.areaCoverage, 1); assert.equal(area.radiusArcsec, 61.5);
  assert.equal(point.pixelsUsed, 9);
  // Every disc pixel is 2 MJy/sr above the sky ring; one pixel is 6.15″ square.
  const expected = inside * 2 * 1e12 * (6.15 / 3600 * Math.PI / 180) ** 2;
  assert.ok(Math.abs(area.fluxMicroJy / expected - 1) < 1e-4, `${area.fluxMicroJy} vs ${expected}`);
  assert.ok(area.snr > 10);
});

test('masked pixels inside an area are filled, and a mostly masked area is refused', async () => {
  const full = await measureAt(observation, position, null, { wavelength: false, radiusArcsec: 61.5, fetchImpl: serve(discCrop().image) });
  const holed = await measureAt(observation, position, null, { wavelength: false, radiusArcsec: 61.5, fetchImpl: serve(discCrop({ maskEvery: 5 }).image) });
  assert.ok(holed.areaCoverage < 1 && holed.areaCoverage > 0.75);
  assert.ok(Math.abs(holed.fluxMicroJy / full.fluxMicroJy - 1) < 1e-6);
  await assert.rejects(measureAt(observation, position, null, { wavelength: false, radiusArcsec: 61.5, fetchImpl: serve(discCrop({ maskEvery: 1 }).image) }), /Too few|usable pixels/);
});

// A star about one pixel wide (σ 0.55 px, total 100 MJy/sr·px) on a flat sky,
// with the measured sky position falling (fx, fy) pixels off a pixel centre.
function starCrop(fx, fy) {
  const size = 41, center = 20, sigma = 0.55, steps = 9;
  const values = new Float32Array(size * size).fill(1), flags = new Uint32Array(size * size), variance = new Float32Array(size * size).fill(1e-4);
  for (let y = center - 6; y <= center + 6; y++) for (let x = center - 6; x <= center + 6; x++) {
    let sum = 0;
    for (let j = 0; j < steps; j++) for (let i = 0; i < steps; i++) {
      const dx = x + (i + 0.5) / steps - 0.5 - (center + fx), dy = y + (j + 0.5) / steps - 0.5 - (center + fy);
      sum += Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
    values[y * size + x] += 100 * sum / steps ** 2 / (2 * Math.PI * sigma * sigma);
  }
  const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 10, CRVAL2: 5, CRPIX1: center + 1 + fx, CRPIX2: center + 1 + fy, CD1_1: -6.15 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 6.15 / 3600, BUNIT: 'MJy/sr' };
  return { values, flags, variance, width: size, height: size, header, sourceX: 0, sourceY: 0 };
}

test('the aperture edge counts pixels by the fraction inside the circle', () => {
  assert.equal(circleOverlap(0, 0, 1.5), 1);
  assert.equal(circleOverlap(3, 0, 1.5), 0);
  const corner = circleOverlap(1, 1, 1.5);
  assert.ok(corner > 0.4 && corner < 0.7, `corner pixel ${corner}`);
  // The shares of every pixel add up to the area of the circle.
  let area = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) area += circleOverlap(dx + 0.3, dy - 0.4, 1.5);
  assert.ok(Math.abs(area / (Math.PI * 1.5 ** 2) - 1) < 0.02, `area ${area}`);
});

test('a point is measured where the source is, not at the nearest pixel centre', async () => {
  const fluxes = [];
  for (const [fx, fy] of [[0, 0], [0.25, 0], [0.49, 0], [0.49, 0.49], [0.3, -0.4], [-0.2, 0.45]]) {
    fluxes.push((await measureAt(observation, position, null, { wavelength: false, fetchImpl: serve(starCrop(fx, fy)) })).fluxMicroJy);
  }
  const mean = fluxes.reduce((sum, value) => sum + value, 0) / fluxes.length;
  // The same star reads the same wherever it falls on the pixel grid; snapping
  // the aperture to a whole pixel spreads these by more than 5%.
  assert.ok((Math.max(...fluxes) - Math.min(...fluxes)) / mean < 0.03, fluxes.join(', '));
  // A 1.5-pixel circle holds about 91% of this star.
  const total = 100 * 1e12 * (6.15 / 3600 * Math.PI / 180) ** 2;
  assert.ok(mean / total > 0.88 && mean / total < 0.95, `${mean / total}`);
});

test('an area case file lists what is inside and never rules suspects', () => {
  const file = createCase({ n: 1, raDeg: 10, decDeg: 5, radiusArcsec: 120 });
  assert.equal(summarize(file).verdict.label, 'area');
  assert.deepEqual(summarize(file).verdict.next, ['crossmatch', 'measure_source']);
  const stars = { ok: true, gaia: { starsInside: 3, brightest: [{ gMag: 9.2 }], fastMovingCount: 1 }, jpl: { checked: true, date: '2025-08-21', objectsInside: 1, objects: [{ name: '433 Eros' }] } };
  applyEvidence(file, 'crossmatch', stars);
  applyEvidence(file, 'crossmatch', { ...stars, gaia: { starsInside: 4, brightest: [{ gMag: 9.2 }], fastMovingCount: 0 } });
  applyEvidence(file, 'measure_source', { ok: true, measurements: [1, 2, 3].map(day => ({ date: `2025-08-0${day}`, snr: 20 })), variabilitySigma: 1.4 });
  const summary = summarize(file);
  assert.equal(summary.verdict.label, 'area'); assert.equal(summary.verdict.next, undefined);
  assert.deepEqual(summary.suspects, []);
  assert.deepEqual(summary.findings, ['4 Gaia stars (G ≤ 18) inside; the brightest is G 9.2.', 'JPL lists 1 known asteroid or comet inside on 2025-08-21: 433 Eros.', 'The total brightness inside is steady within 1.4σ across 3 dates.']);
  const book = createCaseBook(), first = book.ensure({ n: 1, raDeg: 10, decDeg: 5, radiusArcsec: 120 });
  assert.notEqual(book.ensure({ n: 1, raDeg: 10, decDeg: 5, radiusArcsec: 240 }), first, 'resizing starts a fresh case');
});

test('a spot is identified once its checks find a known object, and moving or resizing clears it', () => {
  const list = createSpotList();
  const spot = list.add({ raDeg: 10, decDeg: 5 });
  assert.equal(spot.found, false);
  assert.equal(list.setFound(spot.n, true).found, true);
  assert.equal(list.move(spot.n, { raDeg: 10.1, decDeg: 5 }).found, false);
  list.setFound(spot.n, true);
  assert.equal(list.resize(spot.n, 60).found, false);
  assert.equal(list.setFound(42, true), null);
});

test('a point flags itself as likely saturated when its aperture holds near-saturated or nonlinear pixels', async () => {
  const clean = await measureAt(observation, position, null, { wavelength: false, fetchImpl: serve(discCrop().image) });
  assert.equal(clean.likelySaturated, false);
  assert.deepEqual(clean.saturation, { overflowPixels: 0, nonlinearPixels: 0, lostCoreFraction: 0 });
  const { image } = discCrop();
  image.flags[100 * 200 + 100] = (1 << 1) | (1 << 15); // OVERFLOW + NONLINEAR at the centre: kept, but flagged
  const hot = await measureAt(observation, position, null, { wavelength: false, fetchImpl: serve(image) });
  assert.equal(hot.likelySaturated, true);
  assert.equal(hot.saturation.overflowPixels, 1); assert.equal(hot.saturation.nonlinearPixels, 1);
  assert.equal(hot.pixelsUsed, clean.pixelsUsed);
  // Flags in the background ring do not count.
  const ring = discCrop().image;
  ring.flags[100 * 200 + 106] = 1 << 1;
  assert.equal((await measureAt(observation, position, null, { wavelength: false, fetchImpl: serve(ring) })).likelySaturated, false);
});
