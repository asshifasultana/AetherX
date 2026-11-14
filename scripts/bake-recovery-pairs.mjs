// Bakes real SPHEREx 6-month exposure pairs for the recovery grid
// (scripts/recovery-grid.mjs). For each of the top Planet Nine suspicion
// patches: two exposures from the same detector about half a year apart, at
// nearly the same wavelength, projected onto one north-up grid. Only real
// pixels are stored; fake planets are planted by the grid script. Run once
// with network access:
//   node scripts/bake-recovery-pairs.mjs [--fields 6] [--fov 13]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { publicCases } from '../frontend/lib/planetx-suspects.js';
import { PIXEL_ARCSEC } from '../frontend/lib/fits-engine.js';
import { productsAt, createFrameLoader, bakeFrame, candidatePairs, bestPair } from './lib/bake-frames.mjs';

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? Number(process.argv[at + 1]) : fallback; };
const fieldCount = arg('--fields', 6), fovArcmin = arg('--fov', 13);
const outputDir = new URL('../data/recovery/', import.meta.url);
const output = new URL('pairs.json', outputDir);

const model = JSON.parse(await readFile(new URL('../frontend/data/planet-nine.json', import.meta.url), 'utf8'));
const patches = publicCases(model, []).slice(0, fieldCount);
const frameOf = createFrameLoader({ fovArcmin });
const pairs = [];

for (const patch of patches) {
  const target = { raDeg: patch.peak.raDeg, decDeg: patch.peak.decDeg };
  console.log(`\nField: patch #${patch.number} (${patch.id}) RA ${target.raDeg} Dec ${target.decDeg}`);
  try {
    const products = await productsAt(target);
    const candidates = candidatePairs(products, { minDays: 150, maxDays: 210, wantDays: 180 });
    console.log(`${products.length} exposures, ${candidates.length} same-detector pairs 150–210 days apart.`);
    const found = await bestPair(frameOf, target, candidates, { maxLoads: 40 });
    if (!found) { console.log('No 6-month pair with full coverage and matching wavelength; skipping this field.'); continue; }
    const frames = found.frames.map(bakeFrame);
    console.log(`Chose ${frames[0].observationId} / ${frames[1].observationId}, wavelength mismatch ${(100 * found.mismatch).toFixed(1)}%`);
    pairs.push({
      id: `6mo-p${patch.number}`, baseline: '6mo',
      field: { ...target, patchNumber: patch.number, caseId: patch.id, medianDistanceAu: patch.peak.medianDistanceAu, medianVMag: patch.peak.medianVMag },
      fovArcmin, pixelArcsec: PIXEL_ARCSEC, width: found.frames[0].projection.width,
      gapDays: Number((frames[1].midMjd - frames[0].midMjd).toFixed(3)),
      wavelengthMismatch: Number(found.mismatch.toFixed(4)),
      frames
    });
  } catch (error) { console.log(`Field failed: ${error.message}`); }
}

if (!pairs.length) throw new Error('No 6-month pair could be baked.');
await mkdir(outputDir, { recursive: true });
const baked = {
  schemaVersion: 1,
  bakedAt: new Date().toISOString().slice(0, 10),
  note: 'Real SPHEREx exposure pairs about six months apart from IRSA, background-subtracted and resampled onto north-up grids (east left), one pair per Planet Nine suspicion patch. Input for scripts/recovery-grid.mjs; no fake planets are in these pixels.',
  pairs
};
await writeFile(output, JSON.stringify(baked));
console.log(`\nWrote ${output.pathname}: ${pairs.length} pairs (${(JSON.stringify(baked).length / 1024).toFixed(0)} KB)`);
