import { mountStarfield } from './starfield.js';
import { intensity, publicCases, loadPromotedIds, communityScore, candidateId } from './lib/planetx-suspects.js';
import { loadTallies } from './lib/planetx-votes.js';

const canvas = document.querySelector('#planetx-map');
const context = canvas.getContext('2d');
const tooltip = document.querySelector('#map-tooltip');
const caseList = document.querySelector('#case-list');
const communityStatus = document.querySelector('#community-status');
const jumpButton = document.querySelector('#jump-to-coordinate');
mountStarfield(document.querySelector('#starfield'), { labels: false, avoid: ['.site-header', '.px-intro', '.px-map-card'] });
let model;
let maxShare = 0;
let patches = [];
let patchOf = new Map();
let tallies = {};
let sharedVotes = false;
let selectedCell = null;
let layout = null;

const format = (value, digits = 1) => Number(value).toFixed(digits);
const pct = value => `${(Number(value) * 100).toFixed(2)}%`;
const signedDec = (dec, digits = 1) => `${dec < 0 ? '−' : '+'}${format(Math.abs(dec), digits)}°`;
const layer = () => document.querySelector('input[name="px-layer"]:checked')?.value || 'model';
const caseUrl = patch => `/planetx-case.html?id=${encodeURIComponent(patch.id)}`;
// The SPHEREx viewer at a tile, carrying its case (a public patch or the tile's own candidate id).
const viewerUrl = (cell, id) => `/viewer.html?ra=${cell.raDeg}&dec=${cell.decDeg}&px=${encodeURIComponent(id)}`;
/** The case a tile is voted under: its public patch, or the tile itself. */
const caseIdOf = cell => patchOf.get(cell)?.id || candidateId(cell);

