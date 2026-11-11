import { canvasToSky, skyToCanvas } from './sky-projection.js';
import { createSpotList, MAX_SPOTS, spotRadius, MIN_SPOT_RADIUS_ARCSEC } from './lib/spots.js';
import { snapToPeak } from './lib/peak.js';
import { trackArrow, describeTrack, trackUpTo } from './lib/track-arrow.js';
import { displayGrid } from './display-grid.js';
import { initialViewState } from './share.js';
import { QUALITY_FLAGS, FLAG_CATEGORIES, maskBitsFor } from './lib/pixel-quality.js';
import { colormap, colormapGradient } from './lib/colormaps.js';
import { scaleLimits, toneMapper, differenceMapper, gaussianSmooth, fillMaskedHoles, formatValue, subtractLargeScale } from './lib/display-scale.js';
import { estimateBackground } from './lib/background.js';
import { DEFAULT_SETTINGS } from './viewer-settings.js';
import { matrixFor, projectSkyToPixel, projectionKey } from './lib/fits-engine.js';
import { imagePipeline } from './image-pipeline.js';
import { loadCometEpsf } from './lib/comet-native-fit.js';
import { gridPsf } from './lib/core-fill.js';
import { ByteCache, assertStackBudget } from './lib/image-resources.js';
import { observationKey, frameTime } from './timelapse-core.js';
import { exposureCenter, presetMotion, viewerTarget } from './presets.js';

const canvas = document.getElementById('sky-canvas');
const context = canvas.getContext('2d', { alpha: false });
const status = document.getElementById('cutout-status');
const caption = document.getElementById('cutout-caption');
const spotLayer = document.getElementById('spot-layer');
const pixelInspector = document.getElementById('pixel-inspector');
const pixelInspectorResult = document.getElementById('pixel-inspector-result');
const overlay = document.getElementById('overlay-canvas');
const hoverReadout = document.getElementById('quality-hover-readout');
const qualityLegend = document.getElementById('quality-legend');
const blinkBadge = document.getElementById('blink-badge');
// Flags are always fetched: they drive masking, the flag overlay and inspection.
const withDerived = next => ({ ...next, includeFlags: true, maskBits: maskBitsFor(next.maskCategories) });
let target = { raDeg: 269.4521, decDeg: 4.6934 }, settings = withDerived({ ...DEFAULT_SETTINGS });
// The position the user chose; `target` is what the viewer centres on, which
// differs only when a proper-motion preset is shown on a fixed sky grid.
let selectedTarget = target;
let activeObservation = null, activeSequence = 0, cutoutController = null;
let displayedCenter = target;
let publishedGrid = null;
function publishGrid(observation, image, { suspended=false }={}) {
  publishedGrid=suspended?null:displayGrid({observation,image,center:image?.pointing||displayedCenter,width:canvas.width,deep:settings.viewMode==='deep-stack'});
  window.dispatchEvent(new CustomEvent('sky:display-grid-changed',{detail:publishedGrid}));
}
let inspectionCanvasPoint = null;
let pixelInspectionSequence = 0;
let activeFrameExposures = [];
let timelineFrames = [];
let activeTimelineFrame = null;
let dataGeneration = 0;
let repaintSequence = 0;
let deepStackScheduled = false;
let comparisonScale = null;
// What is on screen now, for the overlay, colour bar and hover readout.
let shown = null;
let blinkTimer = null;
let deepTemplateCache = null;
// Marked spots are absolute sky positions, so they survive frame changes, band
// changes and a new search. Only the field of view can move one (partly) out of
// frame. Visitors add spots by clicking; the AI guide adds its own.
const spots = createSpotList();
const PIXEL_ARCSEC = 6.15;
// Decoded frames and their rendered canvases live in memory so playback can swap
// frames with a single draw instead of re-fetching and re-parsing FITS.
const decodedFrames = new ByteCache();
const renderedFrames = new ByteCache();

// The active quality mask; the backend applies the same bits to pixel inspection.
const badPixelMask = () => settings.maskBits >>> 0;
const COMPARISON_MODES = new Set(['blink', 'difference', 'motion-trail']);
const MODE_NAMES = { blink: 'Blink', difference: 'Difference', 'motion-trail': 'Motion trail' };
const STRETCH_NAMES = { asinh: 'asinh', linear: 'linear', sqrt: 'square root', log: 'log', histeq: 'hist. equalised' };
const isComparisonMode = () => COMPARISON_MODES.has(settings.viewMode);

const cards = text => { status.textContent = text; };
window.addEventListener('sky:target-selected', event => { dataGeneration++; selectedTarget = { ...event.detail }; target = viewerTarget(selectedTarget, settings.followProperMotion); comparisonScale = null; activeObservation = null; activeTimelineFrame = null; activeFrameExposures = []; timelineFrames = []; activeSequence++; cutoutController?.abort(); resetViewer('Loading observations…'); });
window.addEventListener('sky:frame-exposure-group', event => { activeFrameExposures = Array.isArray(event.detail?.exposures) ? event.detail.exposures : []; activeTimelineFrame = event.detail?.frame || activeTimelineFrame; });
window.addEventListener('sky:timeline-frames-changed', event => {
  timelineFrames = Array.isArray(event.detail?.frames) ? event.detail.frames : [];
  if (settings.viewMode === 'deep-stack') scheduleDeepStack();
});
function scheduleDeepStack() {
  if (deepStackScheduled) return;
  deepStackScheduled = true;
  queueMicrotask(() => { deepStackScheduled = false; if (settings.viewMode === 'deep-stack') void showDeepStack(); });
}
window.addEventListener('sky:viewer-settings-changed', event => {
  const previousFov = settings.fovArcmin, previousCompose = composeSignature();
  const previousBand = settings.band, previousConsistent = settings.consistentBrightness;
  const previousMode = settings.viewMode, previousStackLimit = settings.maxStackFrames;
  const previousGlitchRejection = settings.rejectVisitGlitches, previousScale = scaleSignature();
  const incoming = withDerived({ ...settings, ...event.detail });
  // New black/white points are needed whenever the measured values or the
  // limit algorithm change; stretch, colour and contrast keep a locked scale.
  const scaleChanged = scaleSignatureOf(incoming) !== previousScale;
  const previousDisplay = displaySignature();
  settings = incoming;
  const previousCenter = `${target.raDeg}|${target.decDeg}|${target.targetId || ''}`;
  target = viewerTarget(selectedTarget, settings.followProperMotion);
  const centerChanged = previousCenter !== `${target.raDeg}|${target.decDeg}|${target.targetId || ''}`;
  if(previousMode!==settings.viewMode||previousFov!==settings.fovArcmin||previousBand!==settings.band||centerChanged)publishGrid(null,null,{suspended:true});
  if (scaleChanged || centerChanged) comparisonScale = null;
  const changed = previousDisplay !== displaySignature() || previousBand !== settings.band;
  if (changed) { dataGeneration++; activeSequence++; cutoutController?.abort(); }
  if (settings.viewMode !== 'blink') stopBlink();
  drawOverlay();
  if (pixelInspector) pixelInspector.hidden = !settings.inspectPixels;
  document.querySelector('.viewer')?.classList.toggle('is-inspecting', Boolean(settings.inspectPixels));
  document.querySelector('.viewer')?.classList.toggle('is-smooth', settings.pixelView === 'smooth');
  document.querySelector('.viewer')?.classList.toggle('is-quality-inspecting', Boolean(settings.inspectPixels || settings.qualityOverlay));
  if (previousGlitchRejection && settings.rejectVisitGlitches === false) {
    for (const image of decodedFrames.values()) { image.derivedTransientPixels?.clear(); image.projectionKey = ''; }
    renderedFrames.clear();
  }
  if (settings.fovArcmin !== previousFov || settings.band !== previousBand || settings.consistentBrightness !== previousConsistent) comparisonScale = null;
  if (settings.viewMode === 'deep-stack' && changed) { scheduleDeepStack(); return; }
  if (changed && activeObservation && !activeObservation.image) { void showCutout(activeTimelineFrame || activeObservation); return; }
  if (activeObservation?.image && activeObservation.detector !== settings.band) {
    status.hidden = false; status.classList.remove('is-error');
    cards(`The loaded image is D${activeObservation.detector}. Choose a D${settings.band} observation in the archive results to view this wavelength band.`);
  } else if ((settings.fovArcmin !== previousFov || centerChanged) && activeObservation) {
    // A new FOV needs a new archive cutout; clear the old image and label the requested size immediately.
    showCutout(activeObservation);
  } else if (settings.viewMode === 'deep-stack' && (previousMode !== 'deep-stack' || previousStackLimit !== settings.maxStackFrames)) {
    void showDeepStack();
  } else if (previousMode !== settings.viewMode && activeTimelineFrame) {
    void showCutout(activeTimelineFrame, { quiet: true, keepImage: true });
  } else if (isComparisonMode() && (changed || previousCompose !== composeSignature()) && activeTimelineFrame) {
    void showCutout(activeTimelineFrame, { quiet: true, keepImage: true });
  } else if (activeObservation?.image?.stackRecord && changed) {
    void showCutout(activeTimelineFrame || activeObservation);
  } else if (activeObservation?.image && displaySignature() !== previousDisplay) {
    // Only an actual display change (stretch, colours, contrast, mask) needs a
    // repaint. A detector-band sync must not re-render the frame that just drew.
    status.hidden = true; void drawImage(activeObservation.image).catch(error => { cards(error.message); status.hidden = false; });
  } else updateColourBar();
});

function resetViewer(message) {
  publishGrid(null,null,{suspended:true});
  displayedCenter = target;
  stopBlink();
  shown = null;
  drawOverlay(); updateColourBar();
  if (hoverReadout) hoverReadout.hidden = true;
  document.querySelector('.viewer')?.classList.remove('has-image');
  canvas.dataset.deepStack = 'false';
  document.getElementById('export-sky-png').disabled = true;
  document.getElementById('coverage-note').hidden = true;
  context.fillStyle = '#08090e'; context.fillRect(0, 0, canvas.width, canvas.height);
  if (spotLayer) spotLayer.hidden = true;
  caption.textContent = '';
  status.hidden = false; status.classList.remove('is-error');
  cards(message);
}

// Black and white points for a grid, honouring a locked comparison scale.
function displayLimits(values) {
  const automatic = scaleLimits(values, settings.scaleMode, { low: settings.scaleLow, high: settings.scaleHigh });
  if (settings.scaleMode === 'manual' || !settings.consistentBrightness) return { limits: automatic, automatic };
  if (!comparisonScale) comparisonScale = automatic;
  return { limits: comparisonScale, automatic };
}

const NO_DATA_RGB = [15, 12, 22];
// Paint a projected value grid. Smoothing and tone mapping are display-only:
// the element keeps the measured values for stacks, inspection and readouts.
// SPHEREx ePSF per detector, for rebuilding masked star cores. Loaded once on
// first use; until it arrives (or if it cannot be fetched) cores use the rim fill.
const epsfByDetector = new Map();
function epsfFor(detector) {
  if (!Number.isInteger(detector)) return null;
  if (!epsfByDetector.has(detector)) {
    epsfByDetector.set(detector, null);
    loadCometEpsf(detector).then(epsf => {
      epsfByDetector.set(detector, epsf);
      if (settings.fillMaskedCores && settings.band === detector) repaintForPsf();
    }).catch(() => { /* Keep the rim fill. */ });
  }
  return epsfByDetector.get(detector);
}
function repaintForPsf() {
  renderedFrames.clear();
  if (settings.viewMode === 'deep-stack') return; // stacks carry no single-detector PSF frame
  if (activeTimelineFrame) void showCutout(activeTimelineFrame, { quiet: true, keepImage: true });
  else if (activeObservation?.image && !activeObservation.image.stackRecord) void drawImage(activeObservation.image).catch(() => {});
}

