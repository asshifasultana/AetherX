// Bakes the real SPHEREx image pair used by the PlanetX "Planted Planet Lab".
// Two exposures of the most probable Planet Nine tile, same detector, a few
// days apart and at nearly the same wavelength, projected onto one north-up
// grid so they can be blinked. The fake planet is added in the browser; this
// file only holds real pixels. Run once with network access:
//   node scripts/bake-planted-lab.mjs [--fov 13]
import { readFile, writeFile } from 'node:fs/promises';
import { publicCases } from '../frontend/lib/planetx-suspects.js';
import { validateSearch, buildQuery, queryArchive, deduplicate } from '../frontend/lib/observations.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { createWavelengthReader } from '../frontend/lib/wavelength.js';
import { projectImage, PIXEL_ARCSEC } from '../frontend/lib/fits-engine.js';
import { estimateBackground } from '../frontend/lib/background.js';

const fovArg = process.argv.indexOf('--fov');
const fovArcmin = fovArg > 0 ? Number(process.argv[fovArg + 1]) : 13;
const output = new URL('../frontend/data/planted-lab.json', import.meta.url);

const model = JSON.parse(await readFile(new URL('../frontend/data/planet-nine.json', import.meta.url), 'utf8'));
const [patch] = publicCases(model, []);
if (!patch) throw new Error('The Planet Nine model has no suspicion patch.');
const target = { raDeg: patch.peak.raDeg, decDeg: patch.peak.decDeg };
console.log(`Field: patch #${patch.number} peak tile RA ${target.raDeg} Dec ${target.decDeg}`);

const search = validateSearch(new URLSearchParams({ raDeg: String(target.raDeg), decDeg: String(target.decDeg) }));
const products = deduplicate(await queryArchive(buildQuery(search)))
  .filter(p => p.accessUrl && Number.isFinite(p.startMjd) && p.detector)
  .sort((a, b) => a.startMjd - b.startMjd);
console.log(`${products.length} exposures cover the tile.`);

// Candidate pairs: same detector, 1-10 days apart, short detectors first
// (sharper images; reflected sunlight is brightest there).
const pairs = [];
for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
  const a = products[i], b = products[j], gap = b.startMjd - a.startMjd;
  if (a.detector === b.detector && gap >= 1 && gap <= 10) pairs.push([a, b, gap]);
}
pairs.sort((x, y) => x[0].detector - y[0].detector || Math.abs(x[2] - 4) - Math.abs(y[2] - 4));
console.log(`${pairs.length} candidate pairs.`);

const load = createFitsRangeLoader();
const wavelengthAt = createWavelengthReader();
const settings = { fovArcmin, hideBadPixels: true, subtractBackground: true };
const cache = new Map();
async function frameOf(product) {
  if (cache.has(product.accessUrl)) return cache.get(product.accessUrl);
  const job = (async () => {
    const image = await load(product.accessUrl, target, settings, AbortSignal.timeout(60000), product.productModifiedAt || '');
    const projection = projectImage(image, target, settings);
    const frame = projection.psfFrame;
    const wavelengthUm = frame ? await wavelengthAt(product.accessUrl, frame.x, frame.y) : NaN;
    const finite = projection.values.reduce((n, v) => n + Number.isFinite(v), 0) / projection.values.length;
    return { product, image, projection, wavelengthUm, finite };
  })();
  cache.set(product.accessUrl, job);
  job.catch(() => cache.delete(product.accessUrl));
  return job;
}

let chosen = null, best = Infinity;
for (const [a, b, gap] of pairs) {
  if (cache.size >= 90 && !(cache.has(a.accessUrl) && cache.has(b.accessUrl))) continue;
  try {
    const [fa, fb] = await Promise.all([frameOf(a), frameOf(b)]);
    if (fa.finite < 0.97 || fb.finite < 0.97) continue;
    const dl = Math.abs(fa.wavelengthUm - fb.wavelengthUm) / fa.wavelengthUm;
    console.log(`D${a.detector} ${a.observationId} / ${b.observationId}: gap ${gap.toFixed(2)} d, λ ${fa.wavelengthUm.toFixed(3)} / ${fb.wavelengthUm.toFixed(3)} μm`);
    if (dl < best) { best = dl; chosen = [fa, fb]; }
    if (dl < 0.12) break;
  } catch (error) { console.log(`skip ${a.observationId}: ${error.message}`); }
}
if (chosen && best > 0.15) chosen = null;
console.log(`Best wavelength mismatch ${(100 * best).toFixed(1)}%`);
if (!chosen) throw new Error('No exposure pair with matching wavelength and full coverage was found.');

const base64 = values => Buffer.from(new Float32Array(Array.from(values, v => Number.isFinite(v) ? v : NaN)).buffer).toString('base64');
const midMjd = p => (p.startMjd + p.endMjd) / 2;
const frames = chosen.map(({ product, image, projection, wavelengthUm }) => {
  const { level, noise } = estimateBackground(projection.values);
  return {
    observationId: product.observationId, accessUrl: product.accessUrl, detector: product.detector, release: product.release,
    midMjd: Number(midMjd(product).toFixed(6)), date: new Date((midMjd(product) - 40587) * 86400000).toISOString(),
    exposureSeconds: product.exposureSeconds, wavelengthUm: Number(wavelengthUm.toFixed(4)),
    bunit: String(image.header.BUNIT || 'MJy/sr'), level, noise, values: base64(projection.values)
  };
});
const baked = {
  schemaVersion: 1,
  bakedAt: new Date().toISOString().slice(0, 10),
  field: { ...target, patchNumber: patch.number, medianDistanceAu: patch.peak.medianDistanceAu, medianVMag: patch.peak.medianVMag },
  fovArcmin, pixelArcsec: PIXEL_ARCSEC, width: chosen[0].projection.width,
  note: 'Real SPHEREx exposures from IRSA, background-subtracted and resampled onto a north-up grid (east left). The planted planet is added in the browser and is not in these pixels.',
  frames
};
await writeFile(output, JSON.stringify(baked));
console.log(`Wrote ${output.pathname} (${(JSON.stringify(baked).length / 1024).toFixed(0)} KB), noise ${frames.map(f => f.noise.toExponential(2)).join(' / ')} ${frames[0].bunit}`);
