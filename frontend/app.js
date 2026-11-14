import { parseCoordinate, formatSexagesimal } from './coordinates.js';
import { presets } from './presets.js';
import { mountObjectLookup } from './object-lookup.js';
const $ = id => document.getElementById(id);
let selected = 'barnard';
let position = { raDeg: presets.barnard.raDeg, decDeg: presets.barnard.decDeg, frame: 'icrs', targetId: 'barnard' };
const defaultSettings = { band: 2, viewMode: 'time-lapse', fovArcmin: 16, combineExposures: true, hideBadPixels: true, stretch: 'asinh', colours: 'grayscale', contrast: 65, invert: false, showTargetMarker: true, labelAsteroids: false, asteroidMagnitude: 20 };
let viewerSettings = { ...defaultSettings };
const ranges = ['0.75 – 1.09', '1.10 – 1.62', '1.63 – 2.41', '2.42 – 3.82', '3.83 – 4.41', '4.42 – 5.00'];
const signed = n => `${n < 0 ? '' : '+'}${n.toFixed(4)}`;
function fillInputs() {
  const sex = $('coordinate-format').value === 'sexagesimal';
  for (const axis of ['ra', 'dec']) $(axis).value = sex ? formatSexagesimal(position[axis + 'Deg'], axis) : String(position[axis + 'Deg']);
  $('ra-unit').textContent = sex ? 'HH:MM:SS' : 'degrees';
  $('dec-unit').textContent = sex ? '±DD:MM:SS' : 'degrees';
}
function clearErrors() { for (const axis of ['ra', 'dec']) { $(axis + '-error').textContent = ''; $(axis).removeAttribute('aria-invalid'); } }
function updateSelection() { document.querySelectorAll('[data-target]').forEach(b => { const active = b.dataset.target === selected; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); }
function showPosition(data) {
  $('object-name').textContent = data.name;
  $('object-type').textContent = data.type; $('object-description').textContent = data.description;
  $('display-ra').innerHTML = `${position.raDeg.toFixed(4)}<span>°</span>`;
  $('display-dec').innerHTML = `${signed(position.decDeg)}<span>°</span>`;
  $('announcement').textContent = `${data.name} selected. The observation search has been updated.`;
  window.dispatchEvent(new CustomEvent('sky:target-selected', { detail: { ...position } }));
}
const objectLookup = mountObjectLookup(data => {
  position = { raDeg: data.raDeg, decDeg: data.decDeg, frame: data.frame };
  selected = null; updateSelection(); fillInputs(); clearErrors();
  showPosition({ name: data.resolvedName || data.submittedName, type: 'CATALOG POSITION · ICRS', description: `Resolved through ${data.source.name} / ${data.source.resolver}. Fixed catalog position; no proper-motion correction. Observation availability is checked separately.` });
});
document.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => {
  objectLookup.invalidate();
  selected = button.dataset.target; const target = presets[selected];
  position = { raDeg: target.raDeg, decDeg: target.decDeg, frame: 'icrs', targetId: selected };
  updateSelection(); fillInputs(); clearErrors(); showPosition(target);
}));
function entryMode(mode) {
  objectLookup.invalidate();
  for (const [tab, panel, value] of [['preset-tab', 'preset-panel', 'presets'], ['manual-tab', 'coordinate-form', 'coordinates'], ['object-tab', 'object-lookup-form', 'object']]) {
    const active = mode === value; $(panel).hidden = !active; $(tab).classList.toggle('selected', active); $(tab).setAttribute('aria-pressed', String(active));
  }
}
$('preset-tab').addEventListener('click', () => entryMode('presets'));
$('manual-tab').addEventListener('click', () => entryMode('coordinates'));
$('object-tab').addEventListener('click', () => entryMode('object'));
$('coordinate-format').addEventListener('change', () => { fillInputs(); clearErrors(); });
for (const axis of ['ra', 'dec']) $(axis).addEventListener('input', () => { selected = null; updateSelection(); $(axis + '-error').textContent = ''; $(axis).removeAttribute('aria-invalid'); });
$('coordinate-form').addEventListener('submit', event => {
  event.preventDefault(); clearErrors(); const parsed = {}; let firstInvalid;
  for (const axis of ['ra', 'dec']) {
    try { parsed[axis + 'Deg'] = parseCoordinate($(axis).value, axis, $('coordinate-format').value); }
    catch (error) { $(axis + '-error').textContent = error.message; $(axis).setAttribute('aria-invalid', 'true'); firstInvalid ??= $(axis); }
  }
  if (firstInvalid) { firstInvalid.focus(); return; }
  objectLookup.invalidate();
  position = { ...parsed, frame: 'icrs' }; selected = null; updateSelection();
  showPosition({ name: 'Your sky position', type: 'CUSTOM COORDINATES · ICRS', description: 'Your destination is set. Scroll down to Find your observations and search this position.' });
});
const modeDescriptions = {
  'time-lapse': 'Play observations in date order to follow changes over time.',
  blink: 'Alternate between observations to spot changes at a glance.',
  difference: 'Compare observations by subtracting one image from another.',
  'motion-trail': 'Trace how sources move across successive observations.',
  'deep-stack': 'Combine observations into a deeper view of faint sources.'
};
const checkboxes = { 'combine-exposures': 'combineExposures', 'hide-bad-pixels': 'hideBadPixels', invert: 'invert', 'crosshair-toggle': 'showTargetMarker', 'label-asteroids': 'labelAsteroids' };
const selects = { stretch: 'stretch', colours: 'colours', 'asteroid-magnitude': 'asteroidMagnitude' };
function emitSettings() {
  window.dispatchEvent(new CustomEvent('sky:viewer-settings-changed', { detail: { ...viewerSettings } }));
}
window.addEventListener('sky:cutout-detector-selected', event => {
  if (!Number.isInteger(event.detail?.detector)) return;
  viewerSettings.band = event.detail.detector; renderSettings();
});
function updateButtons(attribute, value) {
  document.querySelectorAll('[data-' + attribute + ']').forEach(button => {
    const active = button.dataset[attribute] === String(value);
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  });
}
function renderSettings() {
  updateButtons('band', viewerSettings.band); updateButtons('mode', viewerSettings.viewMode); updateButtons('fov', viewerSettings.fovArcmin);
  $('band-range').textContent = ranges[viewerSettings.band - 1] + ' μm';
  $('mode-description').textContent = modeDescriptions[viewerSettings.viewMode];
  for (const [id, key] of Object.entries(checkboxes)) $(id).checked = viewerSettings[key];
  for (const [id, key] of Object.entries(selects)) $(id).value = String(viewerSettings[key]);
  $('contrast').value = viewerSettings.contrast; $('contrast-value').value = viewerSettings.contrast + '%';
}
for (const [attribute, key] of [['band','band'],['mode','viewMode'],['fov','fovArcmin']]) {
  document.querySelectorAll('[data-' + attribute + ']').forEach(button => button.addEventListener('click', () => {
    viewerSettings[key] = attribute === 'mode' ? button.dataset[attribute] : Number(button.dataset[attribute]);
    renderSettings(); emitSettings();
  }));
}
for (const [id, key] of Object.entries(checkboxes)) $(id).addEventListener('change', () => { viewerSettings[key] = $(id).checked; emitSettings(); });
for (const [id, key] of Object.entries(selects)) $(id).addEventListener('change', () => { viewerSettings[key] = key === 'asteroidMagnitude' ? Number($(id).value) : $(id).value; emitSettings(); });
$('contrast').addEventListener('input', () => { viewerSettings.contrast = Number($('contrast').value); $('contrast-value').value = viewerSettings.contrast + '%'; emitSettings(); });
$('reset-button').addEventListener('click', () => {
  viewerSettings = { ...defaultSettings }; renderSettings(); emitSettings();
  $('announcement').textContent = 'All observation settings reset to their defaults.';
});
renderSettings();
// Publish the initial UI settings after the other page modules have attached their listeners.
window.addEventListener('load', emitSettings, { once: true });
$('expand-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('.viewer').requestFullscreen();
  } catch { $('announcement').textContent = 'Fullscreen is unavailable in this browser.'; }
});
