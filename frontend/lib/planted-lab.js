// Maths for the PlanetX "Planted Planet Lab": how bright a fake planet of a
// given AB magnitude looks in a real SPHEREx image, how far Earth's motion
// shifts it between two dates at a given distance, and how that compares
// with the image noise. Pure.

import { parallaxShift } from './ecliptic.js';

export const AB_ZERO_POINT_JY = 3631;
/** Gaussian width (pixels) of the fake source: the same kernel the viewer's hidden-planet quest uses. */
export const PLANT_SIGMA_PX = 0.7;
/** Published approximate SPHEREx point-source depth per spectral channel (AB, 5σ). */
export const SPHEREX_DEPTH_AB = [19.5, 19.9];

const ARCSEC_PER_RADIAN = 206264.806;

/** Peak surface brightness (MJy/sr) of a point source of `magAB` drawn as a 2-D Gaussian. */
export function magToPeak(magAB, { pixelArcsec = 6.15, sigmaPx = PLANT_SIGMA_PX } = {}) {
  const fluxMJy = AB_ZERO_POINT_JY * 10 ** (-0.4 * magAB) * 1e-6;
  const pixelSr = (pixelArcsec / ARCSEC_PER_RADIAN) ** 2;
  return fluxMJy / (2 * Math.PI * sigmaPx ** 2 * pixelSr);
}

/** AB magnitude whose peak equals `peak` (inverse of magToPeak). */
export function peakToMag(peak, options) {
  return -2.5 * Math.log10(peak / magToPeak(0, options));
}

export const peakSigma = (peak, noise) => (noise > 0 ? peak / noise : NaN);

/** Faintest magnitude whose peak still reaches `nSigma` times the noise. */
export function limitingMag(noise, nSigma = 5, options) {
  return peakToMag(nSigma * noise, options);
}

/** Plain-language verdict for a peak signal-to-noise ratio. */
export function visibility(sigma) {
  if (sigma >= 10) return { id: 'obvious', label: 'Obvious', note: 'Anyone blinking these frames would spot it.' };
  if (sigma >= 5) return { id: 'findable', label: 'Findable', note: 'A careful search finds it: above the usual 5σ detection bar.' };
  if (sigma >= 3) return { id: 'lost', label: 'Lost in the noise', note: 'Below the 5σ bar. Noise bumps this bright are everywhere, so a search cannot claim it.' };
  return { id: 'invisible', label: 'Invisible', note: 'Fainter than the noise itself. Nothing in these images could reveal it.' };
}

/**
 * How far a distant body appears to move between two dates because Earth
 * moves (its own orbital motion is negligible beyond ~100 AU). Returns the
 * shift in arcsec and as a pixel offset on a north-up, east-left grid.
 */
export function planetShift({ raDeg, decDeg, distanceAu, fromMjd, toMjd, pixelArcsec = 6.15 }) {
  const shift = parallaxShift({ raDeg, decDeg, distanceAu, fromMjd, toMjd });
  const angle = shift.positionAngleDeg * Math.PI / 180, days = Math.abs(toMjd - fromMjd);
  const arcsec = shift.offsetArcsec;
  return {
    arcsec, days,
    arcsecPerDay: days ? arcsec / days : 0,
    pixels: arcsec / pixelArcsec,
    // East is to the left (−x) and north is up (−y) on the display grid.
    dx: -arcsec * Math.sin(angle) / pixelArcsec,
    dy: -arcsec * Math.cos(angle) / pixelArcsec,
    positionAngleDeg: shift.positionAngleDeg
  };
}

/** A copy of `values` with a Gaussian of height `peak` added at (x, y). */
export function plantInto(values, width, { x, y }, peak, sigmaPx = PLANT_SIGMA_PX) {
  const copy = Float32Array.from(values), height = Math.floor(copy.length / width);
  if (!(peak > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return copy;
  const reach = Math.ceil(4 * sigmaPx), spread = 2 * sigmaPx ** 2;
  for (let row = Math.floor(y) - reach; row <= Math.ceil(y) + reach; row++) {
    for (let column = Math.floor(x) - reach; column <= Math.ceil(x) + reach; column++) {
      if (column < 0 || row < 0 || column >= width || row >= height) continue;
      const index = row * width + column;
      if (Number.isFinite(copy[index])) copy[index] += peak * Math.exp(-((column - x) ** 2 + (row - y) ** 2) / spread);
    }
  }
  return copy;
}

/** Decode a base64 little-endian Float32 plane (as written by scripts/bake-planted-lab.mjs). */
export function decodePlane(base64) {
  const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
