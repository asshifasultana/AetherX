// Canvas <-> sky conversion for the reprojected viewer grid.
//
// The viewer paints a north-up, east-left tangent-plane grid centred on the
// target. The renderer walks that grid pixel by pixel and asks for the sky
// position of each pixel; the marked-source overlay has to run the same
// transformation in reverse so a click lands on the sky position the user
// pointed at. Keeping one implementation here means the two cannot drift.
//
// Pure functions only: no DOM, no canvas, so the round trip is unit tested.

export const ARCSEC_PER_PIXEL = 6.15;
const DEG = Math.PI / 180;

// Canvas edge length in pixels for a field of view, matching paintCanvas.
export function canvasSizeFor(fovArcmin) {
  const size = Math.round(Number(fovArcmin) * 60 / ARCSEC_PER_PIXEL);
  return Number.isFinite(size) && size > 0 ? size : 1;
}

function scaleFor(arcsecPerPixel) {
  return (Number(arcsecPerPixel) / 3600) * DEG;
}

/**
 * Sky position of a canvas pixel on the shared grid.
 * `x` runs east-left and `y` runs north-down, matching the painted image.
 * Returns null for pixels that do not map onto the sky.
 */
export function canvasToSky({
  x, y, size, centerRaDeg, centerDecDeg, arcsecPerPixel = ARCSEC_PER_PIXEL
}) {
  if (![x, y, size, centerRaDeg, centerDecDeg, arcsecPerPixel].every(Number.isFinite)) return null;
  const scale = scaleFor(arcsecPerPixel);
  // Half-pixel centring matches the renderer exactly: the grid is sampled at
  // (size - 1) / 2, so the same convention is used in both directions.
  const xi = (size - 1) / 2 - x;
  const eta = (size - 1) / 2 - y;
  const xiRad = xi * scale;
  const etaRad = eta * scale;
  const dec0 = centerDecDeg * DEG;
  const denom = Math.cos(dec0) - etaRad * Math.sin(dec0);
  const raRad = centerRaDeg * DEG + Math.atan2(xiRad, denom);
  const decRad = Math.atan2(Math.sin(dec0) + etaRad * Math.cos(dec0), Math.hypot(denom, xiRad));
  let raDeg = raRad / DEG;
  raDeg = ((raDeg % 360) + 360) % 360;
  return { raDeg, decDeg: decRad / DEG };
}

/**
 * Canvas pixel for a sky position on the shared grid.
 * Returns null when the position is on the far side of the tangent plane.
 */
export function skyToCanvas({
  raDeg, decDeg, size, centerRaDeg, centerDecDeg, arcsecPerPixel = ARCSEC_PER_PIXEL
}) {
  if (![raDeg, decDeg, size, centerRaDeg, centerDecDeg, arcsecPerPixel].every(Number.isFinite)) return null;
  const scale = scaleFor(arcsecPerPixel);
  const dec0 = centerDecDeg * DEG;
  const dec = decDeg * DEG;
  const ra0 = centerRaDeg * DEG;
  const ra = raDeg * DEG;
  // Wrap to the shortest angular distance so a link across 0h still lands correctly.
  const dra = ((ra - ra0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const denom = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(dra);
  if (!(denom > 0)) return null;
  const xiRad = Math.cos(dec) * Math.sin(dra) / denom;
  const etaRad = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(dra)) / denom;
  return {
    x: (size - 1) / 2 - xiRad / scale,
    y: (size - 1) / 2 - etaRad / scale
  };
}

/**
 * Separation on the sky in arcseconds, used to decide whether a click landed on
 * the already-marked source.
 */
export function angularSeparationArcsec(raA, decA, raB, decB) {
  if (![raA, decA, raB, decB].every(Number.isFinite)) return Number.NaN;
  const d2r = DEG;
  const a = decA * d2r, b = decB * d2r;
  const dra = (raA - raB) * d2r;
  const cos = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dra);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / d2r * 3600;
}
