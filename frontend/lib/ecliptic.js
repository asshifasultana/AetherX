// Ecliptic coordinates, Earth's position and the yearly parallax of distant
// bodies. Low-precision formulas (Astronomical Almanac solar position, about
// 0.01° accuracy) are ample for predicting where a body hundreds of AU away
// would appear six months later. Pure and DOM-free.

const RAD = Math.PI / 180;
export const OBLIQUITY_DEG = 23.4392911;
const MJD_J2000 = 51544.5;

const unit = (raDeg, decDeg) => {
  const ra = raDeg * RAD, dec = decDeg * RAD;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
};
const toRaDec = ([x, y, z]) => {
  const r = Math.hypot(x, y, z);
  return { raDeg: ((Math.atan2(y, x) / RAD) + 360) % 360, decDeg: Math.asin(z / r) / RAD };
};

export function equatorialToEcliptic(raDeg, decDeg) {
  const [x, y, z] = unit(raDeg, decDeg), e = OBLIQUITY_DEG * RAD;
  const ye = y * Math.cos(e) + z * Math.sin(e), ze = -y * Math.sin(e) + z * Math.cos(e);
  const { raDeg: lonDeg, decDeg: latDeg } = toRaDec([x, ye, ze]);
  return { lonDeg, latDeg };
}

export function eclipticToEquatorial(lonDeg, latDeg) {
  const [x, y, z] = unit(lonDeg, latDeg), e = OBLIQUITY_DEG * RAD;
  return toRaDec([x, y * Math.cos(e) - z * Math.sin(e), y * Math.sin(e) + z * Math.cos(e)]);
}

/** Earth's heliocentric position in AU, equatorial (ICRS-aligned) axes. */
export function earthHeliocentric(mjd) {
  const n = mjd - MJD_J2000;
  const L = (280.460 + 0.9856474 * n) * RAD, g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  // The Sun's geocentric direction, reversed, is Earth's heliocentric one.
  const x = -R * Math.cos(lambda), y = -R * Math.sin(lambda), e = OBLIQUITY_DEG * RAD;
  return [x, y * Math.cos(e), y * Math.sin(e)];
}

/** Angle between the Sun and a sky position seen from Earth, in degrees. */
export function solarElongationDeg(raDeg, decDeg, mjd) {
  const earth = earthHeliocentric(mjd), sun = earth.map(value => -value), target = unit(raDeg, decDeg);
  const dot = (sun[0] * target[0] + sun[1] * target[1] + sun[2] * target[2]) / Math.hypot(...sun);
  return Math.acos(Math.max(-1, Math.min(1, dot))) / RAD;
}

export function separationArcsec(a, b) {
  const [x1, y1, z1] = unit(a.raDeg, a.decDeg), [x2, y2, z2] = unit(b.raDeg, b.decDeg);
  return Math.acos(Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2))) / RAD * 3600;
}

/**
 * Where a body seen at (raDeg, decDeg) on fromMjd, at distanceAu from Earth,
 * appears on toMjd if it stays put in space. Orbital motion is ignored, which
 * is a small error beyond about 100 AU (Planet Nine would move well under a
 * degree a year), so the shift is Earth's own change of viewpoint.
 */
export function parallaxShift({ raDeg, decDeg, distanceAu, fromMjd, toMjd }) {
  const direction = unit(raDeg, decDeg), earthFrom = earthHeliocentric(fromMjd), earthTo = earthHeliocentric(toMjd);
  const body = earthFrom.map((value, index) => value + distanceAu * direction[index]);
  const predicted = toRaDec(body.map((value, index) => value - earthTo[index]));
  const offsetArcsec = separationArcsec({ raDeg, decDeg }, predicted);
  const dRa = ((predicted.raDeg - raDeg + 540) % 360 - 180) * Math.cos(decDeg * RAD), dDec = predicted.decDeg - decDeg;
  const directionDeg = ((Math.atan2(dRa, dDec) / RAD) + 360) % 360;
  return { ...predicted, offsetArcsec, offsetArcmin: offsetArcsec / 60, positionAngleDeg: directionDeg };
}
