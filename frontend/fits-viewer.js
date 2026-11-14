const canvas = document.getElementById('sky-canvas');
const context = canvas.getContext('2d', { alpha: false });
const status = document.getElementById('cutout-status');
const caption = document.getElementById('cutout-caption');
let target = { raDeg: 269.4521, decDeg: 4.6934 }, settings = { fovArcmin: 16, stretch: 'asinh', colours: 'grayscale', contrast: 65, invert: false };
let activeObservation = null, activeSequence = 0, cutoutController = null;
const PIXEL_ARCSEC = 6.15;
// Mask unusable samples, but keep overflow/nonlinear source cores so bright stars do not get artificial holes.
const BAD_PIXEL_MASK = [0, 2, 6, 7, 9, 10, 11, 14, 17, 19].reduce((mask, bit) => mask | (1 << bit), 0) >>> 0;

const cards = text => { status.textContent = text; };
window.addEventListener('sky:target-selected', event => { target = { ...event.detail }; activeObservation = null; activeSequence++; cutoutController?.abort(); resetViewer('This target is selected. Scroll down past the timeline and settings to Find your observations. Open Details + on a result, then choose View aligned cutout.'); });
window.addEventListener('sky:viewer-settings-changed', event => {
  const previousFov = settings.fovArcmin;
  settings = { ...settings, ...event.detail };
  if (activeObservation?.image && activeObservation.detector !== settings.band) {
    status.hidden = false; status.classList.remove('is-error');
    cards(`The loaded image is D${activeObservation.detector}. Choose a D${settings.band} observation in the archive results to view this wavelength band.`);
  } else if (settings.fovArcmin !== previousFov && activeObservation) {
    // A new FOV needs a new archive cutout; clear the old image and label the requested size immediately.
    showCutout(activeObservation);
  } else if (activeObservation?.image) { status.hidden = true; drawImage(activeObservation.image); }
});

function resetViewer(message) {
  document.querySelector('.viewer')?.classList.remove('has-image');
  document.getElementById('coverage-note').hidden = true;
  context.fillStyle = '#08090e'; context.fillRect(0, 0, canvas.width, canvas.height);
  document.getElementById('target-marker').hidden = true;
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
    const dataLength = elements * bytesPerPixel;
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
    const flagged = settings.hideBadPixels && image.flags && (image.flags[py * image.width + px] & BAD_PIXEL_MASK) !== 0;
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

function drawImage(image) {
  const valid = [];
  for (let i = 0; i < image.values.length; i++) {
    const flagged = settings.hideBadPixels && image.flags && (image.flags[i] & BAD_PIXEL_MASK) !== 0;
    if (Number.isFinite(image.values[i]) && !flagged) valid.push(image.values[i]);
  }
  if (!valid.length) throw new Error('No valid pixels remain after applying the quality mask.');
  // Remove the image-wide sky pedestal for display only; preserve archive pixel values.
  const sky = percentile(valid, .5);
  const residuals = valid.map(value => value - sky);
  const low = percentile(residuals, .02), high = percentile(residuals, .995);
  if (!(high > low)) throw new Error('The cutout has no usable image contrast.');
  const matrix = image.matrix || (image.matrix = matrixFor(image.header));
  const canvasWidth = Math.max(1, Math.round(settings.fovArcmin * 60 / PIXEL_ARCSEC));
  const canvasHeight = canvasWidth;
  canvas.width = canvasWidth; canvas.height = canvasHeight;
  const pixels = context.createImageData(canvasWidth, canvasHeight), deg = Math.PI / 180;
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
      value = bilinear(image, point[0], point[1]);
      if (Number.isFinite(value)) value -= sky;
    }
    const at = (y * canvasWidth + x) * 4;
    if (Number.isFinite(value)) { coveredPixels++; const rgb = colorize(value, low, high); pixels.data[at] = rgb[0]; pixels.data[at + 1] = rgb[1]; pixels.data[at + 2] = rgb[2]; pixels.data[at + 3] = 255; }
    else { pixels.data[at] = 15; pixels.data[at + 1] = 12; pixels.data[at + 2] = 22; pixels.data[at + 3] = 255; }
  }
  context.putImageData(pixels, 0, 0);
  document.querySelector('.viewer')?.classList.add('has-image');
  const coverage = coveredPixels / (canvasWidth * canvasHeight);
  const coverageNote = document.getElementById('coverage-note');
  coverageNote.hidden = coverage >= 0.98;
  coverageNote.textContent = coverageNote.hidden ? '' : `Partial coverage · ${Math.round(coverage * 100)}%`;
  coverageNote.title = 'The remaining area falls outside this exposure’s detector footprint and has no image data.';
  document.getElementById('target-marker').hidden = !settings.showTargetMarker;
  return coverage;
}

