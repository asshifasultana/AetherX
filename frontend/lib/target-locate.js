// Where the target star actually is on a frame's date. Catalogue and preset
// positions are J2000 (or the discovery epoch), so a fast-moving star such as
// Barnard's Star sits arcminutes away from them by the time SPHEREx looked.
// Pure and DOM-free; the browser supplies the nearby catalogue stars.

import { presetMotion, motionPosition } from '../presets.js';
import { fastStarPasses, yearOf } from './proper-motion.js';
import { propagateGaia } from '../gaia-core.js';
import { separationArcsec } from './ecliptic.js';

const DAY_MS = 86_400_000;
const MATCH_ARCSEC = 6;
const PASS_ARCSEC = 12;
const fixed = (value, digits = 6) => Number(value.toFixed(digits));

/**
 * @param {object} input
 * @param {{raDeg:number, decDeg:number, targetId?:string}} input.target the chosen target
 * @param {number} input.frameTime UTC ms of the frame on screen
 * @param {Array} [input.gaiaSources] catalogue stars {sourceId, raDeg, decDeg, refEpoch, pmra, pmdec}
 * @returns {{raDeg:number, decDeg:number, method:'preset'|'fast-star'|'catalogue-star'|'catalogue', sourceId?:string, sinceYear?:number, movedArcmin:number}}
 */
export function locateTarget({ target, frameTime, gaiaSources = [] }) {
  if (!Number.isFinite(target?.raDeg) || !Number.isFinite(target?.decDeg)) return null;
  const time = Number.isFinite(frameTime) ? frameTime : Date.now();
  const year = yearOf(time), stars = Array.isArray(gaiaSources) ? gaiaSources : [];
  const result = (position, method, extra = {}) => ({
    raDeg: fixed(((position.raDeg % 360) + 360) % 360), decDeg: fixed(position.decDeg), method,
    movedArcmin: Number((separationArcsec(target, position) / 60).toFixed(1)), ...extra
  });
  // 1. A preset with a known proper motion.
  const motion = presetMotion(target);
  if (motion) {
    const now = motionPosition(motion, time / DAY_MS + 40587);
    return { ...result(now, 'preset'), sinceYear: 2000, movedArcmin: Number((separationArcsec(motion, now) / 60).toFixed(1)) };
  }
  // 2. A fast star whose track since 2000 crossed the target position: the
  // target's catalogue position is out of date, and this is where it went.
  const [pass] = fastStarPasses(target, stars, { fromYear: 2000, toYear: year, nowYear: year, toleranceArcsec: PASS_ARCSEC });
  if (pass) return result(pass.now, 'fast-star', { sourceId: pass.sourceId, sinceYear: 2000 });
  // 3. The nearest catalogue star within 6″, moved to the frame date.
  let best = null;
  for (const star of stars) {
    const refEpoch = Number(star.refEpoch) || 2016;
    const position = propagateGaia({ ...star, refEpoch, pmra: Number(star.pmra), pmdec: Number(star.pmdec) }, year);
    const atRef = separationArcsec(target, star);
    const separation = Math.min(atRef, separationArcsec(target, position));
    if (separation <= MATCH_ARCSEC && (!best || separation < best.separation)) best = { star, position, separation };
  }
  if (best) return result(best.position, 'catalogue-star', { sourceId: String(best.star.sourceId) });
  // 4. Nothing better: the position as given.
  return result(target, 'catalogue');
}
