// Injection-recovery grid: how often does our change detector (the code behind
// the AI guide's find_changes) find a fake planet planted into real SPHEREx
// exposure pairs, across distance × brightness? Pairs come from
// data/recovery/pairs.json (6-month pairs, scripts/bake-recovery-pairs.mjs)
// and frontend/data/planted-lab.json (the Lab's days-apart pair). Seeded, so a
// rerun gives the same numbers. Writes frontend/data/recovery-grid.json.
//   node scripts/recovery-grid.mjs [--trials 24] [--per-image 8] [--seed 1]
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pairFromBaked, plantTrial, scoreTrials, patchesOf, chanceMatchRate, mulberry32, binBySigma, fiftyPercentPoint } from '../frontend/lib/recovery.js';
import { differenceImage } from '../frontend/lib/difference.js';
import { limitingMag, peakToMag } from '../frontend/lib/planted-lab.js';

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? Number(process.argv[at + 1]) : fallback; };
const trials = arg('--trials', 24), perImage = arg('--per-image', 8), seed = arg('--seed', 1);
const DETECTOR = { threshold: 5, flatten: true, smoothing: 0, matchPx: 2 };
const DISTANCES_AU = [50, 100, 200, 400, 700, 1000, 1500];
const MAGS = Array.from({ length: 25 }, (_, i) => Number((14.5 + 0.25 * i).toFixed(2)));
const LOG_STEP = 0.1;

const lab = JSON.parse(await readFile(new URL('../frontend/data/planted-lab.json', import.meta.url), 'utf8'));
const pairs = [pairFromBaked({ ...lab, id: `days-p${lab.field.patchNumber}`, baseline: 'days', gapDays: lab.frames[1].midMjd - lab.frames[0].midMjd })];
const bakedPath = new URL('../data/recovery/pairs.json', import.meta.url);
if (existsSync(bakedPath)) pairs.push(...JSON.parse(await readFile(bakedPath, 'utf8')).pairs.map(pairFromBaked));
else console.warn('data/recovery/pairs.json is missing: run scripts/bake-recovery-pairs.mjs for the 6-month pairs.');

