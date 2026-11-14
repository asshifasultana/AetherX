import { canvasToSky, skyToCanvas } from './sky-projection.js';
import { initialViewState } from './share.js';
import { FLAG_CATEGORIES, MASKED_FLAG_BITS, QUALITY_FLAGS } from './lib/pixel-quality.js';
import { matrixFor, projectSkyToPixel, projectionKey } from './lib/fits-engine.js';
import { imagePipeline } from './image-pipeline.js';
import { ByteCache, assertStackBudget } from './lib/image-resources.js';
import { observationKey } from './timelapse-core.js';
import { exposureCenter, presetMotion } from './presets.js';

const canvas = document.getElementById('sky-canvas');
const context = canvas.getContext('2d', { alpha: false });
const status = document.getElementById('cutout-status');
const caption = document.getElementById('cutout-caption');
const sourceMark = document.getElementById('source-mark');
const sourceMarkLabel = document.getElementById('source-mark-label');
const pixelInspector = document.getElementById('pixel-inspector');
const pixelInspectorResult = document.getElementById('pixel-inspector-result');
let target = { raDeg: 269.4521, decDeg: 4.6934 }, settings = { fovArcmin: 16, stretch: 'asinh', colours: 'grayscale', contrast: 65, invert: false };
let activeObservation = null, activeSequence = 0, cutoutController = null;
let displayedCenter = target;
let inspectionCanvasPoint = null;
let pixelInspectionSequence = 0;
let activeFrameExposures = [];
let timelineFrames = [];
let activeTimelineFrame = null;
let dataGeneration = 0;
let repaintSequence = 0;
let deepStackScheduled = false;
let comparisonScale = null;
// A marked candidate source is an absolute sky position, so it survives frame
// changes, band changes and a new search. Only the field of view can move it
// (partly) out of frame.
let markedSource = null;
const PIXEL_ARCSEC = 6.15;
// Decoded frames and their rendered canvases live in memory so playback can swap
// frames with a single draw instead of re-fetching and re-parsing FITS.
const decodedFrames = new ByteCache();
const renderedFrames = new ByteCache();

// The backend publishes this mask policy and applies the same policy to pixel inspection.
const BAD_PIXEL_MASK = MASKED_FLAG_BITS.reduce((mask, bit) => mask | (1 << bit), 0) >>> 0;
const FLAGS_BY_BIT = new Map(QUALITY_FLAGS.map(flag => [flag.bit, flag]));

const cards = text => { status.textContent = text; };
window.addEventListener('sky:target-selected', event => { dataGeneration++; target = { ...event.detail }; comparisonScale = null; activeObservation = null; activeTimelineFrame = null; activeFrameExposures = []; timelineFrames = []; activeSequence++; cutoutController?.abort(); resetViewer('This target is selected. Scroll down past the timeline and settings to Find your observations. Open Details + on a result, then choose View aligned cutout.'); });
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
  const previousFov = settings.fovArcmin, previousDisplay = displaySignature();
  const previousBand = settings.band, previousConsistent = settings.consistentBrightness;
  const previousMode = settings.viewMode, previousStackLimit = settings.maxStackFrames;
  const previousGlitchRejection = settings.rejectVisitGlitches;
  settings = { ...settings, ...event.detail };
  const changed = previousDisplay !== displaySignature() || previousBand !== settings.band;
  if (changed) { dataGeneration++; activeSequence++; cutoutController?.abort(); }
  if (pixelInspector) pixelInspector.hidden = !settings.inspectPixels;
  document.querySelector('.viewer')?.classList.toggle('is-inspecting', Boolean(settings.inspectPixels));
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
  } else if (settings.fovArcmin !== previousFov && activeObservation) {
    // A new FOV needs a new archive cutout; clear the old image and label the requested size immediately.
    showCutout(activeObservation);
  } else if (settings.viewMode === 'deep-stack' && (previousMode !== 'deep-stack' || previousStackLimit !== settings.maxStackFrames)) {
    void showDeepStack();
  } else if (previousMode === 'deep-stack' && settings.viewMode !== 'deep-stack' && activeTimelineFrame) {
    void showCutout(activeTimelineFrame, { quiet: true, keepImage: true });
  } else if (activeObservation?.image?.stackRecord && changed) {
    void showCutout(activeTimelineFrame || activeObservation);
  } else if (activeObservation?.image && displaySignature() !== previousDisplay) {
    // Only an actual display change (stretch, colours, contrast, mask) needs a
    // repaint. A detector-band sync must not re-render the frame that just drew.
    status.hidden = true; void drawImage(activeObservation.image).catch(error => { cards(error.message); status.hidden = false; });
  }
});

