// PlanetX suspicion patches: groups of neighbouring map tiles where the
// Planet Nine model (Brown & Batygin 2021) concentrates its still-allowed
// orbits. Each patch becomes a case file people can inspect and vote on.
// Pure and DOM-free; shared by planetx.js, planetx-case.js and the tests.

/** Map brightness of a tile on a log scale, 0 (none) to 1 (the strongest tile). */
export function intensity(share, maxShare) {
  if (!(maxShare > 0)) return 0;
  return Math.max(0, Math.min(1, Math.log1p(share * 10000) / Math.log1p(maxShare * 10000)));
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const range = values => ({ min: Math.min(...values), median: median(values), max: Math.max(...values) });
const signed = value => `${value < 0 ? '-' : '+'}${Math.abs(value).toFixed(1).padStart(4, '0')}`;

/** Stable case id taken from the patch's brightest tile, e.g. "p9-ra062.5-dec+12.5". */
export function patchId(cell) {
  return `p9-ra${cell.raDeg.toFixed(1).padStart(5, '0')}-dec${signed(cell.decDeg)}`;
}
export const CASE_ID_PATTERN = /^p9-ra\d{3}\.\d-dec[+-]\d{2}\.\d$/;

/**
 * Id for a single tile outside the public case files, e.g. "t9-ra062.5-dec+12.5".
 * People can vote on any tile; the team promotes well-backed ones by adding
 * the id to data/planetx-promoted.json, and the votes carry over.
 */
export function candidateId(cell) {
  return `t9-ra${cell.raDeg.toFixed(1).padStart(5, '0')}-dec${signed(cell.decDeg)}`;
}
export const CANDIDATE_ID_PATTERN = /^t9-ra\d{3}\.\d-dec[+-]\d{2}\.\d$/;
/** A public case id or a candidate tile id. */
export const ANY_CASE_ID_PATTERN = /^(p9|t9)-ra\d{3}\.\d-dec[+-]\d{2}\.\d$/;

/** The model tile a candidate id names, or null. */
export function cellForCandidate(model, id) {
  if (!CANDIDATE_ID_PATTERN.test(String(id))) return null;
  return (model?.cells || []).find(cell => candidateId(cell) === id) || null;
}

/**
 * Promoted tiles become one-tile public patches that keep their "t9-" id,
 * numbered after the model's own patches. Tiles already inside a model patch
 * and unknown ids are skipped.
 */
export function promotedPatches(model, ids = [], startNumber = 1, taken = new Set()) {
  const cells = model?.cells || [];
  if (!cells.length) return [];
  const maxShare = Math.max(...cells.map(cell => cell.share));
  const result = [];
  for (const id of new Set(ids)) {
    const cell = cellForCandidate(model, id);
    if (!cell || taken.has(cell)) continue;
    const patch = describePatch([cell], maxShare);
    patch.id = id;
    patch.promoted = true;
    patch.number = startNumber + result.length;
    result.push(patch);
  }
  return result;
}

/** Model patches plus promoted tiles: every public case file, numbered in order. */
export function publicCases(model, promotedIds = []) {
  const patches = findSuspicionPatches(model);
  const taken = new Set(patches.flatMap(patch => patch.cells));
  return [...patches, ...promotedPatches(model, promotedIds, patches.length + 1, taken)];
}

/** The promoted tile ids from data/planetx-promoted.json; an empty list if it cannot be read. */
export async function loadPromotedIds(fetchImpl = (...args) => fetch(...args)) {
  try {
    const response = await fetchImpl('/data/planetx-promoted.json', { cache: 'no-store' });
    if (!response.ok) return [];
    const { ids } = await response.json();
    return Array.isArray(ids) ? ids.filter(id => CANDIDATE_ID_PATTERN.test(String(id))) : [];
  } catch { return []; }
}

/**
 * Split the hot sky into compact case-sized patches. Tiles at or above
 * `minLevel` are taken brightest first: each unclaimed tile seeds a patch and
 * claims every unclaimed hot tile within `radiusDeg` of it (RA wraps at 0°/360°).
 * Patches holding less than `minShare` of the model are dropped. Returns
 * patches ordered by combined model share, numbered from 1.
 */
export function findSuspicionPatches(model, { minLevel = 0.6, radiusDeg = 11, minShare = 0.008 } = {}) {
  const cells = model?.cells || [];
  if (!cells.length) return [];
  const maxShare = Math.max(...cells.map(cell => cell.share));
  const hot = cells.filter(cell => intensity(cell.share, maxShare) >= minLevel).sort((a, b) => b.share - a.share);
  const claimed = new Set();
  const patches = [];
  for (const seed of hot) {
    if (claimed.has(seed)) continue;
    const members = hot.filter(cell => !claimed.has(cell) && separation(seed, cell) <= radiusDeg);
    for (const cell of members) claimed.add(cell);
    const patch = describePatch(members, maxShare);
    if (patch.totalShare >= minShare) patches.push(patch);
  }
  patches.sort((a, b) => b.totalShare - a.totalShare);
  patches.forEach((patch, index) => { patch.number = index + 1; });
  return patches;
}

/** Approximate angular distance in degrees between two tile centres. */
function separation(a, b) {
  const dRa = Math.min(Math.abs(a.raDeg - b.raDeg), 360 - Math.abs(a.raDeg - b.raDeg)) * Math.cos(((a.decDeg + b.decDeg) / 2) * Math.PI / 180);
  return Math.hypot(dRa, a.decDeg - b.decDeg);
}

function describePatch(cells, maxShare) {
  const peak = cells.reduce((best, cell) => (cell.share > best.share ? cell : best));
  const totalShare = cells.reduce((sum, cell) => sum + cell.share, 0);
  // Share-weighted centre; RA uses a circular mean so patches across 0° stay whole.
  let x = 0, y = 0, dec = 0;
  for (const cell of cells) {
    const angle = cell.raDeg * Math.PI / 180;
    x += Math.cos(angle) * cell.share; y += Math.sin(angle) * cell.share; dec += cell.decDeg * cell.share;
  }
  const raDeg = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  return {
    id: patchId(peak),
    number: 0,
    peak,
    centroid: { raDeg: Number(raDeg.toFixed(2)), decDeg: Number((dec / totalShare).toFixed(2)) },
    cells: [...cells].sort((a, b) => b.share - a.share),
    totalShare,
    peakLevel: intensity(peak.share, maxShare),
    distanceAu: range(cells.map(cell => cell.medianDistanceAu)),
    vMag: range(cells.map(cell => cell.medianVMag))
  };
}

/**
 * Community evidence for one case. `fraction` is a smoothed share of
 * "something here" votes (0.5 with no votes); `brightness` scales the patch on
 * the community map from about 0.35 (clearly dismissed) through 1 (undecided)
 * to 1.6 (clearly supported), growing with the number of votes.
 */
export function communityScore(tally = {}) {
  const something = Math.max(0, Number(tally.something) || 0);
  const nothing = Math.max(0, Number(tally.nothing) || 0);
  const votes = something + nothing;
  const fraction = (something + 1) / (votes + 2);
  const lean = (fraction - 0.5) * 2; // -1 … 1, already damped for few votes
  const brightness = lean >= 0 ? 1 + 0.6 * lean : 1 + 0.65 * lean;
  const label = !votes ? 'No votes yet' : lean > 0.15 ? 'Brightening' : lean < -0.15 ? 'Dimming' : 'Undecided';
  return { something, nothing, votes, fraction, brightness, label };
}
