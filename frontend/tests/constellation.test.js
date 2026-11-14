import test from 'node:test';
import assert from 'node:assert/strict';
import { constellationAt, constellationAbbreviation, precessToB1875, CONSTELLATION_NAMES } from '../lib/constellation.js';
import { distanceLabel, distanceLightYears } from '../lib/distance.js';

test('constellations of well-known ICRS positions', () => {
  for (const [name, raDeg, decDeg, expected] of [
    ["Barnard's Star", 269.4521, 4.6934, 'Ophiuchus'],
    ['Polaris', 37.954, 89.264, 'Ursa Minor'],
    ['Sirius', 101.287155, -16.716116, 'Canis Major'],
    ['Betelgeuse', 88.7929, 7.4071, 'Orion'],
    ['M31', 10.6847, 41.269, 'Andromeda'],
    ['Epsilon Indi B', 331.0441, -56.7828, 'Indus'],
    ['WISE 0855', 133.7951, -7.2451, 'Hydra'],
    ['R Draconis', 248.1676, 66.755, 'Draco'],
    ['south celestial pole', 0, -89.9, 'Octans']
  ]) assert.equal(constellationAt(raDeg, decDeg), expected, name);
});

test('constellation lookup covers all 88 and rejects invalid positions', () => {
  assert.equal(Object.keys(CONSTELLATION_NAMES).length, 88);
  assert.equal(constellationAbbreviation(360 + 101.287155, -16.716116), 'CMa');
  assert.equal(constellationAt(NaN, 0), null);
  assert.equal(constellationAt(10, 91), null);
});

test('precession to B1875 moves J2000 positions by about 1.6 degrees in RA near the equator', () => {
  const p = precessToB1875(0, 0);
  assert.ok(Math.abs(p.raDeg - (360 - 1.60)) < 0.02, `ra ${p.raDeg}`);
  assert.ok(Math.abs(p.decDeg + 0.70) < 0.05, `dec ${p.decDeg}`);
});

test('distance labels use parallax, then a cautious redshift estimate, else nothing', () => {
  assert.equal(distanceLabel({ parallaxMas: 379.21, parallaxErrorMas: 1.58 }), '8.6 light-years');
  assert.equal(distanceLabel({ parallaxMas: 546.9759 }), '5.96 light-years');
  assert.equal(distanceLabel({ parallaxMas: 1.2509, parallaxErrorMas: 0.0648 }), '2,610 light-years');
  assert.equal(distanceLabel({ redshift: 0.0158 }), '≈ 221 million light-years');
  assert.equal(distanceLabel({ redshift: 0.05 }), '≈ 698 million light-years');
  // Blueshifted or very nearby galaxies are dominated by their own motion.
  assert.equal(distanceLabel({ redshift: -0.001 }), null);
  assert.equal(distanceLabel({ redshift: 0.002 }), null);
  assert.equal(distanceLabel({ redshift: 0.5 }), null);
  // An uncertain parallax gives no distance rather than a wrong one.
  assert.equal(distanceLabel({ parallaxMas: 0.5, parallaxErrorMas: 0.4 }), null);
  assert.equal(distanceLabel({ parallaxMas: -1 }), null);
  assert.equal(distanceLabel({}), null);
  assert.equal(distanceLightYears({ parallaxMas: 1000 }).lightYears.toFixed(3), '3.262');
});
