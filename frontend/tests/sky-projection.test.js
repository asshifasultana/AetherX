import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCSEC_PER_PIXEL, angularSeparationArcsec, canvasSizeFor, canvasToSky, skyToCanvas
} from '../sky-projection.js';

const grid = { size: 157, centerRaDeg: 133.79512916666666, centerDecDeg: -7.245147222222222 };

test('canvas size follows the field of view at the SPHEREx pixel scale', () => {
  assert.equal(canvasSizeFor(16), Math.round(16 * 60 / ARCSEC_PER_PIXEL));
  assert.equal(canvasSizeFor(5), 49);
  assert.equal(canvasSizeFor(0), 1);
  assert.equal(canvasSizeFor(Number.NaN), 1);
});

test('the centre pixel maps to the centre of the sky grid', () => {
  const middle = (grid.size - 1) / 2;
  const sky = canvasToSky({ x: middle, y: middle, ...grid });
  assert.ok(Math.abs(sky.raDeg - grid.centerRaDeg) < 1e-9, `RA ${sky.raDeg}`);
  assert.ok(Math.abs(sky.decDeg - grid.centerDecDeg) < 1e-9, `Dec ${sky.decDeg}`);
});

test('pixel to sky to pixel round-trips across the whole canvas', () => {
  for (let x = 0; x < grid.size; x += 6) {
    for (let y = 0; y < grid.size; y += 6) {
      const sky = canvasToSky({ x, y, ...grid });
      assert.ok(sky, `no sky position for ${x},${y}`);
      const back = skyToCanvas({ ...sky, ...grid });
      assert.ok(back, `no pixel for ${x},${y}`);
      assert.ok(Math.abs(back.x - x) < 1e-6, `x ${x} -> ${back.x}`);
      assert.ok(Math.abs(back.y - y) < 1e-6, `y ${y} -> ${back.y}`);
    }
  }
});

test('pixels east of centre have lower right ascension in the east-left grid', () => {
  const middle = (grid.size - 1) / 2;
  const right = canvasToSky({ x: middle + 20, y: middle, ...grid });
  const left = canvasToSky({ x: middle - 20, y: middle, ...grid });
  assert.ok(right.raDeg < left.raDeg, 'the grid is east-left, so +x moves west');
});

test('pixels below centre have lower declination in the north-up grid', () => {
  const middle = (grid.size - 1) / 2;
  const down = canvasToSky({ x: middle, y: middle + 20, ...grid });
  assert.ok(down.decDeg < grid.centerDecDeg, 'the grid is north-up, so +y moves south');
});

test('the pixel scale matches the requested field of view', () => {
  const middle = (grid.size - 1) / 2;
  const edge = canvasToSky({ x: middle + 10, y: middle, ...grid });
  const separation = angularSeparationArcsec(edge.raDeg, edge.decDeg, grid.centerRaDeg, grid.centerDecDeg);
  // Ten pixels east should be ten pixels of sky, within the small-angle term.
  assert.ok(Math.abs(separation - 10 * ARCSEC_PER_PIXEL) < 0.5, `separation ${separation}`);
});

test('a marked source off the edge still converts but lands outside the canvas', () => {
  const sky = canvasToSky({ x: 0, y: 0, ...grid });
  const back = skyToCanvas({ ...sky, ...grid });
  assert.ok(back.x > -1 && back.x < 1);
  const faraway = skyToCanvas({ raDeg: grid.centerRaDeg + 40, decDeg: grid.centerDecDeg, ...grid });
  assert.ok(faraway === null || faraway.x < 0 || faraway.y < 0 || faraway.x > grid.size);
});

test('right ascension wraparound near 0h does not jump across the sky', () => {
  const wrapped = { size: 101, centerRaDeg: 0.001, centerDecDeg: 0 };
  const sky = canvasToSky({ x: 50, y: 50, ...wrapped });
  const back = skyToCanvas({ ...sky, ...wrapped });
  assert.ok(Math.abs(back.x - 50) < 1e-6);
  const across = skyToCanvas({ raDeg: 359.999, decDeg: 0, ...wrapped });
  assert.ok(across.x > 50, 'a position just below 0h sits east of centre');
});

test('invalid input yields null instead of NaN coordinates', () => {
  assert.equal(canvasToSky({ x: Number.NaN, y: 5, ...grid }), null);
  assert.equal(canvasToSky({ x: 5, y: 5, size: 101, centerRaDeg: 10, centerDecDeg: Number.NaN }), null);
  assert.equal(skyToCanvas({ raDeg: 10, decDeg: 90, ...grid }), null);
  assert.equal(angularSeparationArcsec(1, Number.NaN, 2, 3), Number.NaN);
});

test('separation is symmetric and zero for identical positions', () => {
  assert.equal(angularSeparationArcsec(10, 20, 10, 20), 0);
  const a = angularSeparationArcsec(10, 20, 11, 21);
  const b = angularSeparationArcsec(11, 21, 10, 20);
  assert.ok(Math.abs(a - b) < 1e-9);
  assert.ok(a > 0);
});
