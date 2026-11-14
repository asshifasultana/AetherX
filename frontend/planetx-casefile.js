// PlanetX case file in the SPHEREx viewer. Opened from planetx.html ("Jump to
// coordinate") or a case page with ?px=<case id>: a public suspicion patch
// ("p9-…") or any other 5° tile ("t9-…"). The person marks a spot, answers one
// question per AI suspect (lib/case-file.js), may compare with the AI guide's
// own decision for that spot, then files a verdict. Earlier submissions for
// the case are shown above the form.

import { SUSPECTS } from './lib/case-file.js';
import { publicCases, loadPromotedIds, communityScore, cellForCandidate, ANY_CASE_ID_PATTERN, CANDIDATE_ID_PATTERN } from './lib/planetx-suspects.js';
import { loadTallies, loadFindings, submitFinding, myVote } from './lib/planetx-votes.js';

const $ = id => document.getElementById(id);
const section = $('planetx-casefile');
// Read now: share.js rewrites the address bar shortly after load.
const params = new URLSearchParams(location.search);
const caseId = (params.get('px') || '').trim();

const HINTS = {
  glitch: 'Seen on 2 or more dates? Then it is not a one-off glitch.',
  colour_shift: 'Is it right next to a bright star or masked (black) pixels?',
  known_star: 'Turn on the Gaia / catalogue overlay: does a catalogued star sit on it?',
  proper_motion_star: 'Does a catalogued star move through this place over the years?',
  known_asteroid: 'Does it hop between dates along a straight track, like an asteroid?',
  variable_star: 'Same place on every date, but brighter on some and fainter on others?',
  distant_unknown: 'Moves only slowly and nothing above explains it.'
};
const ANSWERS = [['ruled_out', '✗', 'Ruled out'], ['supported', '✓', 'Looks like it'], ['unsure', '?', 'Not sure']];
const AI_MARK = { ruled_out: '✗', supported: '✓', open: '?' };
const AI_WORD = { ruled_out: 'Ruled out', supported: 'Supported', open: 'Not checked' };

const format = (value, digits = 1) => Number(value).toFixed(digits);
const pct = value => `${(Number(value) * 100).toFixed(2)}%`;
const signedDec = (dec, digits = 1) => `${dec < 0 ? '−' : '+'}${format(Math.abs(dec), digits)}°`;
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'role' || key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
};

let place = null;          // {id, centroid: {raDeg, decDeg}} for votes
let isPublic = false;
let spots = [];            // the viewer's marked spots
const aiCases = new Map(); // spot n → AI guide case summary
let aiShown = false, aiPending = null, busy = false;

function selectedSpot() {
  const n = Number($('px-casefile-spot').value);
  return spots.find(spot => spot.n === n) || null;
}
/** The AI's summary for a spot, only while it still describes the same position. */
function aiFor(spot) {
  const summary = spot && aiCases.get(spot.n);
  if (!summary) return null;
  return Math.abs(summary.raDeg - spot.raDeg) < 1e-4 && Math.abs(summary.decDeg - spot.decDeg) < 1e-4 ? summary : null;
}

// ---- Header and tallies -----------------------------------------------------
async function renderTally() {
  const { tallies } = await loadTallies();
  const score = communityScore(tallies[caseId]);
  $('px-casefile-bar').style.width = score.votes ? `${Math.round(100 * score.something / score.votes)}%` : '50%';
  $('px-casefile-bar').parentElement.classList.toggle('is-empty', !score.votes);
  const mine = myVote(caseId);
  $('px-casefile-votes').textContent = (score.votes
    ? `${score.something} said something here · ${score.nothing} said nothing here — ${score.label.toLowerCase()}.`
    : 'No votes yet.') + (mine ? ` You said “${mine === 'something' ? 'something here' : 'nothing here'}”.` : '');
}