const noiseOf = pair => (pair.frames[0].noise + pair.frames[1].noise) / 2;
const differenceOf = (current, reference, width) => differenceImage({ current, reference, width, threshold: DETECTOR.threshold, flatten: DETECTOR.flatten, smoothing: DETECTOR.smoothing });
// Patches each pair already has with nothing planted (star residuals, glitches).
for (const pair of pairs) {
  pair.existing = patchesOf(differenceOf(pair.frames[1].values, pair.frames[0].values, pair.width));
  pair.chanceMatch = chanceMatchRate(pair.existing, pair.width, { matchPx: DETECTOR.matchPx });
  console.log(`${pair.id}: ${pair.existing.length} patches with nothing planted; a random spot has a brighter patch within ${DETECTOR.matchPx} px ${(100 * pair.chanceMatch).toFixed(1)}% of the time.`);
}
const rows = [];
const started = Date.now();
for (const [pairIndex, pair] of pairs.entries()) {
  const rng = mulberry32(seed * 7919 + pairIndex);
  for (const distanceAu of DISTANCES_AU) for (const mag of MAGS) {
    let planted = 0;
    for (let image = 0; planted < trials && image < trials * 3; image++) {
      const trial = plantTrial({ pair, distanceAu, mag, rng, count: Math.min(perImage, trials - planted) });
      if (!trial) continue;
      const difference = differenceOf(trial.current, trial.reference, pair.width);
      scoreTrials(difference, trial.truths, { matchPx: DETECTOR.matchPx, existing: pair.existing, gainSigma: DETECTOR.threshold }).forEach((score, index) => {
        rows.push({ pair: pair.id, baseline: pair.baseline, distanceAu, mag, peakSigma: trial.truths[index].peakSigma, ...score });
      });
      planted += trial.truths.length;
    }
  }
  console.log(`${pair.id}: done (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[sorted.length >> 1] : NaN; };
const baselines = [...new Set(pairs.map(pair => pair.baseline))];

const cells = [];
for (const baseline of baselines) for (const distanceAu of DISTANCES_AU) for (const mag of MAGS) {
  const group = rows.filter(row => row.baseline === baseline && row.distanceAu === distanceAu && row.mag === mag);
  if (!group.length) continue;
  cells.push({ baseline, distanceAu, mag, medianPeakSigma: Number(median(group.map(row => row.peakSigma)).toFixed(2)), trials: group.length, recovered: group.filter(row => row.recovered).length, top3: group.filter(row => row.top3).length });
}

// Brightness curves in 0.1-dex σ bins, pooled over distance ('all') and per distance.
function curve(group) {
  return binBySigma(group, { step: LOG_STEP, sigmaOf: row => (row.peakSigma > 0 ? Math.log10(row.peakSigma) : NaN), hitOf: row => row.recovered })
    .map(bin => {
      const inBin = group.filter(row => row.peakSigma > 0 && Math.abs(Math.floor(Math.log10(row.peakSigma) / LOG_STEP) * LOG_STEP - bin.sigma) < 1e-6);
      return { sigma: Number((10 ** (bin.sigma + LOG_STEP / 2)).toFixed(3)), trials: bin.trials, recovered: bin.hits, top3: inBin.filter(row => row.top3).length };
    });
}
const bySigma = [];
const fifty = {};
for (const baseline of baselines) {
  const ofBaseline = rows.filter(row => row.baseline === baseline);
  fifty[baseline] = {};
  for (const distanceAu of ['all', ...DISTANCES_AU]) {
    const group = distanceAu === 'all' ? ofBaseline : ofBaseline.filter(row => row.distanceAu === distanceAu);
    const points = curve(group);
    for (const point of points) bySigma.push({ baseline, distanceAu, ...point });
    const sigma = fiftyPercentPoint(points.filter(point => point.trials >= 5).map(point => ({ x: point.sigma, fraction: point.recovered / point.trials })));
    fifty[baseline][distanceAu] = sigma === null ? null : Number(sigma.toFixed(2));
  }
}

// σ ↔ AB mag on the Lab's field (Planet Nine patch #1), for the chart's top axis.
const labNoise = noiseOf(pairs[0]);
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  method: 'Fake point sources (Gaussian σ = 0.7 px) planted into real SPHEREx exposure pairs at the position Earth\'s motion predicts for each date and distance; difference image and patch finder are the viewer\'s own (lib/difference.js, lib/blobs.js).',
  settings: { trialsPerCell: trials, plantedPerImage: perImage, seed, distancesAu: DISTANCES_AU, mags: MAGS, sigmaBinDex: LOG_STEP },
  detector: DETECTOR,
  labField: { ...lab.field, noise: labNoise, pixelArcsec: lab.pixelArcsec, magAtFiveSigma: Number(limitingMag(labNoise, 5, { pixelArcsec: lab.pixelArcsec }).toFixed(2)) },
  pairs: pairs.map(pair => ({
    id: pair.id, baseline: pair.baseline, gapDays: Number(pair.gapDays.toFixed(2)), patchNumber: pair.field.patchNumber,
    raDeg: pair.field.raDeg, decDeg: pair.field.decDeg, detector: pair.frames[0].detector,
    observations: pair.frames.map(frame => frame.observationId), patchesWithNothingPlanted: pair.existing.length, chanceMatch: Number(pair.chanceMatch.toFixed(4)), dates: pair.frames.map(frame => frame.date.slice(0, 10)),
    wavelengthUm: pair.frames.map(frame => frame.wavelengthUm), noise: noiseOf(pair),
    magAtFiveSigma: Number(limitingMag(noiseOf(pair), 5, { pixelArcsec: pair.pixelArcsec }).toFixed(2))
  })),
  cells, bySigma,
  fifty: Object.fromEntries(Object.entries(fifty).map(([baseline, byDistance]) => [baseline, {
    ...byDistance,
    magOnLabField: byDistance.all === null ? null : Number(peakToMag(byDistance.all * labNoise, { pixelArcsec: lab.pixelArcsec }).toFixed(2))
  }]))
};
await writeFile(new URL('../frontend/data/recovery-grid.json', import.meta.url), JSON.stringify(output));
console.log(`\n${rows.length} planted planets in ${((Date.now() - started) / 1000).toFixed(0)} s`);
for (const baseline of baselines) console.log(`${baseline}: 50% recovered at ${JSON.stringify(output.fifty[baseline])}`);