// Masked star cores are rebuilt for display (see fillMaskedHoles and
// core-fill.js); difference maps are left alone so a masked pixel never fakes
// a residual.
function paintGrid(element, values, width, { mapper = null, lut = null, smooth = true, covered = null, psfFrame = null } = {}) {
  const epsf = !mapper && settings.fillMaskedCores && psfFrame ? epsfFor(settings.band) : null;
  const psf = epsf ? gridPsf(epsf, psfFrame) : null;
  const filled = !mapper && settings.fillMaskedCores ? fillMaskedHoles(values, width, { covered, psf }) : values;
  const display = smooth && settings.smoothing ? gaussianSmooth(filled, width, settings.smoothing) : filled;
  let limits = null, automatic = null;
  if (!mapper) {
    ({ limits, automatic } = displayLimits(display));
    if (!(limits.high > limits.low)) throw new Error('The image has no usable contrast with these scale limits.');
  }
  const level = mapper || toneMapper({ ...limits, stretch: settings.stretch, contrast: settings.contrast, brightness: settings.brightness, invert: settings.invert }, settings.stretch === 'histeq' ? display : null);
  const table = lut || colormap(settings.colours);
  element.width = width; element.height = width;
  const paintContext = element.getContext('2d', { alpha: false });
  const output = paintContext.createImageData(width, width), data = output.data;
  for (let i = 0; i < display.length; i++) {
    const value = display[i], at = i * 4;
    if (Number.isFinite(value)) {
      const index = level(value) * 3;
      data[at] = table[index]; data[at + 1] = table[index + 1]; data[at + 2] = table[index + 2];
    } else { data[at] = NO_DATA_RGB[0]; data[at + 1] = NO_DATA_RGB[1]; data[at + 2] = NO_DATA_RGB[2]; }
    data[at + 3] = 255;
  }
  paintContext.putImageData(output, 0, 0);
  element.spherexLimits = limits;
  element.spherexAutomaticLimits = automatic;
  return { limits, automatic };
}

// A fake moving source the AI guide's "hidden planet" quest adds to every
// rendered exposure. It is added to a copy of the projected grid, never to the
// decoded or cached data, and is removed by clearing it.
let synthetic = null;
function imageMjd(image) {
  const header = image?.header || {};
  const average = Number(header['MJD-AVG']);
  if (Number.isFinite(average)) return average;
  const start = Date.parse(String(header['DATE-BEG'] ?? header['DATE-OBS'] ?? '').replace(/(\d)$/, '$1Z'));
  return Number.isFinite(start) ? start / 86400000 + 40587 : NaN;
}
function withSynthetic(values, width, image) {
  if (!synthetic || image.stackRecord) return values;
  const mjd = imageMjd(image);
  if (!Number.isFinite(mjd)) return values;
  const days = mjd - synthetic.epochMjd;
  const sky = { raDeg: synthetic.raDeg + days * synthetic.raPerDay, decDeg: synthetic.decDeg + days * synthetic.decPerDay };
  const center = image.pointing || displayedCenter;
  const point = skyToCanvas({ ...sky, size: width, centerRaDeg: center.raDeg, centerDecDeg: center.decDeg });
  if (!point) return values;
  // One fixed brightness in image units for every exposure, so a fake that
  // stays put cancels in a difference and one that moves shows as a pair.
  const peak = Number.isFinite(synthetic.peak) ? synthetic.peak : synthetic.peakSigma * estimateBackground(values).noise;
  if (!(peak > 0)) return values;
  const copy = Float32Array.from(values), spread = 2 * 0.7 ** 2;
  for (let y = Math.floor(point.y) - 3; y <= Math.ceil(point.y) + 3; y++) for (let x = Math.floor(point.x) - 3; x <= Math.ceil(point.x) + 3; x++) {
    if (x < 0 || y < 0 || x >= width || y >= Math.floor(copy.length / width)) continue;
    const index = y * width + x;
    if (Number.isFinite(copy[index])) copy[index] += peak * Math.exp(-((x - point.x) ** 2 + (y - point.y) ** 2) / spread);
  }
  return copy;
}

function paintCanvas(element, image) {
  const projected = image.stackRecord
    ? { values: image.values, flags: new Uint32Array(image.values.length), coverage: image.values.reduce((n, v) => n + Number.isFinite(v), 0) / image.values.length, width: image.width }
    : image.projection;
  if (!projected) throw new Error('This image has not been projected.');
  if (!projected.values.some(Number.isFinite)) throw new Error('No valid pixels remain after applying the quality mask.');
  const values = withSynthetic(projected.values, projected.width, image);
  paintGrid(element, values, projected.width, { covered: projected.covered || null, psfFrame: projected.psfFrame || null });
  element.spherexGrid = { values, flags: image.stackRecord ? null : projected.flags };
  return projected.coverage;
}

async function paintStackCanvas(element, entries, observations, signal) {
  if (!entries.length) throw new Error('No daily exposures were retrieved for this frame.');
  const statistic = settings.stackStatistic === 'clipped-mean' ? 'clipped-mean' : 'median';
  const grid = await imagePipeline.combine(entries.map(entry => entry.canvas.spherexGrid.values), { statistic }, signal);
  if (!grid.values.some(Number.isFinite)) throw new Error('No valid pixels remain in the daily exposure stack.');
  const width = Math.max(1, Math.round(settings.fovArcmin * 60 / PIXEL_ARCSEC));
  // The day's exposures share a detector and nearly the same orientation.
  paintGrid(element, grid.values, width, { psfFrame: entries.find(entry => entry.image?.projection?.psfFrame)?.image.projection.psfFrame || null });
  element.spherexGrid = { values: grid.values, flags: null, counts: grid.counts };
  const exposureSeconds = entries.reduce((sum, entry) => sum + (Number(entry.observation.exposureSeconds) || 0), 0);
  const times = observations.map(observation => Date.parse(observation.observedStartUtc || '')).filter(Number.isFinite).sort((a, b) => a - b);
  const record = {
    method: `per-pixel ${statistic === 'clipped-mean' ? '3σ-clipped mean' : 'median'} of quality-masked, ${settings.subtractBackground === false ? 'unsubtracted' : 'individually background-subtracted'} aligned exposures`,
    requestedExposureCount: observations.length,
    usedExposureCount: entries.length,
    failedObservationIds: observations.filter(observation => !entries.some(entry => entry.observation === observation)).map(observation => observation.observationId),
    observationIds: entries.map(entry => entry.observation.observationId).filter(Boolean),
    productIds: entries.map(entry => entry.observation.productId).filter(Boolean),
    contributors: entries.map(entry => ({
      observationId: entry.observation.observationId || '', productId: entry.observation.productId || '',
      release: entry.observation.release || entry.observation.collection || '',
      processingVersion: entry.observation.processingVersion || '', observedStartUtc: entry.observation.observedStartUtc || '',
      exposureSeconds: Number(entry.observation.exposureSeconds) || 0,
      validOutputPixels: entry.canvas.spherexGrid.values.reduce((count, value) => count + Number.isFinite(value), 0)
    })),
    exposureSeconds,
    startUtc: times.length ? new Date(times[0]).toISOString() : null,
    endUtc: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    validPixelContributions: grid.validPixelContributions,
    coveredOutputPixels: grid.coveredPixels,
    totalOutputPixels: grid.totalPixels
  };
  element.spherexStackRecord = record;
  return { coverage: grid.coveredPixels / grid.totalPixels, record, values: grid.values, counts: grid.counts };
}

function applyChrome(coverage) {
  document.querySelector('.viewer')?.classList.add('has-image');
  document.querySelector('.viewer')?.classList.add('is-marking');
  const coverageNote = document.getElementById('coverage-note');
  coverageNote.hidden = coverage >= 0.98;
  coverageNote.textContent = coverageNote.hidden ? '' : `Partial coverage · ${Math.round(coverage * 100)}%`;
  coverageNote.title = 'The remaining area falls outside this exposure’s detector footprint and has no image data.';
}

async function drawImage(image) {
  const sequence = activeSequence, repaint = ++repaintSequence;
  const requestedTarget = image.pointing || target, requestedSettings = { ...settings };
  if (!image.stackRecord && image.projectionKey !== projectionKey(requestedTarget, settings)) {
    image.projection = await imagePipeline.project(image, requestedTarget, requestedSettings);
    image.projectionKey = projectionKey(requestedTarget, requestedSettings);
  }
  if (sequence !== activeSequence || repaint !== repaintSequence) return;
  const coverage = paintCanvas(canvas, image);
  displayedCenter=image.pointing||target;
  publishGrid(activeObservation,image);
  applyChrome(coverage);
  positionMark();
  setShown(canvas, image);
  return coverage;
}


function publishSpots() {
  positionMark();
  const list = spots.list();
  window.dispatchEvent(new CustomEvent('sky:spots-changed', { detail: { spots: list } }));
  const first = list.find(spot => spot.origin === 'user') || list[0];
  window.dispatchEvent(new CustomEvent('sky:source-marked', { detail: first ? { raDeg: first.raDeg, decDeg: first.decDeg, radiusArcsec: first.radiusArcsec } : {} }));
}

const formatSpot = spot => `${spot.raDeg.toFixed(4)}°, ${spot.decDeg >= 0 ? '+' : ''}${spot.decDeg.toFixed(4)}°`;
const formatRadius = arcsec => arcsec < 60 ? `${Math.round(arcsec)}″` : `${(arcsec / 60).toFixed(arcsec < 600 ? 1 : 0)}′`;

// An area spot's ring diameter as a percentage of the image width. The spot
// layer is a size container, so `cqw` lets the ring scale with the canvas.
function sizeArea(mark, radiusArcsec, size) {
  const fraction = (2 * radiusArcsec / PIXEL_ARCSEC) / size;
  mark.classList.add('is-area');
  mark.classList.toggle('is-large', fraction > 0.45);
  mark.style.setProperty('--spot-d', String(fraction * 100));
}

// Canvas pixel under a pointer event (unclamped, so drags can leave the image).
function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect(), size = canvas.width;
  if (!rect.width || !rect.height || !size) return null;
  return { x: ((event.clientX - rect.left) / rect.width) * size, y: ((event.clientY - rect.top) / rect.height) * size, scale: size / rect.width };
}

