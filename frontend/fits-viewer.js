import { loadCutout } from './cutout-loader.js';
import { canvasToSky, skyToCanvas } from './sky-projection.js';
import { initialViewState } from './share.js';
import { FLAG_CATEGORIES, MASKED_FLAG_BITS, QUALITY_FLAGS } from './lib/pixel-quality.js';
import { decodeRice32 } from './lib/rice.js';
import { estimateBackground } from './lib/background.js';
import { medianStack } from './lib/stack.js';
import { observationKey } from './timelapse-core.js';

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
let inspectionCanvasPoint = null;
let pixelInspectionSequence = 0;
let activeFrameExposures = [];
let timelineFrames = [];
let activeTimelineFrame = null;
let comparisonScale = null;
// A marked candidate source is an absolute sky position, so it survives frame
// changes, band changes and a new search. Only the field of view can move it
// (partly) out of frame.
let markedSource = null;
const PIXEL_ARCSEC = 6.15;
// Decoded frames and their rendered canvases live in memory so playback can swap
// frames with a single draw instead of re-fetching and re-parsing FITS.
const decodedFrames = new Map();
const renderedFrames = new Map();
const MAX_CACHED_FRAMES = 160;
// The backend publishes this mask policy and applies the same policy to pixel inspection.
const BAD_PIXEL_MASK = MASKED_FLAG_BITS.reduce((mask, bit) => mask | (1 << bit), 0) >>> 0;
const FLAGS_BY_BIT = new Map(QUALITY_FLAGS.map(flag => [flag.bit, flag]));

const cards = text => { status.textContent = text; };
window.addEventListener('sky:target-selected', event => { target = { ...event.detail }; comparisonScale = null; activeObservation = null; activeTimelineFrame = null; activeFrameExposures = []; timelineFrames = []; activeSequence++; cutoutController?.abort(); resetViewer('This target is selected. Scroll down past the timeline and settings to Find your observations. Open Details + on a result, then choose View aligned cutout.'); });
window.addEventListener('sky:frame-exposure-group', event => { activeFrameExposures = Array.isArray(event.detail?.exposures) ? event.detail.exposures : []; activeTimelineFrame = event.detail?.frame || activeTimelineFrame; });
window.addEventListener('sky:timeline-frames-changed', event => { timelineFrames = Array.isArray(event.detail?.frames) ? event.detail.frames : []; });
window.addEventListener('sky:viewer-settings-changed', event => {
  const previousFov = settings.fovArcmin, previousDisplay = displaySignature();
  const previousBand = settings.band, previousConsistent = settings.consistentBrightness;
  const previousMode = settings.viewMode, previousStackLimit = settings.maxStackFrames;
  const previousGlitchRejection = settings.rejectVisitGlitches;
  settings = { ...settings, ...event.detail };
  if (pixelInspector) pixelInspector.hidden = !settings.inspectPixels;
  document.querySelector('.viewer')?.classList.toggle('is-inspecting', Boolean(settings.inspectPixels));
  document.querySelector('.viewer')?.classList.toggle('is-quality-inspecting', Boolean(settings.inspectPixels || settings.qualityOverlay));
  if (previousGlitchRejection && settings.rejectVisitGlitches === false) {
    for (const image of decodedFrames.values()) image.derivedTransientPixels?.clear();
    renderedFrames.clear();
  }
  if (settings.fovArcmin !== previousFov || settings.band !== previousBand || settings.consistentBrightness !== previousConsistent) comparisonScale = null;
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
  } else if (activeObservation?.image && displaySignature() !== previousDisplay) {
    // Only an actual display change (stretch, colours, contrast, mask) needs a
    // repaint. A detector-band sync must not re-render the frame that just drew.
    status.hidden = true; drawImage(activeObservation.image);
  }
});

