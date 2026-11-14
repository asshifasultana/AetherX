// Choosing two frames to subtract. SPHEREx sees a given sky position at a
// slightly different wavelength on every visit, so a star's brightness changes
// between frames for colour reasons alone. Pairs are scored on how close the
// time gap is to the one wanted and on how closely their wavelengths match.
// Pure and DOM-free.

const DAY_MS = 86_400_000;
export const WAVELENGTH_SCALE_UM = 0.02;
export const WAVELENGTH_WARN_UM = 0.03;

/** Lower is better: |gap − wanted| / wanted + |Δλ| / 0.02 μm (Δλ ignored when unknown). */
export function epochPairScore({ gapDays, wantedDays, deltaUm = null }) {
  const timePart = Math.abs(gapDays - wantedDays) / Math.max(1, wantedDays);
  return timePart + (Number.isFinite(deltaUm) ? Math.abs(deltaUm) / WAVELENGTH_SCALE_UM : 0);
}

/**
 * Best (earlier, later) pair from frames with frameTime (ms). wavelengthOf(frame)
 * returns μm or null; when fewer than two frames have a wavelength, the time gap
 * alone decides and `wavelengthMatched` is false.
 */
export function chooseEpochPair(frames, { gapDays = 180, wavelengthOf = () => null } = {}) {
  const list = (frames || []).filter(frame => Number.isFinite(frame?.frameTime));
  const known = list.filter(frame => Number.isFinite(wavelengthOf(frame)));
  const useWavelength = known.length >= 2;
  const pool = useWavelength ? known : list;
  let best = null;
  for (const later of pool) for (const earlier of pool) {
    if (earlier.frameTime >= later.frameTime) continue;
    const gap = (later.frameTime - earlier.frameTime) / DAY_MS;
    const deltaUm = useWavelength ? wavelengthOf(later) - wavelengthOf(earlier) : null;
    // A tiny preference for later frames breaks ties deterministically.
    const score = epochPairScore({ gapDays: gap, wantedDays: gapDays, deltaUm }) - later.frameTime / 1e15;
    if (!best || score < best.score) best = { score, earlier, later, gapDays: gap, deltaUm };
  }
  return best ? { ...best, wavelengthMatched: useWavelength } : null;
}
