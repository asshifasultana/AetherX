import { ensureSearchForm } from './target-search.js';
ensureSearchForm();
const $ = id => document.getElementById('moving-' + id);
const form = document.getElementById('target-search-form'), status = $('status'), canvas = $('canvas'), detector = $('detector');
const daySlider = $('day'), minWave = $('min'), maxWave = $('max');
let search, scan, result, worker, request, timer, busy = false, generation = 0;
let displayedDays = [], loadedIds = new Set(), timelineScale;

function stopPlayback() {
  clearInterval(timer);
  timer = null;
  $('play').textContent = 'Play';
}

function setBusy(value) {
  busy = value;
  $('cancel').hidden = !value;
  $('load').disabled = value;
  $('stack').disabled = value;
  detector.disabled = minWave.disabled = maxWave.disabled = value;
  for (const checkbox of $('exposures').querySelectorAll('input')) checkbox.disabled = value;
  const bounds = range();
  const count = scan?.frames.filter(frame => frame.wavelength >= bounds.min && frame.wavelength <= bounds.max).length;
  $('enhance').disabled = value || !result || !(count > 0 && count <= 24);
}

function invalidate() {
  generation++;
  request?.abort();
  request = null;
  worker?.terminate();
  worker = null;
  stopPlayback();
  scan = result = null;
  displayedDays = [];
  loadedIds = new Set();
  $('display').hidden = $('controls').hidden = $('report').hidden = true;
  $('stage-control').hidden = true;
  $('metrics').textContent = '';
  setBusy(false);
}

function displayScale(values) {
  const magnitudes = Array.from(values).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  return (magnitudes[Math.floor(.99 * (magnitudes.length - 1))] || 1) / 8;
}

function render(stack, label, scale = displayScale(stack.values)) {
  if (!stack?.values) return;
  const context = canvas.getContext('2d'), pixels = context.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < stack.values.length; i++) {
    const value = stack.values[i];
    const shade = Number.isFinite(value)
      ? Math.round(255 * Math.max(0, Math.min(1, .25 + Math.asinh(value / scale) / Math.asinh(8) * .75))) : 0;
    pixels.data.set([shade, shade, shade, 255], i * 4);
  }
  context.putImageData(pixels, 0, 0);
  canvas.setAttribute('aria-label', label);
  $('caption').textContent = label;
  $('display').hidden = false;
}

function showDay(index) {
  const frame = displayedDays[index];
  if (!frame) return;
  daySlider.value = index;
  daySlider.setAttribute('aria-valuetext', frame.date);
  const waves = frame.exposures.map(e => e.wavelength);
  const smear = Math.max(...frame.exposures.map(e => e.smearArcsec));
  const coverage = frame.values.filter(Number.isFinite).length / frame.values.length;
  render(frame, `${search.name} · ${frame.date} UTC · ${frame.exposures.length} exposures · ${Math.min(...waves).toFixed(3)}–${Math.max(...waves).toFixed(3)} µm · maximum smear ${smear.toFixed(1)}″ · ${Math.round(coverage * 100)}% coverage`, timelineScale);
  $('metrics').textContent = '';
}

function setDays(days) {
  stopPlayback();
  displayedDays = days;
  timelineScale = displayScale(days.flatMap(day => Array.from(day.values)));
  daySlider.max = Math.max(0, days.length - 1);
  daySlider.value = 0;
  $('play').disabled = days.length < 2;
}

