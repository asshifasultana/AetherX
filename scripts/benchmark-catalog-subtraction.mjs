import { readFile } from 'node:fs/promises';
import { stackMovingTarget, positionAt } from '../frontend/lib/moving-stack.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { createWavelengthReader } from '../frontend/lib/wavelength.js';
import { size, diffuse, measure, recovery } from './benchmark-aperture.mjs';
import { loadCometEpsf } from '../frontend/lib/comet-native-fit.js';
import { kernelAt, crossSubtract } from './benchmark-psf-model.mjs';
import { fetchFieldCatalogs, refineAlignment, starsAt, subtractCatalogStars } from './catalog-field-model.mjs';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/benchmark-catalog-subtraction.mjs manifest.json');
const input = JSON.parse(await readFile(filename, 'utf8'));
const { ephemeris, cases } = input.manifest ?? input;
const { exposures } = cases.find(entry => entry.name.includes('D1 continuum'));
const loadFits = createFitsRangeLoader();
const readWavelength = createWavelengthReader();
const cache = new Map();
const load = (url, target, options) => {
  const key = JSON.stringify([url, target.raDeg, target.decDeg, options.fovArcmin]);
  if (!cache.has(key)) cache.set(key, loadFits(url, target, options));
  return cache.get(key);
};
const dates = [...new Set(exposures.map(row => row.observedStartUtc.slice(0, 10)))].sort();
const epsf = await loadCometEpsf(1);
const fields = await Promise.all(dates.map(date => {
  const exposure = exposures.find(row => row.observedStartUtc.startsWith(date));
  return fetchFieldCatalogs(positionAt(ephemeris, exposure.mjd));
}));
const catalogs = { gaia: fields.flatMap(field => field.gaia), pan: fields.flatMap(field => field.pan) };
console.log(JSON.stringify({ catalogFields: fields.map((field, i) =>
  ({ date: dates[i], gaia: field.gaia.length, pan: field.pan.length })) }));
const starsByTime = new Map();
function catalogAt(mjd) {
  if (!starsByTime.has(mjd)) starsByTime.set(mjd, starsAt(catalogs, mjd));
  return starsByTime.get(mjd);
}
const aligned = new WeakMap();
const alignmentStats = new Map();
function alignImage(image, field, exposure, mjd) {
  if (!aligned.has(image)) {
    const result = refineAlignment(image, field, catalogAt(mjd).merged, epsf);
    aligned.set(image, result.image);
    const key = [exposure.url, field.raDeg, field.decDeg].join('|');
    alignmentStats.set(key, { ...result, image: undefined });
  }
  return aligned.get(image);
}
const catalogStats = new Map();
const filter = includePan => (image, target, exposure, mjd, field) => {
  const stars = catalogAt(mjd);
  const result = subtractCatalogStars(image, target, includePan ? stars.merged : stars.gaia, epsf, field);
  const key = [exposure.url, image.sourceX, image.sourceY].join('|');
  if (!catalogStats.has(key)) catalogStats.set(key, { gaia: result.gaia, pan: result.pan });
  return result.image;
};

const splits = [{ name: 'all exposures', exposures }, ...dates.map(date => ({
  name: 'omit ' + date, exposures: exposures.filter(row => !row.observedStartUtc.startsWith(date))
}))];
const psf = { kernelAt, subtract: crossSubtract };
const modes = [
  ['PSF baseline', psf],
  ['Gaia alignment', { ...psf, alignImage }],
  ['Gaia source fitting', { ...psf, alignImage, filterImage: filter(false) }],
  ['Gaia + Pan-STARRS source fitting', { ...psf, alignImage, filterImage: filter(true) }]
];
for (const split of splits) {
  for (const [mode, options] of modes) {
    catalogStats.clear();
    const result = await stackMovingTarget({
      exposures: split.exposures, ephemeris, load, wavelengthAt: readWavelength, injections: [diffuse], ...options,
      onStage(stage, output, frames, injected) {
        if (stage === 'trackedMedian') return;
        console.log(JSON.stringify({
          split: split.name, mode, stage, exposures: frames.length,
          r1: measure(output.values, 1), r2: measure(output.values, 2),
          core: recovery(output.values, injected.values, diffuse, 0, 1),
          outer: recovery(output.values, injected.values, diffuse, 9, 15),
          referenceCenter: frames.filter(frame => frame.cleaned.referenceCounts?.[(size * size - 1) / 2]).length,
          referencePixels: frames.reduce((sum, frame) => sum + (frame.cleaned.referenceCounts?.filter(Boolean).length ?? 0), 0)
        }));
      }
    });
    if (split.exposures.length === exposures.length && options.filterImage) {
      const counts = [...catalogStats.values()];
      console.log(JSON.stringify({ mode, cutouts: counts.length,
        gaiaModels: counts.reduce((sum, count) => sum + count.gaia, 0),
        panModels: counts.reduce((sum, count) => sum + count.pan, 0) }));
    }
    if (result.failures.length || result.frames.length !== split.exposures.length) throw new Error(JSON.stringify(result.failures));
  }
}
const shifts = [...alignmentStats.values()];
console.log(JSON.stringify({ alignmentCutouts: shifts.length,
  appliedShifts: shifts.filter(shift => shift.applied).length, shifts }));


