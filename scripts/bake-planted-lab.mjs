// Bakes the real SPHEREx image pair used by the PlanetX "Planted Planet Lab".
// Two exposures of the most probable Planet Nine tile, same detector, a few
// days apart and at nearly the same wavelength, projected onto one north-up
// grid so they can be blinked. The fake planet is added in the browser; this
// file only holds real pixels. Run once with network access:
//   node scripts/bake-planted-lab.mjs [--fov 13]
import { readFile, writeFile } from 'node:fs/promises';
import { publicCases } from '../frontend/lib/planetx-suspects.js';
import { PIXEL_ARCSEC } from '../frontend/lib/fits-engine.js';
import { productsAt, createFrameLoader, bakeFrame, candidatePairs, bestPair } from './lib/bake-frames.mjs';

const fovArg = process.argv.indexOf('--fov');
const fovArcmin = fovArg > 0 ? Number(process.argv[fovArg + 1]) : 13;
const output = new URL('../frontend/data/planted-lab.json', import.meta.url);

const model = JSON.parse(await readFile(new URL('../frontend/data/planet-nine.json', import.meta.url), 'utf8'));
const [patch] = publicCases(model, []);
if (!patch) throw new Error('The Planet Nine model has no suspicion patch.');
const target = { raDeg: patch.peak.raDeg, decDeg: patch.peak.decDeg };
console.log(`Field: patch #${patch.number} peak tile RA ${target.raDeg} Dec ${target.decDeg}`);

const products = await productsAt(target);
console.log(`${products.length} exposures cover the tile.`);

// Candidate pairs: same detector, 1-10 days apart, short detectors first
// (sharper images; reflected sunlight is brightest there).
const pairs = candidatePairs(products, { minDays: 1, maxDays: 10, wantDays: 4 });
console.log(`${pairs.length} candidate pairs.`);

const found = await bestPair(createFrameLoader({ fovArcmin }), target, pairs);
if (!found) throw new Error('No exposure pair with matching wavelength and full coverage was found.');
console.log(`Best wavelength mismatch ${(100 * found.mismatch).toFixed(1)}%`);

const frames = found.frames.map(bakeFrame);
const baked = {
  schemaVersion: 1,
  bakedAt: new Date().toISOString().slice(0, 10),
  field: { ...target, patchNumber: patch.number, medianDistanceAu: patch.peak.medianDistanceAu, medianVMag: patch.peak.medianVMag },
  fovArcmin, pixelArcsec: PIXEL_ARCSEC, width: found.frames[0].projection.width,
  note: 'Real SPHEREx exposures from IRSA, background-subtracted and resampled onto a north-up grid (east left). The planted planet is added in the browser and is not in these pixels.',
  frames
};
await writeFile(output, JSON.stringify(baked));
console.log(`Wrote ${output.pathname} (${(JSON.stringify(baked).length / 1024).toFixed(0)} KB), noise ${frames.map(f => f.noise.toExponential(2)).join(' / ')} ${frames[0].bunit}`);
