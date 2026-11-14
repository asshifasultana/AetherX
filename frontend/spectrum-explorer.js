import { createWavelengthReader } from './lib/wavelength.js';
import { measureAt } from './lib/photometry.js';
import { observeCutout } from './fits-viewer.js';
import { exposureCenter } from './presets.js';

const $ = id => document.getElementById(id);
const svg = $('spectrum-chart'), status = $('spectrum-status');
const NS = 'http://www.w3.org/2000/svg';
const wavelengthAt = createWavelengthReader();
let observations = [], position = null, targetName = 'selected target', samples = [], controller = null;
const el = (tag, attrs = {}, parent = svg) => {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  parent.append(node); return node;
};
const finite = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));

window.addEventListener('sky:target-selected', event => {
  position = event.detail; targetName = $('object-name')?.textContent || 'selected target';
  controller?.abort(); samples = []; svg.replaceChildren(); svg.hidden = true; $('build-spectrum').disabled = true;
  status.textContent = 'Select “Measure loaded images” to build a quick-look spectrum for this position.';
});
window.addEventListener('sky:observations-loading', () => {
  controller?.abort(); observations = []; samples = []; svg.replaceChildren(); svg.hidden = true;
  $('build-spectrum').disabled = true; $('wavelength-jump').disabled = true; $('jump-wavelength').disabled = true;
  status.textContent = 'Searching for images at the selected sky position…';
});
function acceptObservationState(detail) {
  if (detail.failed) { observations = []; $('build-spectrum').disabled = true; status.textContent = 'No search results available to measure.'; return; }
  controller?.abort();
  observations = (detail.observations || []).filter(item => item.accessUrl);
  if (detail.position) position = detail.position;
  targetName = detail.targetName || targetName;
  samples = []; svg.replaceChildren(); svg.hidden = true;
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
  samples = []; svg.replaceChildren(); svg.hidden = true;
  let finished = 0, failed = 0, next = 0;
  status.textContent = `Measuring ${observations.length} archive images. This may take a while…`;
  const workers = Array.from({ length: Math.min(3, observations.length) }, async () => {
    while (next < observations.length && !controller.signal.aborted) {
      const index = next++;
      try { samples.push(await measure(observations[index], controller.signal)); }
      catch (error) { if (controller.signal.aborted) return; failed++; }
      finished++;
      status.textContent = `Measured ${finished}/${observations.length} images · ${samples.length} valid points · ${failed} skipped.`;
      renderChart();
    }
  });
  const active = controller;
  try { await Promise.all(workers); }
  finally {
    if (controller === active) controller = null;
    cancel.hidden = true; button.disabled = false;
    if (active.signal.aborted) status.textContent = `Cancelled · kept ${samples.length} valid measurements.`;
    else if (samples.length) status.textContent = `Quick-look spectrum for ${targetName}: ${samples.length} valid samples from ${observations.length} loaded images; ${failed} skipped.`;
    else status.textContent = 'No usable measurements. Try a different target or load more archive images.';
    renderChart();
  }
}

