// Six-detector view: deep median stacks of D1–D6 side by side on the same sky
// grid, with a linked cursor and a false-colour composite of three detectors.
// Every aligned exposure is projected onto one north-up grid that depends only
// on the target and field of view, so pixel (x, y) is the same sky in all six.
// Stacks are built one detector at a time (downloads do not overlap between
// detectors, and they share one frame cache) and fill in as days arrive.

import { buildDetectorStack, viewerSettings } from './fits-viewer.js';
import { buildFrames } from './timelapse-core.js';
import { canvasToSky } from './sky-projection.js';
import { colormap } from './lib/colormaps.js';
import { formatValue } from './lib/display-scale.js';
import { paintChannel, compositeRgb } from './lib/composite.js';
import { DETECTOR_COUNT, detectorLabel } from './lib/detectors.js';

const MODE = 'six-detector';
const DETECTORS = Array.from({ length: DETECTOR_COUNT }, (_, i) => i + 1);
// Settings that change the measured values; anything else only repaints.
const PROCESSING_KEYS = ['fovArcmin', 'followProperMotion', 'maxStackFrames', 'combineExposures', 'hideBadPixels', 'rejectVisitGlitches',
  'exposuresPerDay', 'maskCategories', 'resampling', 'subtractBackground', 'stackStatistic'];
const DISPLAY_KEYS = ['stretch', 'scaleMode', 'contrast', 'brightness', 'invert', 'colours', 'fillMaskedCores', 'pixelView'];
const MAX_RETRIES = 3;

const $ = id => document.getElementById(id);
const section = $('detector-panels');
const stage = document.querySelector('.viewer-stage');
const explorer = $('explorer');
const grid = section?.querySelector('.detector-panels-grid');
const progressText = $('detector-panels-progress');
const readout = $('detector-readout');
const compositeCanvas = $('composite-canvas');
const channelSelects = { r: $('composite-red'), g: $('composite-green'), b: $('composite-blue') };

let active = false;
let observationState = window.spherexObservationState || null;
let controller = null, generation = 0, building = false;
let processingKey = '', displayKey = '';
let settings = viewerSettings();
// detector → { values, width, pointing, unit, complete, record }
const stacks = new Map();
// detector → { status, message }
const states = new Map();
const panels = new Map();

const channels = () => ({ r: Number(channelSelects.r?.value || 6), g: Number(channelSelects.g?.value || 4), b: Number(channelSelects.b?.value || 2) });
const keyOf = (source, keys) => keys.map(key => JSON.stringify(source[key] ?? null)).join('|');

function observationsKey() {
  const list = observationState?.observations || [];
  const position = observationState?.position;
  return `${position?.raDeg}|${position?.decDeg}|${list.length}|${list.map(item => item.accessUrl || item.observationId).join(',')}`;
}

function framesFor(detector) {
  if (!observationState?.observations?.length) return [];
  return buildFrames(observationState.observations, { band: detector, combineExposures: settings.combineExposures !== false });
}

function searched(detector) {
  const filter = observationState?.detectorFilter;
  return !filter || filter === 'all' || Number(filter) === detector;
}

// ---- Markup -------------------------------------------------------------