// Place one numbered DOM marker per spot over the stretched canvas. Percentages
// of the element box map one-to-one onto canvas pixels, so marks stay put at
// every field of view even though the canvas has a fluid CSS size. Area spots
// draw a ring to scale; the handle on its edge resizes any spot.
function positionMark() {
  if (!spotLayer) return;
  const size = canvas.width, list = spots.list().map(shownSpot);
  if (!list.length || !size || !document.querySelector('.viewer')?.classList.contains('has-image')) { spotLayer.hidden = true; return; }
  spotLayer.hidden = false;
  const elements = list.map(spot => {
    const point = skyToCanvas({ raDeg: spot.raDeg, decDeg: spot.decDeg, size, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
    if (!point) return null;
    const clamp = value => Math.max(0, Math.min(size - 1, value));
    const x = clamp(point.x), y = clamp(point.y), offscreen = x !== point.x || y !== point.y;
    const mark = document.createElement('div');
    mark.className = `source-mark spot-mark is-${spot.origin}${spot.found ? ' is-found' : ''}${offscreen ? ' is-offscreen' : ''}`;
    mark.style.left = `${((x + 0.5) / size) * 100}%`;
    mark.style.top = `${((y + 0.5) / size) * 100}%`;
    mark.dataset.spot = String(spot.n);
    if (spot.radiusArcsec && !offscreen) sizeArea(mark, spot.radiusArcsec, size);
    const area = `${spot.radiusArcsec ? ` · radius ${formatRadius(spot.radiusArcsec)}` : ''}${spot.found ? ' · identified as a known object' : ''}`;
    const ring = document.createElement('span'); ring.className = 'source-mark-ring';
    const label = document.createElement('button');
    label.type = 'button'; label.className = 'source-mark-label spot-label';
    label.textContent = `${spot.n}${offscreen ? ' · outside field' : ''}`;
    label.title = `Spot ${spot.n}${spot.label ? ` (${spot.label})` : ''} · ${formatSpot(spot)}${area}${offscreen ? ' · outside this field of view' : ''}. Click to ask the AI guide about it.`;
    label.setAttribute('aria-label', `Spot ${spot.n} at ${formatSpot(spot)}${area}. Ask the AI guide about it.`);
    label.addEventListener('click', event => { event.stopPropagation(); window.dispatchEvent(new CustomEvent('sky:spot-selected', { detail: { ...spot } })); });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'spot-remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove spot ${spot.n}`);
    remove.addEventListener('click', event => { event.stopPropagation(); spots.remove(spot.n); publishSpots(); });
    mark.append(ring, label, remove);
    if (!offscreen) mark.append(resizeHandle(spot, mark, point, size));
    return mark;
  }).filter(Boolean);
  const tracks = trackLayer(list, size);
  spotLayer.replaceChildren(...(tracks ? [tracks] : []), ...elements);
}

// Arrows for spots followed across frames: from where the star was on the
// oldest date to where it was on the newest. Drawn in canvas pixels, with
// strokes sized for the canvas's current CSS scale (redrawn on resize).
const SVG_NS = 'http://www.w3.org/2000/svg';
// The day of the frame on screen: the path shows where the star had been by
// then, not where it goes later. A deep stack spans every date, so it shows all.
function shownDay() {
  if (settings.viewMode === 'deep-stack' || !activeObservation) return null;
  const time = frameTime(activeObservation);
  return time > 0 ? new Date(time).toISOString().slice(0, 10) : null;
}
// A tracked spot as it was on the frame shown: its ring where the star was
// that day and its path up to then. Before the first tracked date it sits at
// the first place. Only drawing uses this; the stored spot is unchanged.
function shownSpot(spot) {
  if (!spot.track?.length) return spot;
  const past = trackUpTo(spot.track, shownDay());
  const here = past.at(-1) || spot.track[0];
  return { ...spot, raDeg: here.raDeg, decDeg: here.decDeg, track: past };
}

function trackLayer(list, size) {
  const followed = list.filter(spot => spot.track?.length >= 2);
  const width = canvas.getBoundingClientRect().width;
  if (!followed.length || !width) return null;
  const unit = size / width;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'spot-tracks');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const make = (tag, attributes) => { const node = document.createElementNS(SVG_NS, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); return node; };
  const toCanvas = sky => skyToCanvas({ raDeg: sky.raDeg, decDeg: sky.decDeg, size, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
  const half = point => ({ x: point.x + 0.5, y: point.y + 0.5 });
  for (const spot of followed) {
    const center = toCanvas(spot);
    if (!center || center.x < 0 || center.y < 0 || center.x >= size || center.y >= size) continue;
    const points = spot.track.map(toCanvas);
    if (points.some(point => !point)) continue;
    const ringPx = Math.max(10 * unit, spot.radiusArcsec ? spot.radiusArcsec / PIXEL_ARCSEC : 0);
    const arrow = trackArrow({ points: points.map(half), center: half(center), ringPx, unit });
    const about = describeTrack(spot.track);
    if (!arrow || !about) continue;
    const group = make('g', { class: `spot-track is-${spot.origin}${spot.found ? ' is-found' : ''}` });
    const title = make('title', {});
    title.textContent = `Spot ${spot.n} moved ${about.text}${about.from && about.to ? ` (${about.from} to ${about.to})` : ''}`;
    group.append(title);
    for (const { line, head } of arrow.segments) {
      group.append(make('line', { ...line, 'stroke-width': arrow.width, class: 'spot-track-line' }));
      if (head) group.append(make('polygon', { points: head.map(p => `${p.x},${p.y}`).join(' '), class: 'spot-track-head' }));
    }
    // Dots last, so the hollow first place sits on top of the lines.
    for (const dot of arrow.dots) group.append(make('circle', { cx: dot.x, cy: dot.y, r: dot.r, 'stroke-width': arrow.width, class: `spot-track-dot is-${dot.kind}` }));
    const label = make('text', { x: arrow.label.x, y: arrow.label.y, 'text-anchor': arrow.label.anchor, 'dominant-baseline': 'middle', 'font-size': 11 * unit, 'stroke-width': 3 * unit, class: 'spot-track-label' });
    label.textContent = about.text;
    group.append(label);
    svg.append(group);
  }
  return svg.childNodes.length ? svg : null;
}

// Drag the handle (or use arrow keys on it) to grow a spot into an area or
// change its radius. The ring follows live; the list updates on release.
function resizeHandle(spot, mark, center, size) {
  const handle = document.createElement('button');
  handle.type = 'button'; handle.className = 'spot-resize';
  handle.setAttribute('aria-label', `Resize spot ${spot.n}${spot.radiusArcsec ? `, radius ${formatRadius(spot.radiusArcsec)}` : ''}. Drag, or use the arrow keys.`);
  handle.title = 'Drag to resize this spot';
  let radius = spot.radiusArcsec || 0, dragging = false;
  const commit = () => { spots.resize(spot.n, radius); publishSpots(); };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    dragging = true; try { handle.setPointerCapture(event.pointerId); } catch { /* keep tracking without capture */ } mark.classList.add('is-resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (!dragging) return;
    const at = canvasPoint(event);
    if (!at) return;
    radius = spotRadius(Math.hypot(at.x - center.x, at.y - center.y) * PIXEL_ARCSEC) || MIN_SPOT_RADIUS_ARCSEC;
    sizeArea(mark, radius, size);
    handle.dataset.radius = formatRadius(radius);
  });
  const finish = () => { if (!dragging) return; dragging = false; mark.classList.remove('is-resizing'); commit(); };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('click', event => event.stopPropagation());
  handle.addEventListener('keydown', event => {
    const grow = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
    if (!grow) return;
    event.preventDefault();
    const step = Math.max(PIXEL_ARCSEC, (radius || PIXEL_ARCSEC * 2) * 0.15);
    radius = spotRadius((radius || PIXEL_ARCSEC * 2) + grow * step) || MIN_SPOT_RADIUS_ARCSEC;
    commit();
    spotLayer.querySelector(`[data-spot="${spot.n}"] .spot-resize`)?.focus();
  });
  return handle;
}

// Click marks a point; press and drag outward marks a circular area whose
// centre is where the drag began. Pressing on a spot's ring (its outer edge)
// and dragging moves that spot instead.
const DRAG_THRESHOLD_PX = 6;
const EDGE_GRAB_PX = 7;
let drawing = null, suppressClick = false;

// The spot whose ring edge is under the pointer (nearest edge wins), or null.
function ringUnder(event) {
  const rect = canvas.getBoundingClientRect(), size = canvas.width;
  if (!rect.width || !size || spotLayer?.hidden) return null;
  const at = canvasPoint(event), cssPerPixel = rect.width / size;
  let best = null;
  for (const spot of spots.list().map(shownSpot)) {
    const center = skyToCanvas({ raDeg: spot.raDeg, decDeg: spot.decDeg, size, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
    if (!center || center.x < 0 || center.y < 0 || center.x > size - 1 || center.y > size - 1) continue;
    // Matches the drawn ring: a 20px minimum diameter, else drawn to scale.
    const ringCss = Math.max(10, spot.radiusArcsec ? spot.radiusArcsec / PIXEL_ARCSEC * cssPerPixel : 0);
    const fromCenterCss = Math.hypot(at.x - center.x - 0.5, at.y - center.y - 0.5) * cssPerPixel;
    const gap = Math.abs(fromCenterCss - ringCss);
    if (gap <= EDGE_GRAB_PX && (!best || gap < best.gap)) best = { spot, center, gap };
  }
  return best;
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || settings.inspectPixels || !activeObservation?.image) return;
  const start = canvasPoint(event);
  if (!start) return;
  const grab = ringUnder(event);
  drawing = { start, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, draft: null,
    ...(grab ? { move: grab.spot, offset: { x: start.x - grab.center.x, y: start.y - grab.center.y } } : {}) };
});
canvas.addEventListener('pointermove', event => {
  if (!drawing) { canvas.classList.toggle('sky-canvas-grab', !settings.inspectPixels && Boolean(activeObservation?.image && ringUnder(event))); return; }
  if (event.pointerId !== drawing.pointerId) return;
  if (!drawing.draft) {
    if (Math.hypot(event.clientX - drawing.clientX, event.clientY - drawing.clientY) < DRAG_THRESHOLD_PX) return;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* keep tracking without capture */ }
    if (drawing.move) {
      drawing.draft = spotLayer.querySelector(`[data-spot="${drawing.move.n}"]`);
      if (!drawing.draft) { drawing = null; return; }
      drawing.draft.classList.add('is-moving');
    } else {
      const size = canvas.width, draft = document.createElement('div');
      draft.className = 'source-mark spot-mark is-user is-draft';
      draft.style.left = `${((drawing.start.x + 0.5) / size) * 100}%`;
      draft.style.top = `${((drawing.start.y + 0.5) / size) * 100}%`;
      const ring = document.createElement('span'); ring.className = 'source-mark-ring';
      const readout = document.createElement('span'); readout.className = 'source-mark-label spot-label';
      draft.append(ring, readout);
      spotLayer.hidden = false; spotLayer.append(draft);
      drawing.draft = draft;
    }
  }
  const at = canvasPoint(event);
  if (!at) return;
  const size = canvas.width;
  if (drawing.move) {
    // Keep the grabbed point of the ring under the pointer, centre within the image.
    const clamp = value => Math.max(0, Math.min(size - 1, value));
    drawing.to = { x: clamp(at.x - drawing.offset.x), y: clamp(at.y - drawing.offset.y) };
    drawing.draft.style.left = `${((drawing.to.x + 0.5) / size) * 100}%`;
    drawing.draft.style.top = `${((drawing.to.y + 0.5) / size) * 100}%`;
    return;
  }
  drawing.radius = spotRadius(Math.hypot(at.x - drawing.start.x, at.y - drawing.start.y) * PIXEL_ARCSEC) || MIN_SPOT_RADIUS_ARCSEC;
  sizeArea(drawing.draft, drawing.radius, size);
  drawing.draft.lastChild.textContent = `r ${formatRadius(drawing.radius)}`;
});
function endDrawing(event, cancelled) {
  if (!drawing || event.pointerId !== drawing.pointerId) return;
  const { start, draft, radius, move, to } = drawing;
  drawing = null;
  // A press on a ring edge without a drag does nothing (no spot on a spot);
  // any other plain click is left to the click handler, which marks a point.
  if (!draft) { if (move) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); } return; }
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
  const toSky = point => canvasToSky({ x: point.x, y: point.y, size: canvas.width, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
  if (move) {
    const sky = !cancelled && to && toSky(to);
    if (sky) spots.move(move.n, sky);
    publishSpots();
    return;
  }
  draft.remove();
  if (cancelled) { positionMark(); return; }
  const sky = toSky(start);
  if (sky && spots.add({ ...sky, radiusArcsec: radius }, { origin: 'user' })) publishSpots();
  else { positionMark(); if (sky) cards(`Up to ${MAX_SPOTS} spots can be marked. Remove one first.`); }
}
canvas.addEventListener('pointerup', event => endDrawing(event, false));
canvas.addEventListener('pointercancel', event => endDrawing(event, true));
canvas.addEventListener('pointerleave', () => { if (!drawing) canvas.classList.remove('sky-canvas-grab'); });

canvas.addEventListener('click', event => {
  if (suppressClick) { suppressClick = false; return; }
  if (!activeObservation?.image) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const size = canvas.width;
  if (!size) return;
  const x = ((event.clientX - rect.left) / rect.width) * size;
  const y = ((event.clientY - rect.top) / rect.height) * size;
  const sky = canvasToSky({
    x, y, size, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg
  });
  if (settings.inspectPixels) { inspectionCanvasPoint = { x, y }; inspectPixel(activeObservation.image, sky); return; }
  if (sky && spots.add(sky, { origin: 'user' })) publishSpots();
  else if (sky) cards(`Up to ${MAX_SPOTS} spots can be marked. Remove one first.`);
});


canvas.addEventListener('keydown', event => {
  if (!settings.inspectPixels || !activeObservation?.image || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const size = canvas.width;
  inspectionCanvasPoint ||= { x: (size - 1) / 2, y: (size - 1) / 2 };
  if (event.key === 'ArrowUp') inspectionCanvasPoint.y--;
  if (event.key === 'ArrowDown') inspectionCanvasPoint.y++;
  if (event.key === 'ArrowLeft') inspectionCanvasPoint.x--;
  if (event.key === 'ArrowRight') inspectionCanvasPoint.x++;
  inspectionCanvasPoint.x = Math.max(0, Math.min(size - 1, inspectionCanvasPoint.x));
  inspectionCanvasPoint.y = Math.max(0, Math.min(size - 1, inspectionCanvasPoint.y));
  inspectPixel(activeObservation.image, canvasToSky({ ...inspectionCanvasPoint, size, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg }));
});

async function inspectPixel(image, sky) {
  if (!sky) return;
  const sequence = ++pixelInspectionSequence;
  const point = projectSkyToPixel(image, sky.raDeg, sky.decDeg);
  const position = `RA ${sky.raDeg.toFixed(6)}°, Dec ${sky.decDeg >= 0 ? '+' : ''}${sky.decDeg.toFixed(6)}°`;
  const covered = Boolean(point && point[0] >= 0 && point[1] >= 0 && point[0] < image.width && point[1] < image.height);
  const x = covered ? Math.min(image.width - 1, Math.round(point[0])) : -1, y = covered ? Math.min(image.height - 1, Math.round(point[1])) : -1;
  const index = covered ? y * image.width + x : -1;
  const value = covered ? image.values[index] : null;
  const flags = covered && image.flags ? image.flags[index] >>> 0 : 0;
  pixelInspectorResult.textContent = 'Loading same-observation exposures for a transient check…';
  pixelInspector.hidden = false;
  try {
    await warmSelectedExposureGroup(sequence);
    if (sequence !== pixelInspectionSequence) return;
    const exposureData = getAvailableExposureSamples(sky, image);
    const samples = exposureData.items;
    const inspectedSample = image.stackRecord ? samples[exposureData.currentIndex] : null;
    pixelInspectorResult.textContent = `Assessing FITS pixel ${covered ? `${x + 1 + (image.sourceX || 0)}, ${y + 1 + (image.sourceY || 0)}` : 'outside the detector'}…`;
    const response = await fetch('/api/pixel-quality', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ covered: inspectedSample ? inspectedSample.covered : covered, value: inspectedSample ? inspectedSample.value : (Number.isFinite(value) ? value : null), flags: inspectedSample?.flags ?? flags, flagsAvailable: inspectedSample?.flagsAvailable ?? Boolean(image.flags), maskEnabled: Boolean(settings.hideBadPixels), maskBits: badPixelMask(), detectGlitches: Boolean(settings.rejectVisitGlitches), samples, activeSampleIndex: exposureData.currentIndex })
    });
    const assessment = await response.json();
    if (!response.ok) throw new Error(assessment.error || 'Pixel quality assessment failed.');
    if (sequence !== pixelInspectionSequence) return;
    for (const sampleIndex of assessment.glitchIndices || []) {
      const entry = exposureData.entries[sampleIndex];
      if (!entry) continue;
      entry.image.derivedTransientPixels ||= new Set();
      entry.image.derivedTransientPixels.add(entry.pixel);
      entry.image.projectionKey = '';
      for (const record of renderedFrames.values()) if (record.image === entry.image) record.image.projectionKey = '';
      const sourceUrl = entry.url;
      for (const key of renderedFrames.keys()) if (key.startsWith(sourceUrl + '|')) renderedFrames.delete(key);
    }
    if (assessment.glitchIndices?.length && activeObservation?.image) {
      renderedFrames.clear();
      if (activeObservation.image.stackRecord) await showCutout(activeTimelineFrame || activeObservation);
      else await drawImage(activeObservation.image);
    }
    const state = assessment.state === 'missing_data'
      ? `${assessment.label} — this is not evidence that the source faded.`
      : assessment.state === 'outside_coverage'
        ? `${assessment.label} — no image pixel exists at this sky position.`
        : assessment.state === 'masked'
          ? `${assessment.label} — this sample is ignored in the rendered image.`
          : assessment.state === 'flagged_included'
            ? `${assessment.label} because Hide unreliable pixels is off.`
            : assessment.state === 'suspected_transient'
              ? `${assessment.label} within this observation; the sample is excluded from the image.`
            : assessment.state === 'unassessed'
              ? `${assessment.label}; treat changes cautiously.`
            : `${assessment.label} — a low value is image data, not a coverage gap.`;
    const measurement = Number.isFinite(value) ? `${image.stackRecord ? 'Stack median' : 'Value'} ${value.toPrecision(6)}${image.header.BUNIT ? ` ${image.header.BUNIT}` : ''}` : 'No finite science value';
    const reasons = assessment.setFlags?.map(flag => `${flag.name}: ${flag.description}`) || [];
    const flagText = reasons.length ? reasons.join('; ') : image.flags ? 'No flags set' : 'Pixel flags unavailable in this FITS product';
    const counts = assessment.exposureCounts;
    const contribution = counts?.examined
      ? ` · ${counts.valid} valid contributions from ${counts.examined} downloaded cutouts (${counts.masked} masked, ${counts.missing} missing, ${counts.uncovered} outside, ${counts.unassessed} unassessed, ${counts.glitches} single-exposure transients rejected)`
      : '';
    const stackContext = image.stackRecord ? ` · constituent ${inspectedSample?.observationId || 'exposure'} quality; ${image.stackContributionCounts?.[index] || 0} exposures contributed to this stack pixel` : '';
    pixelInspectorResult.textContent = `${state} ${measurement} · ${covered ? `FITS pixel ${x + 1 + (image.sourceX || 0)}, ${y + 1 + (image.sourceY || 0)} · ` : ''}${flagText}${stackContext}${contribution} · ${position}`;
  } catch (error) {
    if (sequence !== pixelInspectionSequence) return;
    pixelInspectorResult.textContent = `Could not assess this pixel: ${error.message} · ${position}`;
  }
}

