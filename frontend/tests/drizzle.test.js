import test from 'node:test';
import assert from 'node:assert/strict';
import { matrixFor, PIXEL_ARCSEC } from '../lib/fits-engine.js';
import { drizzleExposure, drizzleStack } from '../../scripts/fixed-stack-drizzle.mjs';

test('aligned Drizzle keeps a masked core empty and uses other exposures to fill it', () => {
  const pointing = { raDeg: 359.999, decDeg: 4.69 };
  const header = {
    CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: pointing.raDeg, CRVAL2: pointing.decDeg,
    CRPIX1: 3, CRPIX2: 3, CD1_1: -PIXEL_ARCSEC / 3600, CD2_2: -PIXEL_ARCSEC / 3600,
    CD1_2: 0, CD2_1: 0,
  };
  const image = { width: 5, height: 5, values: new Float32Array(25).fill(10),
    flags: new Uint32Array(25), header, matrix: matrixFor(header) };
  image.flags[12] = 1 << 9;
  image.values[12] = 1e6;
  const masked = drizzleExposure(image, pointing, 2, 5);
  assert.ok(Number.isNaN(drizzleStack([masked]).values[12]));
  image.flags[12] = 0;
  image.values[12] = 18;
  const clear = drizzleExposure(image, pointing, 2, 5);
  const stack = drizzleStack([masked, clear]);
  assert.equal(stack.values[12], 16);
  assert.equal(stack.counts[12], 1);
  assert.equal(stack.values[13], 8);
  assert.equal(stack.counts[13], 2);
});