function renderChart() {
  svg.replaceChildren();
  svg.hidden = !samples.length;
  $('wavelength-jump').disabled = !samples.length;
  $('jump-wavelength').disabled = !samples.length || !finite($('wavelength-jump').value);
  if (!samples.length) return;
  const mode = $('spectrum-view').value, left = 62, right = 735, top = 20, bottom = 250;
  const values = samples.map(sample => mode === 'time' ? sample.time : sample.wavelengthUm);
  const xs = values.filter(Number.isFinite), fluxes = samples.map(sample => sample.fluxMicroJy).filter(Number.isFinite);
  if (!xs.length || !fluxes.length) return;
  let xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...fluxes), ymax = Math.max(...fluxes);
  if (xmin === xmax) { xmin -= 0.01; xmax += 0.01; }
  if (ymin === ymax) { const pad = Math.max(Math.abs(ymin) * 0.1, 1); ymin -= pad; ymax += pad; }
  const errors = samples.map(sample => sample.errorMicroJy).filter(Number.isFinite);
  if (errors.length) { ymin = Math.min(ymin, ...samples.map(s => s.fluxMicroJy - (s.errorMicroJy || 0))); ymax = Math.max(ymax, ...samples.map(s => s.fluxMicroJy + (s.errorMicroJy || 0))); }
  const x = value => left + (value - xmin) / (xmax - xmin) * (right - left);
  const y = value => bottom - (value - ymin) / (ymax - ymin) * (bottom - top);
  for (let index = 0; index <= 4; index++) {
    const yy = top + index * (bottom - top) / 4, value = ymax - index * (ymax - ymin) / 4;
    el('line', { x1: left, x2: right, y1: yy, y2: yy, class: 'spectrum-grid' });
    const label = el('text', { x: left - 8, y: yy + 4, 'text-anchor': 'end', class: 'spectrum-tick' }); label.textContent = value.toPrecision(3);
  }
  el('line', { x1: left, x2: right, y1: bottom, y2: bottom, class: 'spectrum-axis' });
  el('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'spectrum-axis' });
  for (let index = 0; index <= 4; index++) {
    const xx = left + index * (right - left) / 4, value = xmin + index * (xmax - xmin) / 4;
    const label = el('text', { x: xx, y: bottom + 19, 'text-anchor': 'middle', class: 'spectrum-tick' });
    label.textContent = mode === 'time' ? new Date(value).toISOString().slice(0, 10) : `${value.toFixed(2)} μm`;
  }
  const xLabel = el('text', { x: (left + right) / 2, y: 293, 'text-anchor': 'middle', class: 'spectrum-label' });
  xLabel.textContent = mode === 'time' ? 'Observation date (UTC)' : 'Wavelength at selected sky position (μm)';
  const yLabel = el('text', { x: 14, y: 135, transform: 'rotate(-90 14 135)', 'text-anchor': 'middle', class: 'spectrum-label' }); yLabel.textContent = 'Quick-look flux (μJy)';
  const minTime = Math.min(...samples.map(item => item.time)), maxTime = Math.max(...samples.map(item => item.time));
  for (const sample of samples) {
    const xv = x(mode === 'time' ? sample.time : sample.wavelengthUm), yv = y(sample.fluxMicroJy);
    const g = el('g', { class: 'spectrum-point-group', tabindex: '0', role: 'button', 'aria-label': `${sample.wavelengthUm.toFixed(3)} micrometers, ${sample.fluxMicroJy.toPrecision(3)} microjanskys, detector ${sample.detector}, ${sample.observation.observedStartUtc || 'date not reported'}` });
    const fraction = maxTime === minTime ? 0.5 : (sample.time - minTime) / (maxTime - minTime);
    g.style.setProperty('--visit-hue', String(214 - 185 * fraction));
    if (Number.isFinite(sample.errorMicroJy)) {
      el('line', { x1: xv, x2: xv, y1: y(sample.fluxMicroJy - sample.errorMicroJy), y2: y(sample.fluxMicroJy + sample.errorMicroJy), class: 'spectrum-error' }, g);
      el('line', { x1: xv - 3, x2: xv + 3, y1: y(sample.fluxMicroJy - sample.errorMicroJy), y2: y(sample.fluxMicroJy - sample.errorMicroJy), class: 'spectrum-error' }, g);
      el('line', { x1: xv - 3, x2: xv + 3, y1: y(sample.fluxMicroJy + sample.errorMicroJy), y2: y(sample.fluxMicroJy + sample.errorMicroJy), class: 'spectrum-error' }, g);
    }
    el('circle', { cx: xv, cy: yv, r: 3.3, class: 'spectrum-point' }, g);
    const title = el('title', {}, g); title.textContent = `${sample.wavelengthUm.toFixed(4)} μm · ${sample.fluxMicroJy.toFixed(2)} ± ${sample.errorMicroJy.toFixed(2)} μJy · D${sample.detector} · ${sample.observation.observedStartUtc || 'date not reported'} · click to open image`;
    g.addEventListener('click', () => { observeCutout(sample.observation); $('explorer').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    g.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); g.click(); } });
  }
}
