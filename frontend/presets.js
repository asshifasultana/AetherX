// The UI positions also identify legacy shared links and index snapshots.
export const presets = {
  barnard: { name: 'Barnard’s Star', type: 'RED DWARF · OPHIUCHUS', description: 'One of our closest stellar neighbors. Background stars hold still so you can watch it move across the dates.', raDeg: 269.4521, decDeg: 4.6934 },
  // The brown-dwarf pair, 6.7′ east of the bright primary Epsilon Indi A.
  epsilon: { name: 'Epsilon Indi B', type: 'BROWN-DWARF SYSTEM · INDUS', description: 'Two faint companions. Background stars hold still so you can watch them move across the dates.', raDeg: 331.0441, decDeg: -56.7828 },
  // The challenge's discovery-epoch coordinates; cutouts follow proper motion.
  wise: { name: 'WISE 0855', type: 'SUBSTELLAR OBJECT · HYDRA', description: 'A cold, fast-moving neighbor. Background stars hold still so you can watch it move across the dates.', raDeg: 133.79512916666666, decDeg: -7.245147222222222 },
  aurigae: { name: 'RW Aurigae', type: 'YOUNG STELLAR SYSTEM · AURIGA', description: 'A young stellar system with a changing story. A place to look for the unexpected.', raDeg: 76.9567, decDeg: 30.4043 },
  draconis: { name: 'R Draconis', type: 'VARIABLE STAR · DRACO', description: 'Follow the rhythm of a variable star and imagine the stories hidden between observations.', raDeg: 248.1676, decDeg: 66.7550 }
};

// Linear proper motion from a J2000 (MJD 51544.5) ICRS reference position.
// Parallax and perspective acceleration are not modelled (≤ 0.55″ here).
const linearMotion = (raDeg, decDeg, pmRaMasYr, pmDecMasYr) => ({
  epochMjd: 51544.5, raDeg, decDeg,
  raPerDay: pmRaMasYr / (3.6e6 * 365.25 * Math.cos(decDeg * Math.PI / 180)),
  decPerDay: pmDecMasYr / (3.6e6 * 365.25),
});
const MOTIONS = {
  // SIMBAD position and Gaia EDR3 proper motion for GJ 699.
  // https://simbad.cds.unistra.fr/simbad/sim-id?Ident=Barnard%27s+Star
  barnard: linearMotion((17 + 57 / 60 + 48.4984700685 / 3600) * 15, 4 + 41 / 60 + 36.113879676 / 3600, -801.551, 10362.394),
  // SIMBAD J2000 position of eps Ind B with the system's Gaia DR3 proper motion
  // (measured on eps Ind A; the wide pair shares it).
  epsilon: linearMotion(331.04414658852124, -56.78284419511611, 3966.661, -2536.192),
  // SIMBAD J2000 position (WISEA J085510.74-071442.5) and proper motion
  // (Luhman & Esplin 2016). The 2013 discovery position is ~2′ from 2026 data.
  wise: linearMotion(133.81890825, -7.247048, -8118, 680),
};

// Position used when the viewer is asked to hold the sky fixed instead of
// following the star: the star's place on 2026-01-01, mid-way through the data.
export const FIXED_SKY_MJD = 61041;

export function presetMotion(position) {
  const motion = MOTIONS[position?.targetId], preset = presets[position?.targetId];
  return motion && position.raDeg === preset.raDeg && position.decDeg === preset.decDeg ? motion : null;
}

export function motionPosition(motion, mjd) {
  const days = mjd - motion.epochMjd;
  return { raDeg: motion.raDeg + days * motion.raPerDay, decDeg: motion.decDeg + days * motion.decPerDay };
}

// The viewer's target. When proper motion is followed, the preset is returned
// unchanged and each exposure is centred on the star. Otherwise a fixed sky
// position (no targetId) is returned so background stars stay still and the
// star itself visibly moves.
export function viewerTarget(position, followMotion = true) {
  const motion = presetMotion(position);
  if (followMotion || !motion) return position;
  const { targetId, ...rest } = position;
  return { ...rest, ...motionPosition(motion, FIXED_SKY_MJD), fixedSkyFor: targetId };
}

export function exposureMidpointMjd(observation) {
  const isoMjd = value => Date.parse(value) / 86400000 + 40587;
  const start = observation.startMjd ?? isoMjd(observation.observedStartUtc);
  const end = observation.endMjd ?? isoMjd(observation.observedEndUtc);
  if (!Number.isFinite(start)) return NaN;
  if (Number.isFinite(end) && end >= start) return (start + end) / 2;
  return start + (Number.isFinite(observation.exposureSeconds) ? observation.exposureSeconds : 0) / 172800;
}

export function exposureCenter(position, observation) {
  const motion = presetMotion(position);
  const midpoint = motion ? exposureMidpointMjd(observation) : NaN;
  if (!Number.isFinite(midpoint)) return position;
  return motionPosition(motion, midpoint);
}
