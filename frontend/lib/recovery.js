// Injection-recovery maths: plant a fake planet into a real pair of SPHEREx
// exposures at a given distance and brightness, then ask whether our change
// detector (lib/difference.js + lib/blobs.js, the code behind the AI guide's
// find_changes) finds it. Also the small statistics the "How deep?" chart
// needs. Pure and DOM-free; scripts/recovery-grid.mjs drives it.

import { findBlobs } from './blobs.js';
import { magToPeak, planetShift, plantInto, decodePlane } from './planted-lab.js';

/** Seeded uniform [0, 1) generator, so a grid run is exactly repeatable. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A baked pair (frames with base64 planes, as written by the bake scripts) with decoded pixels. */
export function pairFromBaked(entry) {
  return { ...entry, frames: entry.frames.map(frame => ({ ...frame, values: frame.values instanceof Float32Array ? frame.values : decodePlane(frame.values) })) };
}

const inside = ({ x, y }, width, margin) => x >= margin && y >= margin && x <= width - 1 - margin && y <= width - 1 - margin;

function finiteAround(values, width, { x, y }, reach = 2) {
  const cx = Math.round(x), cy = Math.round(y);
  for (let row = cy - reach; row <= cy + reach; row++) for (let column = cx - reach; column <= cx + reach; column++) {
    if (!Number.isFinite(values[row * width + column])) return false;
  }
  return true;
}

/**
 * Plant `count` fake planets of one brightness and distance. Each later-epoch
 * position B is drawn uniformly at least `marginPx` inside the grid on finite
 * pixels; A (earlier frame) is where Earth's motion puts the same body on the
 * earlier date, planted only when it lands on the grid (at a 6-month gap it
 * usually does not). Every planted position keeps `minSeparationPx` from the
 * others so their patches stay apart. Returns null if no clean spot exists.
 */
export function plantTrial({ pair, distanceAu, mag, rng, count = 1, marginPx = 6, minSeparationPx = 12 }) {
  const [early, late] = pair.frames, width = pair.width, pixelArcsec = pair.pixelArcsec;
  const shift = planetShift({ raDeg: pair.field.raDeg, decDeg: pair.field.decDeg, distanceAu, fromMjd: early.midMjd, toMjd: late.midMjd, pixelArcsec });
  const peak = magToPeak(mag, { pixelArcsec });
  const noise = (early.noise + late.noise) / 2;
  const taken = [], truths = [];
  const clear = point => taken.every(other => Math.hypot(other.x - point.x, other.y - point.y) >= minSeparationPx);
  for (let attempt = 0; attempt < 80 * count && truths.length < count; attempt++) {
    const b = { x: marginPx + rng() * (width - 1 - 2 * marginPx), y: marginPx + rng() * (width - 1 - 2 * marginPx) };
    if (!finiteAround(late.values, width, b) || !finiteAround(early.values, width, b) || !clear(b)) continue;
    const a = { x: b.x - shift.dx, y: b.y - shift.dy };
    const aInField = inside(a, width, 0);
    if (aInField && !clear(a)) continue;
    taken.push(b); if (aInField) taken.push(a);
    truths.push({ b, a, aInField, peak, peakSigma: noise > 0 ? peak / noise : NaN, shiftPx: shift.pixels, distanceAu, mag });
  }
  if (!truths.length) return null;
  let reference = early.values, current = late.values;
  for (const truth of truths) {
    current = plantInto(current, width, truth.b, peak);
    if (truth.aInField) reference = plantInto(reference, width, truth.a, peak);
  }
  return { reference, current, truths, truth: truths[0] };
}

/**
 * Did the detector find each planted planet? `recovered`: a brighter patch
 * within `matchPx` of B among every patch above threshold. `top3`: that patch
 * is among the three strongest, which is what the guide marks on screen
 * (other planted planets are left out of the ranking). `aRecovered`: the
 * matching fainter patch at A (null when A is off the grid).
 *
 * `existing` holds the patches of the same pair with nothing planted. A patch
 * that was already there (a star residual, a glitch) only counts when the
 * planet made it at least `gainSigma` stronger; otherwise the planet is lost
 * in confusion, as it would be for a person blinking the frames.
 */
