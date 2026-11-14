import test from 'node:test';
import assert from 'node:assert/strict';
import { exposureTiming, positionAt, weightedStack } from '../lib/moving-stack.js';
import { createWavelengthReader } from '../lib/wavelength.js';
import { header, pad } from './fixtures/fits-builder.js';

test('FITS date-obs is UTC and exposure duration determines the tracking midpoint', () => {
  const timing = exposureTiming({ 'DATE-OBS': '2025-08-08T17:42:35.859', EXPTIME: 120 }, {});
  assert.equal(timing.observedStartUtc, '2025-08-08T17:42:35.859Z');
  assert.ok(Math.abs((timing.midpoint - 40587) * 86400000 - Date.parse('2025-08-08T17:43:35.859Z')) < 1);
  const archive = exposureTiming({ 'DATE-BEG': '2025-08-11T17:23:58.840', 'MJD-AVG': 60898.725652763 }, {});
  assert.equal(archive.midpoint, 60898.725652763);
  assert.equal(archive.hasDuration, true);
  assert.deepEqual(positionAt([{ mjd: 1, ra: 359, dec: 0 }, { mjd: 2, ra: 1, dec: 4 }], 1.5), { raDeg: 0, decDeg: 2 });
  assert.throws(() => positionAt([{ mjd: 1, ra: 0, dec: 0 }], 2), /outside/);
});

test('variance weighting skips invalid data and rejects a large isolated outlier', () => {
  const inputs = [[2, 1], [6, 4], [NaN, 1], [3, -1]].map(([value, variance]) => ({ values: [value], variance: [variance] }));
  const weighted = weightedStack(inputs);
  assert.ok(Math.abs(weighted.values[0] - 2.8) < 1e-6);
  assert.equal(weighted.counts[0], 2);
  const clipped = weightedStack([1, 1, 1, 1, 100].map(value => ({ values: [value], variance: [1] })));
  assert.equal(clipped.values[0], 1);
  assert.equal(clipped.counts[0], 4);
});

test('WCS-WAVE reader uses detector FITS coordinates and bilinear interpolation', async () => {
  const table = Buffer.alloc(48);
  [1, 3, 1, 3].forEach((value, i) => table.writeInt32BE(value, 4 * i));
  [1, 0.1, 2, 0.1, 3, 0.1, 4, 0.1].forEach((value, i) => table.writeFloatBE(value, 16 + 4 * i));
  const bytes = Buffer.concat([Buffer.alloc(2880, 0xff), header({
    XTENSION: 'BINTABLE', EXTNAME: 'WCS-WAVE', NAXIS2: 1, TFORM1: '2J', TFORM2: '2J', TFORM3: '8E'
  }), pad(table)]);
  const read = createWavelengthReader(async () => new Response(bytes, { status: 206 }));
  assert.equal(await read('https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/test.fits', 1, 1), 2.5);
});