function resetViewer(message) {
  displayedCenter = target;
  document.querySelector('.viewer')?.classList.remove('has-image');
  canvas.dataset.deepStack = 'false';
  document.getElementById('export-sky-png').disabled = true;
  document.getElementById('coverage-note').hidden = true;
  context.fillStyle = '#08090e'; context.fillRect(0, 0, canvas.width, canvas.height);
  document.getElementById('target-marker').hidden = true;
  if (sourceMark) sourceMark.hidden = true;
  document.getElementById('quality-hover-readout').hidden = true;
  document.getElementById('quality-legend').hidden = true;
  caption.textContent = '';
  status.hidden = false; status.classList.remove('is-error');
  cards(message);
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function colorize(value, low, high) {
  let t = (value - low) / (high - low || 1);
  if (settings.stretch === 'asinh') t = Math.asinh(t * 10) / Math.asinh(10);
  else if (settings.stretch === 'sqrt') t = Math.sqrt(Math.max(0, t));
  else if (settings.stretch === 'log') t = Math.log1p(Math.max(0, t) * 100) / Math.log(101);
  t = Math.max(0, Math.min(1, (t - 0.5) * (settings.contrast / 50) + 0.5));
  if (settings.invert) t = 1 - t;
  if (settings.colours === 'inferno' || settings.colours === 'magma') return [255 * Math.min(1, t * 1.7), 255 * Math.pow(t, 2.1) * .7, 255 * Math.pow(t, 5) * .9];
  if (settings.colours === 'viridis') return [255 * (.25 + .65 * t), 255 * (.08 + .82 * t), 255 * (.3 + .4 * (1 - t))];
  return [255 * t, 255 * t, 255 * t];
}

function hexRgb(hex) { return [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16)); }

function paintCanvas(element, image) {
  const projected = image.stackRecord
    ? { values: image.values, flags: new Uint32Array(image.values.length), coverage: image.values.reduce((n, v) => n + Number.isFinite(v), 0) / image.values.length, width: image.width }
    : image.projection;
  if (!projected) throw new Error('This image has not been projected.');
  const allValues = Array.from(projected.values).filter(Number.isFinite);
  if (!allValues.length) throw new Error('No valid pixels remain after applying the quality mask.');
  const automaticScale = { low: percentile(allValues, .02), high: percentile(allValues, .995) };
  if (settings.consistentBrightness && !comparisonScale) comparisonScale = automaticScale;
  const limits = settings.consistentBrightness ? comparisonScale : automaticScale;
  if (!(limits.high > limits.low)) throw new Error('The cutout has no usable image contrast.');
  element.width = projected.width; element.height = projected.width;
  const paintContext = element.getContext('2d', { alpha: false });
  const pixels = paintContext.createImageData(element.width, element.height);
  for (let i = 0; i < projected.values.length; i++) {
    const value = projected.values[i], flag = projected.flags[i];
    let rgb = Number.isFinite(value) ? colorize(value, limits.low, limits.high) : [15, 12, 22];
    if (settings.qualityOverlay && !image.stackRecord) {
      if (!projected.covered[i]) rgb = hexRgb(FLAG_CATEGORIES.uncovered.colour);
      else if ((flag & (1 << 9)) || !Number.isFinite(value)) rgb = hexRgb(FLAG_CATEGORIES.missing.colour);
      else if (flag) {
        const category = ['transient', 'detector', 'correction', 'artifact', 'caution'].find(name => QUALITY_FLAGS.some(item => item.category === name && (flag & (2 ** item.bit)) !== 0));
        rgb = hexRgb(FLAG_CATEGORIES[category || 'caution'].colour);
      }
    }
    pixels.data.set([...rgb, 255], i * 4);
  }
  paintContext.putImageData(pixels, 0, 0);
  element.spherexGrid = { values: projected.values, flags: projected.flags };
  return projected.coverage;
}

