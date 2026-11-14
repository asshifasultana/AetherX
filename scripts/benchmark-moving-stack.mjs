import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stackMovingTarget } from '../frontend/lib/moving-stack.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { projectSkyToPixel } from '../frontend/lib/fits-engine.js';
import { createWavelengthReader } from '../frontend/lib/wavelength.js';
import { profileValue } from '../frontend/lib/comet-profile.js';

const size = 49;
const injections = [
  { name: 'compact', amplitude: 1, radius: 5, scale: 1 },
  { name: 'diffuse', amplitude: 0.4, radius: 20, scale: 4, east: 0.35, north: -0.25 },
  { name: 'elongated', amplitude: 0.7, radius: 18, scale: 5, east: -0.3, north: 0.4, axisRatio: 0.45, angle: Math.PI / 3 }
];
const settings = { fovArcmin: size * 6.15 / 60, hideBadPixels: true };
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

async function discover(root) {
  const module = name => import(pathToFileURL(join(root, 'js', name + '.js')));
  const { findAlongPath } = await module('catalog');
  const { ephemeris, positionAt } = await module('ephem');
  const wavelengthAt = createWavelengthReader();
  const upstreamFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (typeof url !== 'string' || !url.startsWith('data/')) return upstreamFetch(url, options);
    return new Response(await readFile(join(root, url)));
  };
  const track = await ephemeris('3I/ATLAS');
  if (!track.precise) throw new Error('Expected the spacecraft-relative featured ephemeris.');
  const all = await findAlongPath(track.points, mjd => positionAt(track.points, mjd));
  const load = createFitsRangeLoader();
  const rows = [];
  const candidates = all.filter(row => [1, 5].includes(row.detector) && row.date.toISOString().startsWith('2025-08'));
  for (let start = 0; start < candidates.length; start += 6) {
    await Promise.all(candidates.slice(start, start + 6).map(async row => {
      const url = row.url.replace(/^.*?\/(qr\d+)\//, 'https://irsa.ipac.caltech.edu/ibe/data/spherex/$1/');
      try {
        const target = { raDeg: row.obj.ra, decDeg: row.obj.dec };
        const image = await load(url, target, settings);
        const pixel = projectSkyToPixel(image, row.obj.ra, row.obj.dec);
        const wavelength = await wavelengthAt(url, pixel[0] + image.sourceX, pixel[1] + image.sourceY);
        rows.push({ url, archiveUrl: row.url, detector: row.detector, mjd: row.mjd, observedStartUtc: row.date.toISOString(), wavelength });
      } catch (error) {
        console.error('Discovery skipped', row.id, error.message);
      }
    }));
  }
  rows.sort((a, b) => a.mjd - b.mjd || a.url.localeCompare(b.url));
  const d1 = rows.filter(row => row.detector === 1);
  const centers = d1.map(row => row.wavelength);
  const continuum = centers.map(center => d1.filter(row => Math.abs(row.wavelength - center) <= 0.025))
    .sort((a, b) => b.length - a.length)[0] ?? [];
  const co2 = rows.filter(row => row.detector === 5 && row.wavelength >= 4.23 && row.wavelength <= 4.27);
  console.log(JSON.stringify({ discovered: rows.length, d1: d1.length, co2: co2.length }));
  return { ephemeris: track.points, cases: [{ name: 'August 2025 D1 continuum', exposures: continuum }, { name: 'August 2025 D5 CO₂ 4.23–4.27 µm', exposures: co2 }] };
}

async function comparison(root, frames) {
  const module = name => import(pathToFileURL(join(root, 'js', name + '.js')));
  const { makeCutout } = await module('cutout');
  const { medianStack, backgroundSubtract } = await module('render');
  const app = await readFile(join(root, 'js', 'app.js'), 'utf8');
  const extract = name => app.match(new RegExp('function ' + name + '\\([^]*?\\r?\\n}'))[0];
  const group = new Function('state', extract('groupExposures') + '; return groupExposures')({ group: true });
  const mean = new Function(extract('nanMean') + '; return nanMean')();
  const data = new Map();
  for (const frame of frames) {
    const cutout = await makeCutout({ url: frame.archiveUrl }, frame.target.raDeg, frame.target.decDeg, size);
    if (!cutout.data) throw new Error('Comparator lacked coverage on a shared exposure.');
    data.set(frame, cutout.data);
  }
  const combined = groups => medianStack(groups.map(g => backgroundSubtract(mean(g.exposures.map(frame => data.get(frame)))).data));
  const nativeGroups = group(frames);
  const matchedGroups = [...Map.groupBy(frames, frame => frame.observedStartUtc.slice(0, 10)).values()].map(exposures => ({ exposures }));
  return {
    shivenNative: { ...measure(combined(nativeGroups)), exposures: nativeGroups.flatMap(g => g.exposures).length },
    shivenMatched: { ...measure(combined(matchedGroups)), exposures: frames.length }
  };
}

const [mode, input, output, against] = process.argv.slice(2);
if (!input || !['--manifest', '--compare'].includes(mode)) throw new Error('Usage: node scripts/benchmark-moving-stack.mjs --manifest manifest.json | --compare /path/to/spherex-timelapse [output.json]');
const comparator = mode === '--compare' ? resolve(input) : against ? resolve(against) : null;
const saved = mode === '--manifest' ? JSON.parse(await readFile(input, 'utf8')) : null;
const manifest = saved ? saved.manifest ?? saved : await discover(comparator);
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
  if (comparator) console.log(JSON.stringify(await comparison(comparator, result.frames)));
  if (output) {
    const encode = stack => ({ values: Array.from(stack.values), counts: Array.from(stack.counts),
      variance: stack.variance && Array.from(stack.variance) });
    products.push({ case: entry.name, size, exposures: result.frames.map(({ url, target, wavelength }) => ({ url, target, wavelength })),
      tracked: encode(result.tracked), cleaned: encode(result.cleaned), weighted: encode(result.weighted) });
  }
}
if (output) await writeFile(output, JSON.stringify({ manifest, products }));