export function scoreTrials(difference, truths, { matchPx = 2, existing = [], gainSigma = 5 } = {}) {
  if (!difference) return truths.map(() => ({ recovered: false, top3: false, rank: -1, aRecovered: null, patches: 0 }));
  const blobs = patchesOf(difference);
  const near = (blob, point) => Math.hypot(blob.x - point.x, blob.y - point.y) <= matchPx;
  const plantedPatch = blob => truths.some(truth => near(blob, truth.b) || (truth.aInField && near(blob, truth.a)));
  const isNew = blob => existing.every(old => old.sign !== blob.sign || !near(old, blob) || blob.peakSigma >= old.peakSigma + gainSigma);
  return truths.map(truth => {
    const index = blobs.findIndex(blob => blob.sign === 'brighter' && near(blob, truth.b) && isNew(blob));
    const rank = index < 0 ? -1 : blobs.slice(0, index).filter(blob => !plantedPatch(blob)).length;
    return {
      recovered: index >= 0,
      top3: index >= 0 && rank < 3,
      rank,
      aRecovered: truth.aInField ? blobs.some(blob => blob.sign === 'fainter' && near(blob, truth.a) && isNew(blob)) : null,
      patches: blobs.length
    };
  });
}

/** Every patch in a difference image, strongest first (the `existing` list for scoreTrials). */
export function patchesOf(difference) {
  if (!difference) return [];
  return findBlobs({ significant: difference.significant, values: difference.values, width: Math.round(Math.sqrt(difference.values.length)), sigma: difference.sigma }, { limit: Infinity });
}

/**
 * Share of random grid positions that already have a brighter patch within
 * `matchPx` with nothing planted: how often a naive position match would be
 * pure chance on this pair.
 */
export function chanceMatchRate(existing, width, { matchPx = 2, samples = 4000, rng = mulberry32(99), marginPx = 6 } = {}) {
  const brighter = existing.filter(blob => blob.sign === 'brighter');
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const x = marginPx + rng() * (width - 1 - 2 * marginPx), y = marginPx + rng() * (width - 1 - 2 * marginPx);
    if (brighter.some(blob => Math.hypot(blob.x - x, blob.y - y) <= matchPx)) hits++;
  }
  return hits / samples;
}

/** scoreTrials for a single planted planet. */
export function scoreTrial(difference, truth, options) {
  return scoreTrials(difference, [truth], options)[0];
}

/** Wilson score interval for k successes in n trials (z = 1 → about 68%). */
export function wilson(k, n, z = 1) {
  if (!(n > 0)) return { p: NaN, low: 0, high: 1 };
  const p = k / n, z2 = z * z, denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Group rows into brightness bins of `step` σ: [{sigma (bin start), trials, hits}],
 * ascending. `sigmaOf` and `hitOf` read each row.
 */
export function binBySigma(rows, { step = 1, sigmaOf = row => row.peakSigma, hitOf = row => Boolean(row.found) } = {}) {
  const bins = new Map();
  for (const row of rows) {
    const sigma = sigmaOf(row);
    if (!Number.isFinite(sigma)) continue;
    const key = Number((Math.floor(sigma / step) * step).toFixed(6));
    const bin = bins.get(key) || { sigma: key, trials: 0, hits: 0 };
    bin.trials++; if (hitOf(row)) bin.hits++;
    bins.set(key, bin);
  }
  return [...bins.values()].sort((x, y) => x.sigma - y.sigma);
}

/**
 * Where a recovery curve first climbs through 50%: [{x, fraction}] sorted by
 * x, linearly interpolated. null when it never crosses (or starts above).
 */
export function fiftyPercentPoint(curve, level = 0.5) {
  for (let i = 1; i < curve.length; i++) {
    const before = curve[i - 1], after = curve[i];
    if (before.fraction < level && after.fraction >= level) {
      const t = (level - before.fraction) / (after.fraction - before.fraction);
      return before.x + t * (after.x - before.x);
    }
  }
  return null;
}
