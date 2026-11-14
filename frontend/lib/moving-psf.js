import { loadCometEpsf, psfColumn } from './comet-native-fit.js';
import { projectImage, projectSkyToPixel } from './fits-engine.js';
const median = values => {
  if (!values.length) return NaN;
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2;
};

const kernels = new WeakMap();
export async function kernelAt(image, target, detector, options) {
  if (kernels.has(image)) return kernels.get(image);
  const [x, y] = projectSkyToPixel(image, target.raDeg, target.decDeg);
  const core = psfColumn(image, x, y, await loadCometEpsf(detector));
  const projected = projectImage({ ...image, values: core, flags: undefined, variance: undefined,
    derivedTransientPixels: undefined }, target, options);
  const center = (projected.width - 1) / 2;
  const cells = [];
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
    const value = projected.values[(center + dy) * projected.width + center + dx];
    if (value > 0) cells.push([dx, dy, value]);
  }
  const total = cells.reduce((sum, cell) => sum + cell[2], 0);
  if (!(total > 0)) throw new Error('Invalid projected ePSF.');
  const kernel = cells.map(([dx, dy, value]) => [dx, dy, value / total]);
  kernels.set(image, kernel);
  return kernel;
}

function convolve(image, kernel) {
  const { width, values, variance } = image;
  const filtered = new Float32Array(values.length).fill(NaN);
  const filteredVariance = filtered.slice();
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    const x = i % width, y = Math.floor(i / width);
    let weight = 0, signal = 0, noise = 0;
    for (const [dx, dy, w] of kernel) {
      const u = x - dx, v = y - dy;
      if (u < 0 || v < 0 || u >= width || v >= width) continue;
      const j = v * width + u;
      if (!Number.isFinite(values[j]) || !Number.isFinite(variance[j])) continue;
      weight += w;
      signal += w * values[j];
      noise += w * w * variance[j];
    }
    if (weight < 0.99) continue;
    filtered[i] = signal / weight;
    filteredVariance[i] = noise / weight ** 2;
  }
  return { values: filtered, variance: filteredVariance };
}

export function crossSubtract(science, references) {
  const pairs = references.map(reference => ({
    science: convolve(science, reference.kernel),
    reference: convolve(reference, science.kernel)
  }));
  const values = science.values.slice(), variance = science.variance.slice();
  const referenceCounts = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const valid = pairs.filter(pair =>
      Number.isFinite(pair.science.values[i]) && Number.isFinite(pair.reference.values[i]));
    if (valid.length < 2) continue;
    values[i] = median(valid.map(pair => pair.science.values[i] - pair.reference.values[i]));
    const scienceVariance = median(valid.map(pair => pair.science.variance[i]));
    const referenceVariance = valid.reduce((sum, pair) => sum + pair.reference.variance[i], 0);
    variance[i] = scienceVariance + (valid.length === 2 ? 1 : Math.PI / 2) * referenceVariance / valid.length ** 2;
    referenceCounts[i] = valid.length;
  }
  return { ...science, values, variance, referenceCounts };
}

