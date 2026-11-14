import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, plantTrial, scoreTrial, scoreTrials, patchesOf, chanceMatchRate, wilson, binBySigma, fiftyPercentPoint } from '../lib/recovery.js';
import { differenceImage } from '../lib/difference.js';
import { peakToMag } from '../lib/planted-lab.js';
import { tallyRecovery } from '../lib/planetx-votes.js';

function noisePlane(width, sigma, seed) {
  const rng = mulberry32(seed), values = new Float32Array(width * width);
  for (let i = 0; i < values.length; i++) values[i] = sigma * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  return values;
}
// The Planted Lab's real field and first date: SPHEREx looks ~90° from the Sun, almost along Earth's path.
const pairOf = (gapDays, width = 64) => ({
  width, pixelArcsec: 6.15, field: { raDeg: 92.5, decDeg: 22.5 },
  frames: [{ midMjd: 61116.57, noise: 1, values: noisePlane(width, 1, 11) }, { midMjd: 61116.57 + gapDays, noise: 1, values: noisePlane(width, 1, 12) }]
});
const run = (pair, distanceAu, sigma, seed = 3) => {
  const trial = plantTrial({ pair, distanceAu, mag: peakToMag(sigma, { pixelArcsec: 6.15 }), rng: mulberry32(seed) });
  const diff = differenceImage({ current: trial.current, reference: trial.reference, width: pair.width });
  return { trial, score: scoreTrial(diff, trial.truth) };
};

test('the same seed plants the same planet', () => {
  const pair = pairOf(180);
  const one = run(pair, 500, 10), two = run(pair, 500, 10);
  assert.deepEqual(one.trial.truth, two.trial.truth);
  assert.ok(Math.abs(one.trial.truth.peakSigma - 10) < 1e-6);
});

test('a bright planet in a 6-month pair is recovered; a 1σ one is not', () => {
  const pair = pairOf(180);
  const bright = run(pair, 500, 20);
  assert.equal(bright.trial.truth.aInField, false, 'a 6-month hop at 500 AU leaves the field');
  assert.ok(bright.score.recovered);
  assert.ok(bright.score.top3);
  assert.equal(run(pair, 500, 1).score.recovered, false);
});

test('in a days-apart pair a planet at 1000 AU barely moves and cancels itself out', () => {
  const pair = pairOf(4);
  const far = run(pair, 1000, 30);
  assert.ok(far.trial.truth.shiftPx < 0.5, `shift ${far.trial.truth.shiftPx}`);
  assert.equal(far.score.recovered, false);
});

test('Wilson interval, binning and the 50% point', () => {
  const half = wilson(5, 10);
  assert.equal(half.p, 0.5);
  assert.ok(half.low < 0.5 && half.high > 0.5 && half.low > 0.3);
  assert.equal(wilson(0, 0).low, 0);
  assert.ok(wilson(10, 10).high <= 1);
  const bins = binBySigma([{ peakSigma: 4.2, found: true }, { peakSigma: 4.9, found: false }, { peakSigma: 7.1, found: true }, { peakSigma: NaN, found: true }]);
  assert.deepEqual(bins, [{ sigma: 4, trials: 2, hits: 1 }, { sigma: 7, trials: 1, hits: 1 }]);
  assert.equal(fiftyPercentPoint([{ x: 4, fraction: 0.1 }, { x: 6, fraction: 0.3 }, { x: 8, fraction: 0.7 }]), 7);
  assert.equal(fiftyPercentPoint([{ x: 4, fraction: 0.6 }, { x: 6, fraction: 0.9 }]), null);
});

test('several planets per image stay apart and are each scored', () => {
  const pair = pairOf(180, 96);
  const trial = plantTrial({ pair, distanceAu: 500, mag: peakToMag(25, { pixelArcsec: 6.15 }), rng: mulberry32(5), count: 6 });
  assert.equal(trial.truths.length, 6);
  for (const [i, one] of trial.truths.entries()) for (const other of trial.truths.slice(i + 1)) assert.ok(Math.hypot(one.b.x - other.b.x, one.b.y - other.b.y) >= 12);
  const scores = scoreTrials(differenceImage({ current: trial.current, reference: trial.reference, width: pair.width }), trial.truths);
  assert.equal(scores.length, 6);
  assert.ok(scores.every(score => score.recovered && score.top3), JSON.stringify(scores));
});

test('a patch that was already there only counts when the planet made it much stronger', () => {
  const pair = pairOf(180);
  const trial = plantTrial({ pair, distanceAu: 500, mag: peakToMag(20, { pixelArcsec: 6.15 }), rng: mulberry32(3) });
  const difference = differenceImage({ current: trial.current, reference: trial.reference, width: pair.width });
  const [found] = patchesOf(difference).filter(blob => blob.sign === 'brighter' && Math.hypot(blob.x - trial.truth.b.x, blob.y - trial.truth.b.y) <= 2);
  assert.ok(found);
  assert.equal(scoreTrial(difference, trial.truth, { existing: [{ ...found, peakSigma: found.peakSigma - 1 }] }).recovered, false);
  assert.equal(scoreTrial(difference, trial.truth, { existing: [{ ...found, peakSigma: found.peakSigma - 6 }] }).recovered, true);
  const rate = chanceMatchRate([{ sign: 'brighter', x: 32, y: 32 }], 64, { matchPx: 2 });
  assert.ok(rate > 0 && rate < 0.02, `rate ${rate}`);
});

test('local hidden-planet rounds are binned like the shared views', () => {
  const { bins, cells } = tallyRecovery([
    { game: 'lab', peakSigma: 6.5, found: true, mag: 17.3, distanceAu: 420 },
    { game: 'lab', peakSigma: 6.1, found: false, mag: 17.2, distanceAu: 380 },
    { game: 'quest', peakSigma: 8, found: true },
    { game: 'quest', peakSigma: NaN, found: true }
  ]);
  assert.deepEqual(bins, [{ game: 'lab', sigma: 6, trials: 2, found: 1 }, { game: 'quest', sigma: 8, trials: 1, found: 1 }]);
  assert.deepEqual(cells, [{ mag: 17.25, distanceAu: 400, trials: 2, found: 1 }]);
});