async function warmSelectedExposureGroup(sequence) {
  if (!settings.rejectVisitGlitches && !activeObservation?.image?.stackRecord) return;
  const visitId = String(activeObservation?.image?.header.OBSID || '');
  const sameVisit = visitId ? activeFrameExposures.filter(observation => String(observation.observationId || '') === visitId) : [];
  const exposures = (sameVisit.length >= 3 ? sameVisit : activeFrameExposures).slice(0, 12);
  for (const observation of exposures) {
    if (sequence !== pixelInspectionSequence) return;
    if (Number(observation.detector) !== Number(settings.band)) continue;
    const url = cutoutRequestUrl(observation);
    if (decodedFrames.has(url)) continue;
    try { await warmCutout(observation); } catch { /* Keep the inspection useful with cutouts already available. */ }
  }
}

function localSignalAndNoise(image, x, y) {
  const center = image.values[y * image.width + x], neighborhood = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (dx * dx + dy * dy < 2) continue;
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
    const index = py * image.width + px, value = image.values[index];
    if (Number.isFinite(value) && !(image.flags && (image.flags[index] & badPixelMask()))) neighborhood.push(value);
  }
  if (!neighborhood.length || !Number.isFinite(center)) return { signal: null, noise: null };
  const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
  const background = median(neighborhood), noise = 1.4826 * median(neighborhood.map(value => Math.abs(value - background)));
  return { signal: center - background, noise };
}

function getAvailableExposureSamples(sky, activeImage) {
  const items = [], entries = [];
  const tracked = Boolean(presetMotion(target));
  let currentIndex = -1;
  for (const [url, image] of decodedFrames) {
    let params;
    try { params = new URL(url, location.origin).searchParams; } catch { continue; }
    const isContributor = image === activeImage || activeImage.stackSourceUrls?.includes(url);
    if (Number(params.get('fovArcmin')) !== settings.fovArcmin || Number(image.header.DETECTOR) !== Number(settings.band)) continue;
    const fixedCenterMatches = Number(params.get('raDeg')) === target.raDeg && Number(params.get('decDeg')) === target.decDeg;
    if (tracked ? !isContributor : !fixedCenterMatches) continue;
    const pixelSky = tracked && activeImage.stackRecord && image.pointing
      ? skyAtContributor(sky, activeImage, image.pointing)
      : sky;
    const point = pixelSky && projectSkyToPixel(image, pixelSky.raDeg, pixelSky.decDeg);
    const covered = Boolean(point && point[0] >= 0 && point[1] >= 0 && point[0] < image.width && point[1] < image.height);
    const x = covered ? Math.min(image.width - 1, Math.round(point[0])) : -1, y = covered ? Math.min(image.height - 1, Math.round(point[1])) : -1;
    const pixel = covered ? y * image.width + x : -1;
    const value = covered ? image.values[pixel] : null;
    const local = covered && Number.isFinite(value) ? localSignalAndNoise(image, x, y) : { signal: null, noise: null };
    if (image === activeImage || activeImage.stackSourceUrls?.includes(url)) {
      if (currentIndex < 0) currentIndex = items.length;
    }
    items.push({ covered, value: Number.isFinite(value) ? value : null, flags: covered && image.flags ? image.flags[pixel] >>> 0 : 0, flagsAvailable: Boolean(image.flags), visitId: String(image.header.OBSID || ''), observationId: String(image.header.OBSID || ''), ...local });
    entries.push({ image, pixel, url });
  }
  if (currentIndex < 0) {
    if (activeImage.stackRecord) throw new Error('Constituent exposure data is unavailable. Retry pixel inspection to reload it.');
    const sourceImage = decodedFrames.get(activeImage.stackSourceUrls?.[0]) || activeImage;
    const point = projectSkyToPixel(sourceImage, sky.raDeg, sky.decDeg);
    const covered = Boolean(point && point[0] >= 0 && point[1] >= 0 && point[0] < sourceImage.width && point[1] < sourceImage.height);
    const x = covered ? Math.min(sourceImage.width - 1, Math.round(point[0])) : -1, y = covered ? Math.min(sourceImage.height - 1, Math.round(point[1])) : -1, pixel = covered ? y * sourceImage.width + x : -1;
    const value = covered ? sourceImage.values[pixel] : null;
    const local = covered && Number.isFinite(value) ? localSignalAndNoise(sourceImage, x, y) : { signal: null, noise: null };
    currentIndex = items.length;
    items.push({ covered, value: Number.isFinite(value) ? value : null, flags: covered && sourceImage.flags ? sourceImage.flags[pixel] >>> 0 : 0, flagsAvailable: Boolean(sourceImage.flags), visitId: String(sourceImage.header.OBSID || ''), observationId: String(sourceImage.header.OBSID || ''), ...local });
    entries.push({ image: sourceImage, pixel, url: activeImage.stackSourceUrls?.[0] || (activeObservation ? cutoutRequestUrl(activeObservation) : '') });
  }
  return { items, entries, currentIndex };
}

function skyAtContributor(sky, stack, pointing) {
  const pixel = projectSkyToPixel(stack, sky.raDeg, sky.decDeg);
  return pixel && canvasToSky({ x: pixel[0], y: pixel[1], size: stack.width, centerRaDeg: pointing.raDeg, centerDecDeg: pointing.decDeg });
}

window.addEventListener('sky:clear-source-mark', () => { spots.clear(); publishSpots(); });
// The AI guide adds, removes or clears spots; respond() gets the spots it added.
window.addEventListener('sky:agent-spots', event => {
  const detail = event.detail || {};
  if (detail.clear) spots.clear(detail.clear === 'all' ? null : detail.clear);
  for (const n of detail.remove || []) spots.remove(n);
  const added = (detail.add || []).map(spot => spots.add(spot, { origin: spot.origin || 'agent', label: spot.label, radiusArcsec: spot.radiusArcsec, date: spot.date })).filter(Boolean);
  const resized = (detail.resize || []).map(({ n, radiusArcsec }) => spots.resize(n, radiusArcsec)).filter(Boolean);
  // A dated move is the star's motion between frames, kept on the spot's track.
  const moved = (detail.move || []).map(({ n, raDeg, decDeg, date, restart }) => spots.move(n, { raDeg, decDeg }, { date, restart: Boolean(restart) })).filter(Boolean);
  const tracked = (detail.track || []).map(({ n, points }) => spots.setTrack(n, points)).filter(Boolean);
  for (const { n, found } of detail.found || []) spots.setFound(n, found);
  publishSpots();
  detail.respond?.({ added, resized, moved, tracked, spots: spots.list() });
});
window.addEventListener('sky:spots-requested', event => event.detail?.respond?.(spots.list()));

