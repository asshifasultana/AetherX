import { mountStarfield } from './starfield.js';

const canvas = document.querySelector('#planetx-map');
const context = canvas.getContext('2d');
const tooltip = document.querySelector('#map-tooltip');
const regionsList = document.querySelector('#top-regions');
mountStarfield(document.querySelector('#starfield'), { labels: false, avoid: ['.site-header', '.px-intro', '.px-map-card'] });
let model;
let selectedCell = null;
let layout = null;

const format = (value, digits = 1) => Number(value).toFixed(digits);
const pct = value => `${(Number(value) * 100).toFixed(2)}%`;

function intensity(share, maxShare) {
  return Math.max(0, Math.min(1, Math.log1p(share * 10000) / Math.log1p(maxShare * 10000)));
}

function colour(value) {
  const stops = [[9, 18, 31], [18, 58, 78], [31, 120, 133], [137, 188, 135], [251, 208, 124]];
  const position = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const mix = position - index;
  const rgb = stops[index].map((channel, i) => Math.round(channel * (1 - mix) + stops[index + 1][i] * mix));
  return `rgb(${rgb.join(',')})`;
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
  const maxShare = Math.max(...model.cells.map(cell => cell.share));
  layout = { x: 30, y: 25, w: w - 60, h: h - 50 };
  const cellWidth = layout.w / 72;
  const cellHeight = layout.h / 36;

  if (document.querySelector('#grid-toggle').checked) {
    context.strokeStyle = 'rgba(159,190,190,.13)';
    context.lineWidth = 1;
    for (let ra = 0; ra <= 360; ra += 30) {
      const x = layout.x + layout.w * (1 - ra / 360);
      context.beginPath(); context.moveTo(x, layout.y); context.lineTo(x, layout.y + layout.h); context.stroke();
    }
    for (let dec = -90; dec <= 90; dec += 30) {
      const y = layout.y + layout.h * (1 - (dec + 90) / 180);
      context.beginPath(); context.moveTo(layout.x, y); context.lineTo(layout.x + layout.w, y); context.stroke();
    }
  }

  for (const cell of model.cells) {
    const x = layout.x + layout.w * (1 - (cell.raDeg + model.cellDeg / 2) / 360);
    const y = layout.y + layout.h * (1 - (cell.decDeg + model.cellDeg / 2 + 90) / 180);
    const level = intensity(cell.share, maxShare);
    context.fillStyle = colour(level);
    context.globalAlpha = 0.3 + 0.7 * level;
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
      const ra = step;
      const dec = Math.asin(Math.sin(23.439 * Math.PI / 180) * Math.sin(ra * Math.PI / 180)) * 180 / Math.PI;
      const x = layout.x + layout.w * (1 - ra / 360);
      const y = layout.y + layout.h * (1 - (dec + 90) / 180);
      if (step === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke(); context.setLineDash([]);
  }

  if (selectedCell?._rect) {
    const r = selectedCell._rect;
    context.strokeStyle = '#fff1bd'; context.lineWidth = 2;
    context.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }
}

function selectCell(cell) {
  selectedCell = cell;
  draw();
  document.querySelector('#cell-title').textContent = `RA ${format(cell.raDeg)}° · Dec ${cell.decDeg < 0 ? '−' : '+'}${format(Math.abs(cell.decDeg))}°`;
  document.querySelector('#cell-copy').textContent = 'The cell centre in the modelled reference sky.';
  document.querySelector('#cell-ra').textContent = `${format(cell.raDeg, 2)}°`;
  document.querySelector('#cell-dec').textContent = `${cell.decDeg < 0 ? '−' : '+'}${format(Math.abs(cell.decDeg), 2)}°`;
  document.querySelector('#cell-share').textContent = pct(cell.share);
  document.querySelector('#cell-distance').textContent = `${Math.round(cell.medianDistanceAu).toLocaleString()} AU`;
  document.querySelector('#cell-magnitude').textContent = `V ${format(cell.medianVMag, 1)}`;
  document.querySelector('#open-spherex').href = `/?ra=${cell.raDeg}&dec=${cell.decDeg}`;
  tooltip.hidden = false;
  tooltip.innerHTML = `<strong>RA ${format(cell.raDeg)}° · Dec ${cell.decDeg < 0 ? '−' : '+'}${format(Math.abs(cell.decDeg))}°</strong><br>${pct(cell.share)} model share`;
  tooltip.style.left = `${Math.min(82, Math.max(4, 100 * (cell._rect.x + cell._rect.w / 2) / canvas.clientWidth))}%`;
  tooltip.style.top = `${Math.max(2, 100 * cell._rect.y / canvas.clientHeight)}%`;
}

function showTopRegions() {
  const top = [...model.cells].sort((a, b) => b.share - a.share).slice(0, 5);
  regionsList.replaceChildren(...top.map((cell, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<span class="px-rank">0${index + 1}</span><span class="px-region-coords">RA ${format(cell.raDeg)}° <small>Dec ${cell.decDeg < 0 ? '−' : '+'}${format(Math.abs(cell.decDeg))}°</small></span><strong>${pct(cell.share)}</strong>`;
    button.addEventListener('click', () => { selectCell(cell); canvas.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
    item.append(button);
    return item;
  }));
}

function nearestCell(event) {
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  if (!layout || x < layout.x || x > layout.x + layout.w || y < layout.y || y > layout.y + layout.h) return null;
  const ra = (1 - (x - layout.x) / layout.w) * 360;
  const dec = (1 - (y - layout.y) / layout.h) * 180 - 90;
  return model.cells.reduce((nearest, cell) => {
    const deltaRa = Math.min(Math.abs(cell.raDeg - ra), 360 - Math.abs(cell.raDeg - ra)) * Math.cos(dec * Math.PI / 180);
    const distance = deltaRa * deltaRa + (cell.decDeg - dec) ** 2;
    return !nearest || distance < nearest.distance ? { cell, distance } : nearest;
  }, null)?.cell;
}

canvas.addEventListener('click', event => { const cell = nearestCell(event); if (cell) selectCell(cell); });
canvas.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (!selectedCell || event.key === 'Enter' || event.key === ' ') { selectCell([...model.cells].sort((a, b) => b.share - a.share)[0]); return; }
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
  const ra = (selectedCell.raDeg + direction[0] * model.cellDeg + 360) % 360;
  const dec = Math.max(-87.5, Math.min(87.5, selectedCell.decDeg + direction[1] * model.cellDeg));
  const next = model.cells.find(cell => cell.raDeg === ra && cell.decDeg === dec);
  if (next) selectCell(next);
});
canvas.addEventListener('mousemove', event => {
  const cell = nearestCell(event);
  if (cell && !selectedCell) {
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>RA ${format(cell.raDeg)}° · Dec ${cell.decDeg < 0 ? '−' : '+'}${format(Math.abs(cell.decDeg))}°</strong><br>${pct(cell.share)} model share`;
    tooltip.style.left = `${Math.min(82, Math.max(4, event.offsetX / canvas.clientWidth * 100))}%`;
    tooltip.style.top = `${Math.max(2, event.offsetY / canvas.clientHeight * 100)}%`;
  } else if (!selectedCell) tooltip.hidden = true;
});
for (const control of document.querySelectorAll('#ecliptic-toggle, #grid-toggle')) control.addEventListener('change', draw);
new ResizeObserver(draw).observe(canvas);

try {
  const response = await fetch('/data/planet-nine.json');
  if (!response.ok) throw new Error('Model data could not be loaded.');
  model = await response.json();
  document.querySelector('#model-epoch').textContent = model.epoch;
  showTopRegions();
  draw();
} catch {
  document.querySelector('#cell-title').textContent = 'Map unavailable';
  document.querySelector('#cell-copy').textContent = 'PlanetX model data could not be loaded. Please refresh and try again.';
  regionsList.innerHTML = '<li>Model data unavailable.</li>';
}
