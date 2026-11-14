import { projectSkyToPixel } from './fits-engine.js';

export const ARCSEC_PER_PIXEL = 6.15;

export function offsetTarget(target, east, north) {
  const ra = target.raDeg + east * ARCSEC_PER_PIXEL / (3600 * Math.cos(target.decDeg * Math.PI / 180));
  return { raDeg: (ra + 360) % 360, decDeg: target.decDeg + north * ARCSEC_PER_PIXEL / 3600 };
}

export function profileValue(east, north, shape) {
  const { scale = 1, radius = 5, axisRatio = 1, angle = 0 } = shape;
  const c = Math.cos(angle), s = Math.sin(angle);
  const along = east * c + north * s, across = (-east * s + north * c) / axisRatio;
  const r = Math.hypot(along, across);
  return r <= radius ? 1 / (1 + (r / scale) ** 2) : 0;
}

export function injectProfile(image, target, scenario) {
  const shifted = offsetTarget(target, scenario.east ?? 0, scenario.north ?? 0);
  const center = projectSkyToPixel(image, shifted.raDeg, shifted.decDeg);
  const east = offsetTarget(shifted, 1, 0), north = offsetTarget(shifted, 0, 1);
  const pe = projectSkyToPixel(image, east.raDeg, east.decDeg), pn = projectSkyToPixel(image, north.raDeg, north.decDeg);
  if (!center || !pe || !pn) return image;
  const [x, y] = center;
  const a = pe[0] - x, b = pn[0] - x, c = pe[1] - y, d = pn[1] - y, determinant = a * d - b * c;
  const extent = (scenario.radius ?? 5) * Math.max(Math.hypot(a, b), Math.hypot(c, d));
  const values = image.values.slice();
  for (let row = Math.max(0, Math.floor(y - extent)); row <= Math.min(image.height - 1, Math.ceil(y + extent)); row++) {
    for (let col = Math.max(0, Math.floor(x - extent)); col <= Math.min(image.width - 1, Math.ceil(x + extent)); col++) {
      const u = (d * (col - x) - b * (row - y)) / determinant, v = (a * (row - y) - c * (col - x)) / determinant;
      values[row * image.width + col] += scenario.amplitude * profileValue(u, v, scenario);
    }
  }
  return { ...image, values };
}