// Snap a sky position onto the source under it: the flux-weighted centroid of
// above-background pixels within radiusPx on the frame on screen (the current
// frame, not the difference, in difference mode). Masked pixels are skipped,
// so a saturated core still centres from its bright ring.
window.addEventListener('sky:peak-requested', event => {
  const { raDeg, decDeg, radiusPx = 2, respond } = event.detail || {};
  if (!respond) return;
  const values = shown?.kind === 'difference' ? shown.currentCanvas?.spherexGrid?.values : shown?.values;
  const width = shown?.width;
  if (!values || !width) { respond(null); return; }
  const at = skyToCanvas({ raDeg, decDeg, size: width, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
  if (!at) { respond(null); return; }
  const peak = snapToPeak(values, width, at.x, at.y, radiusPx);
  if (peak.noSource) { respond({ noSource: true }); return; }
  const sky = canvasToSky({ x: peak.x, y: peak.y, size: width, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
  respond(sky ? { raDeg: sky.raDeg, decDeg: sky.decDeg, peakSigma: peak.peakSigma, offsetArcsec: Number((Math.hypot(peak.x - at.x, peak.y - at.y) * PIXEL_ARCSEC).toFixed(1)) } : null);
});

// The AI guide's find_changes tool reads the difference image on screen.
window.addEventListener('sky:difference-requested', event => {
  const respond = event.detail?.respond;
  if (!respond) return;
  if (shown?.kind !== 'difference') { respond(null); return; }
  respond({
    values: shown.values, significant: shown.significant, width: shown.width, sigma: shown.sigma, threshold: shown.threshold,
    center: { ...displayedCenter }, referenceLabel: shown.referenceLabel,
    date: shown.observation?.observedStartUtc || '', referenceDate: shown.referenceObservation?.observedStartUtc || ''
  });
});

// Small image stamps around a sky position (new frame, reference, difference)
// for the vision second opinion. PNG data URLs, nearest-neighbour enlarged.
window.addEventListener('sky:stamps-requested', event => {
  const { raDeg, decDeg, sizePx = 24, scale = 4, respond } = event.detail || {};
  if (!respond) return;
  if (shown?.kind !== 'difference' || !shown.currentCanvas) { respond(null); return; }
  const point = skyToCanvas({ raDeg, decDeg, size: shown.width, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
  if (!point) { respond(null); return; }
  const crop = source => {
    if (!source) return null;
    const stamp = document.createElement('canvas');
    stamp.width = stamp.height = sizePx * scale;
    const ctx = stamp.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, Math.round(point.x - sizePx / 2), Math.round(point.y - sizePx / 2), sizePx, sizePx, 0, 0, sizePx * scale, sizePx * scale);
    return stamp.toDataURL('image/png');
  };
  respond({ current: crop(shown.currentCanvas), reference: crop(shown.referenceCanvas), difference: crop(canvas) });
});

// A picture of exactly what is on screen (image, overlays and numbered spots)
// for the AI guide to show in the chat. JPEG data URL, nearest-neighbour enlarged.
const SPOT_COLOURS = { user: '#5aa9ff', agent: '#ff6b6b', predicted: '#c9a7ff', found: '#7ee08a' };
window.addEventListener('sky:snapshot-requested', event => {
  const { size: wanted = 560, respond } = event.detail || {};
  if (!respond) return;
  if (!canvas.width || !document.querySelector('.viewer')?.classList.contains('has-image')) { respond(null); return; }
  const size = Math.max(canvas.width, Math.min(800, wanted));
  const output = document.createElement('canvas');
  output.width = output.height = size;
  const context = output.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(canvas, 0, 0, size, size);
  if (overlay?.width && overlayHasContent()) { context.imageSmoothingEnabled = true; context.drawImage(overlay, 0, 0, size, size); }
  const scale = size / canvas.width;
  context.font = `600 ${Math.round(size / 34)}px Manrope, system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  for (const spot of spots.list().map(shownSpot)) {
    const point = skyToCanvas({ raDeg: spot.raDeg, decDeg: spot.decDeg, size: canvas.width, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
    if (!point || point.x < 0 || point.y < 0 || point.x >= canvas.width || point.y >= canvas.height) continue;
    const x = (point.x + 0.5) * scale, y = (point.y + 0.5) * scale;
    const radius = Math.max(8, size / 50, spot.radiusArcsec ? spot.radiusArcsec / PIXEL_ARCSEC * scale : 0);
    context.lineWidth = Math.max(2, size / 280);
    context.strokeStyle = spot.found ? SPOT_COLOURS.found : SPOT_COLOURS[spot.origin] || SPOT_COLOURS.user;
    if (spot.origin === 'predicted') {
      context.setLineDash([4, 3]);
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.stroke();
      context.setLineDash([]);
    } else {
      // Arcs with gaps at N, E, S and W (eight arcs for an area), as on screen.
      const parts = spot.radiusArcsec ? 8 : 4, step = Math.PI * 2 / parts, gap = (spot.radiusArcsec ? 8 : 20) * Math.PI / 180;
      for (let i = 0; i < parts; i++) { context.beginPath(); context.arc(x, y, radius, i * step + gap / 2, (i + 1) * step - gap / 2); context.stroke(); }
    }
    context.lineWidth = 3; context.strokeStyle = '#000c';
    context.strokeText(String(spot.n), x, y - radius - 2);
    context.fillStyle = '#fff';
    context.fillText(String(spot.n), x, y - radius - 2);
    drawTrackOnCanvas(context, spot, { x, y }, radius, scale, size);
  }
  respond({ src: output.toDataURL('image/jpeg', 0.9), width: size, height: size });
});

// The same track arrow as on screen, for the snapshot.
function drawTrackOnCanvas(context, spot, center, radius, scale, size) {
  if (!(spot.track?.length >= 2)) return;
  const points = spot.track.map(sky => skyToCanvas({ raDeg: sky.raDeg, decDeg: sky.decDeg, size: canvas.width, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg }));
  if (points.some(point => !point)) return;
  const unit = Math.max(1, size / 400);
  const arrow = trackArrow({ points: points.map(p => ({ x: (p.x + 0.5) * scale, y: (p.y + 0.5) * scale })), center, ringPx: radius, unit });
  const about = describeTrack(spot.track);
  if (!arrow || !about) return;
  const colour = spot.found ? SPOT_COLOURS.found : SPOT_COLOURS[spot.origin] || SPOT_COLOURS.user;
  context.save();
  context.strokeStyle = context.fillStyle = colour;
  context.lineWidth = arrow.width; context.lineCap = 'round';
  for (const { line, head } of arrow.segments) {
    context.beginPath(); context.moveTo(line.x1, line.y1); context.lineTo(line.x2, line.y2); context.stroke();
    if (head) { context.beginPath(); head.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath(); context.fill(); }
  }
  for (const dot of arrow.dots) {
    context.beginPath(); context.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    if (dot.kind === 'step') context.fill(); else context.stroke();
  }
  context.font = `600 ${Math.round(11 * unit)}px Manrope, system-ui, sans-serif`;
  context.textAlign = arrow.label.anchor === 'middle' ? 'center' : arrow.label.anchor === 'end' ? 'right' : 'left';
  context.textBaseline = 'middle';
  context.lineWidth = 3; context.strokeStyle = '#000c';
  context.strokeText(about.text, arrow.label.x, arrow.label.y);
  context.fillText(about.text, arrow.label.x, arrow.label.y);
  context.restore();
}

// Noise of the image on screen (MAD), so a fake source can be set to a chosen
// number of sigma once and keep that brightness in every exposure.
window.addEventListener('sky:noise-requested', event => {
  const values = shown?.kind === 'difference' ? null : shown?.values;
  event.detail?.respond?.(values ? estimateBackground(values).noise : null);
});

// The hidden-planet quest: add or remove a synthetic moving source, then redraw.
window.addEventListener('sky:inject-synthetic', event => {
  const detail = event.detail || {};
  synthetic = detail.source && Number.isFinite(detail.source.raDeg) ? { ...detail.source } : null;
  renderedFrames.clear();
  deepTemplateCache = null;
  if (activeObservation?.image && !isComparisonMode()) void drawImage(activeObservation.image);
  else if (activeTimelineFrame) void showCutout(activeTimelineFrame, { quiet: true, keepImage: true });
  detail.respond?.({ ok: true, active: Boolean(synthetic) });
});

// The exact proxy URL for a frame at the current target and field of view. The
// time-lapse preloader uses the same URL so its cached download is reused.
export function cutoutRequestUrl(observation) {
  const pointing = exposureCenter(target, observation);
  const params = new URLSearchParams({
    url: observation.accessUrl,
    raDeg: pointing.raDeg,
    decDeg: pointing.decDeg,
    fovArcmin: settings.fovArcmin,
    aligned: '1',
    revision: observation.productModifiedAt || observation.metadataModifiedAt || ''
  });
  return '/api/cutout?' + params.toString();
}

// A frame rendered for the current target and display settings. Two frames from
// the same product at different stretches are kept separately, while the decoded
// pixels are shared by URL.
function displaySignature() {
  return [
    target.raDeg, target.decDeg, presetMotion(target) ? 'proper-motion' : '', settings.fovArcmin, settings.consistentBrightness ? 1 : 0,
    settings.consistentBrightness && comparisonScale ? comparisonScale.low : '', settings.consistentBrightness && comparisonScale ? comparisonScale.high : '',
    settings.stretch, settings.colours, settings.contrast, settings.brightness, settings.invert,
    settings.fillMaskedCores ? (epsfByDetector.get(settings.band) ? 'psf' : 'rim') : 0,
    scaleSignature(), settings.rejectVisitGlitches ? 1 : 0, settings.resampling
  ].join('|');
}

// Settings that change the measured values or the limit algorithm.
function scaleSignatureOf(value) {
  return [value.scaleMode, value.scaleLow ?? '', value.scaleHigh ?? '', value.smoothing, value.hideBadPixels ? 1 : 0, value.maskBits,
    value.subtractBackground ? 1 : 0, value.stackStatistic, value.exposuresPerDay].join('|');
}
function scaleSignature() { return scaleSignatureOf(settings); }

// Settings that only change how frames are combined for display.
function composeSignature() {
  return [settings.viewMode, settings.referenceFrame, settings.pinnedReferenceKey || '', settings.differenceThreshold,
    settings.trailWindow, settings.blinkIntervalMs, settings.maxStackFrames, settings.differenceFlatten ? 1 : 0].join('|');
}

function renderKey(observation) {
  const sources = (observation.exposures || [observation]).map(item => cutoutRequestUrl(item)).join(',');
  return sources + '|' + displaySignature();
}

function remember(map, key, value) {
  map.set(key, value);
}

// Download, decode and render one frame off-screen. This is what warm-up does:
// by the time a frame is shown, there is no network request, FITS parse or
// reprojection left to do — only a canvas blit.
async function warmSingleCutout(observation, signal, priority = 1) {
  const generation = dataGeneration;
  const url = cutoutRequestUrl(observation);
  const key = url + '|' + displaySignature();
  const rendered = renderedFrames.get(key);
  const requestedTarget = exposureCenter(target, observation), requestedSettings = { ...settings };
  const expected = projectionKey(requestedTarget, requestedSettings);
  if (rendered && rendered.image.projectionKey === expected) return rendered;
  let image = decodedFrames.get(url);
  if (!image) image = await imagePipeline.load(url, observation.accessUrl, requestedTarget, requestedSettings, { signal, priority });
  else if (image.projectionKey !== expected) {
    image.projection = await imagePipeline.project(image, requestedTarget, requestedSettings, signal);
    image.projectionKey = expected;
  }
  signal?.throwIfAborted();
  if (generation !== dataGeneration) throw new DOMException('Viewer settings changed.', 'AbortError');
  image.pointing = requestedTarget;
  remember(decodedFrames, url, image);
  const element = document.createElement('canvas');
  const coverage = paintCanvas(element, image);
  const entry = { canvas: element, image, coverage };
  remember(renderedFrames, renderKey(observation), entry);
  window.dispatchEvent(new CustomEvent('sky:cutout-warmed', { detail: { observation, canvas: element } }));
  return entry;
}

function stackedImage(values, counts, reference, record, sourceUrls) {
  const width = Math.max(1, Math.round(settings.fovArcmin * 60 / PIXEL_ARCSEC));
  const scale = PIXEL_ARCSEC / 3600;
  const pointing = reference.pointing || target;
  const header = {
    ...reference.header, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN',
    CRVAL1: pointing.raDeg, CRVAL2: pointing.decDeg,
    CRPIX1: (width + 1) / 2, CRPIX2: (width + 1) / 2,
    CD1_1: -scale, CD1_2: 0, CD2_1: 0, CD2_2: -scale,
    CDELT1: -scale, CDELT2: -scale, A_ORDER: 0, B_ORDER: 0
  };
  const image = { values, width, height: width, header, pointing, flags: null, stackRecord: record, stackContributionCounts: counts, stackSourceUrls: sourceUrls, matrix: null };
  image.matrix = matrixFor(header);
  return image;
}

export function isCutoutReady(observation) {
  return renderedFrames.has(renderKey(observation));
}

// One UTC-day frame can hold dozens of exposures: for Barnard's Star the median
// day has 8 and the busiest has 36. Each exposure is a separate multi-megabyte
// cutout, so stacking every one turns a single frame into minutes of
// downloading (8 x 2.9 MB, or 105 MB for a 36-exposure day). By default the
// day is sampled evenly (Processing › Exposures per day), and the omission
// is disclosed. 0 means every exposure.
function sampleExposures(list) {
  const limit = settings.exposuresPerDay > 0 ? settings.exposuresPerDay : Infinity;
  if (list.length <= limit) return list;
  if (limit === 1) return [list[Math.floor((list.length - 1) / 2)]];
  const picked = [];
  for (let i = 0; i < limit; i++) picked.push(list[Math.round(i * (list.length - 1) / (limit - 1))]);
  return [...new Set(picked)];
}

export async function warmCutout(observation, signal, priority = 2, onExposure = null) {
  const generation = dataGeneration;
  const key = renderKey(observation);
  const rendered = renderedFrames.get(key);
  if (rendered) return rendered;
  assertStackBudget([observation], settings.fovArcmin);
  const available = (observation.exposures || [observation]).filter(item => item?.accessUrl);
  const exposures = sampleExposures(available);
  if (exposures.length <= 1) {
    const entry = await warmSingleCutout(exposures[0] || observation, signal, priority);
    if (generation !== dataGeneration) throw new DOMException('Viewer changed.', 'AbortError');
    remember(renderedFrames, renderKey(observation), entry);
    return entry;
  }
  const entries = [], sourceImages = [], sourceUrls = [];
  let completed = 0;
  const results = await Promise.allSettled(exposures.map(async exposure => {
    const entry = await warmSingleCutout(exposure, signal, priority);
    signal?.throwIfAborted();
    if (generation !== dataGeneration) throw new DOMException('Viewer changed.', 'AbortError');
    completed++;
    onExposure?.(exposure, entry, completed, exposures.length);
    return entry;
  }));
  signal?.throwIfAborted();
  if (generation !== dataGeneration) throw new DOMException('Viewer changed.', 'AbortError');
  for (let index = 0; index < results.length; index++) {
    const result = results[index], exposure = exposures[index];
    if (result.status === 'fulfilled') {
      entries.push({ ...result.value, observation: exposure });
      sourceImages.push(result.value.image);
      sourceUrls.push(cutoutRequestUrl(exposure));
    } else if (result.reason?.name === 'AbortError' || result.reason?.name === 'ImageBudgetError') throw result.reason;
  }
  const element = document.createElement('canvas');
  const stacked = await paintStackCanvas(element, entries, exposures, signal);
  // Report how many exposures the day actually offered, so a sampled stack is
  // never mistaken for the complete set.
  if (available.length > exposures.length) {
    stacked.record.requestedExposureCount = available.length;
    stacked.record.omittedExposureCount = available.length - exposures.length;
  }
  signal?.throwIfAborted();
  if (generation !== dataGeneration) throw new DOMException('Viewer changed.', 'AbortError');
  const image = stackedImage(stacked.values, stacked.counts, sourceImages[0], stacked.record, sourceUrls);
  const entry = { canvas: element, image, coverage: stacked.coverage, stackRecord: stacked.record };
  remember(renderedFrames, renderKey(observation), entry);
  window.dispatchEvent(new CustomEvent('sky:cutout-warmed', { detail: { observation, canvas: element, stackRecord: stacked.record } }));
  return entry;
}

async function showDeepStack() {
  const available = timelineFrames.filter(frame => !settings.band || Number(frame.detector) === Number(settings.band));
  if (!available.length) { resetViewer('Search for observations in this detector before building a deep stack.'); return; }
  const frames = available.slice(0, Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80)));
  activeSequence++;
  const sequence = activeSequence;
  cutoutController?.abort();
  cutoutController = new AbortController();
  const controller = cutoutController;
  activeObservation = null;
  document.getElementById('export-sky-png').disabled = true;
  status.hidden = false; status.classList.remove('is-error');
  cards(`Building a median stack from up to ${frames.length} UTC-day frames…`);
  const loaded = [], failedFrames = [];
  try {
    assertStackBudget(frames, settings.fovArcmin);
    let lastPreview = 0;
    for (let offset = 0; offset < frames.length; offset += 4) {
      controller.signal.throwIfAborted();
      if (sequence !== activeSequence) return;
      await Promise.all(frames.slice(offset, offset + 4).map(async frame => {
        try {
          const entry = await warmCutout(frame, controller.signal, 1);
          controller.signal.throwIfAborted();
          if (sequence !== activeSequence) return;
          const retained = entry.image.stackRecord ? entry : {
            ...entry, image: { header: entry.image.header, pointing: entry.image.pointing, stackSourceUrls: [cutoutRequestUrl(frame)] }
          };
          loaded.push({ frame, entry: retained });
          loaded.sort((a, b) => frames.indexOf(a.frame) - frames.indexOf(b.frame));
          if (loaded.length === 1) {
            canvas.width = entry.canvas.width; canvas.height = entry.canvas.height;
            displayedCenter = entry.image.pointing || target;
            context.drawImage(entry.canvas, 0, 0); applyChrome(entry.coverage);
            positionMark();
          }
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'ImageBudgetError') throw error;
          failedFrames.push(frame);
        }
        if (sequence !== activeSequence) return;
        const used = loaded.reduce((n, item) => n + (item.entry.stackRecord?.usedExposureCount || 1), 0);
        const failed = failedFrames.reduce((n, frame) => n + (frame.exposures || [frame]).length, 0) + loaded.reduce((n, item) => n + (item.entry.stackRecord?.failedObservationIds.length || 0), 0);
        cards(`Preview · ${loaded.length}/${frames.length} days · ${used} exposures · ${failed} failed exposures`);
        caption.textContent = 'Building the deep median stack; preview includes completed daily frames only.';
      }));
      controller.signal.throwIfAborted();
      if (sequence !== activeSequence) return;
      if (loaded.length && performance.now() - lastPreview >= 1000) {
        const preview = document.createElement('canvas');
        const result = await paintStackCanvas(preview, loaded.map(item => ({ ...item.entry, observation: item.frame })), loaded.map(item => item.frame), controller.signal);
        if (sequence !== activeSequence) return;
        canvas.width = preview.width; canvas.height = preview.height;
        displayedCenter = loaded[0].entry.image.pointing || target;
        context.drawImage(preview, 0, 0); applyChrome(result.coverage);
        positionMark();
        lastPreview = performance.now();
      }
    }
    if (!loaded.length) throw new Error('No timeline frames could be loaded for the deep stack.');
    if (sequence !== activeSequence) return;
    const element = document.createElement('canvas');
    const frameEntries = loaded.map(item => ({ ...item.entry, observation: item.frame }));
    const stacked = await paintStackCanvas(element, frameEntries, loaded.map(item => item.frame), controller.signal);
    controller.signal.throwIfAborted();
    if (sequence !== activeSequence) return;
    const allExposures = frames.flatMap(frame => frame.exposures || [frame]);
    const contributorRecords = loaded.flatMap(({ frame, entry }) => entry.stackRecord?.contributors || (frame.exposures || [frame]).map(item => ({
      observationId: item.observationId || '', productId: item.productId || '', release: item.release || item.collection || '',
      processingVersion: item.processingVersion || '', observedStartUtc: item.observedStartUtc || '', exposureSeconds: Number(item.exposureSeconds) || 0,
      validOutputPixels: entry.canvas.spherexGrid.values.reduce((count, value) => count + Number.isFinite(value), 0)
    })));
    const nestedFailed = loaded.flatMap(({ entry }) => entry.stackRecord?.failedObservationIds || []);
    const record = {
      ...stacked.record, deepStack: true,
      method: `per-pixel median of UTC-day median stacks aligned by ${presetMotion(target) ? 'proper motion' : 'fixed sky position'}; unreliable input pixels are excluded`,
      availableFrameCount: available.length, requestedFrameCount: frames.length, usedFrameCount: loaded.length,
      excludedByFrameLimit: Math.max(0, available.length - frames.length),
      requestedExposureCount: allExposures.length, usedExposureCount: contributorRecords.length,
      failedObservationIds: [...failedFrames.flatMap(frame => (frame.exposures || [frame]).map(item => item.observationId)), ...nestedFailed],
      contributors: contributorRecords,
      observationIds: contributorRecords.map(item => item.observationId).filter(Boolean),
      productIds: contributorRecords.map(item => item.productId).filter(Boolean),
      exposureSeconds: contributorRecords.reduce((sum, item) => sum + (Number(item.exposureSeconds) || 0), 0)
    };
    const sourceUrls = loaded.flatMap(({ frame, entry }) => entry.image.stackSourceUrls || [cutoutRequestUrl(frame)]);
    const image = stackedImage(stacked.values, stacked.counts, loaded[0].entry.image, record, sourceUrls);
    image.deepStackSignature = deepStackSignature();
    const firstFrame = frames[0], lastFrame = frames.at(-1);
    const observation = { ...firstFrame, observedEndUtc: lastFrame.observedEndUtc || lastFrame.observedStartUtc, exposures: allExposures, stackLabel: 'Deep median stack' };
    activeObservation = { ...observation, image };
    activeFrameExposures = allExposures;
    const entry = { canvas: element, image, coverage: stacked.coverage, stackRecord: record };
    commitCutout(observation, entry, { announce: false });
    caption.textContent = `Deep median stack · ${record.usedFrameCount}/${record.availableFrameCount} UTC-day frames · ${record.usedExposureCount} exposures · ${Math.round(record.exposureSeconds)} s total · ${formatWavelength(observation)} · north up${presetMotion(target) ? ' · proper-motion aligned' : target.fixedSkyFor ? ' · fixed sky, star moves' : ''}`;
    window.dispatchEvent(new CustomEvent('sky:deep-stack-built', { detail: { record } }));
  } catch (error) {
    if (sequence === activeSequence && !controller.signal.aborted) {
      controller.abort();
      resetViewer(error.message); status.classList.add('is-error');
      document.getElementById('cutout-cache-state').textContent = 'Deep stack unavailable';
      window.dispatchEvent(new CustomEvent('sky:deep-stack-error'));
    }
  }
}

function deepStackSignature() {
  const frames = timelineFrames.slice(0, Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80)));
  return `${displaySignature()}|${settings.band}|${frames.map(observationKey).join(',')}`;
}

function commitCutout(observation, entry, { announce = true, preview = false } = {}) {
  stopBlink();
  const source = entry.canvas;
  if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
  context.drawImage(source, 0, 0);
  displayedCenter = entry.image.pointing || target;
  publishGrid(observation,entry.image,{suspended:preview});
  applyChrome(entry.coverage);
  positionMark();
  const image = entry.image;
  setShown(source, image);
  canvas.dataset.deepStack = String(Boolean(image.stackRecord?.deepStack));
  const masked = image.flags && settings.hideBadPixels ? Array.from(image.flags).filter(value => (value & badPixelMask()) !== 0).length : 0;
  const release = observation.release || observation.collection || 'Release not reported';
  const processing = observation.processingVersion ? ` · ${observation.processingVersion}` : '';
  const omitted = image.stackRecord?.omittedExposureCount || 0;
  const stackLabel = image.stackRecord
    ? ` · median stack ${image.stackRecord.usedExposureCount} exposures${omitted ? ` of ${image.stackRecord.requestedExposureCount} (evenly sampled; change in Processing › Advanced)` : ''} · ${Math.round(image.stackRecord.exposureSeconds)} s total`
    : '';
  caption.textContent = `${formatWavelength(observation)} · ${release}${processing}${stackLabel} · ${settings.fovArcmin}′ square · north up${presetMotion(target) ? ' · proper-motion aligned' : target.fixedSkyFor ? ' · fixed sky, star moves' : ''}${masked ? ` · ${masked} flagged pixels masked` : ''}`;
  status.hidden = true;
  document.getElementById('export-sky-png').disabled = preview;
  document.getElementById('cutout-cache-state').textContent = '';
  if (!preview) window.dispatchEvent(new CustomEvent('sky:cutout-rendered', { detail: { observation, stackRecord: image.stackRecord || null } }));
  // Playback frames are not shared state: only a frame the user opened updates
  // the address bar. Click the sky image to mark a candidate source.
  if (announce && !preview) window.dispatchEvent(new CustomEvent('sky:frame-shown', { detail: { observation } }));
  return { stackRecord: image.stackRecord || null };
}

export async function showCutout(observation, { quiet = false, keepImage = false } = {}) {
  if (settings.viewMode === 'deep-stack' && activeObservation?.image?.stackRecord?.deepStack && activeObservation.image.deepStackSignature === deepStackSignature()) return { stackRecord: activeObservation.image.stackRecord };
  if (settings.viewMode === 'deep-stack') { activeTimelineFrame = observation; return showDeepStack(); }
  activeObservation = observation;
  activeFrameExposures = Array.isArray(observation.exposures) ? observation.exposures : [observation];
  const sequence = ++activeSequence;
  cutoutController?.abort();
  cutoutController = new AbortController();
  const requestController = cutoutController;
  const url = cutoutRequestUrl(observation);
  const key = renderKey(observation);
  let entry = renderedFrames.get(key);
  // Playback sets quiet so a frame swap never flashes a status message, and
  // keepImage so the previous frame stays visible until the new one is ready.
  if (!entry && !quiet && !keepImage) { resetViewer(`Loading ${settings.fovArcmin}′ × ${settings.fovArcmin}′ cutout · ${observation.observedStartUtc?.slice(0, 10) || 'observation'} · D${observation.detector}…`); }
  try {
    if (!entry) {
      let previewShown = false;
      const onExposure = quiet || keepImage ? null : (exposure, candidate, completed, total) => {
        if (sequence !== activeSequence || requestController.signal.aborted) return;
        if (!previewShown) {
          activeObservation = { ...exposure, image: candidate.image };
          commitCutout(exposure, candidate, { announce: false, preview: true });
          caption.textContent = `Single-exposure preview · ${caption.textContent}`;
          previewShown = true;
        }
        document.getElementById('cutout-cache-state').textContent = `Preview · preparing daily stack (${completed}/${total} exposures ready)`;
      };
      entry = await warmCutout(observation, requestController.signal, 0, onExposure);
      if (sequence !== activeSequence) return;
    }
    if (sequence !== activeSequence) return;
    activeObservation = { ...observation, image: entry.image };
    if (isComparisonMode()) {
      const composed = await composeComparison(observation, entry, requestController.signal, sequence);
      if (sequence !== activeSequence) return;
      const displayed = commitComposite(observation, entry, composed, { announce: !quiet });
      window.dispatchEvent(new CustomEvent('sky:cutout-detector-selected', { detail: { detector: observation.detector } }));
      return displayed;
    }
    const displayed = commitCutout(observation, entry, { announce: !quiet });
    window.dispatchEvent(new CustomEvent('sky:cutout-detector-selected', { detail: { detector: observation.detector } }));
    return displayed;
  } catch (error) {
    if (sequence === activeSequence && !requestController.signal.aborted) {
      resetViewer(error.message); status.classList.add('is-error');
      document.getElementById('cutout-cache-state').textContent = 'Cutout unavailable';
      window.dispatchEvent(new CustomEvent('sky:cutout-error', { detail: { observation, error } }));
    }
  }
}

function formatWavelength(observation) {
  const low = Number(observation.wavelengthMinUm), high = Number(observation.wavelengthMaxUm);
  return Number.isFinite(low) && Number.isFinite(high) ? `${low.toFixed(2)}–${high.toFixed(2)} μm` : `D${observation.detector}`;
}

export function observeCutout(observation) { void showCutout(observation); }

document.getElementById('export-sky-png').addEventListener('click', () => {
  if (!activeObservation?.image || !canvas.width) return;
  const output = document.createElement('canvas');
  const withOverlay = overlay && overlay.width > 0 && overlayHasContent();
  output.width = withOverlay ? overlay.width : canvas.width; output.height = withOverlay ? overlay.height : canvas.height;
  const outputContext = output.getContext('2d');
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(canvas, 0, 0, output.width, output.height);
  if (withOverlay) outputContext.drawImage(overlay, 0, 0);
  output.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `spherex-${activeObservation.observedStartUtc?.slice(0, 10) || 'frame'}-D${activeObservation.detector}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
});

// ---------------------------------------------------------------------------
// Comparison modes: blink, difference and motion trail. All three work on the
// projected value grids of warmed frames, which share one north-up sky grid.

const frameLabel = frame => frame?.observedStartUtc?.slice(0, 10) || 'reference';
const bandFrames = () => timelineFrames.filter(frame => !settings.band || Number(frame.detector) === Number(settings.band));
const isAbort = (error, signal) => signal?.aborted || error?.name === 'AbortError' || error?.name === 'ImageBudgetError';
const setCacheState = text => { document.getElementById('cutout-cache-state').textContent = text; };

function referenceFrameFor(frame) {
  const frames = bandFrames(), index = frames.indexOf(frame);
  if (frames.length < 2 || index < 0) return null;
  if (settings.referenceFrame === 'pinned' && settings.pinnedReferenceKey) {
    const pinned = frames.find(item => observationKey(item) === settings.pinnedReferenceKey);
    if (pinned && pinned !== frame) return pinned;
  }
  if (settings.referenceFrame === 'first') return index === 0 ? frames[1] : frames[0];
  return index === 0 ? frames[1] : frames[index - 1];
}

// Load frames four at a time; failures of single frames are tolerated.
async function warmGrids(frames, signal, sequence, label, current = null) {
  const grids = [];
  for (let offset = 0; offset < frames.length; offset += 4) {
    await Promise.all(frames.slice(offset, offset + 4).map(async frame => {
      try { grids.push(frame === current?.frame ? current.values : (await warmCutout(frame, signal, 1)).canvas.spherexGrid.values); }
      catch (error) { if (isAbort(error, signal)) throw error; }
    }));
    signal.throwIfAborted();
    if (sequence === activeSequence) setCacheState(`${label} · ${Math.min(frames.length, offset + 4)}/${frames.length} frames`);
  }
  if (!grids.length) throw new Error(`No frames could be loaded for the ${label.toLowerCase()}.`);
  return grids;
}

// A deep template: the combined stack of every day in the band, cached until
// the frames or the processing settings change.
async function deepTemplate(signal, sequence) {
  const frames = bandFrames().slice(0, Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80)));
  const signature = `${displaySignature()}|${settings.band}|${frames.map(observationKey).join(',')}`;
  if (deepTemplateCache?.signature === signature) return deepTemplateCache;
  if (frames.length < 2) throw new Error('A deep reference needs at least two observing days in this band.');
  assertStackBudget(frames, settings.fovArcmin);
  const grids = await warmGrids(frames, signal, sequence, 'Building deep reference');
  const statistic = settings.stackStatistic === 'clipped-mean' ? 'clipped-mean' : 'median';
  const combined = await imagePipeline.combine(grids, { statistic }, signal);
  deepTemplateCache = { signature, values: combined.values, days: grids.length };
  return deepTemplateCache;
}

async function composeComparison(frame, entry, signal, sequence) {
  const current = entry.canvas.spherexGrid?.values, width = entry.canvas.width;
  if (!current) return null;
  const unit = entry.image.header?.BUNIT || '';
  if (settings.viewMode === 'motion-trail') {
    const frames = bandFrames(), index = frames.indexOf(frame);
    if (frames.length < 2 || index < 0) return null;
    const limit = Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80));
    const span = settings.trailWindow > 0
      ? frames.slice(Math.max(0, index - settings.trailWindow), index + settings.trailWindow + 1)
      : frames.slice(0, limit);
    assertStackBudget(span, settings.fovArcmin);
    const grids = await warmGrids(span, signal, sequence, 'Building motion trail', { frame, values: current });
    const combined = await imagePipeline.combine(grids, { statistic: 'max' }, signal);
    const element = document.createElement('canvas');
    paintGrid(element, combined.values, width, { psfFrame: entry.image?.projection?.psfFrame || null });
    return { kind: 'trail', canvas: element, values: combined.values, unit, frames: grids.length, first: span[0], last: span.at(-1) };
  }
  let referenceValues, referenceLabel, referenceCanvas, referenceObservation=null, referenceImage=null;
  if (settings.referenceFrame === 'deep-stack') {
    const template = await deepTemplate(signal, sequence);
    referenceValues = template.values;
    referenceLabel = `deep reference (${template.days} days)`;
    if (settings.viewMode === 'blink') { referenceCanvas = document.createElement('canvas'); paintGrid(referenceCanvas, referenceValues, width, { psfFrame: entry.image?.projection?.psfFrame || null }); }
  } else {
    const reference = referenceFrameFor(frame);
    if (!reference) return null;
    const referenceEntry = await warmCutout(reference, signal, 0);
    referenceObservation=reference;referenceImage=referenceEntry.image;
    referenceValues = referenceEntry.canvas.spherexGrid.values;
    referenceCanvas = referenceEntry.canvas;
    referenceLabel = frameLabel(reference);
  }
  signal.throwIfAborted();
  if (referenceValues.length !== current.length) throw new Error('The reference frame uses a different sky grid; choose another reference.');
  if (settings.viewMode === 'blink') return { kind: 'blink', canvas: entry.canvas, other: referenceCanvas, otherValues: referenceValues, referenceLabel, unit,
    observation:frame,image:entry.image,referenceObservation,referenceImage };
  const raw = new Float32Array(current.length);
  for (let i = 0; i < raw.length; i++) raw[i] = Number.isFinite(current[i]) && Number.isFinite(referenceValues[i]) ? current[i] - referenceValues[i] : NaN;
  if (!raw.some(Number.isFinite)) throw new Error('This frame and its reference do not overlap on the sky.');
  // Remove sky-level offsets and gradients between the two epochs, either
  // locally (default) or as one constant, so only compact changes remain.
  let flattened;
  if (settings.differenceFlatten) flattened = subtractLargeScale(raw, width, 16);
  else { const level = estimateBackground(raw).level; flattened = raw.map(value => value - level); }
  const diff = settings.smoothing ? gaussianSmooth(flattened, width, settings.smoothing) : flattened;
  // Robust (MAD) noise of the difference image, so a few real changes do not
  // inflate the significance scale.
  const sigma = estimateBackground(diff).noise;
  const threshold = settings.differenceThreshold, significant = new Uint8Array(diff.length);
  let brighter = 0, fainter = 0;
  if (sigma > 0) for (let i = 0; i < diff.length; i++) {
    if (diff[i] > threshold * sigma) { significant[i] = 1; brighter++; }
    else if (diff[i] < -threshold * sigma) { significant[i] = 2; fainter++; }
  }
  const element = document.createElement('canvas');
  paintGrid(element, diff, width, { mapper: differenceMapper(sigma, threshold * 2), lut: colormap('diverging'), smooth: false });
  return { kind: 'difference', canvas: element, values: diff, unit, sigma, threshold, significant, brighter, fainter, referenceLabel, currentCanvas: entry.canvas, referenceCanvas, referenceObservation };
}

function commitComposite(observation, entry, composed, { announce = true } = {}) {
  if (!composed) {
    const result = commitCutout(observation, entry, { announce });
    caption.textContent = `${MODE_NAMES[settings.viewMode]} needs at least two frames in this band; showing this frame alone · ${caption.textContent}`;
    return result;
  }
  stopBlink();
  const source = composed.canvas;
  if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
  context.drawImage(source, 0, 0);
  displayedCenter = entry.image.pointing || target;
  publishGrid(observation,entry.image,{suspended:composed.kind!=='blink'});
  applyChrome(entry.coverage);
  canvas.dataset.deepStack = 'false';
  const date = frameLabel(observation), wave = formatWavelength(observation);
  if (composed.kind === 'difference') {
    shown = { values: composed.values, flags: null, width: source.width, unit: composed.unit, kind: 'difference', sigma: composed.sigma, threshold: composed.threshold, significant: composed.significant, brighter: composed.brighter, fainter: composed.fainter, referenceLabel: composed.referenceLabel,
      currentCanvas: composed.currentCanvas, referenceCanvas: composed.referenceCanvas, observation, referenceObservation: composed.referenceObservation };
    caption.textContent = `Difference · ${date} − ${composed.referenceLabel} · noise σ = ${formatValue(composed.sigma)}${composed.unit ? ` ${composed.unit}` : ''} · ${composed.brighter} pixels brighter and ${composed.fainter} fainter beyond ±${composed.threshold}σ · ${wave}`;
    setCacheState('Difference image · orange brighter, blue fainter');
  } else if (composed.kind === 'trail') {
    shown = { values: composed.values, flags: null, width: source.width, unit: composed.unit, kind: 'image', limits: source.spherexLimits, automatic: source.spherexAutomaticLimits };
    caption.textContent = `Motion trail · per-pixel maximum of ${composed.frames} frames · ${frameLabel(composed.first)} to ${frameLabel(composed.last)} · ${wave}`;
    setCacheState('Motion trail · moving sources leave streaks');
  } else {
    setShown(source, entry.image);
    shown.kind = 'blink'; shown.referenceLabel = composed.referenceLabel;
    caption.textContent = `Blink · ${date} ⇄ ${composed.referenceLabel} every ${(settings.blinkIntervalMs / 1000).toFixed(2)} s · ${wave}${settings.consistentBrightness ? '' : ' · tip: turn on Consistent brightness so both frames share one scale'}`;
    setCacheState('Blinking · A is this frame, B the reference');
    startBlink(composed, date);
  }
  status.hidden = true;
  document.getElementById('export-sky-png').disabled = false;
  drawOverlay(); updateColourBar();
  // Thumbnails keep the plain frame, never the composite.
  window.dispatchEvent(new CustomEvent('sky:cutout-rendered', { detail: { observation, stackRecord: entry.image.stackRecord || null, canvas: entry.canvas } }));
  if (announce) window.dispatchEvent(new CustomEvent('sky:frame-shown', { detail: { observation } }));
  return { stackRecord: entry.image.stackRecord || null };
}

function startBlink(composed, date) {
  stopBlink();
  let showingReference = false;
  if (blinkBadge) { blinkBadge.hidden = false; blinkBadge.textContent = `A · ${date}`; }
  blinkTimer = setInterval(() => {
    showingReference = !showingReference;
    context.drawImage(showingReference ? composed.other : composed.canvas, 0, 0);
    const image=showingReference?composed.referenceImage:composed.image;
    const observation=showingReference?composed.referenceObservation:composed.observation;
    if(image)displayedCenter=image.pointing||target;
    publishGrid(observation,image,{suspended:!image});
    if (blinkBadge) blinkBadge.textContent = showingReference ? `B · ${composed.referenceLabel}` : `A · ${date}`;
    if (shown) {
      shown.values = showingReference ? composed.otherValues : composed.canvas.spherexGrid.values;
      shown.flags = showingReference ? composed.other.spherexGrid?.flags || null : composed.canvas.spherexGrid.flags;
      if (settings.qualityOverlay) drawOverlay();
    }
  }, settings.blinkIntervalMs);
}

function stopBlink() {
  clearInterval(blinkTimer);
  blinkTimer = null;
  if (blinkBadge) blinkBadge.hidden = true;
}

// ---------------------------------------------------------------------------
// On-screen state, overlays, colour bar and hover readout.

function setShown(element, image) {
  shown = {
    values: element.spherexGrid?.values || null, flags: element.spherexGrid?.flags || null, width: element.width,
    limits: element.spherexLimits, automatic: element.spherexAutomaticLimits, unit: image?.header?.BUNIT || '', kind: 'image'
  };
  drawOverlay(); updateColourBar();
}

// Informational flags (FULLSAMPLE, SOURCE) would paint every star; skip them.
const OVERLAY_FLAGS = QUALITY_FLAGS.filter(flag => flag.bit !== 12 && flag.bit !== 21);
function flagCategory(flags) {
  for (const flag of OVERLAY_FLAGS) if (flags & (2 ** flag.bit)) return flag.category;
  return null;
}

function overlayHasContent() {
  return Boolean(shown) && (settings.showCrosshair || settings.showCompass || settings.qualityOverlay || shown.kind === 'difference');
}

function drawOverlay() {
  if (!overlay) return;
  const overlayContext = overlay.getContext('2d');
  if (typeof overlayContext?.setTransform !== 'function') return;
  const cssSize = canvas.getBoundingClientRect().width, ratio = globalThis.devicePixelRatio || 1;
  const pixelSize = Math.max(1, Math.round(cssSize * ratio));
  if (overlay.width !== pixelSize || overlay.height !== pixelSize) { overlay.width = pixelSize; overlay.height = pixelSize; }
  overlayContext.setTransform(1, 0, 0, 1, 0, 0);
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  if (!shown || !cssSize || !shown.width) { updateLegend(null); return; }
  overlayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  const cell = cssSize / shown.width, width = shown.width;
  if (settings.qualityOverlay && shown.flags) {
    const counts = new Map();
    for (let i = 0; i < shown.flags.length; i++) {
      const category = shown.flags[i] ? flagCategory(shown.flags[i]) : null;
      if (!category) continue;
      counts.set(category, (counts.get(category) || 0) + 1);
      overlayContext.fillStyle = FLAG_CATEGORIES[category].colour + 'a0';
      overlayContext.fillRect((i % width) * cell, Math.floor(i / width) * cell, cell, cell);
    }
    updateLegend(counts);
  } else if (settings.qualityOverlay) {
    updateLegend(new Map(), 'Flags belong to single exposures. Stacked, difference and trail views have none: set Exposures per day to 1 or pick a single-exposure frame.');
  } else updateLegend(null);
  if (shown.kind === 'difference' && shown.significant) {
    overlayContext.lineWidth = Math.max(1, cell * 0.2);
    for (let i = 0; i < shown.significant.length; i++) {
      if (!shown.significant[i]) continue;
      overlayContext.strokeStyle = shown.significant[i] === 1 ? '#ffd27a' : '#8fd3ff';
      overlayContext.strokeRect((i % width) * cell + 0.5, Math.floor(i / width) * cell + 0.5, Math.max(1, cell - 1), Math.max(1, cell - 1));
    }
  }
  if (settings.showCrosshair) {
    const center = cssSize / 2, gap = Math.max(8, cell * 2), arm = Math.max(16, cssSize * 0.05);
    overlayContext.strokeStyle = '#7dffbf'; overlayContext.lineWidth = 1.5;
    overlayContext.beginPath();
    overlayContext.moveTo(center - gap - arm, center); overlayContext.lineTo(center - gap, center);
    overlayContext.moveTo(center + gap, center); overlayContext.lineTo(center + gap + arm, center);
    overlayContext.moveTo(center, center - gap - arm); overlayContext.lineTo(center, center - gap);
    overlayContext.moveTo(center, center + gap); overlayContext.lineTo(center, center + gap + arm);
    overlayContext.stroke();
  }
  if (settings.showCompass) drawCompass(overlayContext, cssSize, cell);
}

function arrow(drawing, x0, y0, x1, y1) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  drawing.beginPath();
  drawing.moveTo(x0, y0); drawing.lineTo(x1, y1);
  drawing.lineTo(x1 - 7 * Math.cos(angle - 0.5), y1 - 7 * Math.sin(angle - 0.5));
  drawing.moveTo(x1, y1); drawing.lineTo(x1 - 7 * Math.cos(angle + 0.5), y1 - 7 * Math.sin(angle + 0.5));
  drawing.stroke();
}