function resetViewer(message) {
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

function parseHeader(bytes, offset) {
  const values = {};
  let cursor = offset, ended = false;
  while (cursor + 80 <= bytes.length && !ended) {
    const endBlock = Math.min(cursor + 2880, bytes.length);
    for (let start = cursor; start + 80 <= endBlock; start += 80) {
      const card = new TextDecoder('ascii').decode(bytes.subarray(start, start + 80));
      const key = card.slice(0, 8).trim();
      if (key === 'END') { cursor = start + 80; ended = true; break; }
      if (card[8] !== '=') continue;
      const raw = card.slice(10).split('/')[0].trim();
      if (raw.startsWith("'")) values[key] = raw.slice(1, raw.lastIndexOf("'")).trim();
      else if (raw) values[key] = Number(raw.replace(/D/g, 'E'));
    }
    if (!ended) cursor = endBlock;
  }
  return { header: values, dataOffset: Math.ceil(cursor / 2880) * 2880 };
}

function readFits(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (new TextDecoder('ascii').decode(bytes.subarray(0, 8)) !== 'SIMPLE  ') throw new Error('This file is not a FITS image.');
  let offset = 0, selected = null, flags = null;
  while (offset + 2880 <= bytes.length) {
    const { header, dataOffset } = parseHeader(bytes, offset);
    const count = Math.max(0, Number(header.NAXIS) || 0);
    const axes = Array.from({ length: count }, (_, i) => Number(header[`NAXIS${i + 1}`]) || 0);
    const bitpix = Number(header.BITPIX) || 0;
    const elements = axes.reduce((a, b) => a * b, 1);
    const bytesPerPixel = Math.abs(bitpix) / 8;
    const tableLength = Number(header.NAXIS1 || 0) * Number(header.NAXIS2 || 0);
    const dataLength = header.XTENSION === 'BINTABLE' || header.XTENSION === 'TABLE'
      ? tableLength + (Number(header.PCOUNT) || 0)
      : elements * bytesPerPixel;
    if (selected && header.EXTNAME === 'FLAGS' && header.ZCMPTYPE === 'RICE_1' && dataOffset + dataLength <= bytes.length) {
      const width = Number(header.ZNAXIS1), height = Number(header.ZNAXIS2), tileHeight = Number(header.ZTILE2);
      if (Number(header.ZBITPIX) !== 32 || tileHeight !== 1 || width !== selected.axes[0] || height !== selected.axes[1]) throw new Error('The compressed FLAGS image has an unsupported tile layout.');
      const heapStart = dataOffset + (Number(header.THEAP) || tableLength);
      const viewRows = new DataView(buffer, dataOffset, tableLength);
      flags = new Uint32Array(width * height);
      for (let row = 0; row < height; row++) {
        const rowOffset = row * Number(header.NAXIS1);
        const compressedLength = viewRows.getInt32(rowOffset, false), heapOffset = viewRows.getInt32(rowOffset + 4, false);
        const start = heapStart + heapOffset, end = start + compressedLength;
        if (compressedLength < 5 || start < dataOffset + tableLength || end > dataOffset + dataLength) throw new Error('A compressed FLAGS row is outside its FITS heap.');
        const decoded = decodeRice32(bytes.subarray(start, end), new Int32Array(width), 32);
        for (let x = 0; x < width; x++) flags[row * width + x] = decoded[x] >>> 0;
      }
    }
    if (count >= 2 && axes[0] > 1 && axes[1] > 1 && [-64, -32, 8, 16, 32, 64].includes(bitpix) && dataOffset + dataLength <= bytes.length) {
      if (header.EXTNAME === 'FLAGS' && bitpix === 32 && selected && axes[0] === selected.axes[0] && axes[1] === selected.axes[1]) {
        flags = new Uint32Array(axes[0] * axes[1]);
        for (let i = 0; i < flags.length; i++) flags[i] = view.getInt32(dataOffset + i * 4, false) >>> 0;
      } else if (!selected && header.EXTNAME !== 'FLAGS' && bitpix < 0) selected = { header, axes, bitpix, offset: dataOffset, count: axes[0] * axes[1] };
    }
    if (!dataLength) { if (dataOffset <= offset) break; offset = dataOffset; continue; }
    offset = dataOffset + Math.ceil(dataLength / 2880) * 2880;
  }
  if (!selected) throw new Error('No science image was found in the FITS cutout.');
  const { header, axes, bitpix, offset: dataOffset, count } = selected;
  const values = new Float32Array(count), scale = Number(header.BSCALE ?? 1), zero = Number(header.BZERO ?? 0), blank = header.BLANK;
  for (let i = 0; i < count; i++) {
    const p = dataOffset + i * (Math.abs(bitpix) / 8); let value;
    if (bitpix === -32) value = view.getFloat32(p, false);
    else if (bitpix === -64) value = view.getFloat64(p, false);
    else if (bitpix === 8) value = view.getUint8(p);
    else if (bitpix === 16) value = view.getInt16(p, false);
    else if (bitpix === 32) value = view.getInt32(p, false);
    else value = Number.NaN;
    values[i] = value === blank ? Number.NaN : value * scale + zero;
  }
  return { values, width: axes[0], height: axes[1], header, flags };
}

function matrixFor(header) {
  const firstAxis = String(header.CTYPE1 || '');
  const secondAxis = String(header.CTYPE2 || '');
  if (!/^RA---TAN(?:-SIP)?$/.test(firstAxis) || !/^DEC--TAN(?:-SIP)?$/.test(secondAxis)) throw new Error('This image uses an unsupported sky projection; its pixels cannot be aligned safely.');
  let a = Number(header.CD1_1), b = Number(header.CD1_2), c = Number(header.CD2_1), d = Number(header.CD2_2);
  if (![a, b, c, d].every(Number.isFinite)) {
    const sx = Number(header.CDELT1), sy = Number(header.CDELT2);
    const p11 = Number(header.PC1_1 ?? 1), p12 = Number(header.PC1_2 ?? 0), p21 = Number(header.PC2_1 ?? 0), p22 = Number(header.PC2_2 ?? 1);
    a = sx * p11; b = sx * p12; c = sy * p21; d = sy * p22;
  }
  const determinant = a * d - b * c;
  if (![a, b, c, d].every(Number.isFinite) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) throw new Error('The FITS image has no usable sky-coordinate grid.');
  return { a, b, c, d, determinant };
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function bilinear(image, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let sum = 0, weight = 0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const px = x0 + dx, py = y0 + dy;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), value = image.values[py * image.width + px];
    const index = py * image.width + px;
    const flagged = (settings.hideBadPixels && image.flags && (image.flags[index] & BAD_PIXEL_MASK) !== 0) || image.derivedTransientPixels?.has(index);
    if (Number.isFinite(value) && !flagged) { sum += w * value; weight += w; }
  }
  return weight > 0 ? sum / weight : Number.NaN;
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

function projectSkyToPixel(image, ra, dec) {
  const h = image.header, matrix = image.matrix;
  const deg = Math.PI / 180, ra0 = Number(h.CRVAL1) * deg, dec0 = Number(h.CRVAL2) * deg;
  const dra = ((ra * deg - ra0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const decRad = dec * deg, denom = Math.sin(dec0) * Math.sin(decRad) + Math.cos(dec0) * Math.cos(decRad) * Math.cos(dra);
  if (denom <= 0) return null;
  const xi = Math.cos(decRad) * Math.sin(dra) / denom / deg;
  const eta = (Math.cos(dec0) * Math.sin(decRad) - Math.sin(dec0) * Math.cos(decRad) * Math.cos(dra)) / denom / deg;
  const dx = (matrix.d * xi - matrix.b * eta) / matrix.determinant;
  const dy = (-matrix.c * xi + matrix.a * eta) / matrix.determinant;
  let x = dx, y = dy;
  const sip = (prefix, order, u, v) => {
    let value = 0;
    for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) value += Number(h[`${prefix}_${i}_${j}`] || 0) * u ** i * v ** j;
    return value;
  };
  if (String(h.CTYPE1).endsWith('-SIP')) {
    for (let i = 0; i < 3; i++) { x = dx - sip('A', Number(h.A_ORDER) || 0, x, y); y = dy - sip('B', Number(h.B_ORDER) || 0, x, y); }
  }
  return [Number(h.CRPIX1) - 1 + x, Number(h.CRPIX2) - 1 + y];
}

function paintCanvas(element, image) {
  const paintContext = element.getContext('2d', { alpha: false });
  const valid = [];
  for (let i = 0; i < image.values.length; i++) {
    const flagged = (settings.hideBadPixels && image.flags && (image.flags[i] & BAD_PIXEL_MASK) !== 0) || image.derivedTransientPixels?.has(i);
    if (Number.isFinite(image.values[i]) && !flagged) valid.push(image.values[i]);
  }
  if (!valid.length) throw new Error('No valid pixels remain after applying the quality mask.');
  // Estimate and remove each cutout's robust sky pedestal for display only.
  // The original science values remain intact for inspection and export.
  const sky = estimateBackground(valid).level;
  const residuals = valid.map(value => value - sky);
  const automaticScale = { low: percentile(residuals, .02), high: percentile(residuals, .995) };
  if (settings.consistentBrightness && !comparisonScale) comparisonScale = automaticScale;
  const { low, high } = settings.consistentBrightness ? comparisonScale : automaticScale;
  if (!(high > low)) throw new Error('The cutout has no usable image contrast.');
  const matrix = image.matrix || (image.matrix = matrixFor(image.header));
  const canvasWidth = Math.max(1, Math.round(settings.fovArcmin * 60 / PIXEL_ARCSEC));
  const canvasHeight = canvasWidth;
  element.width = canvasWidth; element.height = canvasHeight;
  const pixels = paintContext.createImageData(canvasWidth, canvasHeight), deg = Math.PI / 180;
  const projectedValues = new Float32Array(canvasWidth * canvasHeight);
  projectedValues.fill(Number.NaN);
  const qualityBits = new Uint32Array(canvasWidth * canvasHeight);
  let coveredPixels = 0;
  const square = canvasWidth, left = 0, top = 0;
  const scaleDeg = PIXEL_ARCSEC / 3600;
  const ra0 = target.raDeg * deg, dec0 = target.decDeg * deg;
  for (let y = 0; y < canvasHeight; y++) for (let x = 0; x < canvasWidth; x++) {
    // One shared north-up, east-left tangent-plane grid for every observation.
    const xi = (square - 1) / 2 - (x - left), northPixels = (square - 1) / 2 - (y - top);
    const xiRad = xi * scaleDeg * deg, eta = northPixels * scaleDeg * deg;
    const denom = Math.cos(dec0) - eta * Math.sin(dec0);
    const ra = ra0 + Math.atan2(xiRad, denom), dec = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(denom, xiRad));
    const point = projectSkyToPixel({ ...image, matrix }, ra / deg, dec / deg);
    let value = Number.NaN;
    if (point) {
      if (point[0] >= 0 && point[1] >= 0 && point[0] < image.width && point[1] < image.height) coveredPixels++;
      value = bilinear(image, point[0], point[1]);
      if (Number.isFinite(value)) value -= sky;
    }
    const at = (y * canvasWidth + x) * 4;
    const gridIndex = y * canvasWidth + x;
    if (Number.isFinite(value)) projectedValues[gridIndex] = value;
    qualityBits[gridIndex] = flag >>> 0;
    let rgb = Number.isFinite(value) ? colorize(value, low, high) : [15, 12, 22];
    let flag = 0, pixelValue = Number.NaN, inBounds = false;
    if (point) {
      const px = Math.round(point[0]), py = Math.round(point[1]);
      if (px >= 0 && py >= 0 && px < image.width && py < image.height) {
        inBounds = true;
        const index = py * image.width + px;
        if (image.flags) flag = image.flags[index] >>> 0;
        pixelValue = image.values[index];
      }
    }
    const derivedTransient = inBounds && image.derivedTransientPixels?.has(Math.round(point[1]) * image.width + Math.round(point[0]));
    if (derivedTransient) rgb = hexRgb(FLAG_CATEGORIES.transient.colour);
    else if (settings.qualityOverlay) {
      if (!inBounds) rgb = hexRgb(FLAG_CATEGORIES.uncovered.colour);
      else if ((flag & (1 << 9)) || !Number.isFinite(pixelValue)) rgb = hexRgb(FLAG_CATEGORIES.missing.colour);
      else if (flag) {
        const priority = ['transient', 'detector', 'correction', 'artifact', 'caution'];
        const category = priority.find(name => QUALITY_FLAGS.some(item => item.category === name && (flag & (2 ** item.bit)) !== 0));
        rgb = hexRgb(FLAG_CATEGORIES[category || 'caution'].colour);
      }
    }
    pixels.data[at] = rgb[0]; pixels.data[at + 1] = rgb[1]; pixels.data[at + 2] = rgb[2]; pixels.data[at + 3] = 255;
  }
  paintContext.putImageData(pixels, 0, 0);
  element.spherexGrid = { values: projectedValues, flags: qualityBits };
  return coveredPixels / (canvasWidth * canvasHeight);
}

function paintStackCanvas(element, entries, observations) {
  if (!entries.length) throw new Error('No daily exposures were retrieved for this frame.');
  const grid = medianStack(entries.map(entry => entry.canvas.spherexGrid.values));
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
    if (settings.invert && Number.isFinite(grid.values[i])) rgb = [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]];
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

function drawImage(image) {
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
    centerRaDeg: target.raDeg, centerDecDeg: target.decDeg
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
    x, y, size, centerRaDeg: target.raDeg, centerDecDeg: target.decDeg
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
  const sky = canvasToSky({ x, y, size, centerRaDeg: target.raDeg, centerDecDeg: target.decDeg });
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
  const x = Math.round(point[0]), y = Math.round(point[1]), index = y * image.width + x;
  const value = image.values[index], flags = image.flags?.[index] >>> 0;
  const names = image.flags ? [...FLAGS_BY_BIT.values()].filter(flag => (flags & (2 ** flag.bit)) !== 0).map(flag => flag.name) : [];
  if (image.derivedTransientPixels?.has(index)) return `Possible one-exposure transient rejected · FITS pixel ${x + 1}, ${y + 1}`;
  if ((flags & (1 << 9)) || !Number.isFinite(value)) return `Missing pixel data · FITS pixel ${x + 1}, ${y + 1} · not a fading measurement`;
  if (names.length) return `${names.join(' + ')} · FITS pixel ${x + 1}, ${y + 1} · ${Number.isFinite(value) ? value.toPrecision(4) : 'no value'} ${image.header.BUNIT || ''}`;
  return `${image.flags ? 'Valid' : 'Quality flags unavailable'} pixel ${x + 1}, ${y + 1} · ${value.toPrecision(4)} ${image.header.BUNIT || ''}`;
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
  inspectPixel(activeObservation.image, canvasToSky({ ...inspectionCanvasPoint, size, centerRaDeg: target.raDeg, centerDecDeg: target.decDeg }));
});

