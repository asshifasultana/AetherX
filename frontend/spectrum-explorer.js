import { createWavelengthReader } from './lib/wavelength.js';
import { measureAt } from './lib/photometry.js';
import { observeCutout } from './fits-viewer.js';
import { exposureCenter } from './presets.js';
import { binSpectrum, binsToCsv } from './lib/spectrum-bins.js';
import { DETECTOR_BANDS, SPECTRAL_FEATURES } from './lib/detectors.js';

const $ = id => document.getElementById(id);
const svg = $('spectrum-chart'), status = $('spectrum-status');
const NS = 'http://www.w3.org/2000/svg';
const wavelengthAt = createWavelengthReader();
let observations = [], position = null, targetName = 'selected target', samples = [], bins = [], controller = null;
const el = (tag, attrs = {}, parent = svg) => {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  parent.append(node); return node;
};
// SVG elements have no \`hidden\` property, so the attribute is set directly.
const showChart = visible => svg.toggleAttribute('hidden', !visible);
const finite = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));

window.addEventListener('sky:target-selected', event => {
  position = event.detail; targetName = $('object-name')?.textContent || 'selected target';
  controller?.abort(); samples = []; bins = []; svg.replaceChildren(); showChart(false); $('build-spectrum').disabled = true;
  status.textContent = 'Select “Measure loaded images” to build a quick-look spectrum for this position.';
});
window.addEventListener('sky:observations-loading', () => {
  controller?.abort(); observations = []; samples = []; bins = []; svg.replaceChildren(); showChart(false);
  $('build-spectrum').disabled = true; $('wavelength-jump').disabled = true; $('jump-wavelength').disabled = true;
  status.textContent = 'Searching for images at the selected sky position…';
});
function acceptObservationState(detail) {
  if (detail.failed) { observations = []; $('build-spectrum').disabled = true; status.textContent = 'No search results available to measure.'; return; }
  controller?.abort();
  observations = (detail.observations || []).filter(item => item.accessUrl);
  if (detail.position) position = detail.position;
  targetName = detail.targetName || targetName;
  samples = []; bins = []; svg.replaceChildren(); showChart(false);
  status.textContent = observations.length
    ? `${observations.length} loaded images available for ${targetName}. Measure them to see the wavelength samples.`
    : 'No loaded images available to measure.';
  $('build-spectrum').disabled = !observations.length;
  $('wavelength-jump').disabled = true; $('jump-wavelength').disabled = true;
}
window.addEventListener('sky:observations-loaded', event => acceptObservationState(event.detail));
// Searches can finish before this module evaluates on slower connections.
// Keep the latest observation payload available so the button state is replayed.
if (window.spherexObservationState) acceptObservationState(window.spherexObservationState);
$('spectrum-view').addEventListener('change', () => renderChart());
$('spectrum-raw')?.addEventListener('change', () => renderChart());
$('export-spectrum-csv')?.addEventListener('click', () => {
  if (!bins.length) return;
  const url = URL.createObjectURL(new Blob([binsToCsv(bins, { target: targetName })], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `spherex-channel-spectrum-${targetName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'target'}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('cancel-spectrum').addEventListener('click', () => controller?.abort());
$('wavelength-jump').addEventListener('input', () => { $('jump-wavelength').disabled = !samples.length || !finite($('wavelength-jump').value); });
$('jump-wavelength').addEventListener('click', () => {
  const wanted = Number($('wavelength-jump').value);
  if (!Number.isFinite(wanted) || !samples.length) return;
  const sample = samples.reduce((best, current) => Math.abs(current.wavelengthUm - wanted) < Math.abs(best.wavelengthUm - wanted) ? current : best);
  observeCutout(sample.observation); $('explorer').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('build-spectrum').addEventListener('click', () => { void buildSpectrum(); });

function measure(observation, signal) {
  return measureAt(observation, exposureCenter(position, observation), signal, { wavelengthAt });
}

async function buildSpectrum() {
  if (!position || !observations.length || controller) return;
  const button = $('build-spectrum'), cancel = $('cancel-spectrum');
  controller = new AbortController(); button.disabled = true; cancel.hidden = false;
  samples = []; bins = []; svg.replaceChildren(); showChart(false);
  let finished = 0, failed = 0, next = 0;
  status.textContent = `Measuring ${observations.length} archive images. This may take a while…`;
  const workers = Array.from({ length: Math.min(3, observations.length) }, async () => {
    while (next < observations.length && !controller.signal.aborted) {
      const index = next++;
      try { samples.push(await measure(observations[index], controller.signal)); }
      catch (error) { if (controller.signal.aborted) return; failed++; }
      finished++;
      status.textContent = `Measured ${finished}/${observations.length} images · ${samples.length} valid points · ${failed} skipped${saturationNote()}.`;
      renderChart();
    }
  });
  const active = controller;
  try { await Promise.all(workers); }
  finally {
    if (controller === active) controller = null;
    cancel.hidden = true; button.disabled = false;
    if (active.signal.aborted) status.textContent = `Cancelled · kept ${samples.length} valid measurements.`;
    else if (samples.length) status.textContent = `Quick-look spectrum for ${targetName}: ${samples.length} valid samples in ${bins.filter(bin => bin.n).length} of 102 channels from ${observations.length} loaded images; ${failed} skipped${saturationNote()}.`;
    else status.textContent = 'No usable measurements. Try a different target or load more archive images.';
    renderChart();
  }
}

function saturationNote() {
  const count = samples.filter(sample => sample.likelySaturated).length;
  return count ? ` · ${count} point${count === 1 ? '' : 's'} flagged as likely saturated and left out of the channel medians` : '';
}

const describe = sample => `${sample.wavelengthUm.toFixed(4)} μm · ${sample.fluxMicroJy.toFixed(2)} ± ${sample.errorMicroJy.toFixed(2)} μJy · D${sample.detector} · ${sample.observation.observedStartUtc || 'date not reported'}`;

function openSample(sample) {
  observeCutout(sample.observation);
  $('explorer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// One measured exposure. Raw points are a faint layer under the channel
// medians; a likely-saturated point is drawn hollow so a dip it causes is not
// read as a real absorption feature.
function drawRawPoint(sample, xv, yv, y, { faint }) {
  const saturated = Boolean(sample.likelySaturated);
  const g = el('g', {
    class: `spectrum-point-group spectrum-raw${faint ? ' is-faint' : ''}${saturated ? ' is-saturated' : ''}`, tabindex: '0', role: 'button',
    'aria-label': `${saturated ? 'Likely saturated: ' : ''}${sample.wavelengthUm.toFixed(3)} micrometers, ${sample.fluxMicroJy.toPrecision(3)} microjanskys, detector ${sample.detector}, ${sample.observation.observedStartUtc || 'date not reported'}`
  });
  g.style.setProperty('--detector-colour', `var(--d${sample.detector})`);
  if (!faint && Number.isFinite(sample.errorMicroJy)) el('line', { x1: xv, x2: xv, y1: y(sample.fluxMicroJy - sample.errorMicroJy), y2: y(sample.fluxMicroJy + sample.errorMicroJy), class: 'spectrum-error' }, g);
  el('circle', { cx: xv, cy: yv, r: saturated ? 3.4 : faint ? 2.2 : 3.3, class: 'spectrum-point' }, g);
  const title = el('title', {}, g);
  title.textContent = `${saturated ? '⚠ Likely saturated (near-saturation, nonlinear or bloom-masked pixels in the aperture); left out of the channel median · ' : ''}${describe(sample)} · click to open image`;
  g.addEventListener('click', () => openSample(sample));
  g.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); g.click(); } });
}

function drawBin(bin, x, y) {
  if (!Number.isFinite(bin.fluxMicroJy)) return;
  const xv = x(bin.wavelengthUm), yv = y(bin.fluxMicroJy);
  const g = el('g', { class: 'spectrum-bin', role: 'img', 'aria-label': `Detector ${bin.detector} channel ${bin.channel + 1}: ${bin.wavelengthUm.toFixed(3)} micrometers, median ${bin.fluxMicroJy.toPrecision(3)} microjanskys from ${bin.n} exposures` });
  g.style.setProperty('--detector-colour', `var(--d${bin.detector})`);
  if (Number.isFinite(bin.errorMicroJy)) {
    const low = y(bin.fluxMicroJy - bin.errorMicroJy), high = y(bin.fluxMicroJy + bin.errorMicroJy);
    el('line', { x1: xv, x2: xv, y1: low, y2: high, class: 'spectrum-bin-error' }, g);
    el('line', { x1: xv - 3.5, x2: xv + 3.5, y1: low, y2: low, class: 'spectrum-bin-error' }, g);
    el('line', { x1: xv - 3.5, x2: xv + 3.5, y1: high, y2: high, class: 'spectrum-bin-error' }, g);
  }
  el('rect', { x: xv - 3.6, y: yv - 3.6, width: 7.2, height: 7.2, rx: 1.5, class: 'spectrum-bin-mark' }, g);
  const title = el('title', {}, g);
  title.textContent = `D${bin.detector} channel ${bin.channel + 1} · ${bin.wavelengthUm.toFixed(3)} μm · median ${bin.fluxMicroJy.toFixed(2)} ± ${Number.isFinite(bin.errorMicroJy) ? bin.errorMicroJy.toFixed(2) : '?'} μJy from ${bin.n} exposure${bin.n === 1 ? '' : 's'}${bin.saturatedCount ? ` (${bin.saturatedCount} likely saturated left out)` : ''}`;
}

function renderLegend() {
  const legend = $('spectrum-legend');
  if (!legend) return;
  legend.replaceChildren();
  legend.hidden = !samples.length;
  for (let detector = 1; detector <= 6; detector++) {
    const chip = document.createElement('span');
    chip.className = 'spectrum-legend-chip';
    chip.style.setProperty('--detector-colour', `var(--d${detector})`);
    chip.textContent = `D${detector}`;
    legend.append(chip);
  }
  const key = (className, text) => { const item = document.createElement('span'); item.className = className; item.textContent = text; legend.append(item); };
  key('spectrum-legend-bin', 'channel median ± error');
  key('spectrum-legend-raw', 'single exposure');
  if (samples.some(sample => sample.likelySaturated)) key('spectrum-legend-saturated', 'likely saturated (left out)');
}

function renderChart() {
  svg.replaceChildren();
  showChart(samples.length > 0);
  bins = binSpectrum(samples);
  if ($('export-spectrum-csv')) $('export-spectrum-csv').disabled = !bins.some(bin => bin.n);
  $('wavelength-jump').disabled = !samples.length;
  $('jump-wavelength').disabled = !samples.length || !finite($('wavelength-jump').value);
  renderLegend();
  if (!samples.length) return;
  const byTime = $('spectrum-view').value === 'time', showRaw = byTime || $('spectrum-raw')?.checked !== false;
  const left = 62, right = 735, top = 26, bottom = 250;
  const fluxes = [];
  const shownBins = byTime ? [] : bins.filter(bin => Number.isFinite(bin.fluxMicroJy));
  for (const bin of shownBins) fluxes.push(bin.fluxMicroJy - (Number.isFinite(bin.errorMicroJy) ? bin.errorMicroJy : 0), bin.fluxMicroJy + (Number.isFinite(bin.errorMicroJy) ? bin.errorMicroJy : 0));
  if (showRaw) for (const sample of samples) if (Number.isFinite(sample.fluxMicroJy)) fluxes.push(sample.fluxMicroJy);
  if (!fluxes.length) return;
  let xmin, xmax;
  if (byTime) {
    const times = samples.map(sample => sample.time).filter(Number.isFinite);
    if (!times.length) return;
    xmin = Math.min(...times); xmax = Math.max(...times);
    if (xmin === xmax) { xmin -= 43200000; xmax += 43200000; }
  } else { xmin = 0.7; xmax = 5.05; }
  let ymin = Math.min(...fluxes), ymax = Math.max(...fluxes);
  if (ymin === ymax) { const pad = Math.max(Math.abs(ymin) * 0.1, 1); ymin -= pad; ymax += pad; }
  const pad = (ymax - ymin) * 0.06; ymin -= pad; ymax += pad;
  const x = value => left + (value - xmin) / (xmax - xmin) * (right - left);
  const y = value => bottom - (value - ymin) / (ymax - ymin) * (bottom - top);
  if (!byTime) {
    // Spectral features worth checking, as shaded bands behind the data.
    for (const feature of SPECTRAL_FEATURES) {
      el('rect', { x: x(feature.lowUm), y: top, width: Math.max(2, x(feature.highUm) - x(feature.lowUm)), height: bottom - top, class: `spectrum-feature feature-${feature.id}` });
      const label = el('text', { x: x(feature.centerUm), y: top - 6, 'text-anchor': 'middle', class: 'spectrum-feature-label' });
      label.textContent = feature.short;
      el('title', {}, label).textContent = `${feature.label}: ${feature.lowUm}–${feature.highUm} μm`;
    }
  }
  for (let index = 0; index <= 4; index++) {
    const yy = top + index * (bottom - top) / 4, value = ymax - index * (ymax - ymin) / 4;
    el('line', { x1: left, x2: right, y1: yy, y2: yy, class: 'spectrum-grid' });
    const label = el('text', { x: left - 8, y: yy + 4, 'text-anchor': 'end', class: 'spectrum-tick' }); label.textContent = value.toPrecision(3);
  }
  el('line', { x1: left, x2: right, y1: bottom, y2: bottom, class: 'spectrum-axis' });
  el('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'spectrum-axis' });
  if (byTime) {
    for (let index = 0; index <= 4; index++) {
      const xx = left + index * (right - left) / 4, value = xmin + index * (xmax - xmin) / 4;
      const label = el('text', { x: xx, y: bottom + 19, 'text-anchor': 'middle', class: 'spectrum-tick' });
      label.textContent = new Date(value).toISOString().slice(0, 10);
    }
  } else {
    for (const um of [1, 2, 3, 4, 5]) {
      el('line', { x1: x(um), x2: x(um), y1: bottom, y2: bottom + 4, class: 'spectrum-axis' });
      const label = el('text', { x: x(um), y: bottom + 19, 'text-anchor': 'middle', class: 'spectrum-tick' }); label.textContent = `${um} μm`;
    }
    // Detector bands along the axis, coloured like the points.
    DETECTOR_BANDS.forEach(([low, high], index) => {
      const band = el('rect', { x: x(low), y: bottom + 1, width: x(high) - x(low), height: 3, class: 'spectrum-detector-band' });
      band.style.setProperty('--detector-colour', `var(--d${index + 1})`);
    });
  }
  const xLabel = el('text', { x: (left + right) / 2, y: 293, 'text-anchor': 'middle', class: 'spectrum-label' });
  xLabel.textContent = byTime ? 'Observation date (UTC)' : 'Wavelength at selected sky position (μm)';
  const yLabel = el('text', { x: 14, y: 135, transform: 'rotate(-90 14 135)', 'text-anchor': 'middle', class: 'spectrum-label' }); yLabel.textContent = 'Quick-look flux (μJy)';
  if (showRaw) {
    // Saturated points last, so they are never hidden under good ones.
    const ordered = [...samples].sort((a, b) => Number(Boolean(a.likelySaturated)) - Number(Boolean(b.likelySaturated)));
    for (const sample of ordered) {
      const xv = x(byTime ? sample.time : sample.wavelengthUm);
      if (!Number.isFinite(xv) || !Number.isFinite(sample.fluxMicroJy)) continue;
      drawRawPoint(sample, xv, y(sample.fluxMicroJy), y, { faint: !byTime });
    }
  }
  for (const bin of shownBins) drawBin(bin, x, y);
}