function colour(value) {
  const stops = [[9, 18, 31], [18, 58, 78], [31, 120, 133], [137, 188, 135], [251, 208, 124]];
  const position = Math.max(0, Math.min(1, value)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const mix = position - index;
  const rgb = stops[index].map((channel, i) => Math.round(channel * (1 - mix) + stops[index + 1][i] * mix));
  return `rgb(${rgb.join(',')})`;
}

// Rings shrink to plain dots on narrow maps so they do not hide the tiles.
const ringRadius = () => Math.max(4, Math.min(10, layout.w / 90));
const toX = ra => layout.x + layout.w * (1 - ra / 360);
const toY = dec => layout.y + layout.h * (1 - (dec + 90) / 180);

function drawPatchMarker(patch, community) {
  const score = communityScore(tallies[patch.id]);
  const x = toX(patch.centroid.raDeg), y = toY(patch.centroid.decDeg);
  const radius = ringRadius();
  const numbered = radius >= 8;
  const strong = community ? score.brightness : 1;
  context.save();
  if (community && score.votes) {
    context.shadowColor = score.brightness >= 1 ? 'rgba(251,208,124,.9)' : 'rgba(120,140,150,.6)';
    context.shadowBlur = 6 + 10 * Math.max(0, score.brightness - 1);
  }
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = numbered ? 'rgba(7,17,29,.82)' : (strong >= 1 ? 'rgba(255,241,189,.9)' : 'rgba(150,165,170,.7)');
  context.fill();
  context.lineWidth = selectedCell && patchOf.get(selectedCell) === patch ? 2.5 : 1.5;
  context.strokeStyle = strong >= 1 ? `rgba(255,236,180,${Math.min(1, 0.65 + 0.35 * (strong - 1) / 0.6)})` : `rgba(170,185,190,${0.35 + 0.4 * strong})`;
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = strong >= 1 ? '#fff1bd' : '#b9c6c8';
  context.font = '600 11px Manrope, system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  if (numbered) context.fillText(String(patch.number), x, y + 0.5);
  context.restore();
}

function draw() {
  if (!model) return;
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = bounds.width;
  const h = bounds.height;
  context.fillStyle = '#07111d';
  context.fillRect(0, 0, w, h);
  layout = { x: 30, y: 25, w: w - 60, h: h - 50 };
  const cellWidth = layout.w / 72;
  const cellHeight = layout.h / 36;
  const community = layer() === 'community';

  if (document.querySelector('#grid-toggle').checked) {
    context.strokeStyle = 'rgba(159,190,190,.13)';
    context.lineWidth = 1;
    for (let ra = 0; ra <= 360; ra += 30) {
      const x = toX(ra);
      context.beginPath(); context.moveTo(x, layout.y); context.lineTo(x, layout.y + layout.h); context.stroke();
    }
    for (let dec = -90; dec <= 90; dec += 30) {
      const y = toY(dec);
      context.beginPath(); context.moveTo(layout.x, y); context.lineTo(layout.x + layout.w, y); context.stroke();
    }
  }

  for (const cell of model.cells) {
    const x = toX(cell.raDeg + model.cellDeg / 2);
    const y = toY(cell.decDeg + model.cellDeg / 2);
    const level = intensity(cell.share, maxShare);
    const patch = patchOf.get(cell);
    let shown = level, alpha = 0.3 + 0.7 * level;
    if (community) {
      // Only voted-on patches carry community evidence; the rest of the sky fades back.
      if (patch) {
        const { brightness } = communityScore(tallies[patch.id]);
        shown = Math.min(1, level * brightness);
        alpha = Math.min(1, (0.3 + 0.7 * level) * brightness);
      } else {
        // Any other tile people voted on brightens or dims on its own, so a tile
        // many people back stands out as a candidate for a public case file.
        const tally = tallies[candidateId(cell)];
        const { brightness, votes } = communityScore(tally);
        shown = votes ? Math.min(1, Math.max(level, 0.35) * brightness) : level * 0.5;
        alpha = votes ? Math.min(1, (0.45 + 0.55 * level) * brightness) : 0.12 + 0.25 * level;
      }
    }
    context.fillStyle = colour(shown);
    context.globalAlpha = alpha;
    context.fillRect(x + 0.6, y + 0.6, Math.max(1, cellWidth - 1.2), Math.max(1, cellHeight - 1.2));
    context.globalAlpha = 1;
    cell._rect = { x, y, w: cellWidth, h: cellHeight };
  }

  if (document.querySelector('#ecliptic-toggle').checked) {
    context.strokeStyle = 'rgba(255,221,151,.82)';
    context.setLineDash([5, 6]);
    context.lineWidth = 1.5;
    context.beginPath();
    for (let step = 0; step <= 360; step += 2) {
      const dec = Math.asin(Math.sin(23.439 * Math.PI / 180) * Math.sin(step * Math.PI / 180)) * 180 / Math.PI;
      if (step === 0) context.moveTo(toX(step), toY(dec)); else context.lineTo(toX(step), toY(dec));
    }
    context.stroke(); context.setLineDash([]);
  }

  // Outline the selected patch's tiles, then the numbered markers on top.
  const selectedPatch = selectedCell && patchOf.get(selectedCell);
  if (selectedPatch) {
    context.strokeStyle = 'rgba(255,241,189,.55)'; context.lineWidth = 1;
    for (const cell of selectedPatch.cells) context.strokeRect(cell._rect.x + 0.5, cell._rect.y + 0.5, cell._rect.w - 1, cell._rect.h - 1);
  }
  for (const patch of patches) drawPatchMarker(patch, community);

  if (selectedCell?._rect) {
    const r = selectedCell._rect;
    context.strokeStyle = '#fff1bd'; context.lineWidth = 2;
    context.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }
}

function tooltipHtml(cell) {
  const patch = patchOf.get(cell);
  const head = `<strong>RA ${format(cell.raDeg)}° · Dec ${signedDec(cell.decDeg)}</strong><br>${pct(cell.share)} model share · ${Math.round(cell.medianDistanceAu).toLocaleString()} AU · V ${format(cell.medianVMag, 1)}`;
  const score = communityScore(tallies[caseIdOf(cell)]);
  const votes = score.votes ? `${score.something} something / ${score.nothing} nothing` : 'no votes yet';
  return patch ? `${head}<br>Suspicion case #${patch.number} · ${votes}` : `${head}<br>Candidate tile · ${votes}`;
}

function selectCell(cell) {
  selectedCell = cell;
  draw();
  const patch = patchOf.get(cell);
  jumpButton.href = viewerUrl(cell, caseIdOf(cell));
  jumpButton.removeAttribute('aria-disabled');
  jumpButton.firstChild.textContent = patch ? `Jump to case #${patch.number} ` : 'Jump to coordinate ';
  jumpButton.title = patch
    ? `Open case #${patch.number} at RA ${format(cell.raDeg)}°, Dec ${signedDec(cell.decDeg)} in the SPHEREx viewer`
    : `Open this candidate tile (RA ${format(cell.raDeg)}°, Dec ${signedDec(cell.decDeg)}) in the SPHEREx viewer to inspect and file it`;
  window.dispatchEvent(new CustomEvent('sky:planetx-region-selected', { detail: { raDeg: cell.raDeg, decDeg: cell.decDeg } }));
  tooltip.hidden = false;
  tooltip.innerHTML = tooltipHtml(cell);
  tooltip.style.left = `${Math.min(82, Math.max(4, 100 * (cell._rect.x + cell._rect.w / 2) / canvas.clientWidth))}%`;
  tooltip.style.top = `${Math.max(2, 100 * cell._rect.y / canvas.clientHeight)}%`;
}

function showCaseList() {
  if (!patches.length) { caseList.innerHTML = '<li>No suspicion patches in this model.</li>'; return; }
  caseList.replaceChildren(...patches.map(patch => {
    const score = communityScore(tallies[patch.id]);
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = caseUrl(patch);
    link.className = `px-case-row is-${score.label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    link.innerHTML = `<span class="px-rank">#${String(patch.number).padStart(2, '0')}</span><span class="px-region-coords">RA ${format(patch.centroid.raDeg)}° · Dec ${signedDec(patch.centroid.decDeg)} <small>${patch.cells.length} tiles · ${score.votes ? `${score.something} something / ${score.nothing} nothing · ${score.label}` : 'No votes yet'}</small></span><strong>${pct(patch.totalShare)}</strong>`;
    item.append(link);
    return item;
  }));
}

function updateLayerCopy() {
  const community = layer() === 'community';
  document.querySelector('#legend-low').textContent = community ? 'DIMMED BY “NOTHING HERE”' : 'LOWER PROBABILITY';
  document.querySelector('#legend-high').textContent = community ? 'BRIGHTENED BY “SOMETHING HERE”' : 'HIGHER PROBABILITY';
  const voted = Object.values(tallies).reduce((sum, tally) => sum + (tally.something || 0) + (tally.nothing || 0), 0);
  communityStatus.hidden = !community;
  communityStatus.textContent = sharedVotes
    ? `Community layer: ${voted} vote${voted === 1 ? '' : 's'} from visitors. Patches people back grow brighter; patches they dismiss dim. Votes are opinions about what the images show, not detections.`
    : 'Community layer: the shared vote store is not available here, so this shows only the votes saved in this browser.';
}

function nearestCell(event) {
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  if (!layout || x < layout.x || x > layout.x + layout.w || y < layout.y || y > layout.y + layout.h) return null;
  // Clicking a numbered ring picks that patch's brightest tile.
  const ring = patches.find(patch => Math.hypot(toX(patch.centroid.raDeg) - x, toY(patch.centroid.decDeg) - y) <= ringRadius() + 2);
  if (ring) return ring.peak;
  const ra = (1 - (x - layout.x) / layout.w) * 360;
  const dec = (1 - (y - layout.y) / layout.h) * 180 - 90;
  return model.cells.reduce((nearest, cell) => {
    const deltaRa = Math.min(Math.abs(cell.raDeg - ra), 360 - Math.abs(cell.raDeg - ra)) * Math.cos(dec * Math.PI / 180);
    const distance = deltaRa * deltaRa + (cell.decDeg - dec) ** 2;
    return !nearest || distance < nearest.distance ? { cell, distance } : nearest;
  }, null)?.cell;
}

canvas.addEventListener('click', event => { const cell = nearestCell(event); if (cell) selectCell(cell); });
canvas.addEventListener('dblclick', event => { const patch = patchOf.get(nearestCell(event)); if (patch) location.assign(caseUrl(patch)); });
canvas.addEventListener('keydown', event => {
  if (event.key === 'Enter' && selectedCell && patchOf.get(selectedCell)) { location.assign(caseUrl(patchOf.get(selectedCell))); return; }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (!selectedCell || event.key === 'Enter' || event.key === ' ') { selectCell([...model.cells].sort((a, b) => b.share - a.share)[0]); return; }
  // RA increases to the left on this map.
  const direction = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
  const ra = (selectedCell.raDeg + direction[0] * model.cellDeg + 360) % 360;
  const dec = Math.max(-87.5, Math.min(87.5, selectedCell.decDeg + direction[1] * model.cellDeg));
  const next = model.cells.find(cell => cell.raDeg === ra && cell.decDeg === dec);
  if (next) selectCell(next);
});
canvas.addEventListener('mousemove', event => {
  const cell = nearestCell(event);
  canvas.style.cursor = cell && patchOf.has(cell) ? 'pointer' : 'crosshair';
  if (cell && !selectedCell) {
    tooltip.hidden = false;
    tooltip.innerHTML = tooltipHtml(cell);
    tooltip.style.left = `${Math.min(82, Math.max(4, event.offsetX / canvas.clientWidth * 100))}%`;
    tooltip.style.top = `${Math.max(2, event.offsetY / canvas.clientHeight * 100)}%`;
  } else if (!selectedCell) tooltip.hidden = true;
});
for (const control of document.querySelectorAll('#ecliptic-toggle, #grid-toggle')) control.addEventListener('change', draw);
for (const control of document.querySelectorAll('input[name="px-layer"]')) control.addEventListener('change', () => { updateLayerCopy(); draw(); });
new ResizeObserver(draw).observe(canvas);
// Votes cast on a case page show up when the visitor comes back to the map.
window.addEventListener('pageshow', event => { if (event.persisted) void refreshVotes(); });

async function refreshVotes() {
  ({ tallies, shared: sharedVotes } = await loadTallies());
  showCaseList();
  updateLayerCopy();
  draw();
}

try {
  const response = await fetch('/data/planet-nine.json');
  if (!response.ok) throw new Error('Model data could not be loaded.');
  model = await response.json();
  maxShare = Math.max(...model.cells.map(cell => cell.share));
  patches = publicCases(model, await loadPromotedIds());
  patchOf = new Map(patches.flatMap(patch => patch.cells.map(cell => [cell, patch])));
  document.querySelector('#model-epoch').textContent = model.epoch;
  showCaseList();
  if (new URLSearchParams(location.search).get('layer') === 'community') document.querySelector('input[name="px-layer"][value="community"]').checked = true;
  updateLayerCopy();
  draw();
  void refreshVotes();
} catch {
  communityStatus.hidden = false;
  communityStatus.textContent = 'Map unavailable: PlanetX model data could not be loaded. Please refresh and try again.';
  caseList.innerHTML = '<li>Model data unavailable.</li>';
}