async function inspectPixel(image, sky) {
  if (!sky) return;
  const sequence = ++pixelInspectionSequence;
  const point = projectSkyToPixel(image, sky.raDeg, sky.decDeg);
  const position = `RA ${sky.raDeg.toFixed(6)}°, Dec ${sky.decDeg >= 0 ? '+' : ''}${sky.decDeg.toFixed(6)}°`;
  const covered = Boolean(point && point[0] >= 0 && point[1] >= 0 && point[0] < image.width && point[1] < image.height);
  const x = covered ? Math.round(point[0]) : -1, y = covered ? Math.round(point[1]) : -1;
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
    pixelInspectorResult.textContent = `Assessing FITS pixel ${covered ? `${x + 1}, ${y + 1}` : 'outside the detector'}…`;
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
      const sourceUrl = entry.url;
      for (const key of renderedFrames.keys()) if (key.startsWith(sourceUrl + '|')) renderedFrames.delete(key);
    }
    if (assessment.glitchIndices?.length && activeObservation?.image) drawImage(activeObservation.image);
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
    pixelInspectorResult.textContent = `${state} ${measurement} · ${covered ? `FITS pixel ${x + 1}, ${y + 1} · ` : ''}${flagText}${stackContext}${contribution} · ${position}`;
  } catch (error) {
    if (sequence !== pixelInspectionSequence) return;
    pixelInspectorResult.textContent = `Could not assess this pixel: ${error.message} · ${position}`;
  }
}