function displayReport(data) {
  const entries = data.frames.map(e => `${e.observedStartUtc} · ${e.observationId} · ${e.wavelength.toFixed(4)} µm · ${e.smearArcsec.toFixed(2)}″ smear · ${Math.round(e.coverage * 100)}% coverage${e.centerValid ? '' : ' · center pixel masked or missing'}`);
  for (const failure of data.failures) entries.push(`${failure.productId}: ${failure.reason}`);
  for (const ref of data.enhanced?.referenceReport ?? []) {
    entries.push(`${ref.productId}: ${ref.sources.length} references (${[...new Set(ref.sources.map(s => s.strategy))].join(', ') || 'none'}) · ${ref.supportedPixels} supported pixels${ref.warning ? ' · ' + ref.warning : ''}`);
  }
  const percent = n => Number.isFinite(n) ? Math.round(n * 100) + '%' : 'unavailable';
  for (const { profile, core, outer } of data.enhanced?.injectionRecovery ?? []) {
    entries.push(`Injected ${profile}: core recovery ${percent(core.fraction)} (${percent(core.coverage)} covered) · outer recovery ${percent(outer.fraction)} (${percent(outer.coverage)} covered)`);
  }
  $('report-list').replaceChildren(...entries.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  $('report').hidden = false;
}

function listExposures() {
  const exposures = search.exposures.filter(e => e.detector === Number(detector.value));
  $('exposures').replaceChildren(...exposures.map(e => {
    const label = document.createElement('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = e.productId;
    checkbox.checked = exposures.length <= 80;
    label.append(checkbox, ` ${e.observedStartUtc} · ${e.observationId} · ${e.release}`);
    return label;
  }));
  status.textContent = exposures.length > 80
    ? `${exposures.length} exposures on D${detector.value}. Open the exposure list and select up to 80.`
    : `${exposures.length} exposures selected on D${detector.value}.`;
}

window.addEventListener('sky:moving-search-requested', async () => {
  if (document.getElementById('target-type').value !== 'moving') return;
  if (!form.reportValidity()) return;
  if (form.elements.startDate.value > form.elements.endDate.value) {
    status.textContent = 'End date must be on or after the start date.';
    form.elements.endDate.focus();
    return;
  }
  invalidate();
  search = null;
  $('selection').hidden = true;
  $('choices').replaceChildren();
  const token = generation;
  request = new AbortController();
  setBusy(true);
  status.textContent = 'Searching IRSA and calculating spacecraft-relative positions…';
  try {
    const response = await fetch('/api/moving-observations?' + new URLSearchParams(new FormData(form)), { signal: request.signal });
    const data = await response.json();
    if (token !== generation) return;
    if (!response.ok) {
      for (const choice of data.choices ?? []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = choice.label + ' (' + choice.designation + ')';
        button.addEventListener('click', () => { form.elements.object.value = choice.designation; form.requestSubmit(); });
        $('choices').append(button);
      }
      throw new Error(data.error || 'Moving-object search failed.');
    }
    search = data;
    if (!data.exposures.length) { status.textContent = 'No public exposures matched this object and date range.'; return; }
    const detectors = [...new Set(data.exposures.map(e => e.detector))].sort();
    detector.replaceChildren(...detectors.map(d => new Option('D' + d, d)));
    $('selection').hidden = false;
    listExposures();
    if (data.trajectoryError) status.textContent = `${data.exposures.length} candidates found. ${data.trajectoryError}`;
    else status.textContent += ` ${data.name} · Horizons ${data.solution}, viewed from SPHEREx.`;
  } catch (err) {
    if (token === generation) status.textContent = err.message;
  } finally {
    if (token === generation) {
      request = null;
      setBusy(false);
      if (search?.trajectoryError) $('load').disabled = true;
    }
  }
});

function send(message, onResult) {
  const current = worker;
  const token = generation;
  setBusy(true);
  current.onmessage = ({ data }) => {
    if (token !== generation || worker !== current) return;
    if (data.type === 'progress') {
      status.textContent = `${data.value.completed} of ${data.value.total} exposures processed.`;
      if (data.value.preview) render(data.value.preview, `${search.name} · ${data.value.preview.date} UTC preview`);
      return;
    }
    setBusy(false);
    if (data.type === 'error') { status.textContent = data.message; return; }
    onResult(data.value);
    setBusy(false);
  };
  current.onerror = () => {
    if (token !== generation || worker !== current) return;
    invalidate();
    status.textContent = 'The image worker stopped. Load the selected exposures again.';
  };
  current.postMessage(message);
}

$('load').addEventListener('click', () => {
  if (busy || search?.trajectoryError) return;
  const checked = new Set(Array.from($('exposures').querySelectorAll('input:checked'), node => node.value));
  const exposures = search.exposures.filter(e => checked.has(e.productId) && e.detector === Number(detector.value));
  if (!exposures.length || exposures.length > 80) {
    status.textContent = 'Select between 1 and 80 exposures from the list.';
    return;
  }
  invalidate();
  loadedIds = new Set(exposures.map(e => e.productId));
  worker = new Worker(new URL('./moving-worker.js', import.meta.url), { type: 'module' });
  status.textContent = 'Loading quality-masked FITS cutouts…';
  send({ type: 'scan', search: { object: search.object, name: search.name, observer: search.observer, solution: search.solution }, exposures }, data => {
    scan = data;
    const waves = scan.frames.map(e => e.wavelength);
    minWave.value = Math.floor(Math.min(...waves) * 10000) / 10000;
    maxWave.value = Math.ceil(Math.max(...waves) * 10000) / 10000;
    setDays(scan.days);
    showDay(0);
    $('controls').hidden = false;
    displayReport(scan);
    status.textContent = `${scan.frames.length} aligned exposures across ${scan.days.length} UTC days. Review the wavelength range before building a deep stack.`;
  });
});

function range() {
  return { min: minWave.valueAsNumber, max: maxWave.valueAsNumber };
}

function showStack(stageName) {
  if (!result) return;
  const enhanced = stageName === 'enhanced' && result.enhanced?.values;
  const stage = enhanced ? result.enhanced : result.tracked;
  render(stage, `${search.name} · ${enhanced ? 'Enhanced contrast' : 'Tracked median'} · ${result.frames.length} exposures`);
  const format = n => Number.isFinite(n) ? n.toPrecision(4) : 'unavailable';
  const metric = (name, item) => `${name}: aperture signal ${format(item.apertureSignal)}, off-target scatter ${format(item.apertureSkyScatter)}, contrast ${format(item.apertureContrast)}.`;
  $('metrics').textContent = metric('Tracked', result.tracked.metrics) + (result.enhanced?.values
    ? ` ${metric('Enhanced', result.enhanced.metrics)} Reference coverage ${Math.round(result.enhanced.referenceCoverage * 100)}%. Subtraction can remove diffuse emission.` : '');
}

function stack(enhanced) {
  if (!worker || busy || !scan) return;
  const { min, max } = range();
  if (!(min > 0 && max >= min)) { status.textContent = 'Enter a valid wavelength range.'; return; }
  stopPlayback();
  status.textContent = enhanced ? 'Checking independent references and matching stellar PSFs…' : 'Building the tracked median…';
  send({ type: 'stack', min, max, enhanced }, data => {
    result = data;
    setDays(data.days);
    $('stage-control').hidden = !data.enhanced?.values;
    $('stage').value = data.enhanced?.values ? 'enhanced' : 'tracked';
    showStack($('stage').value);
    displayReport(data);
    status.textContent = data.enhanced?.unavailable || (data.enhanced?.values ? 'Enhanced view ready. Use Stack view to compare.'
      : data.frames.length > 24 ? 'Tracked stack ready. Narrow the selection to 24 exposures for enhancement.' : 'Tracked stack ready.');
  });
}

$('stack').addEventListener('click', () => stack(false));
$('enhance').addEventListener('click', () => stack(true));
detector.addEventListener('change', () => { invalidate(); listExposures(); if (search.trajectoryError) $('load').disabled = true; });
$('exposures').addEventListener('change', () => {
  if (!scan) return;
  invalidate();
  status.textContent = 'Exposure selection changed. Load the new selection.';
  if (search?.trajectoryError) $('load').disabled = true;
});
for (const field of [minWave, maxWave]) field.addEventListener('input', () => {
  result = null;
  $('stage-control').hidden = true;
  setBusy(busy);
});
$('stage').addEventListener('change', () => { stopPlayback(); showStack($('stage').value); });
daySlider.addEventListener('input', () => { stopPlayback(); showDay(Number(daySlider.value)); });
$('play').addEventListener('click', () => {
  if (timer) { stopPlayback(); return; }
  if (displayedDays.length < 2) return;
  $('play').textContent = 'Pause';
  timer = setInterval(() => showDay((Number(daySlider.value) + 1) % displayedDays.length), 600);
});
$('cancel').addEventListener('click', () => { invalidate(); status.textContent = 'Cancelled.'; });
$('download').addEventListener('click', () => {
  const { object, name, observer, solution } = search;
  const excludedCandidates = search.exposures.filter(e => !loadedIds.has(e.productId)).map(e => ({
    observationId: e.observationId, productId: e.productId, detector: e.detector, reason: 'Not selected for loading.',
  }));
  const data = JSON.stringify({ object, name, observer, solution, pixelArcsec: 6.15, size: canvas.width,
    excludedCandidates, ...(result ?? scan) },
    (_, value) => ArrayBuffer.isView(value) ? Array.from(value) : value);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'spherex-moving-target.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
