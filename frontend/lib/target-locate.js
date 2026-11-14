// Where the target star actually is on a frame's date. Catalogue and preset
// positions are J2000 (or the discovery epoch), so a fast-moving star such as
// Barnard's Star sits arcminutes away from them by the time SPHEREx looked.
// Pure and DOM-free; the browser supplies the nearby catalogue stars.

import { presetMotion, motionPosition } from '../presets.js';
import { fastStarPasses, yearOf, compassDirection } from './proper-motion.js';
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

const BRIGHT_G_MAG = 15;
const BRIGHT_REACH_ARCSEC = 45;

/**
 * The nearest bright Gaia star (G ≤ 15) within 45″ of a position, moved to the
 * frame date: when a position has no star of its own, its light is usually the
 * wing of this one. Null when there is none.
 * @returns {{sourceId:string, gMag:number, raDeg:number, decDeg:number, separationArcsec:number, direction:string} | null}
 */
export function nearestBrightStar({ position, frameTime, gaiaSources = [] }) {
  if (!Number.isFinite(position?.raDeg) || !Number.isFinite(position?.decDeg)) return null;
  const year = yearOf(Number.isFinite(frameTime) ? frameTime : Date.now());
  let best = null;
  for (const star of Array.isArray(gaiaSources) ? gaiaSources : []) {
    const gMag = Number(star.gMag);
    if (!(gMag <= BRIGHT_G_MAG) || !Number.isFinite(star.raDeg) || !Number.isFinite(star.decDeg)) continue;
    const now = propagateGaia({ ...star, refEpoch: Number(star.refEpoch) || 2016, pmra: Number(star.pmra) || 0, pmdec: Number(star.pmdec) || 0 }, year);
    const separation = separationArcsec(position, now);
    if (separation <= BRIGHT_REACH_ARCSEC && (!best || separation < best.separation)) best = { star, now, separation, gMag };
  }
  if (!best) return null;
  const dRa = ((best.now.raDeg - position.raDeg + 540) % 360) - 180;
  const east = dRa * Math.cos(position.decDeg * Math.PI / 180) * 3600, north = (best.now.decDeg - position.decDeg) * 3600;
  return {
    sourceId: String(best.star.sourceId), gMag: Number(best.gMag.toFixed(1)),
    raDeg: fixed(((best.now.raDeg % 360) + 360) % 360), decDeg: fixed(best.now.decDeg),
    separationArcsec: Number(best.separation.toFixed(1)), direction: compassDirection(east, north)
  };
}