async function warmSelectedExposureGroup(sequence) {
  if (!settings.rejectVisitGlitches) return;
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
  let currentIndex = -1;
  for (const [url, image] of decodedFrames) {
    let params;
    try { params = new URL(url, location.origin).searchParams; } catch { continue; }
    if (Number(params.get('raDeg')) !== target.raDeg || Number(params.get('decDeg')) !== target.decDeg || Number(params.get('fovArcmin')) !== settings.fovArcmin || Number(image.header.DETECTOR) !== Number(settings.band)) continue;
    const point = projectSkyToPixel(image, sky.raDeg, sky.decDeg);
    const covered = Boolean(point && point[0] >= 0 && point[1] >= 0 && point[0] < image.width && point[1] < image.height);
    const x = covered ? Math.round(point[0]) : -1, y = covered ? Math.round(point[1]) : -1;
    const pixel = covered ? y * image.width + x : -1;
    const value = covered ? image.values[pixel] : null;
    const local = covered && Number.isFinite(value) ? localSignalAndNoise(image, x, y) : { signal: null, noise: null };
    if (image === activeImage || activeImage.stackSourceImages?.includes(image)) {
      if (currentIndex < 0) currentIndex = items.length;
    }
    items.push({ covered, value: Number.isFinite(value) ? value : null, flags: covered && image.flags ? image.flags[pixel] >>> 0 : 0, flagsAvailable: Boolean(image.flags), visitId: String(image.header.OBSID || ''), observationId: String(image.header.OBSID || ''), ...local });
    entries.push({ image, pixel, url });
  }
  if (currentIndex < 0) {
    const sourceImage = activeImage.stackSourceImages?.[0] || activeImage;
    const point = projectSkyToPixel(sourceImage, sky.raDeg, sky.decDeg);
    const covered = Boolean(point && point[0] >= 0 && point[1] >= 0 && point[0] < sourceImage.width && point[1] < sourceImage.height);
    const x = covered ? Math.round(point[0]) : -1, y = covered ? Math.round(point[1]) : -1, pixel = covered ? y * sourceImage.width + x : -1;
    const value = covered ? sourceImage.values[pixel] : null;
    const local = covered && Number.isFinite(value) ? localSignalAndNoise(sourceImage, x, y) : { signal: null, noise: null };
    currentIndex = items.length;
    items.push({ covered, value: Number.isFinite(value) ? value : null, flags: covered && sourceImage.flags ? sourceImage.flags[pixel] >>> 0 : 0, flagsAvailable: Boolean(sourceImage.flags), visitId: String(sourceImage.header.OBSID || ''), observationId: String(sourceImage.header.OBSID || ''), ...local });
    entries.push({ image: sourceImage, pixel, url: activeImage.stackSourceUrls?.[0] || (activeObservation ? cutoutRequestUrl(activeObservation) : '') });
  }
  return { items, entries, currentIndex };
}

