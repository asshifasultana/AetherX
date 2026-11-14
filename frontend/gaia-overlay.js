import { initialViewState } from './share.js';
import { skyToCanvas } from './sky-projection.js';
import { propagateGaia, fieldRadiusDeg, markerSuspension, createCatalogLoader } from './gaia-core.js';

const byId = id => document.getElementById(id);
const image = byId('sky-canvas');
const canvas = byId('gaia-canvas');
const panel = byId('survey-layers');
const trigger = byId('survey-layers-button');
const selection = byId('survey-source-details');
const candidates = byId('survey-candidates');
const candidateList = byId('survey-candidate-list');

const layers = [
  { key: 'gaia', label: 'Gaia DR3', color: '#65e5ed' },
  { key: 'wise', label: 'AllWISE', color: '#ffc36b' }
].map(layer => ({
  ...layer,
  toggle: byId(layer.key === 'gaia' ? 'gaia-stars' : 'wise-sources'),
  list: byId(layer.key + '-source-list'),
  status: byId(layer.key + '-status'),
  retry: byId(layer.key + '-retry'),
  section: byId(layer.key + '-readouts'),
  legend: byId(layer.key + '-legend'),
  loader: createCatalogLoader(),
  points: []
}));

let field = initialViewState;
let grid = null;
let mode = 'time-lapse';
let entryMode = 'object';
let selected = null;
let candidateKeys = [];

function positionPanel() {
  const rect = trigger.getBoundingClientRect();
  panel.style.setProperty('--layers-top', Math.min(rect.bottom + 8, window.innerHeight - 160) + 'px');
  panel.style.setProperty('--layers-right', Math.max(12, window.innerWidth - rect.right) + 'px');
}

function openPanel() {
  positionPanel();
  if (!panel.matches(':popover-open')) panel.showPopover();
}

trigger.addEventListener('click', () => {
  if (panel.matches(':popover-open')) panel.hidePopover();
  else openPanel();
});
byId('survey-layers-close').addEventListener('click', () => {
  panel.hidePopover();
  trigger.focus();
});
panel.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(panel.matches(':popover-open'))));
window.addEventListener('resize', positionPanel);

function suspension(layer) {
  if (layer.key === 'gaia') return markerSuspension({ mode, entryMode, grid });
  if (entryMode === 'moving') return 'WISE markers are unavailable in the moving-target viewer.';
  return grid ? '' : 'WISE markers require a displayed image with a sky grid.';
}

function resetRequest(layer) {
  layer.loader.cancel();
  layer.query = '';
  layer.data = null;
  layer.error = '';
}

// Catalogs are fetched for the current field even while a layer is switched off,
// so ticking the box draws markers immediately instead of starting a lookup.
async function load(layer, retry = false) {
  if (entryMode === 'moving' || (layer.key === 'wise' && !grid)) return;
  const center = layer.key === 'wise' ? grid : field;
  const radius = layer.key === 'wise'
    ? fieldRadiusDeg(grid.width * grid.arcsecPerPixel / 60)
    : fieldRadiusDeg(field.fovArcmin);
  const query = new URLSearchParams({
    ra: String(center.centerRaDeg ?? center.raDeg),
    dec: String(center.centerDecDeg ?? center.decDeg),
    radius: String(radius)
  }).toString();
  if (query === layer.query && !retry) return;
  layer.query = query;
  layer.data = null;
  layer.error = '';
  render();
  try {
    const data = await layer.loader.load('/api/' + layer.key + '-sources?' + query);
    if (!data || layer.query !== query) return;
    layer.data = data;
  } catch (error) {
    if (layer.query !== query) return;
    layer.error = error.message || layer.label + ' lookup failed.';
  }
  render();
}

function choose(point) {
  selected = point.key;
  candidateKeys = [];
  openPanel();
  render();
  selection.focus();
}

function updateList(layer) {
  const ids = layer.points.map(point => point.key).join('|');
  if (ids === layer.list.dataset.ids) return;
  layer.list.dataset.ids = ids;
  layer.list.replaceChildren(...layer.points.map(point => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.source = point.key;
    button.textContent = point.source.sourceId;
    button.addEventListener('click', () => choose(point));
    li.append(button);
    return li;
  }));
}

