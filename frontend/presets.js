// The UI positions also identify legacy shared links and index snapshots.
export const presets = {
  barnard: { name: 'Barnard’s Star', type: 'RED DWARF · OPHIUCHUS', description: 'One of our closest stellar neighbors. The preset follows its proper motion across observation dates.', raDeg: 269.4521, decDeg: 4.6934 },
  epsilon: { name: 'Epsilon Indi B', type: 'BROWN-DWARF SYSTEM · INDUS', description: 'Two faint companions. A fascinating destination to explore beyond the light our eyes can see.', raDeg: 330.8413, decDeg: -56.7859 },
  wise: { name: 'WISE 0855', type: 'SUBSTELLAR OBJECT · HYDRA', description: 'A cold, faint neighbor that invites us to look beyond visible light and into the infrared.', raDeg: 133.79512916666666, decDeg: -7.245147222222222 },
  aurigae: { name: 'RW Aurigae', type: 'YOUNG STELLAR SYSTEM · AURIGA', description: 'A young stellar system with a changing story. A place to look for the unexpected.', raDeg: 76.9567, decDeg: 30.4043 },
  draconis: { name: 'R Draconis', type: 'VARIABLE STAR · DRACO', description: 'Follow the rhythm of a variable star and imagine the stories hidden between observations.', raDeg: 248.1217, decDeg: 66.7569 }
};

// SIMBAD ICRS J2000 position and Gaia EDR3 proper motion for GJ 699.
// https://simbad.cds.unistra.fr/simbad/sim-id?Ident=Barnard%27s+Star
const barnardDec = 4 + 41 / 60 + 36.113879676 / 3600;
const barnardMotion = {
  epochMjd: 51544.5,
  raDeg: (17 + 57 / 60 + 48.4984700685 / 3600) * 15,
  decDeg: barnardDec,
  raPerDay: -801.551 / (3.6e6 * 365.25 * Math.cos(barnardDec * Math.PI / 180)),
  decPerDay: 10362.394 / (3.6e6 * 365.25),
};

export function presetMotion(position) {
  const preset = presets.barnard;
  return position.targetId === 'barnard' && position.raDeg === preset.raDeg && position.decDeg === preset.decDeg
    ? barnardMotion : null;
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
  const days = midpoint - motion.epochMjd;
  return { raDeg: motion.raDeg + days * motion.raPerDay, decDeg: motion.decDeg + days * motion.decPerDay };
}