window.addEventListener('sky:clear-source-mark', () => setMarkedSource(null));

// The exact proxy URL for a frame at the current target and field of view. The
// time-lapse preloader uses the same URL so its cached download is reused.
export function cutoutRequestUrl(observation) {
  const params = new URLSearchParams({
    url: observation.accessUrl,
    raDeg: target.raDeg,
    decDeg: target.decDeg,
    fovArcmin: settings.fovArcmin,
    revision: observation.productModifiedAt || observation.metadataModifiedAt || ''
  });
  return '/api/cutout?' + params.toString();
}

// A frame rendered for the current target and display settings. Two frames from
// the same product at different stretches are kept separately, while the decoded
// pixels are shared by URL.
function displaySignature() {
  return [
    target.raDeg, target.decDeg, settings.fovArcmin, settings.consistentBrightness ? 1 : 0,
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
  if (map.size > MAX_CACHED_FRAMES) map.delete(map.keys().next().value);
}

// Download, decode and render one frame off-screen. This is what warm-up does:
// by the time a frame is shown, there is no network request, FITS parse or
// reprojection left to do — only a canvas blit.
async function warmSingleCutout(observation, signal) {
  const url = cutoutRequestUrl(observation);
  const key = url + '|' + displaySignature();
  const rendered = renderedFrames.get(key);
  if (rendered) return rendered;
  let image = decodedFrames.get(url);
  if (!image) {
    const bytes = await loadCutout(url, { signal, priority: false });
    if (signal?.aborted) throw new DOMException('The cutout request was cancelled.', 'AbortError');
    image = readFits(bytes); image.matrix = matrixFor(image.header);
    remember(decodedFrames, url, image);
  }
  const element = document.createElement('canvas');
  const coverage = paintCanvas(element, image);
  const entry = { canvas: element, image, coverage };
  remember(renderedFrames, key, entry);
  window.dispatchEvent(new CustomEvent('sky:cutout-warmed', { detail: { observation, canvas: element } }));
  return entry;
}

function stackedImage(values, counts, reference, record, sourceImages, sourceUrls) {
  const width = Math.max(1, Math.round(settings.fovArcmin * 60 / PIXEL_ARCSEC));
  const scale = PIXEL_ARCSEC / 3600;
  const header = {
    ...reference.header, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN',
    CRVAL1: target.raDeg, CRVAL2: target.decDeg,
    CRPIX1: (width + 1) / 2, CRPIX2: (width + 1) / 2,
    CD1_1: -scale, CD1_2: 0, CD2_1: 0, CD2_2: -scale,
    CDELT1: -scale, CDELT2: -scale, A_ORDER: 0, B_ORDER: 0
  };
  const image = { values, width, height: width, header, flags: null, stackRecord: record, stackContributionCounts: counts, stackSourceImages: sourceImages, stackSourceUrls: sourceUrls, matrix: null };
  image.matrix = matrixFor(header);
  return image;
}

export async function warmCutout(observation, signal) {
  const key = renderKey(observation);
  const rendered = renderedFrames.get(key);
  if (rendered) return rendered;
  const exposures = (observation.exposures || [observation]).filter(item => item?.accessUrl);
  if (exposures.length <= 1) {
    const entry = await warmSingleCutout(exposures[0] || observation, signal);
    remember(renderedFrames, key, entry);
    return entry;
  }
  const entries = [], sourceImages = [], sourceUrls = [];
  for (const exposure of exposures) {
    signal?.throwIfAborted();
    try {
      const entry = await warmSingleCutout(exposure, signal);
      entries.push({ ...entry, observation: exposure });
      sourceImages.push(entry.image);
      sourceUrls.push(cutoutRequestUrl(exposure));
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
    }
  }
  const element = document.createElement('canvas');
  const stacked = paintStackCanvas(element, entries, exposures);
  const image = stackedImage(stacked.values, stacked.counts, sourceImages[0], stacked.record, sourceImages, sourceUrls);
  const entry = { canvas: element, image, coverage: stacked.coverage, stackRecord: stacked.record };
  remember(renderedFrames, renderKey(observation), entry);
  window.dispatchEvent(new CustomEvent('sky:cutout-warmed', { detail: { observation, canvas: element, stackRecord: stacked.record } }));
  return entry;
}

async function showDeepStack() {
  if (!timelineFrames.length) { cards('Search for observations before building a deep stack.'); return; }
  const frames = timelineFrames.slice(0, Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80)));
  activeSequence++;
  const sequence = activeSequence;
  cutoutController?.abort();
  cutoutController = new AbortController();
  const controller = cutoutController;
  status.hidden = false; status.classList.remove('is-error');
  cards(`Building a median stack from up to ${frames.length} UTC-day frames…`);
  const loaded = [], failedFrames = [];
  try {
    for (let index = 0; index < frames.length; index++) {
      controller.signal.throwIfAborted();
      if (sequence !== activeSequence) return;
      cards(`Stacking frame ${index + 1} of ${frames.length} · ${frames[index].observedStartUtc?.slice(0, 10) || 'date not reported'}…`);
      try { loaded.push({ frame: frames[index], entry: await warmCutout(frames[index], controller.signal) }); }
      catch (error) { if (error?.name === 'AbortError') throw error; failedFrames.push(frames[index]); }
    }
    if (!loaded.length) throw new Error('No timeline frames could be loaded for the deep stack.');
    if (sequence !== activeSequence) return;
    const element = document.createElement('canvas');
    const frameEntries = loaded.map(item => ({ ...item.entry, observation: item.frame }));
    const stacked = paintStackCanvas(element, frameEntries, loaded.map(item => item.frame));
    const allExposures = frames.flatMap(frame => frame.exposures || [frame]);
    const contributorRecords = loaded.flatMap(({ frame, entry }) => entry.stackRecord?.contributors || (frame.exposures || [frame]).map(item => ({
      observationId: item.observationId || '', productId: item.productId || '', release: item.release || item.collection || '',
      processingVersion: item.processingVersion || '', observedStartUtc: item.observedStartUtc || '', exposureSeconds: Number(item.exposureSeconds) || 0,
      validOutputPixels: entry.canvas.spherexGrid.values.reduce((count, value) => count + Number.isFinite(value), 0)
    })));
    const nestedFailed = loaded.flatMap(({ entry }) => entry.stackRecord?.failedObservationIds || []);
    const record = {
      ...stacked.record, deepStack: true,
      method: 'per-pixel median of separately aligned UTC-day median stacks; unreliable input pixels are excluded',
      availableFrameCount: timelineFrames.length, requestedFrameCount: frames.length, usedFrameCount: loaded.length,
      excludedByFrameLimit: Math.max(0, timelineFrames.length - frames.length),
      requestedExposureCount: allExposures.length, usedExposureCount: contributorRecords.length,
      failedObservationIds: [...failedFrames.flatMap(frame => (frame.exposures || [frame]).map(item => item.observationId)), ...nestedFailed],
      contributors: contributorRecords,
      observationIds: contributorRecords.map(item => item.observationId).filter(Boolean),
      productIds: contributorRecords.map(item => item.productId).filter(Boolean),
      exposureSeconds: contributorRecords.reduce((sum, item) => sum + (Number(item.exposureSeconds) || 0), 0)
    };
    const sourceImages = loaded.flatMap(({ entry }) => entry.image.stackSourceImages || [entry.image]);
    const sourceUrls = loaded.flatMap(({ entry }) => entry.image.stackSourceUrls || []);
    const image = stackedImage(stacked.values, stacked.counts, loaded[0].entry.image, record, sourceImages, sourceUrls);
    image.deepStackSignature = deepStackSignature();
    const firstFrame = frames[0], lastFrame = frames.at(-1);
    const observation = { ...firstFrame, observedEndUtc: lastFrame.observedEndUtc || lastFrame.observedStartUtc, exposures: allExposures, stackLabel: 'Deep median stack' };
    activeObservation = { ...observation, image };
    activeFrameExposures = allExposures;
    const entry = { canvas: element, image, coverage: stacked.coverage, stackRecord: record };
    commitCutout(observation, entry, { announce: false });
    caption.textContent = `Deep median stack · ${record.usedFrameCount}/${record.availableFrameCount} UTC-day frames · ${record.usedExposureCount} exposures · ${Math.round(record.exposureSeconds)} s total · D${observation.detector} · ${formatWavelength(observation)} · north up`;
    window.dispatchEvent(new CustomEvent('sky:deep-stack-built', { detail: { record } }));
  } catch (error) {
    if (sequence === activeSequence && !controller.signal.aborted) {
      resetViewer(error.message); status.classList.add('is-error');
      document.getElementById('cutout-cache-state').textContent = 'Deep stack unavailable';
    }
  }
}