async function paintStackCanvas(element, entries, observations, signal) {
  if (!entries.length) throw new Error('No daily exposures were retrieved for this frame.');
  const grid = await imagePipeline.median(entries.map(entry => entry.canvas.spherexGrid.values), signal);
  const allValues = Array.from(grid.values).filter(Number.isFinite);
  if (!allValues.length) throw new Error('No valid pixels remain in the daily exposure stack.');
  const automaticScale = { low: percentile(allValues, .02), high: percentile(allValues, .995) };
  if (settings.consistentBrightness && !comparisonScale) comparisonScale = automaticScale;
  const limits = settings.consistentBrightness ? comparisonScale : automaticScale;
  if (!(limits.high > limits.low)) throw new Error('The exposure stack has no usable image contrast.');
  const width = Math.max(1, Math.round(settings.fovArcmin * 60 / PIXEL_ARCSEC));
  element.width = width; element.height = width;
  const paintContext = element.getContext('2d', { alpha: false }), output = paintContext.createImageData(width, width);
  for (let i = 0; i < grid.values.length; i++) {
    let rgb;
    if (!Number.isFinite(grid.values[i])) rgb = [15, 12, 22];
    else rgb = colorize(grid.values[i], limits.low, limits.high);
    const at = i * 4;
    output.data[at] = rgb[0]; output.data[at + 1] = rgb[1]; output.data[at + 2] = rgb[2]; output.data[at + 3] = 255;
  }
  paintContext.putImageData(output, 0, 0);
  element.spherexGrid = { values: grid.values, flags: new Uint32Array(grid.values.length), counts: grid.counts };
  const exposureSeconds = entries.reduce((sum, entry) => sum + (Number(entry.observation.exposureSeconds) || 0), 0);
  const times = observations.map(observation => Date.parse(observation.observedStartUtc || '')).filter(Number.isFinite).sort((a, b) => a - b);
  const record = {
    method: 'per-pixel median of quality-masked, individually background-subtracted aligned exposures',
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
  document.getElementById('target-marker').hidden = !settings.showTargetMarker;
  document.getElementById('quality-legend').hidden = !settings.qualityOverlay && !activeObservation?.image?.derivedTransientPixels?.size;
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
  applyChrome(coverage);
  positionMark();
  return coverage;
}

const formatMark = sky => `${sky.raDeg.toFixed(4)}°, ${sky.decDeg >= 0 ? '+' : ''}${sky.decDeg.toFixed(4)}°`;

function setMarkedSource(sky) {
  markedSource = sky && Number.isFinite(sky.raDeg) && Number.isFinite(sky.decDeg)
    ? { raDeg: sky.raDeg, decDeg: sky.decDeg }
    : null;
  positionMark();
  window.dispatchEvent(new CustomEvent('sky:source-marked', { detail: markedSource ? { ...markedSource } : {} }));
}

// Place the DOM marker over the stretched canvas. Percentages of the element box
// map one-to-one onto canvas pixels, so the mark stays put at every field of view
// even though the canvas has a fixed pixel grid and a fluid CSS size.
function positionMark() {
  if (!sourceMark) return;
  const size = canvas.width;
  if (!markedSource || !size || !document.querySelector('.viewer')?.classList.contains('has-image')) {
    sourceMark.hidden = true;
    return;
  }
  const point = skyToCanvas({
    raDeg: markedSource.raDeg, decDeg: markedSource.decDeg, size,
    centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg
  });
  if (!point) { sourceMark.hidden = true; return; }
  // Clamp to the frame so a source outside the current field of view is still
  // visible at the edge and clearly marked as out of frame, rather than vanishing.
  const clamp = value => Math.max(0, Math.min(size - 1, value));
  const x = clamp(point.x), y = clamp(point.y);
  const offscreen = x !== point.x || y !== point.y;
  sourceMark.hidden = false;
  sourceMark.classList.toggle('is-offscreen', offscreen);
  sourceMark.style.left = `${((x + 0.5) / size) * 100}%`;
  sourceMark.style.top = `${((y + 0.5) / size) * 100}%`;
  sourceMark.title = offscreen
    ? `Marked source ${formatMark(markedSource)} lies outside this field of view. Widen the field to see it.`
    : `Marked source ${formatMark(markedSource)}`;
  if (sourceMarkLabel) {
    sourceMarkLabel.textContent = offscreen ? `${formatMark(markedSource)} · outside field` : formatMark(markedSource);
  }
}

canvas.addEventListener('click', event => {
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
  if (sky) setMarkedSource(sky);
});

canvas.addEventListener('pointermove', event => {
  const readout = document.getElementById('quality-hover-readout');
  if (!activeObservation?.image || (!settings.qualityOverlay && !settings.inspectPixels)) { readout.hidden = true; return; }
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const size = canvas.width, x = (event.clientX - rect.left) * size / rect.width, y = (event.clientY - rect.top) * size / rect.height;
  const sky = canvasToSky({ x, y, size, centerRaDeg: displayedCenter.raDeg, centerDecDeg: displayedCenter.decDeg });
  readout.textContent = formatHoveredPixel(activeObservation.image, sky);
  const viewerRect = document.querySelector('.viewer').getBoundingClientRect();
  readout.style.left = `${Math.max(10, Math.min(viewerRect.width - 300, event.clientX - viewerRect.left + 12))}px`;
  readout.style.top = `${Math.max(10, Math.min(viewerRect.height - 90, event.clientY - viewerRect.top + 12))}px`;
  readout.hidden = false;
});
canvas.addEventListener('pointerleave', () => { document.getElementById('quality-hover-readout').hidden = true; });

function formatHoveredPixel(image, sky) {
  const point = sky && projectSkyToPixel(image, sky.raDeg, sky.decDeg);
  if (!point || point[0] < 0 || point[1] < 0 || point[0] >= image.width || point[1] >= image.height) return `Outside detector coverage · RA ${sky?.raDeg.toFixed(5)}°, Dec ${sky?.decDeg.toFixed(5)}°`;
  const x = Math.min(image.width - 1, Math.round(point[0])), y = Math.min(image.height - 1, Math.round(point[1])), index = y * image.width + x;
  const value = image.values[index], flags = image.flags?.[index] >>> 0;
  const names = image.flags ? [...FLAGS_BY_BIT.values()].filter(flag => (flags & (2 ** flag.bit)) !== 0).map(flag => flag.name) : [];
  if (image.derivedTransientPixels?.has(index)) return `Possible one-exposure transient rejected · FITS pixel ${x + 1 + (image.sourceX || 0)}, ${y + 1 + (image.sourceY || 0)}`;
  if ((flags & (1 << 9)) || !Number.isFinite(value)) return `Missing pixel data · FITS pixel ${x + 1 + (image.sourceX || 0)}, ${y + 1 + (image.sourceY || 0)} · not a fading measurement`;
  if (names.length) return `${names.join(' + ')} · FITS pixel ${x + 1 + (image.sourceX || 0)}, ${y + 1 + (image.sourceY || 0)} · ${Number.isFinite(value) ? value.toPrecision(4) : 'no value'} ${image.header.BUNIT || ''}`;
  return `${image.flags ? 'Valid' : 'Quality flags unavailable'} pixel ${x + 1 + (image.sourceX || 0)}, ${y + 1 + (image.sourceY || 0)} · ${value.toPrecision(4)} ${image.header.BUNIT || ''}`;
}

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
      body: JSON.stringify({ covered: inspectedSample ? inspectedSample.covered : covered, value: inspectedSample ? inspectedSample.value : (Number.isFinite(value) ? value : null), flags: inspectedSample?.flags ?? flags, flagsAvailable: inspectedSample?.flagsAvailable ?? Boolean(image.flags), maskEnabled: Boolean(settings.hideBadPixels), detectGlitches: Boolean(settings.rejectVisitGlitches), samples, activeSampleIndex: exposureData.currentIndex })
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
              ? `${assessment.label} within this observation; the rejected sample is marked in the image.`
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
    if (Number.isFinite(value) && !(image.flags && (image.flags[index] & BAD_PIXEL_MASK))) neighborhood.push(value);
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

window.addEventListener('sky:clear-source-mark', () => setMarkedSource(null));

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
    settings.viewMode || 'time-lapse', settings.maxStackFrames || 80,
    settings.consistentBrightness && comparisonScale ? comparisonScale.low : '', settings.consistentBrightness && comparisonScale ? comparisonScale.high : '',
    settings.stretch, settings.colours, settings.contrast, settings.invert, settings.hideBadPixels ? 1 : 0, settings.qualityOverlay ? 1 : 0, settings.rejectVisitGlitches ? 1 : 0
  ].join('|');
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
// downloading (8 x 2.9 MB, or 105 MB for a 36-exposure day). Sample evenly
// across the day instead, and disclose how many were left out.
const MAX_STACK_EXPOSURES = 6;
function sampleExposures(list) {
  if (list.length <= MAX_STACK_EXPOSURES) return list;
  const picked = [];
  for (let i = 0; i < MAX_STACK_EXPOSURES; i++) {
    picked.push(list[Math.round(i * (list.length - 1) / (MAX_STACK_EXPOSURES - 1))]);
  }
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
    caption.textContent = `Deep median stack · ${record.usedFrameCount}/${record.availableFrameCount} UTC-day frames · ${record.usedExposureCount} exposures · ${Math.round(record.exposureSeconds)} s total · D${observation.detector} · ${formatWavelength(observation)} · north up${presetMotion(target) ? ' · proper-motion aligned' : ''}`;
    window.dispatchEvent(new CustomEvent('sky:deep-stack-built', { detail: { record } }));
  } catch (error) {
    if (sequence === activeSequence && !controller.signal.aborted) {
      controller.abort();
      resetViewer(error.message); status.classList.add('is-error');
      document.getElementById('cutout-cache-state').textContent = 'Deep stack unavailable';
    }
  }
}

