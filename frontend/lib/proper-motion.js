// Which catalogued fast-moving stars passed through a spot. A star with high
// proper motion leaves its old catalogue position empty (Barnard's Star is
// about 4.4′ from its J2000 position by 2025), so a spot on empty sky can be
// explained by a star that was there years ago. Pure and DOM-free.

import { propagateGaia } from '../gaia-core.js';
import { separationArcsec } from './ecliptic.js';

const D = Math.PI / 180;
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Compass word for an offset given in arcseconds east and north. */
export function compassDirection(eastArcsec, northArcsec) {
  const angle = (Math.atan2(eastArcsec, northArcsec) / D + 360) % 360;
  return COMPASS[Math.round(angle / 45) % 8];
}

// Offset of a sky position from the spot, in arcseconds east and north (small-angle).
function offset(spot, position) {
  const dRa = ((position.raDeg - spot.raDeg + 540) % 360) - 180;
  return { east: dRa * Math.cos(spot.decDeg * D) * 3600, north: (position.decDeg - spot.decDeg) * 3600 };
}

/**
 * Gaia stars (ref epoch 2016) moving at least minPmMasYr whose straight-line
 * track came within toleranceArcsec of the spot between fromYear and toYear.
 * Nearest first. `now` is where each star is at nowYear.
 */
export function fastStarPasses(spot, stars, { fromYear = 2000, toYear, nowYear = toYear, minPmMasYr = 100, toleranceArcsec = 12 } = {}) {
  if (!Number.isFinite(toYear) || !Array.isArray(stars)) return [];
  const passes = [];
  for (const star of stars) {
    const pmra = Number(star.pmra), pmdec = Number(star.pmdec), refEpoch = Number(star.refEpoch) || 2016;
    if (!Number.isFinite(pmra) || !Number.isFinite(pmdec)) continue;
    const pm = Math.hypot(pmra, pmdec);
    if (pm < minPmMasYr) continue;
    const start = offset(spot, star), vEast = pmra / 1000, vNorth = pmdec / 1000;
    const tClosest = Math.min(toYear, Math.max(fromYear, refEpoch - (start.east * vEast + start.north * vNorth) / (vEast ** 2 + vNorth ** 2)));
    const at = t => ({ east: start.east + vEast * (t - refEpoch), north: start.north + vNorth * (t - refEpoch) });
    const closest = at(tClosest), closestArcsec = Math.hypot(closest.east, closest.north);
    if (closestArcsec > toleranceArcsec) continue;
    const position = propagateGaia({ ...star, refEpoch, pmra, pmdec }, nowYear), shift = offset(spot, position);
    passes.push({
      sourceId: String(star.sourceId), gMag: Number.isFinite(star.gMag) ? Number(star.gMag.toFixed(1)) : null,
      pmArcsecPerYear: Number((pm / 1000).toFixed(2)), closestArcsec: Number(closestArcsec.toFixed(1)), closestYear: Math.round(tClosest),
      now: {
        raDeg: Number(position.raDeg.toFixed(5)), decDeg: Number(position.decDeg.toFixed(5)),
        offsetArcmin: Number((separationArcsec(spot, position) / 60).toFixed(1)), direction: compassDirection(shift.east, shift.north)
      }
    });
  }
  return passes.sort((a, b) => a.closestArcsec - b.closestArcsec);
}

/** Decimal year of a UTC time in ms. */
export const yearOf = ms => 2000 + (ms - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86_400_000);