function deepStackSignature() {
  const frames = timelineFrames.slice(0, Math.max(4, Math.min(400, Number(settings.maxStackFrames) || 80)));
  return `${displaySignature()}|${settings.band}|${frames.map(observationKey).join(',')}`;
}

function commitCutout(observation, entry, { announce = true } = {}) {
  const source = entry.canvas;
  if (canvas.width !== source.width || canvas.height !== source.height) { canvas.width = source.width; canvas.height = source.height; }
  context.drawImage(source, 0, 0);
  applyChrome(entry.coverage);
  positionMark();
  const image = entry.image;
  canvas.dataset.deepStack = String(Boolean(image.stackRecord?.deepStack));
  const date = observation.observedStartUtc ? new Date(observation.observedStartUtc).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Date not reported';
  const masked = image.flags && settings.hideBadPixels ? Array.from(image.flags).filter(value => (value & BAD_PIXEL_MASK) !== 0).length : 0;
  const release = observation.release || observation.collection || 'Release not reported';
  const processing = observation.processingVersion ? ` · ${observation.processingVersion}` : '';
  const stackLabel = image.stackRecord ? ` · median stack ${image.stackRecord.usedExposureCount}/${image.stackRecord.requestedExposureCount} exposures · ${Math.round(image.stackRecord.exposureSeconds)} s total` : '';
  caption.textContent = `${date} · D${observation.detector} · ${formatWavelength(observation)} · ${release}${processing}${stackLabel} · ${settings.fovArcmin}′ square · north up${masked ? ` · ${masked} flagged pixels masked` : ''}`;
  status.hidden = true;
  document.getElementById('export-sky-png').disabled = false;
  document.getElementById('cutout-cache-state').textContent = 'Retrieved from IRSA · browser caching enabled';
  window.dispatchEvent(new CustomEvent('sky:cutout-rendered', { detail: { observation, stackRecord: image.stackRecord || null } }));
  // Playback frames are not shared state: only a frame the user opened updates
  // the address bar. Click the sky image to mark a candidate source.
  if (announce) window.dispatchEvent(new CustomEvent('sky:frame-shown', { detail: { observation } }));
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
      entry = await warmCutout(observation, requestController.signal);
      if (sequence !== activeSequence) return;
    }
    if (sequence !== activeSequence) return;
    activeObservation.image = entry.image;
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