// The projection grid is north-up, east-left (RA increases to the left).
function drawCompass(drawing, size, cell) {
  drawing.save();
  drawing.font = '600 12px "DM Sans", sans-serif';
  drawing.lineWidth = 1.5; drawing.strokeStyle = '#e7eef2'; drawing.fillStyle = '#e7eef2';
  drawing.shadowColor = '#000000cc'; drawing.shadowBlur = 3;
  const x = size - 20, y = 52, length = 30;
  arrow(drawing, x, y, x, y - length); drawing.fillText('N', x - 4, y - length - 6);
  arrow(drawing, x, y, x - length, y); drawing.fillText('E', x - length - 13, y + 4);
  const goal = settings.fovArcmin / 5;
  const arcmin = [0.5, 1, 2, 5, 10].reduce((best, choice) => Math.abs(choice - goal) < Math.abs(best - goal) ? choice : best);
  const length2 = arcmin * 60 / PIXEL_ARCSEC * cell, left = 16, bottom = size - 16;
  drawing.beginPath();
  drawing.moveTo(left, bottom); drawing.lineTo(left + length2, bottom);
  drawing.moveTo(left, bottom - 4); drawing.lineTo(left, bottom + 4);
  drawing.moveTo(left + length2, bottom - 4); drawing.lineTo(left + length2, bottom + 4);
  drawing.stroke();
  drawing.fillText(arcmin < 1 ? `${arcmin * 60}″` : `${arcmin}′`, left, bottom - 8);
  drawing.restore();
}

