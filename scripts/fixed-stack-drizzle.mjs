import { MASKED_FLAG_BITS } from '../frontend/lib/pixel-quality.js';
import { skyToCanvas } from '../frontend/sky-projection.js';
import { PIXEL_ARCSEC } from '../frontend/lib/fits-engine.js';

const badMask = MASKED_FLAG_BITS.reduce((mask, bit) => mask | (1 << bit), 0);
const rad = Math.PI / 180;
export const validDetectorPixel = (image, i) =>
  Number.isFinite(image.values[i]) && !(image.flags?.[i] & badMask) && !image.derivedTransientPixels?.has(i);

// FITS forward TAN-SIP, with the cropped image's CRPIX.
function detectorToGrid(image, pointing, size, arcsecPerPixel, x, y) {
  const h = image.header, m = image.matrix;
  const u = x + 1 - h.CRPIX1, v = y + 1 - h.CRPIX2;
  const sip = axis => {
    let shift = 0;
    const order = Number(h[axis + '_ORDER']) || 0;
    for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) {
      shift += Number(h[`${axis}_${i}_${j}`] || 0) * u ** i * v ** j;
    }
    return shift;
  };
  const U = u + sip('A'), V = v + sip('B');
  const xi = (m.a * U + m.b * V) * rad, eta = (m.c * U + m.d * V) * rad;
  const dec0 = Number(h.CRVAL2) * rad;
  const denominator = Math.cos(dec0) - eta * Math.sin(dec0);
  return skyToCanvas({
    raDeg: Number(h.CRVAL1) + Math.atan2(xi, denominator) / rad,
    decDeg: Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(denominator, xi)) / rad,
    size, arcsecPerPixel, centerRaDeg: pointing.raDeg, centerDecDeg: pointing.decDeg,
  });
}

function clip(polygon, axis, bound, side) {
  const output = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = side * (a[axis] - bound), db = side * (b[axis] - bound);
    if (da >= 0) output.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      output.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return output;
}

function overlap(polygon, x, y) {
  const p = clip(clip(clip(clip(polygon, 'x', x - .5, 1), 'x', x + .5, -1),
    'y', y - .5, 1), 'y', y + .5, -1);
  let twiceArea = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    twiceArea += (a.x - x) * (b.y - y) - (b.x - x) * (a.y - y);
  }
  return Math.abs(twiceArea) / 2;
}

export function drizzleExposure(image, pointing, background, size, { scale = 1, pixfrac = .8, injection } = {}) {
  const width = size * scale, pixelScale = PIXEL_ARCSEC / scale, half = pixfrac / 2;
  const sum = new Float64Array(width ** 2), weight = sum.slice(), injected = injection && sum.slice();
  for (let i = 0; i < image.values.length; i++) {
    if (!validDetectorPixel(image, i)) continue;
    const x = i % image.width, y = Math.floor(i / image.width);
    const polygon = [[-half, -half], [half, -half], [half, half], [-half, half]]
      .map(([dx, dy]) => detectorToGrid(image, pointing, width, pixelScale, x + dx, y + dy));
    if (polygon.some(p => !p)) continue;
    const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
    for (let row = Math.max(0, Math.round(Math.min(...ys))); row <= Math.min(width - 1, Math.round(Math.max(...ys))); row++) {
      for (let col = Math.max(0, Math.round(Math.min(...xs))); col <= Math.min(width - 1, Math.round(Math.max(...xs))); col++) {
        const area = overlap(polygon, col, row), j = row * width + col;
        sum[j] += area * (image.values[i] - background);
        weight[j] += area;
        if (injected) injected[j] += area * injection[i];
      }
    }
  }
  return { sum, weight, injected, width };
}

export function drizzleStack(frames, { injected = false } = {}) {
  const { width } = frames[0], values = new Float32Array(width ** 2).fill(NaN);
  const counts = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, weight = 0;
    for (const frame of frames) {
      if (!(frame.weight[i] > 1e-10)) continue;
      sum += frame.sum[i] + (injected ? frame.injected[i] : 0);
      weight += frame.weight[i];
      counts[i]++;
    }
    if (weight) values[i] = sum / weight;
  }
  return { values, counts, width };
}