// ---- Earlier findings -------------------------------------------------------
function renderHistory(findings, shared) {
  const body = $('px-casefile-history-body');
  if (!findings.length) {
    body.replaceChildren(el('p', { className: 'px-casefile-muted', textContent: isPublic
      ? 'No one has filed this case yet. Be the first.'
      : 'No one has filed this tile yet. Tiles that many people back can be promoted to public case files.' }));
    return;
  }
  const count = findings.length;
  const something = findings.filter(item => item.verdict === 'something').length;
  const rows = Object.entries(SUSPECTS).map(([key, { label }]) => {
    const tally = { ruled_out: 0, supported: 0 };
    for (const item of findings) if (tally[item.answers?.[key]] !== undefined) tally[item.answers[key]] += 1;
    const parts = [tally.ruled_out && `${tally.ruled_out} ruled it out`, tally.supported && `${tally.supported} said it looks like it`].filter(Boolean);
    return el('li', {}, el('span', { textContent: label }), el('small', { textContent: parts.length ? parts.join(' · ') : 'no one was sure' }));
  });
  const aiLabels = new Map();
  for (const item of findings) if (item.ai?.label) aiLabels.set(item.ai.label, (aiLabels.get(item.ai.label) || 0) + 1);
  const recent = findings.slice(0, 5).map(item => {
    const day = item.createdAt ? new Date(item.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Earlier';
    return el('li', {}, el('strong', { textContent: item.verdict === 'something' ? 'Something here' : 'Nothing here' }),
      el('small', { textContent: `${day}${item.ai?.label ? ` · AI said “${item.ai.label}”` : ''}${item.spot ? ` · spot at ${format(item.spot.raDeg, 4)}°, ${signedDec(item.spot.decDeg, 4)}` : ''}` }));
  });
  body.replaceChildren(
    el('p', { className: 'px-casefile-summary', textContent: `${count} case file${count === 1 ? '' : 's'} so far: ${something} said something here, ${count - something} said nothing here.${shared ? '' : ' (Only the ones saved in this browser: the shared store is not available here.)'}` }),
    el('ul', { className: 'px-casefile-suspect-summary' }, ...rows),
    aiLabels.size ? el('p', { className: 'px-casefile-muted', textContent: `The AI guide’s decisions they saw: ${[...aiLabels].map(([label, n]) => `${label} (${n})`).join(', ')}.` }) : null,
    el('h5', { textContent: 'Latest case files' }),
    el('ul', { className: 'px-casefile-recent' }, ...recent)
  );
}
async function refreshHistory() {
  const { findings, shared } = await loadFindings(caseId);
  renderHistory(findings, shared);
}

// ---- Checklist --------------------------------------------------------------
function buildRows() {
  $('px-casefile-rows').replaceChildren(...Object.entries(SUSPECTS).map(([key, { label }]) => {
    const choices = el('div', { className: 'px-casefile-choices', role: 'radiogroup', 'aria-label': label },
      ...ANSWERS.map(([value, mark, word]) => el('label', { title: word },
        el('input', { type: 'radio', name: `px-answer-${key}`, value, checked: value === 'unsure' }),
        el('span', { className: `px-casefile-mark is-${value}`, textContent: mark }), el('span', { textContent: word }))));
    return el('div', { className: 'px-casefile-row', role: 'row' },
      el('div', { role: 'cell' }, el('strong', { textContent: label }), el('small', { textContent: HINTS[key] })),
      el('div', { role: 'cell' }, choices),
      el('div', { role: 'cell', className: 'px-casefile-ai-col', hidden: true, 'data-ai': key }));
  }));
}
const answers = () => Object.fromEntries(Object.keys(SUSPECTS).map(key => [key, document.querySelector(`input[name="px-answer-${key}"]:checked`)?.value || 'unsure']));
const verdictChoice = () => document.querySelector('input[name="px-casefile-verdict"]:checked')?.value || null;

function renderAi() {
  const spot = selectedSpot(), summary = aiFor(spot);
  for (const node of document.querySelectorAll('#planetx-casefile .px-casefile-ai-col')) node.hidden = !aiShown;
  const button = $('px-casefile-ai-button');
  button.setAttribute('aria-expanded', String(aiShown));
  button.textContent = aiShown ? 'Hide the AI’s decision' : 'See the AI’s decision';
  if (!aiShown) return;
  const status = $('px-casefile-ai-status');
  if (!summary) {
    for (const cell of document.querySelectorAll('#px-casefile-rows [data-ai]')) cell.replaceChildren(el('span', { className: 'px-casefile-muted', textContent: '…' }));
    status.textContent = aiPending === spot?.n ? `Asked the AI guide to check spot ${spot.n}. Its decision appears here when it is done.` : 'The AI guide has not checked this spot yet.';
    return;
  }
  const bySuspect = new Map((summary.suspects || []).map(item => [item.key, item]));
  for (const cell of document.querySelectorAll('#px-casefile-rows [data-ai]')) {
    const item = bySuspect.get(cell.dataset.ai);
    cell.replaceChildren(item
      ? el('span', { className: `px-casefile-ai-answer is-${item.status}`, title: item.evidence || AI_WORD[item.status] },
        el('span', { className: `px-casefile-mark is-${item.status === 'open' ? 'unsure' : item.status}`, textContent: AI_MARK[item.status] || '?' }),
        el('span', { textContent: item.evidence || AI_WORD[item.status] }))
      : el('span', { className: 'px-casefile-muted', textContent: summary.radiusArcsec ? 'Area: see below' : 'Not checked' }));
  }
  const findings = summary.findings?.length ? ` Inside the area: ${summary.findings.join(' ')}` : '';
  status.textContent = `AI decision for spot ${summary.spot}: ${summary.verdict?.label || 'open'}. ${summary.verdict?.detail || ''}${findings}`;
}

function syncForm() {
  const spot = selectedSpot();
  $('px-casefile-spot-hint').hidden = Boolean(spots.length);
  $('px-casefile-ai-button').disabled = !spot;
  $('px-casefile-submit').disabled = busy || !spot || !verdictChoice();
}

function renderSpots() {
  const select = $('px-casefile-spot'), previous = Number(select.value);
  select.replaceChildren(spots.length
    ? el('option', { value: '', textContent: 'Choose a marked spot' })
    : el('option', { value: '', textContent: 'No spot marked yet' }),
  ...spots.map(spot => el('option', { value: String(spot.n), textContent: `Spot ${spot.n}${spot.label ? ` · ${spot.label}` : ''}${spot.radiusArcsec ? ` · area ${Math.round(spot.radiusArcsec)}″` : ''} · ${format(spot.raDeg, 4)}°, ${signedDec(spot.decDeg, 4)}` })));
  const keep = spots.some(spot => spot.n === previous) ? previous : spots.length === 1 ? spots[0].n : null;
  select.value = keep === null ? '' : String(keep);
  syncForm();
  renderAi();
}

function askAi() {
  const spot = selectedSpot();
  if (!spot) return;
  aiShown = !aiShown;
  if (aiShown && !aiFor(spot) && aiPending !== spot.n) {
    const text = spot.radiusArcsec
      ? `Check spot ${spot.n}: what is inside this area? Crossmatch it against the star and asteroid catalogues and measure its brightness on every date.`
      : `Check spot ${spot.n}: crossmatch it against the star and asteroid catalogues, measure it on every date, and give your verdict.`;
    window.dispatchEvent(new CustomEvent('sky:agent-prompt-requested', { detail: { text, spot: spot.n, respond: ok => {
      aiPending = ok ? spot.n : null;
      if (!ok) $('px-casefile-ai-status').textContent = 'The AI guide is busy. Try again when it has finished.';
      renderAi();
    } } }));
  }
  renderAi();
}

async function submit(event) {
  event.preventDefault();
  const spot = selectedSpot(), verdict = verdictChoice();
  if (!spot || !verdict || busy) { syncForm(); return; }
  busy = true; syncForm();
  $('px-casefile-status').textContent = 'Filing…';
  const summary = aiShown ? aiFor(spot) : null;
  const ai = summary ? { label: summary.verdict?.label || 'open', suspects: Object.fromEntries((summary.suspects || []).map(item => [item.key, item.status])) } : null;
  try {
    const result = await submitFinding(place, { verdict, answers: answers(), ai, spot: { raDeg: spot.raDeg, decDeg: spot.decDeg, ...(spot.radiusArcsec ? { radiusArcsec: spot.radiusArcsec } : {}) } });
    $('px-casefile-status').textContent = result.saved
      ? 'Case file submitted. Thank you — it now counts towards this case on the community map.'
      : 'Case file saved in this browser. The shared store is not available here, so others will not see it yet.';
  } catch {
    $('px-casefile-status').textContent = 'Could not file the case right now. Please try again.';
  }
  busy = false; syncForm();
  await Promise.all([renderTally(), refreshHistory()]);
}

// ---- Start --------------------------------------------------------------------
async function start() {
  section.hidden = false;
  buildRows();
  syncForm();
  $('px-casefile-form').addEventListener('submit', submit);
  $('px-casefile-form').addEventListener('change', event => {
    if (event.target.id === 'px-casefile-spot') { aiShown = false; $('px-casefile-ai-status').textContent = ''; renderAi(); }
    syncForm();
  });
  $('px-casefile-ai-button').addEventListener('click', askAi);
  window.addEventListener('sky:spots-changed', event => { spots = Array.isArray(event.detail?.spots) ? event.detail.spots : []; renderSpots(); });
  window.addEventListener('sky:case-updated', event => {
    const summary = event.detail?.case;
    if (!summary || !Number.isInteger(summary.spot)) return;
    aiCases.set(summary.spot, summary);
    if (summary.spot === aiPending && summary.verdict?.label !== 'open') aiPending = null;
    if (summary.spot === selectedSpot()?.n) renderAi();
  });
  // Spots already on the image (a shared link) before this module listened.
  window.dispatchEvent(new CustomEvent('sky:spots-requested', { detail: { respond: list => { if (Array.isArray(list)) { spots = list; renderSpots(); } } } }));

  const raDeg = Number(params.get('ra')), decDeg = Number(params.get('dec'));
  let name = 'PlanetX case', where = '', centroid = Number.isFinite(raDeg) && Number.isFinite(decDeg) ? { raDeg, decDeg } : null;
  try {
    const response = await fetch('/data/planet-nine.json');
    if (!response.ok) throw new Error('model');
    const model = await response.json();
    const patch = publicCases(model, await loadPromotedIds()).find(item => item.id === caseId);
    if (patch) {
      isPublic = true;
      centroid = patch.centroid;
      name = `Case file #${patch.number}${patch.promoted ? ' · promoted tile' : ''}`;
      where = `Centre RA ${format(patch.centroid.raDeg, 2)}°, Dec ${signedDec(patch.centroid.decDeg, 2)} · ${patch.cells.length} tile${patch.cells.length === 1 ? '' : 's'} · ${pct(patch.totalShare)} of the model’s still-allowed orbits`;
      $('px-casefile-back').href = `/planetx-case.html?id=${encodeURIComponent(patch.id)}`;
      $('px-casefile-back').textContent = `Open the full case page for #${patch.number}`;
    } else {
      const cell = cellForCandidate(model, caseId);
      if (cell) {
        centroid = { raDeg: cell.raDeg, decDeg: cell.decDeg };
        name = 'Candidate tile';
        where = `Tile at RA ${format(cell.raDeg)}°, Dec ${signedDec(cell.decDeg)} · ${pct(cell.share)} model share · about ${Math.round(cell.medianDistanceAu).toLocaleString()} AU, V ${format(cell.medianVMag, 1)} · not a public case file yet`;
      } else {
        name = CANDIDATE_ID_PATTERN.test(caseId) ? 'Candidate tile' : 'Retired case';
        where = 'This case is not in the current model. You can still file what you see here.';
      }
    }
  } catch {
    where = 'The PlanetX model could not be loaded; you can still file what you see here.';
  }
  $('px-casefile-kind').textContent = isPublic ? 'PUBLIC CASE FILE' : 'CANDIDATE · NOT YET PUBLIC';
  $('px-casefile-kind').classList.toggle('is-public', isPublic);
  $('px-casefile-name').textContent = name;
  $('px-casefile-title').textContent = `PlanetX ${isPublic ? name.toLowerCase() : 'case file · candidate tile'}`;
  $('px-casefile-where').textContent = where;
  place = { id: caseId, centroid: centroid || { raDeg: 0, decDeg: 0 } };

  // Searching somewhere far away leaves the case behind.
  window.addEventListener('sky:target-selected', event => {
    const target = event.detail;
    if (!centroid || !Number.isFinite(target?.raDeg) || !Number.isFinite(target?.decDeg)) return;
    const dRa = Math.min(Math.abs(target.raDeg - centroid.raDeg), 360 - Math.abs(target.raDeg - centroid.raDeg)) * Math.cos(target.decDeg * Math.PI / 180);
    section.hidden = Math.hypot(dRa, target.decDeg - centroid.decDeg) > 15;
  });
  await Promise.all([renderTally(), refreshHistory()]);
}

if (section && ANY_CASE_ID_PATTERN.test(caseId)) void start();