function deepStackSignature() {
  const frames = timelineFrames.slice(0, Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80)));
  return `${displaySignature()}|${settings.band}|${frames.map(observationKey).join(',')}`;
}

function commitCutout(observation, entry, { announce = true, preview = false } = {}) {
  const source = entry.canvas;
  if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
  context.drawImage(source, 0, 0);
  displayedCenter = entry.image.pointing || target;
  applyChrome(entry.coverage);
  positionMark();
  const image = entry.image;
  canvas.dataset.deepStack = String(Boolean(image.stackRecord?.deepStack));
  const date = observation.observedStartUtc ? new Date(observation.observedStartUtc).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Date not reported';
  const masked = image.flags && settings.hideBadPixels ? Array.from(image.flags).filter(value => (value & BAD_PIXEL_MASK) !== 0).length : 0;
  const release = observation.release || observation.collection || 'Release not reported';
  const processing = observation.processingVersion ? ` · ${observation.processingVersion}` : '';
  const omitted = image.stackRecord?.omittedExposureCount || 0;
  const stackLabel = image.stackRecord
    ? ` · median stack ${image.stackRecord.usedExposureCount} exposures${omitted ? ` of ${image.stackRecord.requestedExposureCount} (evenly sampled for download time)` : ''} · ${Math.round(image.stackRecord.exposureSeconds)} s total`
    : '';
  caption.textContent = `${date} · D${observation.detector} · ${formatWavelength(observation)} · ${release}${processing}${stackLabel} · ${settings.fovArcmin}′ square · north up${presetMotion(target) ? ' · proper-motion aligned' : ''}${masked ? ` · ${masked} flagged pixels masked` : ''}`;
  status.hidden = true;
  document.getElementById('export-sky-png').disabled = preview;
  document.getElementById('cutout-cache-state').textContent = image.stackRecord ? 'Aligned median stack · browser caching enabled' : 'Retrieved from NASA archive · browser caching enabled';
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
  const record = activeObservation.image.stackRecord;
  const ids = record?.contributors.map(item => item.observationId).filter(Boolean) || [];
  const idLines = [];
  for (const id of ids) {
    const previous = idLines.at(-1);
    if (previous && `${previous}, ${id}`.length <= 44) idLines[idLines.length - 1] += `, ${id}`;
    else idLines.push(id);
  }
  const scale = 2, footerHeight = record ? 58 + idLines.length * 20 : 52, output = document.createElement('canvas');
  output.width = canvas.width * scale; output.height = canvas.height * scale + footerHeight;
  const out = output.getContext('2d');
  out.fillStyle = '#101b20'; out.fillRect(0, 0, output.width, output.height);
  out.drawImage(canvas, 0, 0, canvas.width * scale, canvas.height * scale);
  const imageBottom = canvas.height * scale;
  out.fillStyle = '#e6ede2'; out.font = '20px sans-serif';
  out.fillText(caption.textContent.slice(0, 100), 16, imageBottom + 25);
  if (record) {
    out.fillStyle = '#bdcbbd'; out.font = '17px sans-serif';
    out.fillText(`${record.deepStack ? 'Deep median across UTC-day frames' : 'Daily per-pixel median'} · ${record.usedExposureCount}/${record.requestedExposureCount} exposures · ${record.validPixelContributions.toLocaleString()} pixel contributions · ${Math.round(record.exposureSeconds)} s`, 16, imageBottom + 49);
    idLines.forEach((line, index) => out.fillText(`${index === 0 ? 'Observation IDs: ' : '                 '}${line}`, 16, imageBottom + 72 + index * 20));
  }
  output.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `spherex-${activeObservation.observedStartUtc?.slice(0, 10) || 'frame'}-D${activeObservation.detector}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
});

// Restore a marked source carried by a shared link before any image is loaded.
if (Number.isFinite(initialViewState.markRaDeg) && Number.isFinite(initialViewState.markDecDeg)) {
  setMarkedSource({ raDeg: initialViewState.markRaDeg, decDeg: initialViewState.markDecDeg });
}
resetViewer('Scroll down past the timeline and settings to Find your observations. Choose Details + on a result, then View aligned cutout. Click the sky image to mark a candidate source.');