export async function showCutout(observation, { quiet = false } = {}) {
  activeObservation = observation;
  const sequence = ++activeSequence;
  cutoutController?.abort();
  cutoutController = new AbortController();
  const requestController = cutoutController;
  const cacheState = document.getElementById('cutout-cache-state');
  if (!quiet) { resetViewer(`Loading ${settings.fovArcmin}′ × ${settings.fovArcmin}′ cutout · ${observation.observedStartUtc?.slice(0, 10) || 'observation'} · D${observation.detector}…`); }
  const params = new URLSearchParams({ url: observation.accessUrl, raDeg: target.raDeg, decDeg: target.decDeg, fovArcmin: settings.fovArcmin, revision: observation.productModifiedAt || observation.metadataModifiedAt || '' });
  try {
    const response = await fetch('/api/cutout?' + params, { signal: requestController.signal });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'The cutout could not be retrieved.'); }
    let bytes;
    try { bytes = await response.arrayBuffer(); }
    catch { throw new Error('The cutout download was interrupted or exceeded the 24 MiB limit. Try again or choose a smaller field of view.'); }
    const image = readFits(bytes); image.matrix = matrixFor(image.header);
    if (sequence !== activeSequence) return;
    activeObservation.image = image; const coverage = drawImage(image);
    window.dispatchEvent(new CustomEvent('sky:cutout-detector-selected', { detail: { detector: observation.detector } }));
    const date = observation.observedStartUtc ? new Date(observation.observedStartUtc).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Date not reported';
    const masked = image.flags && settings.hideBadPixels ? Array.from(image.flags).filter(value => (value & BAD_PIXEL_MASK) !== 0).length : 0;
    caption.textContent = `${date} · D${observation.detector} · ${formatWavelength(observation)} · ${settings.fovArcmin}′ square · north up${masked ? ` · ${masked} flagged pixels masked` : ''}`;
    status.hidden = true;
    cacheState.textContent = 'Retrieved from IRSA · browser caching enabled';
    document.getElementById('target-marker').hidden = !settings.showTargetMarker;
    window.dispatchEvent(new CustomEvent('sky:cutout-rendered', { detail: { observation } }));
  } catch (error) {
    if (sequence === activeSequence && !requestController.signal.aborted) {
      resetViewer(error.message); status.classList.add('is-error'); cacheState.textContent = 'Cutout unavailable';
      window.dispatchEvent(new CustomEvent('sky:cutout-error', { detail: { observation, error } }));
    }
  }
}

function formatWavelength(observation) {
  const low = Number(observation.wavelengthMinUm), high = Number(observation.wavelengthMaxUm);
  return Number.isFinite(low) && Number.isFinite(high) ? `${low.toFixed(2)}–${high.toFixed(2)} μm` : `D${observation.detector}`;
}

export function observeCutout(observation) { void showCutout(observation); }
resetViewer('Scroll down past the timeline and settings to Find your observations. Choose Details + on a result, then View aligned cutout.');
