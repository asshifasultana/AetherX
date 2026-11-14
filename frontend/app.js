import { ensureSearchForm, mountTargetSearch, setSearchLoading } from './target-search.js';
import { readSearchEntry } from './search-route.js';
import { presets } from './presets.js';
import { mountObjectLookup } from './object-lookup.js';
import { initialViewState, isEmbedded } from './share.js';
import { encodeViewState } from './url-state.js';
ensureSearchForm();
const initialEntry = readSearchEntry(typeof location === 'undefined' ? '' : location.search);
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
const defaultSettings = { band: 2, viewMode: 'time-lapse', fovArcmin: 16, maxStackFrames: 80, combineExposures: true, hideBadPixels: true, rejectVisitGlitches: true, qualityOverlay: false, inspectPixels: false, consistentBrightness: true, stretch: 'asinh', colours: 'grayscale', contrast: 65, invert: false, showTargetMarker: false, labelAsteroids: false, asteroidMagnitude: 20 };
let viewerSettings = { ...defaultSettings, band: initialViewState.band, fovArcmin: initialViewState.fovArcmin };
const ranges = ['0.75 – 1.09', '1.10 – 1.62', '1.63 – 2.41', '2.42 – 3.82', '3.83 – 4.41', '4.42 – 5.00'];
const signed = n => `${n < 0 ? '' : '+'}${n.toFixed(4)}`;
function updateSelection() { document.querySelectorAll('[data-target]').forEach(b => { const active = b.dataset.target === selected; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); }
let fixedTargetData = { name: 'Barnard’s Star', type: '', description: '' };
function renderTarget(data) {
  $('object-name').textContent = data.name;
  $('object-type').textContent = data.type; $('object-description').textContent = data.description;
  $('display-ra').innerHTML = `${position.raDeg.toFixed(4)}<span>°</span>`;
  $('display-dec').innerHTML = `${signed(position.decDeg)}<span>°</span>`;
}
function showPosition(data) {
  fixedTargetData = data; renderTarget(data);
  $('target-coordinates').hidden = false; $('moving-position-note').hidden = true;
  $('announcement').textContent = `${data.name} selected. The observation search has been updated.`;
  window.dispatchEvent(new CustomEvent('sky:target-selected', { detail: { ...position } }));
}
const objectLookup = mountObjectLookup(data => {
  position = { raDeg: data.raDeg, decDeg: data.decDeg, frame: data.frame };
  selected = null; updateSelection();
  showPosition({ name: data.resolvedName || data.submittedName, type: 'CATALOG POSITION · ICRS', description: `Resolved through ${data.source.name} / ${data.source.resolver}. Fixed catalog position; no proper-motion correction.` });
});
const targetSearch = mountTargetSearch({
  initialPosition: position,
  invalidate: objectLookup.invalidate,
  onEdit: () => { selected = null; updateSelection(); },
  onObject: query => objectLookup.resolve(query),
  onCoordinates: coordinates => {
    position = { ...coordinates, frame: 'icrs' }; selected = null; updateSelection();
    showPosition({ name: 'Your sky position', type: 'CUSTOM COORDINATES · ICRS', description: 'Searching observations at your selected sky position.' });
  },
  onPreset: (targetId, target) => {
    selected = targetId; position = { raDeg: target.raDeg, decDeg: target.decDeg, frame: 'icrs', targetId };
    updateSelection(); showPosition(target);
  },
  onMoving: () => window.dispatchEvent(new CustomEvent('sky:moving-search-requested'))
});
function renderEntryMode(mode, query = $('lookup-name').value) {
  const moving = mode === 'moving';
  $('moving-target').hidden = !moving;
  $('observations').hidden = moving;
  $('target-coordinates').hidden = moving; $('moving-position-note').hidden = !moving;
  if (moving) { $('object-name').textContent = query || 'Moving object'; $('object-type').textContent = 'MOVING OBJECT'; }
  else renderTarget(fixedTargetData);
}
window.addEventListener('sky:entry-mode-changed', event => renderEntryMode(event.detail.mode));
window.addEventListener('sky:search-entry', event => { if (event.detail.type === 'moving') renderEntryMode('moving', event.detail.query); });
$('lookup-name').addEventListener('input', () => { if ($('target-type').value === 'moving') renderEntryMode('moving'); });
// The search area shows progress visually; only actionable failures get text.
window.addEventListener('sky:observations-loading', () => {
  setSearchLoading('observations', true);
  $('target-search-status').textContent = '';
});
window.addEventListener('sky:observations-loaded', event => {
  setSearchLoading('observations', false);
  $('target-search-status').textContent = event.detail.failed && !$('search-error').hidden
    ? $('search-error').textContent : '';
});
const modeDescriptions = {
  'time-lapse': 'Play observations in date order to follow changes over time.',
  blink: 'Alternate between observations to spot changes at a glance.',
  difference: 'Compare observations by subtracting one image from another.',
  'motion-trail': 'Trace how sources move across successive observations.',
  'deep-stack': 'Per-pixel median across up to the selected number of UTC-day frames. Masked, missing and uncovered pixels do not count as zeros.'
};
const checkboxes = { 'combine-exposures': 'combineExposures', 'hide-bad-pixels': 'hideBadPixels', 'reject-visit-glitches': 'rejectVisitGlitches', 'consistent-brightness': 'consistentBrightness', 'inspect-pixels': 'inspectPixels', invert: 'invert' };
const selects = { stretch: 'stretch', colours: 'colours' };
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
function renderSettings() {
  $('detector-array').value = String(viewerSettings.band);
  $('view-mode').value = viewerSettings.viewMode;
  $('field-of-view').value = viewerSettings.fovArcmin;
  $('field-of-view-value').value = viewerSettings.fovArcmin + '′';
  $('field-of-view').setAttribute('aria-valuetext', viewerSettings.fovArcmin + ' arcminutes');
  $('band-range').textContent = ranges[viewerSettings.band - 1] + ' μm';
  $('mode-description').textContent = modeDescriptions[viewerSettings.viewMode];
  for (const [id, key] of Object.entries(checkboxes)) $(id).checked = viewerSettings[key];
  for (const [id, key] of Object.entries(selects)) $(id).value = String(viewerSettings[key]);
  $('contrast').value = viewerSettings.contrast; $('contrast-value').value = viewerSettings.contrast + '%';
  $('max-stack-frames').value = viewerSettings.maxStackFrames;
  $('max-stack-frames-value').value = `${viewerSettings.maxStackFrames} frames`;
}
for (const [id, key] of [['detector-array', 'band'], ['view-mode', 'viewMode']]) {
  $(id).addEventListener('change', () => { viewerSettings[key] = key === 'band' ? Number($(id).value) : $(id).value; renderSettings(); emitSettings(); });
}
$('field-of-view').addEventListener('input', () => {
  $('field-of-view-value').value = $('field-of-view').value + '′';
  $('field-of-view').setAttribute('aria-valuetext', $('field-of-view').value + ' arcminutes');
});
$('field-of-view').addEventListener('change', () => {
  const next = Number($('field-of-view').value);
  if (next === viewerSettings.fovArcmin) return;
  viewerSettings.fovArcmin = next; renderSettings(); emitSettings();
});
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
targetSearch.setEntry(initialEntry);
if (isEmbedded) document.documentElement.classList.add('is-embed');
function restoredTarget() {
  if (restoredTargetId) return presets[restoredTargetId];
  if (initialEntry.query) return { name: initialEntry.query, type: 'CATALOG POSITION · ICRS', description: 'Restored catalog position from this link.' };
  return {
    name: 'Shared sky position',
    type: 'SHARED COORDINATES · ICRS',
    description: 'This link opened a specific patch of sky. The observation search below is already set to it.'
  };
}
// Publish the initial UI settings, then restore the shared destination, after the
// other page modules have attached their listeners. A bare page loads the default target.
window.addEventListener('load', () => {
  emitSettings();
  if (initialEntry.type === 'moving') {
    document.getElementById('target-search-form').requestSubmit();
  } else if (initialEntry.resolved || restoredView && !initialEntry.query) {
    showPosition(restoredTarget());
  } else if (initialEntry.query) {
    document.getElementById('target-search-form').requestSubmit();
  } else {
    selected = 'barnard';
    position = { ...position, targetId: selected };
    updateSelection();
    showPosition(presets.barnard);
  }
}, { once: true });
$('expand-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('.viewer-shell').requestFullscreen();
  } catch { $('announcement').textContent = 'Fullscreen is unavailable in this browser.'; }
});
