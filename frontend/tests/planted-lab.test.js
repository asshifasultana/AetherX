import test from 'node:test';
import assert from 'node:assert/strict';
import { magToPeak, peakToMag, peakSigma, limitingMag, visibility, planetShift, plantInto, decodePlane } from '../lib/planted-lab.js';

test('one magnitude fainter is 2.512 times dimmer, and peakToMag inverts magToPeak', () => {
  const ratio = magToPeak(18) / magToPeak(19);
  assert.ok(Math.abs(ratio - 10 ** 0.4) < 1e-9);
  assert.ok(Math.abs(peakToMag(magToPeak(20.3)) - 20.3) < 1e-9);
  assert.ok(magToPeak(15) > magToPeak(16));
});

test('the limiting magnitude is where the planted peak reaches the requested sigma', () => {
  const noise = 0.02, limit = limitingMag(noise, 5);
  assert.ok(Math.abs(peakSigma(magToPeak(limit), noise) - 5) < 1e-9);
  assert.equal(visibility(12).id, 'obvious');
  assert.equal(visibility(6).id, 'findable');
  assert.equal(visibility(4).id, 'lost');
  assert.equal(visibility(1).id, 'invisible');
});

test('the blink shift shrinks with distance and vanishes for one date', () => {
  const at = { raDeg: 60, decDeg: 15, fromMjd: 61300, toMjd: 61304.4 };
  const near = planetShift({ ...at, distanceAu: 100 }), far = planetShift({ ...at, distanceAu: 1000 });
  assert.ok(near.arcsec > 0);
  assert.ok(Math.abs(near.arcsec / far.arcsec - 10) < 0.2, `${near.arcsec} vs ${far.arcsec}`);
  assert.ok(Math.abs(Math.hypot(near.dx, near.dy) - near.pixels) < 1e-9);
  assert.equal(planetShift({ ...at, toMjd: at.fromMjd, distanceAu: 500 }).arcsec, 0);
});

test('planting adds the peak at the centre and leaves the input untouched', () => {
  const values = new Float32Array(15 * 15).fill(1);
  const planted = plantInto(values, 15, { x: 7, y: 7 }, 10);
  assert.equal(values[7 * 15 + 7], 1);
  assert.ok(Math.abs(planted[7 * 15 + 7] - 11) < 1e-6);
  assert.ok(planted[7 * 15 + 8] < planted[7 * 15 + 7] && planted[7 * 15 + 8] > 1);
  assert.equal(planted[0], 1);
});

test('baked planes decode from base64 float32', () => {
  const source = new Float32Array([1.5, -2, NaN]);
  const decoded = decodePlane(Buffer.from(source.buffer).toString('base64'));
  assert.equal(decoded[0], 1.5); assert.equal(decoded[1], -2); assert.ok(Number.isNaN(decoded[2]));
});