function updateLegend(counts, note = '') {
  if (!qualityLegend) return;
  if (!counts) { qualityLegend.hidden = true; qualityLegend.replaceChildren?.(); return; }
  qualityLegend.hidden = false;
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => {
    const item = document.createElement('span'), swatch = document.createElement('i');
    swatch.style.setProperty?.('--flag-colour', FLAG_CATEGORIES[category].colour);
    item.append?.(swatch, `${FLAG_CATEGORIES[category].label} · ${count.toLocaleString()} px`);
    return item;
  });
  if (!items.length) {
    const item = document.createElement('span');
    item.textContent = note || 'No flagged pixels in this frame.';
    items.push(item);
  }
  qualityLegend.replaceChildren?.(...items);
}

// A plain-data summary of what is on screen, for the AI guide. Deferred one
// tick so the caption written right after a render is included.
let summaryTimer = null;
function publishViewSummary() {
  if (summaryTimer) return;
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    if (!shown) return;
    const record = activeObservation?.image?.stackRecord;
    const detail = {
      kind: canvas.dataset.deepStack === 'true' ? 'deep-stack' : shown.kind,
      mode: settings.viewMode,
      caption: caption.textContent,
      unit: shown.unit || '',
      detector: activeObservation?.detector ?? null,
      date: activeObservation?.observedStartUtc || '',
      limits: shown.limits ? { low: shown.limits.low, high: shown.limits.high } : null
    };
    if (shown.kind === 'difference') Object.assign(detail, { sigma: shown.sigma, threshold: shown.threshold, brighterPixels: shown.brighter, fainterPixels: shown.fainter, reference: shown.referenceLabel });
    if (shown.kind === 'blink') detail.reference = shown.referenceLabel;
    if (record?.deepStack) Object.assign(detail, { usedFrames: record.usedFrameCount, availableFrames: record.availableFrameCount, usedExposures: record.usedExposureCount, exposureSeconds: Math.round(record.exposureSeconds), skippedExposures: record.failedObservationIds?.length || 0 });
    else if (record) Object.assign(detail, { stackedExposures: record.usedExposureCount });
    window.dispatchEvent(new CustomEvent('sky:view-summary', { detail }));
  }, 0);
}

