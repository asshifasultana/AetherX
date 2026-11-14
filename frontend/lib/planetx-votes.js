// PlanetX community votes: shared totals from /api/cases when the record store
// is set up, otherwise this browser's own votes only. Each browser keeps a
// random voter id and its latest verdict per case; nothing personal is sent.

const VOTER_KEY = 'planetx-voter';
const VOTES_KEY = 'planetx-votes';

function storage() {
  try { return window.localStorage; } catch { return null; }
}
function readVotes() {
  try { return JSON.parse(storage()?.getItem(VOTES_KEY) || '{}') || {}; } catch { return {}; }
}
function writeVotes(votes) {
  try { storage()?.setItem(VOTES_KEY, JSON.stringify(votes)); } catch { /* storage blocked: the vote still goes to the server */ }
}

export function voterId() {
  const store = storage();
  try {
    const existing = store?.getItem(VOTER_KEY);
    if (existing) return existing;
  } catch { /* fall through to a fresh id */ }
  const id = globalThis.crypto?.randomUUID?.() || `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  try { store?.setItem(VOTER_KEY, id); } catch { /* an id per page view is the best we can do */ }
  return id;
}

/** This browser's verdict for a case: 'something', 'nothing' or null. */
export function myVote(caseId) {
  return readVotes()[caseId] || null;
}

function localTallies() {
  const tallies = {};
  for (const [caseId, verdict] of Object.entries(readVotes())) {
    tallies[caseId] = { something: verdict === 'something' ? 1 : 0, nothing: verdict === 'nothing' ? 1 : 0 };
  }
  return tallies;
}

/** {tallies: {caseId: {something, nothing}}, shared} — shared is false when only local votes are known. */
export async function loadTallies() {
  try {
    const response = await fetch('/api/cases?kind=vote&tally=1', { cache: 'no-store' });
    if (response.ok) {
      const { tallies } = await response.json();
      return { tallies: tallies || {}, shared: true };
    }
  } catch { /* offline or no API: fall back below */ }
  return { tallies: localTallies(), shared: false };
}

const FINDINGS_KEY = 'planetx-findings';
function readFindings() {
  try { return JSON.parse(storage()?.getItem(FINDINGS_KEY) || '{}') || {}; } catch { return {}; }
}

/**
 * Case-file submissions for one case, newest first: {findings, shared}.
 * Without the shared store only this browser's own submissions are known.
 */
export async function loadFindings(caseId) {
  try {
    const response = await fetch(`/api/cases?kind=finding&caseId=${encodeURIComponent(caseId)}`, { cache: 'no-store' });
    if (response.ok) {
      const { findings } = await response.json();
      return { findings: Array.isArray(findings) ? findings : [], shared: true };
    }
  } catch { /* offline or no API: fall back below */ }
  return { findings: readFindings()[caseId] || [], shared: false };
}

/**
 * File a case: the answers per suspect, the verdict, the AI's read if the
 * person looked, and the spot. Also counts as this browser's vote on the case.
 * `place` is {id, centroid: {raDeg, decDeg}} as for castVote.
 */
export async function submitFinding(place, { verdict, answers = {}, ai = null, spot = null }) {
  const entry = { verdict, answers, ai, spot, createdAt: new Date().toISOString() };
  const all = readFindings();
  all[place.id] = [entry, ...(all[place.id] || [])].slice(0, 20);
  try { storage()?.setItem(FINDINGS_KEY, JSON.stringify(all)); } catch { /* storage blocked: still sent to the server */ }
  let saved = false;
  try {
    const response = await fetch('/api/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'finding', payload: { caseId: place.id, voter: voterId(), ...entry } })
    });
    saved = response.ok;
  } catch { /* kept locally */ }
  const vote = await castVote(place, verdict);
  return { ...vote, saved: saved && vote.saved };
}

/** Record this browser's verdict and return the refreshed totals. */
export async function castVote(patch, verdict) {
  const votes = readVotes();
  votes[patch.id] = verdict;
  writeVotes(votes);
  let saved = false;
  try {
    const response = await fetch('/api/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'vote', payload: { caseId: patch.id, verdict, voter: voterId(), raDeg: patch.centroid.raDeg, decDeg: patch.centroid.decDeg } })
    });
    saved = response.ok;
  } catch { /* kept locally */ }
  const result = await loadTallies();
  return { ...result, saved };
}

// ---- "find the hidden planet" rounds -------------------------------------------
// Each round of the Planted Lab game or the viewer quest: game, brightness
// (peak over single-frame noise), found or not. Shared totals come from
// /api/cases; without the store, this browser's own rounds are counted.

const RECOVERY_KEY = 'planetx-recovery';
const RECOVERY_DISTANCES_AU = [50, 100, 200, 400, 700, 1000, 1500];
function readRecovery() {
  try { const list = JSON.parse(storage()?.getItem(RECOVERY_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
}

/** Bin rounds the way the shared views do: whole-σ bins per game, and Lab rounds per 0.25 mag × nearest grid distance. */
export function tallyRecovery(rounds) {
  const bins = new Map(), cells = new Map();
  for (const round of rounds) {
    if (!Number.isFinite(round?.peakSigma)) continue;
    const sigma = Math.floor(round.peakSigma), binKey = `${round.game}|${sigma}`;
    const bin = bins.get(binKey) || { game: round.game, sigma, trials: 0, found: 0 };
    bin.trials++; if (round.found) bin.found++;
    bins.set(binKey, bin);
    if (round.game === 'lab' && Number.isFinite(round.mag) && round.distanceAu > 0) {
      const mag = Math.round(round.mag * 4) / 4;
      const distanceAu = RECOVERY_DISTANCES_AU.reduce((best, d) => Math.abs(Math.log(d / round.distanceAu)) < Math.abs(Math.log(best / round.distanceAu)) ? d : best);
      const cellKey = `${mag}|${distanceAu}`;
      const cell = cells.get(cellKey) || { mag, distanceAu, trials: 0, found: 0 };
      cell.trials++; if (round.found) cell.found++;
      cells.set(cellKey, cell);
    }
  }
  return { bins: [...bins.values()], cells: [...cells.values()] };
}

/** Save one round (kept locally too, so the chart works without the shared store). */
export async function submitRecovery({ game, peakSigma, found, misses = 0, mag, distanceAu, baselineDays }) {
  const round = { game, peakSigma: Number(peakSigma), found: Boolean(found), misses, ...(Number.isFinite(mag) ? { mag } : {}), ...(Number.isFinite(distanceAu) ? { distanceAu } : {}), ...(Number.isFinite(baselineDays) ? { baselineDays } : {}) };
  if (!Number.isFinite(round.peakSigma)) return { saved: false };
  try { storage()?.setItem(RECOVERY_KEY, JSON.stringify([...readRecovery(), { ...round, createdAt: new Date().toISOString() }].slice(-200))); } catch { /* storage blocked: still sent to the server */ }
  try {
    const response = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'recovery', payload: { ...round, voter: voterId() } }) });
    return { saved: response.ok };
  } catch { return { saved: false }; }
}

/** {bins, cells, shared}: shared community totals, or this browser's own rounds when the store is not set up. */
export async function loadRecoveryTally() {
  try {
    const response = await fetch('/api/cases?kind=recovery&tally=1', { cache: 'no-store' });
    if (response.ok) {
      const { bins, cells } = await response.json();
      return { bins: Array.isArray(bins) ? bins : [], cells: Array.isArray(cells) ? cells : [], shared: true };
    }
  } catch { /* offline or no API: fall back below */ }
  return { ...tallyRecovery(readRecovery()), shared: false };
}
