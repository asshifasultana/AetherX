import { stackMovingTarget } from '../frontend/lib/moving-stack.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { createWavelengthReader } from '../frontend/lib/wavelength.js';
import { medianStack } from '../frontend/lib/stack.js';
import { PIXEL_ARCSEC, projectImage } from '../frontend/lib/fits-engine.js';
import { kernelAt, crossSubtract } from './benchmark-psf-model.mjs';

// Lisse et al. Table 1, 1.0–1.5 µm. The final field is the paper's quality flag.
const observationLog = `
2025W32_2D_0343_3 1.0087
2025W33_1B_0642_1 1.0100 b
2025W32_2D_0343_4 1.0326
2025W33_1B_0642_2 1.0341 b
2025W32_2D_0355_1 1.0578
2025W33_1B_0642_3 1.0587 b
2025W32_2D_0355_2 1.0830 b
2025W33_1B_0642_4 1.0839 b
2025W33_1B_0010_3 1.0937 b
2025W32_2D_0213_4 1.0992 b
2025W32_2D_0355_3 1.1095
2025W33_1B_0010_4 1.1190 c
2025W33_1B_0020_1 1.1448
2025W33_1B_0020_2 1.1722
2025W33_1B_0020_3 1.2005 c
2025W33_1B_0020_4 1.2291 c
2025W33_1B_0049_1 1.2567
2025W33_1B_0049_2 1.2869
2025W33_1B_0049_3 1.3170
2025W33_1B_0049_4 1.3483
2025W32_2D_0189_1 1.3574 b
2025W31_2A_0219_1 1.3691
2025W32_2D_0189_2 1.3899 b
2025W31_2A_0219_2 1.4018
2025W32_2D_0189_3 1.4229
2025W31_2A_0219_3 1.4354
2025W32_2D_0189_4 1.4576
2025W33_1B_0599_1 1.4811
`.trim().split('\n').map(line => {
  const [id, wavelength, flag = ''] = line.split(' ');
  return { id, wavelength: Number(wavelength), flag };
});

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function loadObservationList() {
  const root = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/';
  const [table, commands] = await Promise.all(['obscore_3I_Atlas.vot', '3IATLASImages-curl.sh']
    .map(name => fetchText(root + name)));
  const urls = new Map([...commands.matchAll(/'(https:\/\/irsa\.ipac\.caltech\.edu\/[^']+\/level2_([^/']+?)_spx_[^']+\.fits)'/g)]
    .map(match => [match[2], match[1]]));
  const rows = new Map([...table.matchAll(/<TR>([\s\S]*?)<\/TR>/g)].map(match => {
    const cells = [...match[1].matchAll(/<TD>(.*?)<\/TD>/g)].map(cell => cell[1]);
    return [cells[5], cells];
  }));
  return observationLog.map(entry => {
    const matches = [1, 2].map(detector => ({ detector, key: entry.id + 'D' + detector }))
      .filter(({ key }) => rows.has(key) && urls.has(key));
    if (matches.length !== 1) throw new Error(`Ambiguous D1/D2 archive match for ${entry.id}: ${JSON.stringify(matches)}`);
    const [{ detector, key }] = matches;
    const row = rows.get(key);
    return { ...entry, detector, url: urls.get(key), mjd: Number(row[10]),
      target: { raDeg: Number(row[8]), decDeg: Number(row[9]) } };
  });
}

function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2;
}

const grid = 49;
const wideGrid = 161;
const wideSettings = { fovArcmin: wideGrid * PIXEL_ARCSEC / 60, hideBadPixels: true };
const center = (grid - 1) / 2;
const apertureWeights = [];
const subpixels = 32;
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
  let hits = 0;
  for (let y = 0; y < subpixels; y++) for (let x = 0; x < subpixels; x++) {
    if (Math.hypot(dx + (x + 0.5) / subpixels - 0.5, dy + (y + 0.5) / subpixels - 0.5)
      * PIXEL_ARCSEC <= 12) hits++;
  }
  if (hits) apertureWeights.push([dx, dy, hits / subpixels ** 2]);
}

function measure(values) {
  const aperture = (x, y) => apertureWeights.reduce((sum, [dx, dy, w]) =>
    sum + w * values[(y + dy) * grid + x + dx], 0);
  const controls = [];
  for (let y = center - 18; y <= center + 18; y += 5) for (let x = center - 18; x <= center + 18; x += 5) {
    const offset = Math.hypot(x - center, y - center);
    if (offset >= 8 && offset <= 19) controls.push(aperture(x, y));
  }
  const sky = median(controls);
  const scatter = 1.4826 * median(controls.map(value => Math.abs(value - sky)));
  const signal = aperture(center, center) - sky;
  return { signal, scatter, contrast: signal / scatter, controls: controls.filter(Number.isFinite).length };
}

function sideStripStack(frames) {
  const { values } = medianStack(frames.map(frame => frame.values));
  const midpoint = (wideGrid - 1) / 2;
  const strips = [-75, 75].map(offset => {
    const samples = [];
    for (let y = midpoint - 25; y < midpoint + 25; y++) {
      for (let x = midpoint + offset - 5; x < midpoint + offset + 5; x++) samples.push(values[y * wideGrid + x]);
    }
    return { median: median(samples), count: samples.filter(Number.isFinite).length };
  });
  if (strips.some(strip => !Number.isFinite(strip.median))) throw new Error('No usable sky in one of the side strips.');
  const values49 = Float64Array.from({ length: grid ** 2 }, (_, i) => {
    const x = i % grid - center, y = Math.floor(i / grid) - center;
    const sky = strips[0].median + (strips[1].median - strips[0].median) * (x + 75) / 150;
    return values[(midpoint + y) * wideGrid + midpoint + x] - sky;
  });
  return { ...measure(values49), strips };
}

const all = await loadObservationList();
console.log(JSON.stringify({ archiveMatches: all.map(({ id, detector, wavelength, flag }) =>
  ({ id, detector, wavelength, flag })) }));
const loadFits = createFitsRangeLoader();
const wavelengthAt = createWavelengthReader();
const cache = new Map();
function load(url, target, settings) {
  const key = JSON.stringify([url, target.raDeg, target.decDeg, settings.fovArcmin, settings.includeVariance]);
  if (!cache.has(key)) cache.set(key, loadFits(url, target, settings));
  return cache.get(key);
}

const projections = new Map();
for (let start = 0; start < all.length; start += 4) {
  await Promise.all(all.slice(start, start + 4).map(async exposure => {
    const image = await load(exposure.url, exposure.target, wideSettings);
    projections.set(exposure.id, projectImage(image, exposure.target, wideSettings));
  }));
}

for (const [sample, exposures] of [['all 1.0–1.5 µm', all], ['unflagged 1.0–1.5 µm', all.filter(row => !row.flag)]]) {
  const baseline = sideStripStack(exposures.map(row => projections.get(row.id)));
  console.log(JSON.stringify({ sample, exposures: exposures.length, stage: 'median with side-strip sky', ...baseline }));
  const result = await stackMovingTarget({ exposures, load, wavelengthAt, kernelAt, subtract: crossSubtract,
    onStage(stage, output, frames) {
      console.log(JSON.stringify({ sample, stage, exposures: frames.length, ...measure(output.values),
        centerReferenceFrames: frames.filter(frame => frame.cleaned?.referenceCounts?.[(grid ** 2 - 1) / 2]).length }));
    }
  });
  if (result.failures.length || result.frames.length !== exposures.length) throw new Error(JSON.stringify(result.failures));
}