function updateColourBar() {
  publishViewSummary();
  const bar = document.getElementById('colour-bar');
  if (!bar) return;
  if (!shown) { bar.hidden = true; return; }
  bar.hidden = false;
  const strip = document.getElementById('colour-bar-strip');
  const [low, middle, high, unit] = ['colour-bar-low', 'colour-bar-mid', 'colour-bar-high', 'colour-bar-unit'].map(id => document.getElementById(id));
  if (shown.kind === 'difference') {
    strip.style.background = colormapGradient('diverging');
    const range = shown.threshold * 2;
    low.textContent = `−${range}σ fainter`; middle.textContent = 'no change'; high.textContent = `+${range}σ brighter`;
    unit.textContent = `σ = ${formatValue(shown.sigma)}${shown.unit ? ` ${shown.unit}` : ''}`;
  } else {
    strip.style.background = colormapGradient(settings.colours, settings.invert);
    low.textContent = formatValue(shown.limits?.low);
    middle.textContent = `${STRETCH_NAMES[settings.stretch] || settings.stretch} stretch`;
    high.textContent = formatValue(shown.limits?.high);
    unit.textContent = `${shown.unit || 'image units'}${settings.consistentBrightness && settings.scaleMode !== 'manual' ? ' · shared scale' : ''}`;
    if (shown.limits) window.dispatchEvent(new CustomEvent('sky:display-limits', { detail: { ...shown.limits } }));
  }
}

let hoverFrame = 0, hoverEvent = null;
const nextFrame = callback => (globalThis.requestAnimationFrame || (fn => setTimeout(fn, 16)))(callback);
canvas.addEventListener('pointermove', event => { hoverEvent = event; if (!hoverFrame) hoverFrame = nextFrame(updateHover); });
canvas.addEventListener('pointerleave', () => { hoverEvent = null; if (hoverReadout) hoverReadout.hidden = true; });
function updateHover() {
  hoverFrame = 0;
  if (!hoverReadout) return;
  if (!hoverEvent || !shown?.values) { hoverReadout.hidden = true; return; }
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = (hoverEvent.clientX - rect.left) / rect.width * shown.width, y = (hoverEvent.clientY - rect.top) / rect.height * shown.width;
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= shown.width || iy >= shown.width) { hoverReadout.hidden = true; return; }
  const index = iy * shown.width + ix, value = shown.values[index];
  const sky = canvasToSky({ x, y, size: shown.width, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
  const parts = [];
  if (sky) parts.push(`RA ${sky.raDeg.toFixed(5)}° Dec ${sky.decDeg >= 0 ? '+' : ''}${sky.decDeg.toFixed(5)}°`);
  const unit = shown.unit ? ` ${shown.unit}` : '';
  if (!Number.isFinite(value)) parts.push('no data');
  else if (shown.kind === 'difference') parts.push(`Δ ${value >= 0 ? '+' : ''}${formatValue(value)}${unit} (${shown.sigma > 0 ? `${value >= 0 ? '+' : ''}${(value / shown.sigma).toFixed(1)}σ` : 'σ unavailable'})`);
  else parts.push(`${formatValue(value)}${unit}`);
  const flags = shown.flags ? shown.flags[index] >>> 0 : 0;
  if (flags) parts.push(QUALITY_FLAGS.filter(flag => flags & (2 ** flag.bit)).map(flag => flag.name).join(', '));
  hoverReadout.textContent = parts.join(' · ');
  hoverReadout.hidden = false;
}

if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
  drawOverlay();window.dispatchEvent(new CustomEvent('sky:display-grid-changed',{detail:publishedGrid}));
  // Track arrows are sized for the canvas's CSS scale.
  if (spots.list().some(spot => spot.track?.length >= 2)) positionMark();
}).observe(canvas);

// Lock the comparison scale to the frame on screen, so every later frame is
// painted with exactly these black and white points.
document.getElementById('lock-scale')?.addEventListener('click', () => {
  const limits = shown?.automatic || shown?.limits;
  if (!limits || shown.kind === 'difference') return;
  comparisonScale = { ...limits };
  settings = { ...settings, consistentBrightness: true };
  window.dispatchEvent(new CustomEvent('sky:display-scale-locked'));
  renderedFrames.clear();
  if (activeObservation?.image && !isComparisonMode()) void drawImage(activeObservation.image);
  else if (activeTimelineFrame) void showCutout(activeTimelineFrame, { quiet: true, keepImage: true });
});

// Restore a marked source carried by a shared link before any image is loaded.
if (Number.isFinite(initialViewState.markRaDeg) && Number.isFinite(initialViewState.markDecDeg)) {
  spots.add({ raDeg: initialViewState.markRaDeg, decDeg: initialViewState.markDecDeg, radiusArcsec: initialViewState.markRadiusArcsec }, { origin: 'user' });
}
for (const spot of initialViewState.extraSpots || []) spots.add(spot, { origin: 'user' });
if (spots.list().length) publishSpots();
resetViewer('Waiting for observations.');
