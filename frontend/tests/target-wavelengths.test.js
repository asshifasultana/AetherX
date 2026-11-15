import test from 'node:test';
import assert from 'node:assert/strict';
import { createTargetWavelengths } from '../lib/target-wavelengths.js';

// A 100×100 TAN image centred on (10°, 5°) with 6.15″ pixels.
const header = { NAXIS1: 100, NAXIS2: 100, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 10, CRVAL2: 5, CRPIX1: 50.5, CRPIX2: 50.5, CD1_1: -6.15 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 6.15 / 3600 };
const observations = Array.from({ length: 10 }, (_, i) => ({ accessUrl: `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/e${i}.fits`, detector: 4 }));

test('looks up the wavelength at the pixel the WCS puts the position on, a few at a time', async () => {
  const pixels = [];
  let active = 0, peak = 0;
  const lookups = createTargetWavelengths({
    concurrency: 3,
    readImageHeader: async url => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return url.endsWith('e9.fits') ? { ...header, CRVAL1: 40 } : header; },
    wavelengthAt: async (url, x, y) => { pixels.push([x, y]); return 2.5 + Number(url.match(/e(\d)/)[1]) / 100; }
  });
  const progress = [];
  const result = await lookups.lookup(observations, { raDeg: 10, decDeg: 5 }, { onProgress: p => progress.push(p) });
  assert.equal(result.size, 9); assert.equal(result.failed, 1);
  assert.equal(result.get(observations[3].accessUrl), 2.53);
  assert.ok(peak <= 3 && peak >= 2);
  assert.ok(pixels.every(([x, y]) => Math.abs(x - 49.5) < 1e-6 && Math.abs(y - 49.5) < 1e-6));
  assert.deepEqual(progress.at(-1), { done: 10, failed: 1, total: 10 });
});

test('results are cached per exposure and position; aborts stop the run', async () => {
  let reads = 0;
  const lookups = createTargetWavelengths({ readImageHeader: async () => { reads++; return header; }, wavelengthAt: async () => 1.2 });
  await lookups.lookup(observations, { raDeg: 10, decDeg: 5 });
  await lookups.lookup(observations, { raDeg: 10, decDeg: 5 });
  assert.equal(reads, 10);
  await lookups.lookup(observations.slice(0, 2), { raDeg: 10.001, decDeg: 5 });
  assert.equal(reads, 12);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(lookups.lookup(observations, { raDeg: 9, decDeg: 5 }, { signal: controller.signal }));
});

test('positionFor lets each exposure use its own position; bad wavelengths are failures', async () => {
  const lookups = createTargetWavelengths({ readImageHeader: async () => header, wavelengthAt: async (url, x) => x > 60 ? Number.NaN : 3 });
  const result = await lookups.lookup(observations.slice(0, 2), { raDeg: 10, decDeg: 5 }, { positionFor: observation => observation === observations[1] ? { raDeg: 10 - 20 * 6.15 / 3600, decDeg: 5 } : { raDeg: 10, decDeg: 5 } });
  assert.equal(result.size, 1); assert.equal(result.failed, 1);
});
