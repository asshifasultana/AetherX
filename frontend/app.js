import { ensureSearchForm, mountTargetSearch, setSearchLoading } from './target-search.js';
import { readSearchEntry } from './search-route.js';
import { presets } from './presets.js';
import { mountObjectLookup } from './object-lookup.js';
import { initialViewState, isEmbedded } from './share.js';
import { encodeViewState, linkViewSettings } from './url-state.js';
import { MODE_DESCRIPTIONS, SETTINGS_SCHEMA, DEFAULT_SETTINGS, normalizeSettings, applyLook, reconcileLook, resetKeys, loadStoredSettings, storeSettings } from './viewer-settings.js';
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
// Remembered display and processing choices; a shared link's band and field
// of view always win over what this browser last used.
// A link that carries a view (mode, look, brightness…) applies all of it.
const linkedView = linkViewSettings(initialViewState) || {};
let viewerSettings = { ...normalizeSettings({ ...loadStoredSettings(), ...linkedView, band: initialViewState.band, fovArcmin: initialViewState.fovArcmin }), pinnedReferenceKey: '' };
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
  const starTarget = position.targetId ? { preset: position.targetId } : data.catalogName ? { name: data.catalogName } : null;
  window.dispatchEvent(new CustomEvent('sky:target-selected', {
    detail: { ...position, starTarget: starTarget && { ...starTarget, label: data.name, description: data.description, type: data.type } }
  }));
}
const objectLookup = mountObjectLookup(data => {
  // Distance hints for the loading screen; the resolver already looked them up.
  window.dispatchEvent(new CustomEvent('sky:target-distance', { detail: { name: data.resolvedName || data.submittedName, parallaxMas: data.parallaxMas, parallaxErrorMas: data.parallaxErrorMas, redshift: data.redshift } }));
  position = { raDeg: data.raDeg, decDeg: data.decDeg, frame: data.frame };
  selected = null; updateSelection();
  showPosition({ name: data.resolvedName || data.submittedName, catalogName: data.resolvedName || data.submittedName, type: 'CATALOG POSITION · ICRS', description: `Resolved through ${data.source.name} / ${data.source.resolver}. Fixed catalog position; no proper-motion correction.` });
}, { onNotFound: query => {
  // Names without a fixed catalog match may be numbered or named asteroids.
  // Try the moving-object resolver through the same visible search field.
  targetSearch.setMode('moving');
  $('lookup-name').value = query;
  $('target-search-form').requestSubmit();
} });
const targetSearch = mountTargetSearch({
  initialPosition: position,
  invalidate: objectLookup.invalidate,
  onEdit: () => { selected = null; updateSelection(); },
  onObject: query => objectLookup.resolve(query),
  onCoordinates: (coordinates, targetInfo) => {
    position = { ...coordinates, frame: 'icrs' }; selected = null; updateSelection();
    showPosition(targetInfo || { name: 'Your sky position', type: 'CUSTOM COORDINATES · ICRS', description: 'Searching observations at your selected sky position.' });
  },
  onPreset: (targetId, target) => {
    selected = targetId; position = { raDeg: target.raDeg, decDeg: target.decDeg, frame: 'icrs', targetId };
    updateSelection(); showPosition(target);
  },
  onMoving: () => window.dispatchEvent(new CustomEvent('sky:moving-search-requested'))
});
window.addEventListener('sky:search-cancel', objectLookup.invalidate);
window.addEventListener('sky:navigate-context',event=>{
  const data=event.detail;
  if(!Number.isFinite(data?.raDeg)||!Number.isFinite(data?.decDeg)||Math.abs(data.decDeg)>90)return;
  objectLookup.invalidate();
  position={raDeg:data.raDeg,decDeg:data.decDeg,frame:'icrs'};selected=null;updateSelection();
  targetSearch.setMode('coordinates');targetSearch.setPosition(position,'degrees');
  window.dispatchEvent(new CustomEvent('sky:search-entry',{detail:{type:'coordinates',query:'',format:'degrees',resolved:true}}));
  showPosition({name:data.name||'Cultural sky position',type:'CULTURAL NAVIGATION ANCHOR · ICRS',description:'A verified anchor for this cultural figure; SPHEREx coverage is checked separately.'});
});
function renderEntryMode(mode, query = $('lookup-name').value) {
  const moving = mode === 'moving';
  $('workspace').dataset.entryMode = mode;
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
const TONE_KEYS = new Set(['stretch', 'scaleMode', 'contrast', 'brightness']);
const optionLists = selector => [...(document.querySelectorAll?.(selector) || [])];
let lastDisplayLimits = null;
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
window.addEventListener('sky:six-detector-requested', () => {
  viewerSettings.viewMode = 'six-detector';
  renderSettings();
  emitSettings('six-detector');
});
const maskBoxes = () => optionLists('#mask-categories input[type="checkbox"]');
function readControl(control, element) {
  if (control.type === 'checkbox') return element.checked;
  if (control.type === 'multi') return maskBoxes().filter(box => box.checked).map(box => box.value);
  if (control.type === 'number') return element.value === '' || element.value == null ? null : Number(element.value);
  if (control.type === 'range' || control.number) return Number(element.value);
  return element.value;
}
function renderSettings() {
  for (const control of SETTINGS_SCHEMA) {
    const element = $(control.id);
    if (!element) continue;
    const value = viewerSettings[control.key];
    if (control.type === 'checkbox') element.checked = Boolean(value);
    else if (control.type === 'multi') for (const box of maskBoxes()) box.checked = value.includes(box.value);
    else if (control.type === 'number') element.value = value ?? '';
    else element.value = control.type === 'range' ? value : String(value);
    const output = control.format && $(control.id + '-value');
    if (output) output.value = control.format(value);
    if (control.valuetext) element.setAttribute('aria-valuetext', control.valuetext(value));
  }
  for (const radio of optionLists('input[name="look"]')) radio.checked = radio.value === viewerSettings.look;
  $('band-range').textContent = ranges[viewerSettings.band - 1] + ' μm';
  $('mode-description').textContent = MODE_DESCRIPTIONS[viewerSettings.viewMode];
  // Show only the controls that matter for the chosen mode and scale.
  for (const element of optionLists('[data-show-mode]')) element.hidden = !element.dataset.showMode.split(' ').includes(viewerSettings.viewMode);
  for (const element of optionLists('[data-show-scale]')) element.hidden = viewerSettings.scaleMode !== element.dataset.showScale;
}
function update(changes, { announce = '' } = {}) {
  let next = { ...viewerSettings, ...changes };
  if (Object.keys(changes).some(key => TONE_KEYS.has(key)) && !('look' in changes)) next = reconcileLook(next);
  // Switching to manual limits starts from the limits currently on screen.
  if (changes.scaleMode === 'manual' && lastDisplayLimits && next.scaleLow === null && next.scaleHigh === null) {
    next.scaleLow = Number(lastDisplayLimits.low.toPrecision(4)); next.scaleHigh = Number(lastDisplayLimits.high.toPrecision(4));
  }
  viewerSettings = { ...normalizeSettings(next), pinnedReferenceKey: next.pinnedReferenceKey || '' };
  renderSettings(); storeSettings(viewerSettings); emitSettings();
  if (announce) $('announcement').textContent = announce;
}
for (const control of SETTINGS_SCHEMA) {
  const element = $(control.id);
  if (!element) continue;
  if (control.type === 'range') element.addEventListener('input', () => {
    const value = Number(element.value), output = control.format && $(control.id + '-value');
    if (output) output.value = control.format(value);
    if (control.valuetext) element.setAttribute('aria-valuetext', control.valuetext(value));
  });
  const commit = control.type === 'range' && control.commit !== 'change' ? 'input' : 'change';
  element.addEventListener(commit, () => {
    const value = readControl(control, element);
    if (JSON.stringify(value) === JSON.stringify(viewerSettings[control.key])) return;
    update({ [control.key]: value });
  });
}
for (const radio of optionLists('input[name="look"]')) radio.addEventListener('change', () => {
  if (!radio.checked) return;
  if (radio.value === 'custom') {
    const advanced = document.querySelector?.('details[data-advanced="display"]');
    if (advanced) advanced.open = true;
    update({ look: 'custom' });
  } else {
    const looked = applyLook(viewerSettings, radio.value);
    update({ look: looked.look, stretch: looked.stretch, scaleMode: looked.scaleMode, contrast: looked.contrast, brightness: looked.brightness });
  }
});
// The AI guide changes settings through the same validated path as the controls.
window.addEventListener('sky:agent-settings-requested', event => {
  const changes = event.detail?.changes;
  if (!changes || typeof changes !== 'object') return;
  let next = { ...changes };
  if (next.look && next.look !== 'custom') {
    const looked = applyLook(viewerSettings, next.look);
    next = { look: looked.look, stretch: looked.stretch, scaleMode: looked.scaleMode, contrast: looked.contrast, brightness: looked.brightness, ...next, look: looked.look };
    // Explicit tone values alongside a look turn it into a custom look.
    if (['stretch', 'scaleMode', 'contrast', 'brightness'].some(key => key in changes)) delete next.look;
  }
  update(next, { announce: typeof event.detail.announce === 'string' ? event.detail.announce : '' });
});
window.addEventListener('sky:agent-navigate', event => {
  const detail = event.detail || {};
  if (detail.preset && presets[detail.preset]) {
    const target = presets[detail.preset];
    objectLookup.invalidate();
    targetSearch.setEntry({ type: 'object', query: target.name });
    window.dispatchEvent(new CustomEvent('sky:search-entry', { detail: { type: 'object', query: target.name } }));
    // A game may ask for the fixed-sky view to be framed off the star (presets.js viewerTarget).
    const offset = detail.viewOffset, shifted = Number.isFinite(offset?.eastArcmin) && Number.isFinite(offset?.northArcmin);
    selected = detail.preset; position = { raDeg: target.raDeg, decDeg: target.decDeg, frame: 'icrs', targetId: detail.preset, ...(shifted ? { viewOffset: { eastArcmin: offset.eastArcmin, northArcmin: offset.northArcmin } } : {}) };
    updateSelection(); showPosition(target);
  } else if (typeof detail.name === 'string' && detail.name && !Number.isFinite(detail.raDeg)) {
    targetSearch.setEntry({ type: 'object', query: detail.name });
    window.dispatchEvent(new CustomEvent('sky:search-entry', { detail: { type: 'object', query: detail.name } }));
    objectLookup.resolve(detail.name);
  } else if (Number.isFinite(detail.raDeg) && Number.isFinite(detail.decDeg)) {
    objectLookup.invalidate();
    position = { raDeg: detail.raDeg, decDeg: detail.decDeg, frame: 'icrs' }; selected = null; updateSelection();
    targetSearch.setMode('coordinates'); targetSearch.setPosition(position, 'degrees');
    window.dispatchEvent(new CustomEvent('sky:search-entry', { detail: { type: 'coordinates', query: '', format: 'degrees', resolved: true } }));
    showPosition({ name: detail.name || 'Your sky position', type: 'CUSTOM COORDINATES · ICRS', description: 'Chosen by the AI guide.' });
  }
});
window.addEventListener('sky:reference-frame-pinned', event => {
  if (!event.detail?.key) return;
  update({ referenceFrame: 'pinned', pinnedReferenceKey: event.detail.key }, { announce: 'This frame is now the comparison reference.' });
});
window.addEventListener('sky:display-scale-locked', () => {
  viewerSettings.consistentBrightness = true; renderSettings(); storeSettings(viewerSettings);
  $('announcement').textContent = 'Display scale locked to the current frame.';
});
window.addEventListener('sky:display-limits', event => { if (Number.isFinite(event.detail?.low) && Number.isFinite(event.detail?.high)) lastDisplayLimits = event.detail; });
const RESET_KEYS = Object.keys(DEFAULT_SETTINGS);
function resetAllSettings(announce = '') {
  viewerSettings = { ...resetKeys(viewerSettings, RESET_KEYS), pinnedReferenceKey: '' };
  renderSettings(); storeSettings(viewerSettings); emitSettings();
  if (announce) $('announcement').textContent = announce;
}
$('reset-button').addEventListener('click', () => {
  resetAllSettings('All viewer settings reset to their defaults.');
});
// Every search starts a target from the default settings, so a new star never
// inherits the previous target's view, processing or display choices.
window.addEventListener('sky:search-entry', () => resetAllSettings());
// Remember which sections and Advanced panels are open.
const OPEN_KEY = 'spherex-open-sections-v1';
let openSections = {};
try { openSections = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) || '{}') || {}; } catch { openSections = {}; }
for (const details of optionLists('details[data-advanced], details[data-section]')) {
  const name = details.dataset.advanced ? `advanced-${details.dataset.advanced}` : `section-${details.dataset.section}`;
  if (typeof openSections[name] === 'boolean') details.open = openSections[name];
  details.addEventListener('toggle', () => {
    openSections[name] = details.open;
    try { globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(openSections)); } catch { /* storage may be unavailable */ }
  });
}
renderSettings();
updateSelection();
targetSearch.setEntry(initialEntry);
if (isEmbedded) document.documentElement.classList.add('is-embed');
function restoredTarget() {
  if (restoredTargetId) return presets[restoredTargetId];
  if (initialEntry.type === 'object' && initialEntry.query) return { name: initialEntry.query, catalogName: initialEntry.query, type: 'CATALOG POSITION · ICRS', description: 'Restored catalog position from this link.' };
  return {
    name: 'Shared sky position',
    type: 'SHARED COORDINATES · ICRS',
    description: 'This link opened a specific patch of sky. The observation search below is already set to it.'
  };
}
// Publish the initial UI settings, then restore the shared destination, after the
// other page modules have attached their listeners. A bare page loads the default target.
window.addEventListener('load', () => {
  if (viewerSettings.referenceFrame === 'pinned' && initialViewState.referenceDate) {
    window.dispatchEvent(new CustomEvent('sky:reference-date-requested', { detail: { date: initialViewState.referenceDate } }));
  }
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
