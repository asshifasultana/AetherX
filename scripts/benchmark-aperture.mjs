import { profileValue } from '../frontend/lib/comet-profile.js';

export const size = 49;
export const diffuse = { amplitude: 0.4, radius: 20, scale: 4, east: 0.35, north: -0.25 };
const median = values => {
  if (!values.length) return NaN;
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2;
};

export function measure(values, radius) {

  const aperture = (x, y) => {
    let flux = 0, count = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (Math.hypot(dx, dy) > radius) continue;
      const value = values[(y + dy) * size + x + dx];
      if (!Number.isFinite(value)) return NaN;
      flux += value;
      count++;
    }
    return count ? flux : NaN;
  };
  const center = (size - 1) / 2;
  const controls = [];
  for (let y = center - 18; y <= center + 18; y += 5) for (let x = center - 18; x <= center + 18; x += 5) {
    const offset = Math.hypot(x - center, y - center);
    if (offset >= 8 && offset <= 19) controls.push(aperture(x, y));
  }
  const nulls = controls.filter(Number.isFinite);
  const sky = median(nulls), scatter = 1.4826 * median(nulls.map(value => Math.abs(value - sky)));
  const signal = aperture(center, center) - sky;
  return { apertureSignal: signal, apertureSkyScatter: scatter, apertureContrast: signal / scatter, controlApertures: nulls.length };
}

export function recovery(base, simulated, shape, inner, outer) {
  let expected = 0, recovered = 0, covered = 0, total = 0;
  for (let i = 0; i < base.length; i++) {
    const east = (size - 1) / 2 - i % size;
    const north = (size - 1) / 2 - Math.floor(i / size);
    const radius = Math.hypot(east, north);
    if (radius < inner || radius > outer) continue;
    expected += shape.amplitude * profileValue(east - (shape.east ?? 0), north - (shape.north ?? 0), shape);
    total++;
    if (!Number.isFinite(base[i]) || !Number.isFinite(simulated[i])) continue;
    recovered += simulated[i] - base[i];
    covered++;
  }
  return { fraction: expected > 0 ? recovered / expected : null, coverage: covered / total };
}
