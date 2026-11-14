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