function describeBand(band, i) {
  const name = 'W' + (i + 1);
  const artifact = band.artifact && band.artifact !== '0' ? ' · artifact flag ' + band.artifact : '';
  if (band.magnitude == null) return name + ' unavailable' + artifact;
  const value = band.magnitude.toFixed(2) + ' mag';
  if (['U', 'Z'].includes(band.quality)) return name + ' upper limit (' + value + ')' + artifact;
  const uncertainty = band.uncertainty == null ? '' : ' ± ' + band.uncertainty.toFixed(2) + ' mag';
  return name + ' ' + value + uncertainty + artifact;
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function render() {
  const width = image.clientWidth, height = image.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const layer of layers) {
    const enabled = layer.toggle.checked;
    const blocked = enabled ? suspension(layer) : '';
    layer.points = [];
    layer.section.hidden = !enabled;
    layer.legend.hidden = !enabled;
    layer.retry.hidden = !enabled || !layer.error || Boolean(blocked);
    if (enabled && !blocked && layer.data) {
      for (const source of layer.data.sources) {
        const position = layer.key === 'gaia' ? propagateGaia(source, grid.epoch) : source;
        const p = skyToCanvas({
          ...position, size: grid.width, centerRaDeg: grid.centerRaDeg,
          centerDecDeg: grid.centerDecDeg, arcsecPerPixel: grid.arcsecPerPixel
        });
        if (!p || p.x < -.5 || p.y < -.5 || p.x >= grid.width - .5 || p.y >= grid.height - .5) continue;
        layer.points.push({
          key: layer.key + ':' + source.sourceId, layer, source, position,
          x: (p.x + .5) * width / grid.width, y: (p.y + .5) * height / grid.height
        });
      }
    }
    let status = '';
    if (enabled) {
      status = blocked || layer.error || 'Loading ' + layer.label + '…';
      if (!blocked && layer.data) {
        status = layer.points.length ? layer.points.length + ' ' + layer.label + ' sources in view.' : 'No ' + layer.label + ' sources in view.';
        if (layer.data.truncated) status += ' Search limited to 1,000 results.';
        if (layer.key === 'gaia') status += ' G ≤ 18 · epoch ' + grid.epoch.toFixed(4) + (grid.daily ? ' · daily midpoint approximation.' : '.');
      }
    }
    setText(layer.status, status);
    updateList(layer);
  }

  const points = layers.flatMap(layer => layer.points);
  const selectedPoint = points.find(point => point.key === selected);
  if (!selectedPoint) selected = null;
  for (const point of points) {
    const { x, y, layer } = point;
    const active = point.key === selected;
    const radius = active ? 7 : 4;
    context.strokeStyle = layer.color;
    context.lineWidth = active ? 2.5 : 1.25;
    context.beginPath();
    if (layer.key === 'gaia') context.arc(x, y, radius, 0, Math.PI * 2);
    else {
      context.moveTo(x, y - radius);
      context.lineTo(x + radius, y);
      context.lineTo(x, y + radius);
      context.lineTo(x - radius, y);
      context.closePath();
    }
    context.stroke();
  }

  for (const layer of layers) {
    for (const button of layer.list.querySelectorAll('button[data-source]')) {
      button.setAttribute('aria-pressed', String(button.dataset.source === selected));
    }
  }
  selection.hidden = !selectedPoint;
  if (selectedPoint) {
    const { layer, source, position } = selectedPoint;
    const brightness = layer.key === 'gaia'
      ? 'G ' + source.gMag.toFixed(2) + ' mag · epoch ' + position.epoch.toFixed(4) +
        (position.propagated ? ' (proper motion applied)' : ' (reference position)')
      : source.photometry.map(describeBand).join(' · ') + ' · AllWISE catalog position';
    setText(selection, layer.label + ' ' + source.sourceId + ' · RA ' + position.raDeg.toFixed(6) +
      '°, Dec ' + position.decDeg.toFixed(6) + '° · ' + brightness);
  }

  const nearby = candidateKeys.map(key => points.find(point => point.key === key)).filter(Boolean);
  if (nearby.length < 2) candidateKeys = [];
  candidates.hidden = nearby.length < 2;
  const candidateId = candidateKeys.join('|');
  if (candidates.dataset.ids !== candidateId) {
    candidates.dataset.ids = candidateId;
    candidateList.replaceChildren(...(candidateKeys.length ? nearby : []).map(point => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = point.layer.label + ' ' + point.source.sourceId;
      button.addEventListener('click', () => choose(point));
      return button;
    }));
  }
}

image.addEventListener('click', event => {
  if (byId('inspect-pixels').checked) return;
  const rect = image.getBoundingClientRect();
  const radius = event.pointerType === 'touch' ? 20 : 10;
  const nearby = layers.flatMap(layer => layer.points).filter(point =>
    Math.hypot(point.x - (event.clientX - rect.left), point.y - (event.clientY - rect.top)) <= radius
  );
  if (!nearby.length) return;
  event.stopImmediatePropagation();
  if (nearby.length === 1) choose(nearby[0]);
  else {
    selected = null;
    candidateKeys = nearby.map(point => point.key);
    openPanel();
    render();
    candidates.querySelector('button')?.focus();
  }
}, { capture: true });

for (const layer of layers) {
  layer.toggle.checked = Boolean(initialViewState[layer.key]);
  layer.toggle.addEventListener('change', () => {
    window.dispatchEvent(new CustomEvent('sky:context-settings-changed', { detail: { [layer.key]: layer.toggle.checked } }));
    void load(layer);
    render();
  });
  layer.retry.addEventListener('click', () => void load(layer, true));
}

window.addEventListener('sky:target-selected', event => {
  field = { ...field, ...event.detail };
  grid = null;
  for (const layer of layers) resetRequest(layer);
  render();
  for (const layer of layers) void load(layer);
});
window.addEventListener('sky:viewer-settings-changed', event => {
  mode = event.detail.viewMode;
  if (field.fovArcmin !== event.detail.fovArcmin) {
    field = { ...field, fovArcmin: event.detail.fovArcmin };
    grid = null;
    for (const layer of layers) resetRequest(layer);
    for (const layer of layers) void load(layer);
  }
  render();
});
window.addEventListener('sky:display-grid-changed', event => {
  grid = event.detail;
  void load(layers[1]);
  render();
});
function changeEntry(next) {
  entryMode = next;
  if (next === 'moving') {
    grid = null;
    for (const layer of layers) resetRequest(layer);
  } else {
    for (const layer of layers) void load(layer);
  }
  render();
}
window.addEventListener('sky:entry-mode-changed', event => changeEntry(event.detail.mode));
window.addEventListener('sky:search-entry', event => changeEntry(event.detail.type));
new ResizeObserver(render).observe(image);
render();
