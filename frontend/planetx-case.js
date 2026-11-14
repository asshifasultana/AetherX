import { mountStarfield } from './starfield.js';
import { intensity, publicCases, loadPromotedIds, communityScore } from './lib/planetx-suspects.js';
import { loadTallies, castVote, myVote } from './lib/planetx-votes.js';

const $ = id => document.getElementById(id);
mountStarfield($('starfield'), { labels: false, avoid: ['.site-header', '.px-intro', '.px-case-grid', '.px-vote'] });

const format = (value, digits = 1) => Number(value).toFixed(digits);
const pct = value => `${(Number(value) * 100).toFixed(2)}%`;
const signedDec = (dec, digits = 1) => `${dec < 0 ? '−' : '+'}${format(Math.abs(dec), digits)}°`;
const rangeText = ({ min, max }, unit = '', digits = 0) => (Math.abs(max - min) < 10 ** -digits ? `${format(min, digits)}${unit}` : `${format(min, digits)}–${format(max, digits)}${unit}`);

function colour(value) {
  const stops = [[9, 18, 31], [18, 58, 78], [31, 120, 133], [137, 188, 135], [251, 208, 124]];
  const position = Math.max(0, Math.min(1, value)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const mix = position - index;
  return `rgb(${stops[index].map((channel, i) => Math.round(channel * (1 - mix) + stops[index + 1][i] * mix)).join(',')})`;
}

let patch, model, maxShare, tallies = {}, shared = false, busy = false;

/** Small map of the patch tiles plus a ring of neighbours for context. */
function drawPatch() {
  const canvas = $('case-map');
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = '#07111d';
  context.fillRect(0, 0, bounds.width, bounds.height);
  const step = model.cellDeg;
  // Unwrap RA around the patch centre so patches across 0° draw in one piece.
  const unwrap = ra => { let d = ra - patch.centroid.raDeg; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
  const offsets = patch.cells.map(cell => ({ dRa: unwrap(cell.raDeg), dec: cell.decDeg }));
  const pad = step * 1.5;
  const raMin = Math.min(...offsets.map(o => o.dRa)) - pad, raMax = Math.max(...offsets.map(o => o.dRa)) + pad;
  const decMin = Math.max(-90, Math.min(...offsets.map(o => o.dec)) - pad), decMax = Math.min(90, Math.max(...offsets.map(o => o.dec)) + pad);
  const scale = Math.min(bounds.width / (raMax - raMin), bounds.height / (decMax - decMin));
  const ox = (bounds.width - scale * (raMax - raMin)) / 2, oy = (bounds.height - scale * (decMax - decMin)) / 2;
  const toX = dRa => ox + scale * (raMax - dRa); // RA increases to the left
  const toY = dec => oy + scale * (decMax - dec);
  const members = new Set(patch.cells);
  const { brightness } = communityScore(tallies[patch.id]);
  for (const cell of model.cells) {
    const dRa = unwrap(cell.raDeg);
    if (dRa < raMin || dRa > raMax || cell.decDeg < decMin || cell.decDeg > decMax) continue;
    const level = intensity(cell.share, maxShare);
    const inside = members.has(cell);
    context.fillStyle = colour(inside ? Math.min(1, level * brightness) : level * 0.5);
    context.globalAlpha = inside ? Math.min(1, (0.35 + 0.65 * level) * brightness) : 0.18 + 0.2 * level;
    const x = toX(dRa + step / 2), y = toY(cell.decDeg + step / 2);
    context.fillRect(x + 1, y + 1, scale * step - 2, scale * step - 2);
  }
  context.globalAlpha = 1;
  context.strokeStyle = 'rgba(255,241,189,.6)'; context.lineWidth = 1;
  for (const cell of patch.cells) {
    const x = toX(unwrap(cell.raDeg) + step / 2), y = toY(cell.decDeg + step / 2);
    context.strokeRect(x + 0.5, y + 0.5, scale * step - 1, scale * step - 1);
  }
  const cx = toX(0), cy = toY(patch.centroid.decDeg);
  context.strokeStyle = '#fff1bd'; context.lineWidth = 1.5;
  context.beginPath(); context.arc(cx, cy, 7, 0, Math.PI * 2); context.stroke();
  context.beginPath(); context.moveTo(cx - 12, cy); context.lineTo(cx - 9, cy); context.moveTo(cx + 9, cy); context.lineTo(cx + 12, cy);
  context.moveTo(cx, cy - 12); context.lineTo(cx, cy - 9); context.moveTo(cx, cy + 9); context.lineTo(cx, cy + 12); context.stroke();
}

function renderVotes(message = '') {
  const score = communityScore(tallies[patch.id]);
  const mine = myVote(patch.id);
  for (const button of document.querySelectorAll('.px-vote-button')) {
    button.setAttribute('aria-pressed', String(button.dataset.verdict === mine));
    button.disabled = busy;
  }
  $('vote-bar-something').style.width = score.votes ? `${Math.round(100 * score.something / score.votes)}%` : '50%';
  $('vote-bar-something').parentElement.classList.toggle('is-empty', !score.votes);
  $('vote-summary').textContent = score.votes
    ? `${score.something} said something here · ${score.nothing} said nothing here — ${score.label.toLowerCase()} on the community map.`
    : 'No votes yet. Be the first to give your read.';
  const where = shared ? 'Shared with everyone who opens this case.' : 'The shared vote store is not available here, so your vote is saved in this browser only.';
  $('vote-note').textContent = `${message ? `${message} ` : ''}${mine ? `You said “${mine === 'something' ? 'something here' : 'nothing here'}”. ` : ''}${where}`;
  $('case-state').textContent = score.votes ? `COMMUNITY · ${score.label.toUpperCase()}` : 'MODEL PATCH · NO VOTES';
  drawPatch();
}

async function vote(verdict) {
  if (busy) return;
  busy = true;
  renderVotes('Saving…');
  let message = '';
  try {
    const result = await castVote(patch, verdict);
    ({ tallies, shared } = result);
    message = result.saved ? 'Vote saved.' : '';
  } catch { message = 'Could not save the vote right now.'; }
  busy = false;
  renderVotes(message);
}

function render() {
  document.title = `PlanetX · Case #${patch.number}`;
  $('case-title').textContent = `Case #${patch.number} · RA ${format(patch.centroid.raDeg)}° Dec ${signedDec(patch.centroid.decDeg)}`;
  $('case-lede').textContent = `One of ${patchCount} sky patches where the Planet Nine model concentrates its still-allowed orbits. Inspect it and say whether anything deserves a closer look.`;
  $('case-why').textContent = `These ${patch.cells.length} neighbouring tiles hold ${pct(patch.totalShare)} of the model’s still-allowed orbits (the brightest tile alone holds ${pct(patch.peak.share)}). The surveys behind the model would not have caught a planet here, so it remains a place where one could hide if it exists.`;
  $('case-ra').textContent = `${format(patch.centroid.raDeg, 2)}°`;
  $('case-dec').textContent = signedDec(patch.centroid.decDeg, 2);
  $('case-share').textContent = pct(patch.totalShare);
  $('case-tiles').textContent = String(patch.cells.length);
  $('case-distance').textContent = `${rangeText(patch.distanceAu)} AU`;
  $('case-mag').textContent = `V ${rangeText(patch.vMag, '', 1)}`;
  $('case-mag-copy').textContent = rangeText(patch.vMag, '', 1);
  $('case-spherex').href = `/viewer.html?ra=${patch.centroid.raDeg}&dec=${patch.centroid.decDeg}&px=${encodeURIComponent(patch.id)}`;
  $('case-body').hidden = false;
  for (const button of document.querySelectorAll('.px-vote-button')) button.addEventListener('click', () => void vote(button.dataset.verdict));
  new ResizeObserver(drawPatch).observe($('case-map'));
  renderVotes();
  window.dispatchEvent(new CustomEvent('sky:planetx-region-selected', { detail: { raDeg: patch.centroid.raDeg, decDeg: patch.centroid.decDeg } }));
}

function missing(text) {
  $('case-title').textContent = 'Case not found';
  $('case-lede').textContent = text;
  $('case-missing').hidden = false;
}

let patchCount = 0;
try {
  const response = await fetch('/data/planet-nine.json');
  if (!response.ok) throw new Error('model');
  model = await response.json();
  maxShare = Math.max(...model.cells.map(cell => cell.share));
  const patches = publicCases(model, await loadPromotedIds());
  patchCount = patches.length;
  patch = patches.find(item => item.id === new URLSearchParams(location.search).get('id'));
  if (!patch) missing('No current suspicion patch matches this link.');
  else {
    ({ tallies, shared } = await loadTallies());
    render();
  }
} catch {
  missing('The PlanetX model could not be loaded. Please refresh and try again.');
}
