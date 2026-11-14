import { parseCoordinate, formatSexagesimal } from './coordinates.js';
import { presets } from './presets.js';
import { mountObjectLookup } from './object-lookup.js';
import { initialViewIssues, initialViewState, isEmbedded } from './share.js';
import { encodeViewState } from './url-state.js';
const $ = id => document.getElementById(id);
// A shared link is authoritative. A curated target supplies the label and the
// highlighted quick pick, while explicit coordinates in the link always win.
const restoredTargetId = initialViewState.targetId && presets[initialViewState.targetId] ? initialViewState.targetId : null;
// Opening a bare page keeps the old behaviour: nothing is searched until the
// visitor chooses a destination. Only a link that carries a view restores one.
const restoredView = encodeViewState({ ...initialViewState, embed: false }) !== '';
let selected = restoredTargetId;
let position = {
  raDeg: initialViewState.raDeg,
  decDeg: initialViewState.decDeg,
  frame: 'icrs',
  ...(restoredTargetId ? { targetId: restoredTargetId } : {})
};
const defaultSettings = { band: 2, viewMode: 'time-lapse', fovArcmin: 16, maxStackFrames: 80, combineExposures: true, hideBadPixels: true, rejectVisitGlitches: true, qualityOverlay: false, inspectPixels: false, consistentBrightness: true, stretch: 'asinh', colours: 'grayscale', contrast: 65, invert: false, showTargetMarker: true, labelAsteroids: false, asteroidMagnitude: 20 };
let viewerSettings = { ...defaultSettings, band: initialViewState.band, fovArcmin: initialViewState.fovArcmin };
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
  selected = null; updateSelection(); clearErrors();
  showPosition({ name: data.resolvedName || data.submittedName, type: 'CATALOG POSITION · ICRS', description: `Resolved through ${data.source.name} / ${data.source.resolver}. Fixed catalog position; no proper-motion correction.` });
});
document.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => {
  objectLookup.invalidate();
  selected = button.dataset.target; const target = presets[selected];
  position = { raDeg: target.raDeg, decDeg: target.decDeg, frame: 'icrs', targetId: selected };
  $('lookup-name').value = target.name;
  updateSelection(); clearErrors(); showPosition(target);
}));
const nameDrafts = { object: '', moving: '' };
let currentEntryMode = 'object';
function entryMode(mode) {
  nameDrafts[currentEntryMode] = $('lookup-name').value;
  objectLookup.invalidate();
  currentEntryMode = mode;
  $('target-type').value = mode;
  const coordinates = mode === 'coordinates', moving = mode === 'moving';
  for (const [id, active] of [['name-fields', !coordinates], ['coordinate-fields', coordinates], ['moving-fields', moving]]) {
    $(id).hidden = !active; $(id).disabled = !active;
  }
  $('lookup-name').value = nameDrafts[mode] || '';
  $('lookup-name').maxLength = moving ? 80 : 200;
  $('lookup-name').placeholder = moving ? 'e.g. 3I/ATLAS or 4 Vesta' : 'e.g. Sirius or M31';
  $('lookup-label').textContent = moving ? 'Designation' : 'Object name';
  $('lookup-help').textContent = coordinates
    ? 'ICRS reference frame · RA 0° to <360° · Dec −90° to +90°'
    : moving ? 'Enter a comet or asteroid designation and a UTC date range.'
    : 'Enter a common name or catalog identifier, or choose a quick pick below.';
  $('preset-panel').hidden = mode !== 'object';
  $('lookup-feedback').hidden = mode !== 'object';
  $('moving-feedback').hidden = !moving;
  $('target-search-status').hidden = moving;
  clearErrors();
}
$('target-type').addEventListener('change', () => entryMode($('target-type').value));
$('moving-search-link').addEventListener('click', () => { entryMode('moving'); $('lookup-name').focus(); });
// Keep archive progress and failures next to the entry point as well as results.
window.addEventListener('sky:observations-loading', event => {
  $('target-search-status').textContent = `Searching observations for ${event.detail.targetName}…`;
});
window.addEventListener('sky:observations-loaded', event => {
  $('target-search-status').textContent = event.detail.failed && !$('search-error').hidden
    ? $('search-error').textContent : $('search-status').textContent;
});
$('coordinate-format').addEventListener('change', () => { fillInputs(); clearErrors(); });
for (const axis of ['ra', 'dec']) $(axis).addEventListener('input', () => { selected = null; updateSelection(); $(axis + '-error').textContent = ''; $(axis).removeAttribute('aria-invalid'); });
$('target-search-form').addEventListener('submit', event => {
  event.preventDefault();
  if (currentEntryMode === 'moving') return;
  if (currentEntryMode === 'object') {
    if ($('target-search-form').reportValidity()) objectLookup.resolve($('lookup-name').value);
    return;
  }
  clearErrors(); const parsed = {}; let firstInvalid;
  for (const axis of ['ra', 'dec']) {
    try { parsed[axis + 'Deg'] = parseCoordinate($(axis).value, axis, $('coordinate-format').value); }
    catch (error) { $(axis + '-error').textContent = error.message; $(axis).setAttribute('aria-invalid', 'true'); firstInvalid ??= $(axis); }
  }
  if (firstInvalid) { firstInvalid.focus(); return; }
  objectLookup.invalidate();
  position = { ...parsed, frame: 'icrs' }; selected = null; updateSelection();
  showPosition({ name: 'Your sky position', type: 'CUSTOM COORDINATES · ICRS', description: 'Searching observations at your selected sky position.' });
});
const modeDescriptions = {
  'time-lapse': 'Play observations in date order to follow changes over time.',
  blink: 'Alternate between observations to spot changes at a glance.',
  difference: 'Compare observations by subtracting one image from another.',
  'motion-trail': 'Trace how sources move across successive observations.',
  'deep-stack': 'Per-pixel median across up to the selected number of UTC-day frames. Masked, missing and uncovered pixels do not count as zeros.'
};
const checkboxes = { 'combine-exposures': 'combineExposures', 'hide-bad-pixels': 'hideBadPixels', 'reject-visit-glitches': 'rejectVisitGlitches', 'consistent-brightness': 'consistentBrightness', 'quality-overlay': 'qualityOverlay', 'inspect-pixels': 'inspectPixels', invert: 'invert', 'crosshair-toggle': 'showTargetMarker', 'label-asteroids': 'labelAsteroids' };
const selects = { stretch: 'stretch', colours: 'colours', 'asteroid-magnitude': 'asteroidMagnitude' };
function emitSettings(source) {
  window.dispatchEvent(new CustomEvent('sky:viewer-settings-changed', { detail: { ...viewerSettings, source } }));
}
window.addEventListener('sky:cutout-detector-selected', event => {
  if (!Number.isInteger(event.detail?.detector)) return;
  viewerSettings.band = event.detail.detector; renderSettings(); emitSettings('cutout');
});
window.addEventListener('sky:coverage-stack-requested', event => {
  const detector = Number(event.detail?.detector);
  if (!Number.isInteger(detector) || detector < 1 || detector > 6) return;
  viewerSettings.band = detector;
  viewerSettings.viewMode = 'time-lapse';
  renderSettings();
  emitSettings('coverage-band'); // timeline rebuilds for this detector first
  viewerSettings.viewMode = 'deep-stack';
  renderSettings();
  emitSettings('coverage-stack'); // FITS viewer stacks the newly selected band
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
  $('max-stack-frames').value = viewerSettings.maxStackFrames;
  $('max-stack-frames-value').value = `${viewerSettings.maxStackFrames} frames`;
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
$('max-stack-frames').addEventListener('input', () => { $('max-stack-frames-value').value = `${$('max-stack-frames').value} frames`; });
$('max-stack-frames').addEventListener('change', () => { viewerSettings.maxStackFrames = Number($('max-stack-frames').value); emitSettings(); });
$('reset-button').addEventListener('click', () => {
  viewerSettings = { ...defaultSettings }; renderSettings(); emitSettings();
  $('announcement').textContent = 'All observation settings reset to their defaults.';
});
renderSettings();
updateSelection();
fillInputs();
if (isEmbedded) document.documentElement.classList.add('is-embed');
function restoredTarget() {
  if (restoredTargetId) return presets[restoredTargetId];
  return {
    name: 'Shared sky position',
    type: 'SHARED COORDINATES · ICRS',
    description: 'This link opened a specific patch of sky. The observation search below is already set to it.'
  };
}
// Publish the initial UI settings, then restore the shared destination, after the
// other page modules have attached their listeners. A bare page still waits for
// the visitor to choose a target.
window.addEventListener('load', () => {
  emitSettings();
  if (restoredView) showPosition(restoredTarget());
}, { once: true });
$('expand-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('.viewer').requestFullscreen();
  } catch { $('announcement').textContent = 'Fullscreen is unavailable in this browser.'; }
});
