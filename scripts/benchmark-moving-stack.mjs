import { readFile, writeFile } from 'node:fs/promises';
import { stackMovingTarget } from '../frontend/lib/moving-stack.js';
import { profileValue } from '../frontend/lib/comet-profile.js';

const size = 49;
const injections = [
  { name: 'compact', amplitude: 1, radius: 5, scale: 1 },
  { name: 'diffuse', amplitude: 0.4, radius: 20, scale: 4, east: 0.35, north: -0.25 },
  { name: 'elongated', amplitude: 0.7, radius: 18, scale: 5, east: -0.3, north: 0.4, axisRatio: 0.45, angle: Math.PI / 3 }
];
const median = values => {
  if (!values.length) return NaN;
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2;
};

function measure(values) {
  const radius = 2;
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

function recovery(base, simulated, shape, inner, outer) {
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

const [mode, input, output] = process.argv.slice(2);
if (mode !== '--manifest' || !input) throw new Error('Usage: node scripts/benchmark-moving-stack.mjs --manifest manifest.json [output.json]');
const saved = JSON.parse(await readFile(input, 'utf8'));
const manifest = saved.manifest ?? saved;
const products = [];
for (const entry of manifest.cases) {
  if (!entry.exposures.length) {
    console.log(JSON.stringify({ case: entry.name, skipped: 'No exposures in wavelength bin' }));
    continue;
  }
  const dates = new Set(entry.exposures.map(frame => (frame.observedStartUtc ?? new Date((frame.mjd - 40587) * 86400000).toISOString()).slice(0, 10)));
  const wavelengths = entry.exposures.map(frame => frame.wavelength).filter(Number.isFinite);
  console.log(JSON.stringify({ case: entry.name, input: entry.exposures.length, dates: dates.size,
    wavelengthRange: wavelengths.length ? [Math.min(...wavelengths), Math.max(...wavelengths)] : undefined }));
  const result = await stackMovingTarget({
    ...entry,
    ephemeris: manifest.ephemeris,
    size,
    injections,
    onStage(stage, output, frames, injected, simulations) {
      const central = (size * size - 1) / 2;
      const metrics = measure(output.values);
      console.log(JSON.stringify({ stage, ...metrics, exposures: frames.length,
        midpointCount: frames.filter(frame => frame.hasDuration).length,
        injectionRecovery: simulations.map((simulation, i) => ({
          profile: injections[i].name,
          core: recovery(output.values, simulation.values, injections[i], 0, 2),
          innerComa: recovery(output.values, simulation.values, injections[i], 3, 8),
          outerComa: recovery(output.values, simulation.values, injections[i], 9, 15)
        })),
        referenceCenter: frames.filter(frame => frame.cleaned?.referenceCounts?.[central]).length,
        referencePixels: frames.reduce((sum, frame) => sum + (frame.cleaned?.referenceCounts?.filter(Boolean).length ?? 0), 0) }));
    }
  });
  console.log(JSON.stringify({ failures: result.failures }));
  if (output) {
    const encode = stack => ({ values: Array.from(stack.values), counts: Array.from(stack.counts),
      variance: stack.variance && Array.from(stack.variance) });
    products.push({ case: entry.name, size, exposures: result.frames.map(({ url, target, wavelength }) => ({ url, target, wavelength })),
      tracked: encode(result.tracked), cleaned: encode(result.cleaned), weighted: encode(result.weighted) });
  }
}
if (output) await writeFile(output, JSON.stringify({ manifest, products }));