function makePanel(detector) {
  const figure = document.createElement('figure');
  figure.className = 'detector-panel';
  figure.dataset.detector = String(detector);
  figure.style.setProperty('--panel-colour', `var(--d${detector})`);
  const frame = document.createElement('div');
  frame.className = 'detector-frame';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${detectorLabel(detector)} deep median stack`);
  const cursor = document.createElement('span');
  cursor.className = 'detector-cursor'; cursor.hidden = true; cursor.setAttribute('aria-hidden', 'true');
  const empty = document.createElement('p');
  empty.className = 'detector-empty';
  frame.append(canvas, cursor, empty);
  const caption = document.createElement('figcaption');
  const title = document.createElement('strong');
  title.textContent = detectorLabel(detector);
  const status = document.createElement('span');
  status.className = 'detector-status';
  const open = document.createElement('button');
  open.type = 'button'; open.className = 'text-button detector-open'; open.textContent = 'Open ↗';
  open.title = `Show the D${detector} deep stack in the main viewer`;
  open.disabled = true;
  open.addEventListener('click', () => window.dispatchEvent(new CustomEvent('sky:coverage-stack-requested', { detail: { detector } })));
  caption.append(title, status, open);
  figure.append(frame, caption);
  bindHover(frame);
  return { figure, frame, canvas, cursor, empty, status, open };
}

if (grid) {
  const info = grid.querySelector('.detector-panels-info');
  for (const detector of DETECTORS) {
    const panel = makePanel(detector);
    panels.set(detector, panel);
    grid.insertBefore(panel.figure, info);
  }
  const compositeFrame = $('composite-frame');
  if (compositeFrame) {
    const cursor = document.createElement('span');
    cursor.className = 'detector-cursor'; cursor.hidden = true; cursor.setAttribute('aria-hidden', 'true');
    compositeFrame.append(cursor);
    panels.set('composite', { frame: compositeFrame, cursor, canvas: compositeCanvas });
    bindHover(compositeFrame);
  }
}

// ---- Painting -----------------------------------------------------------

function paintPanel(detector) {
  const panel = panels.get(detector), stack = stacks.get(detector), state = states.get(detector) || { status: 'waiting' };
  if (!panel) return;
  panel.figure.dataset.state = state.status;
  panel.status.textContent = state.message || '';
  panel.open.disabled = !stack?.complete;
  if (stack?.values) {
    try {
      const { rgba } = paintChannel(stack.values, colormap(settings.colours), { ...settings, width: stack.width });
      putPixels(panel.canvas, rgba, stack.width);
      panel.empty.hidden = true;
      panel.canvas.hidden = false;
      return;
    } catch { /* fall through to the empty message */ }
  }
  panel.canvas.hidden = true;
  panel.empty.hidden = false;
  panel.empty.textContent = state.status === 'not-searched' ? 'Not searched'
    : state.status === 'no-coverage' ? 'No coverage'
    : state.status === 'failed' ? 'Stack unavailable'
    : state.status === 'building' ? 'Loading…' : 'Waiting';
}

function putPixels(canvas, rgba, width) {
  if (canvas.width !== width || canvas.height !== width) { canvas.width = width; canvas.height = width; }
  const context = canvas.getContext('2d', { alpha: false });
  const image = context.createImageData(width, width);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
}

function paintComposite() {
  if (!compositeCanvas) return;
  const chosen = channels();
  const picked = { r: stacks.get(chosen.r), g: stacks.get(chosen.g), b: stacks.get(chosen.b) };
  const width = Object.values(picked).find(stack => stack?.values)?.width;
  const status = $('composite-status');
  if (!width) {
    compositeCanvas.hidden = true;
    if (status) status.textContent = 'Appears once one of its three detectors has data.';
    $('composite-png').disabled = true;
    return;
  }
  const values = key => picked[key]?.values && picked[key].width === width ? picked[key].values : null;
  const { rgba } = compositeRgb({ r: values('r'), g: values('g'), b: values('b') }, width, settings);
  putPixels(compositeCanvas, rgba, width);
  compositeCanvas.hidden = false;
  const pending = Object.entries(picked).filter(([, stack]) => !stack?.complete).map(([key]) => `D${chosen[key]}`);
  if (status) status.textContent = pending.length ? `Still stacking ${pending.join(', ')}; the composite updates as they fill in.` : `Red D${chosen.r} · green D${chosen.g} · blue D${chosen.b}`;
  $('composite-png').disabled = Boolean(pending.length);
}

function paintAll() {
  for (const detector of DETECTORS) paintPanel(detector);
  paintComposite();
  section?.classList.toggle('is-smooth', settings.pixelView === 'smooth');
}

function setState(detector, status, message = '') {
  states.set(detector, { status, message });
  paintPanel(detector);
}

function updateProgress() {
  if (!progressText) return;
  const done = DETECTORS.filter(d => stacks.get(d)?.complete).length;
  const skipped = DETECTORS.filter(d => ['not-searched', 'no-coverage', 'failed'].includes(states.get(d)?.status)).length;
  const current = DETECTORS.find(d => states.get(d)?.status === 'building');
  progressText.textContent = !observationState?.observations
    ? 'Search for a target to build the six detector stacks.'
    : building
      ? `Stacking D${current ?? '…'} · ${done} of ${DETECTORS.length - skipped} detectors finished`
      : done ? `${done} detector stack${done === 1 ? '' : 's'} ready${skipped ? ` · ${skipped} without data` : ''}` : 'No detector stacks yet.';
  $('detector-panels-cancel').hidden = !building;
  $('detector-panels-rebuild').hidden = building || !observationState?.observations?.length || DETECTORS.every(d => stacks.get(d)?.complete || ['not-searched', 'no-coverage'].includes(states.get(d)?.status));
}

// ---- Building -----------------------------------------------------------

function reset() {
  controller?.abort(); controller = null; generation++; building = false;
  stacks.clear(); states.clear();
  paintAll(); updateProgress();
  hideCursor();
}

async function build() {
  if (!active || !observationState?.observations) { updateProgress(); return; }
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal, run = ++generation;
  const isCurrent = () => run === generation && active;
  building = true;
  const chosen = channels();
  // The composite's detectors first, so the colour image appears early.
  const order = [...new Set([chosen.r, chosen.g, chosen.b, ...DETECTORS])];
  for (const detector of DETECTORS) if (!stacks.get(detector)?.complete) setState(detector, 'waiting', 'Queued');
  updateProgress();
  try {
    for (const detector of order) {
      if (!isCurrent()) return;
      if (stacks.get(detector)?.complete) continue;
      const frames = framesFor(detector);
      if (!frames.length) {
        setState(detector, searched(detector) ? 'no-coverage' : 'not-searched', searched(detector) ? 'No coverage in this search' : 'Not in this search');
        continue;
      }
      await buildOne(detector, frames, signal, isCurrent);
      updateProgress();
    }
  } finally {
    if (run === generation) { building = false; controller = null; updateProgress(); }
  }
}

async function buildOne(detector, frames, signal, isCurrent) {
  let total = Math.min(frames.length, Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80)));
  setState(detector, 'building', `0/${total} days`);
  updateProgress();
  for (let attempt = 0; ; attempt++) {
    try {
      const built = await buildDetectorStack(frames, {
        signal, isCurrent,
        onFirstFrame: entry => {
          if (stacks.get(detector)?.values) return;
          stacks.set(detector, { values: entry.canvas.spherexGrid.values, width: entry.canvas.width, pointing: entry.image.pointing, complete: false });
          paintPanel(detector); paintComposite();
        },
        onProgress: progress => {
          total = progress.totalFrames;
          setState(detector, 'building', `${progress.loadedFrames}/${progress.totalFrames} days · ${progress.usedExposures} exposures`);
        },
        onPreview: preview => {
          stacks.set(detector, { values: preview.values, width: preview.width, pointing: preview.reference.pointing, complete: false });
          paintPanel(detector); paintComposite();
        }
      });
      const record = built.record;
      stacks.set(detector, { values: built.values, width: built.width, pointing: built.image.pointing, unit: String(built.image.header?.BUNIT || ''), record, complete: true });
      const skipped = record.failedObservationIds.length;
      setState(detector, 'done', `${record.usedFrameCount} days · ${record.usedExposureCount} exposures${record.excludedByFrameLimit ? ` (of ${record.availableFrameCount} days)` : ''}${skipped ? ` · ${skipped} skipped` : ''}`);
      paintComposite();
      return;
    } catch (error) {
      if (signal.aborted || !isCurrent()) throw new DOMException('Six-detector build cancelled.', 'AbortError');
      // A display change elsewhere restarts the viewer's frame warm-up; decoded
      // frames are kept, so trying again is quick.
      if (error?.name === 'AbortError' && attempt < MAX_RETRIES) { await new Promise(resolve => setTimeout(resolve, 0)); continue; }
      stacks.delete(detector);
      setState(detector, 'failed', error?.message || 'The stack could not be built.');
      paintComposite();
      return;
    }
  }
}

function startOrResume() {
  const nextProcessing = `${observationsKey()}|${keyOf(settings, PROCESSING_KEYS)}`;
  if (nextProcessing !== processingKey) { processingKey = nextProcessing; reset(); }
  if (!building) void build().catch(() => {});
}

// ---- Linked cursor ------------------------------------------------------

let hoverEvent = null, hoverFrame = 0;
function bindHover(frame) {
  frame.addEventListener('pointermove', event => { hoverEvent = { event, frame }; if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover); });
  frame.addEventListener('pointerleave', () => { hoverEvent = null; hideCursor(); });
}

function hideCursor() {
  for (const panel of panels.values()) if (panel.cursor) panel.cursor.hidden = true;
  if (readout) readout.textContent = 'Hover any image: the cursor follows on all seven, and the values in each detector appear here.';
}

function updateHover() {
  hoverFrame = 0;
  if (!hoverEvent) return;
  const { event, frame } = hoverEvent;
  const reference = DETECTORS.map(d => stacks.get(d)).find(stack => stack?.values);
  if (!reference) return;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const fx = (event.clientX - rect.left) / rect.width, fy = (event.clientY - rect.top) / rect.height;
  if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) { hideCursor(); return; }
  const width = reference.width, x = fx * width, y = fy * width;
  const ix = Math.floor(x), iy = Math.floor(y);
  for (const panel of panels.values()) {
    if (!panel.cursor) continue;
    panel.cursor.hidden = false;
    panel.cursor.style.left = `${(ix + 0.5) / width * 100}%`;
    panel.cursor.style.top = `${(iy + 0.5) / width * 100}%`;
  }
  const center = reference.pointing;
  const sky = center ? canvasToSky({ x, y, size: width, centerRaDeg: center.raDeg, centerDecDeg: center.decDeg }) : null;
  const parts = [];
  if (sky) parts.push(`RA ${sky.raDeg.toFixed(5)}° Dec ${sky.decDeg >= 0 ? '+' : ''}${sky.decDeg.toFixed(5)}°`);
  const unit = DETECTORS.map(d => stacks.get(d)?.unit).find(Boolean) || 'MJy/sr';
  const values = DETECTORS.map(d => {
    const stack = stacks.get(d);
    if (!stack?.values || stack.width !== width) return `D${d} –`;
    const value = stack.values[iy * width + ix];
    return `D${d} ${Number.isFinite(value) ? formatValue(value) : 'no data'}`;
  });
  parts.push(`${values.join(' · ')} ${unit}`);
  if (readout) readout.textContent = parts.join(' · ');
}

// ---- Mode and events ----------------------------------------------------

function setActive(next) {
  if (next === active) return;
  active = next;
  if (section) section.hidden = !active;
  stage?.classList.toggle('is-six-detector', active);
  explorer?.classList.toggle('is-six-detector', active);
  if (active) startOrResume();
  else { controller?.abort(); controller = null; generation++; building = false; hideCursor(); updateProgress(); }
}

window.addEventListener('sky:viewer-settings-changed', event => {
  settings = { ...settings, ...(event.detail || {}) };
  const nextDisplay = keyOf(settings, DISPLAY_KEYS);
  const displayChanged = nextDisplay !== displayKey;
  displayKey = nextDisplay;
  if (settings.viewMode !== MODE) { setActive(false); return; }
  if (!active) { setActive(true); return; }
  startOrResume();
  if (displayChanged) paintAll();
});

window.addEventListener('sky:target-selected', () => { observationState = null; processingKey = ''; reset(); });
window.addEventListener('sky:observations-loading', () => { observationState = null; processingKey = ''; reset(); });
window.addEventListener('sky:observations-loaded', event => {
  observationState = event.detail?.failed ? null : event.detail;
  if (active) startOrResume(); else updateProgress();
});

for (const select of Object.values(channelSelects)) select?.addEventListener('change', () => {
  paintComposite();
  // Pull a newly chosen detector to the front of the queue.
  if (active && building) { const keep = processingKey; controller?.abort(); generation++; building = false; processingKey = keep; void build().catch(() => {}); }
});
$('detector-panels-cancel')?.addEventListener('click', () => {
  controller?.abort(); controller = null; generation++; building = false;
  for (const detector of DETECTORS) if (['building', 'waiting'].includes(states.get(detector)?.status)) {
    if (!stacks.get(detector)?.complete) stacks.delete(detector);
    setState(detector, 'waiting', 'Cancelled');
  }
  paintComposite(); updateProgress();
});
$('detector-panels-rebuild')?.addEventListener('click', () => { if (active) void build().catch(() => {}); });
$('composite-png')?.addEventListener('click', () => {
  if (!compositeCanvas || compositeCanvas.hidden) return;
  const chosen = channels();
  compositeCanvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `spherex-composite-R-D${chosen.r}-G-D${chosen.g}-B-D${chosen.b}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
});

displayKey = keyOf(settings, DISPLAY_KEYS);
hideCursor();
updateProgress();
if (settings.viewMode === MODE) setActive(true);
