import {
  buildFrames, buildWavelengthFrames, frameDelayMs, frameFractions, frameGaps, frameTime, formatGap,
  formatGapShort, nearestFrameIndex, nearestFrameIndexByTime, nextSpeed, observationKey
} from './timelapse-core.js';
import { showCutout, warmCutout, isCutoutReady } from './fits-viewer.js';
import { takePendingFrameDate } from './share.js';

const $ = id => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const MODE_LABELS = {
  'time-lapse': 'Time-lapse',
  blink: 'Blink',
  difference: 'Difference',
  'motion-trail': 'Motion trail',
  'deep-stack': 'Deep stack',
  'six-detector': 'Six detectors'
};

const state = {
  observations: [],
  frames: [],
  fractions: [],
  index: 0,
  playing: false,
  userPaused: false,
  viewMode: 'time-lapse',
  pinnedKey: '',
  speed: 1,
  band: null,
  combineExposures: true,
  // 'date', or 'wavelength' for slices ordered by the wavelength at the target
  // (wavelength-slices.js supplies the per-exposure wavelengths).
  axis: 'date',
  wavelengths: null,
  timer: null,
  token: 0,
  scrubTimer: null,
  thumbs: new Map(),
  cache: new Map(),
  shownKey: null
};

// Warm up to four upcoming daily frames at a time. Its exposures share the bounded S3
// pool and yield queue priority to selected frames and deep-stack work. IRSA
// fallback transfers remain serialized independently.
const prefetch = {
  timer: null,
  controller: null,
  running: false,
  paused: 0,
  fetched: new Set(),
  failed: new Set(),
  fov: null
};
let prefetchNote = false;
let playbackController = null;

// Search readiness includes every filmstrip frame, not just the selected image.
let searchPending = false, archivePending = false, selectedPending = false;
let loadingProgress = 0, loadingProgressTimer = null;
// The search loader (search-loader.js) draws this progress and plays the exit;
// this module only decides how far along the search is and when it is done.
const emitLoader = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));

function paintLoadingProgress(value) {
  loadingProgress = value;
  emitLoader('sky:loader-progress', { value });
}
function tickLoadingProgress() {
  // An estimated visual cadence: a quick first sweep, then a gentle approach
  // to 99. Only actual image readiness can complete and dismiss the screen.
  if (!searchPending) return;
  paintLoadingProgress(loadingProgress < 90
    ? Math.min(90, loadingProgress + 9)
    : Math.min(99, loadingProgress + (99 - loadingProgress) * .025));
  loadingProgressTimer = setTimeout(tickLoadingProgress, loadingProgress < 90 ? 70 : 250);
}
function updatePreviewLoading() {
  if (!searchPending) return;
  const frames = document.documentElement?.classList.contains('is-tour-preview')
    ? state.frames.slice(state.index, state.index + 1) : state.frames;
  const settled = frames.filter(frame => {
    const key = observationKey(frame);
    return prefetch.fetched.has(key) || prefetch.failed.has(key) || isCutoutReady(frame);
  }).length;
  // The six-detector panels show their own progress, so the search screen can
  // go as soon as the archive has answered.
  const busy = archivePending || (state.viewMode !== 'six-detector' && (selectedPending || settled < frames.length));
  document.querySelector('.viewer')?.setAttribute('aria-busy', String(busy));
  if (busy) return;
  searchPending = false;
  clearTimeout(loadingProgressTimer); loadingProgressTimer = null;
  paintLoadingProgress(100);
  emitLoader('sky:loader-ready', { frames: frames.length });
}


const dateOf = frame => new Date(frameTime(frame));
const isSlice = frame => Number.isFinite(frame?.frameWavelengthUm);
const shortDate = frame => isSlice(frame) ? `${frame.frameWavelengthUm.toFixed(2)} μm` : dateFormat.format(dateOf(frame));
const frameDate = frame => isSlice(frame)
  ? `${frame.frameWavelengthUm.toFixed(3)} μm · D${frame.detector} ch ${Number(frame.channel) + 1} · ${frame.exposureCount} exposure${frame.exposureCount === 1 ? '' : 's'} · at field centre`
  : `${shortDate(frame)} · ${timeFormat.format(dateOf(frame))} UTC`;
const formatRange = () => {
  if (!state.frames.length) return '';
  const first = state.frames[0], last = state.frames[state.frames.length - 1];
  return state.frames.length === 1 ? shortDate(first) : `${shortDate(first)} – ${shortDate(last)}`;
};
const wavelength = frame => {
  const low = Number(frame.wavelengthMinUm), high = Number(frame.wavelengthMaxUm);
  return Number.isFinite(low) && Number.isFinite(high) ? `${low.toFixed(2)}–${high.toFixed(2)} μm` : '';
};
const setStatus = text => { $('timeline-status').textContent = text; };
const modeLabels = {
  'time-lapse': 'Time-lapse',
  blink: 'Blink comparison',
  difference: 'Difference image',
  'motion-trail': 'Motion trail',
  'deep-stack': 'Deep stack',
  'six-detector': 'Six detectors'
};

function updateModeUi() {
  const deepStack = state.viewMode === 'deep-stack';
  const count = state.frames.length;
  $('timeline-heading').textContent = modeLabels[state.viewMode] || 'Sky view';
  $('playback-row').hidden = deepStack;
  $('timeline-filmstrip').hidden = deepStack;
  if (deepStack) {
    const detector = state.frames[state.index]?.detector ?? state.band;
    $('frame-count').textContent = count ? `DEEP STACK${detector ? ` · D${detector}` : ''}` : 'DEEP STACK · NO IMAGES LOADED';
  } else {
    $('frame-count').textContent = count
      ? state.axis === 'wavelength'
        ? `${count} WAVELENGTH ${count === 1 ? 'SLICE' : 'SLICES'} · D1–D6 · ${formatRange()}`
        : `${count} D${state.frames[0].detector} ${count === 1 ? 'FRAME' : 'FRAMES'} · ${formatRange()}`.toUpperCase()
      : 'NO IMAGES LOADED';
  }
}

function updatePlayButton() {
  const button = $('play-button');
  button.textContent = state.playing ? '❚❚' : '▶';
  button.setAttribute('aria-label', state.playing ? 'Pause observation time-lapse' : 'Play observation time-lapse');
  button.setAttribute('aria-pressed', String(state.playing));
  button.classList.toggle('is-playing', state.playing);
}

// The panel carries the selected mode's name and hides the frame controls for
// a deep stack, which is one combined image rather than a sequence.
function updateModeUI() {
  const deepStack = state.viewMode === 'deep-stack';
  $('timeline-heading').textContent = MODE_LABELS[state.viewMode] || 'Time-lapse';
  const panel = document.querySelector?.('.timeline-panel');
  if (panel) panel.dataset.viewMode = state.viewMode;
  const count = state.frames.length;
  $('frame-count').textContent = deepStack
    ? (count ? 'SINGLE COMBINED IMAGE' : 'NO IMAGES LOADED')
    : count
      ? `${count} D${state.frames[0].detector} ${count === 1 ? 'FRAME' : 'FRAMES'} · ${formatRange()}`.toUpperCase()
      : 'NO IMAGES LOADED';
  if (deepStack && state.playing) pausePlayback();
}

function updateStepButtons() {
  const last = state.frames.length - 1;
  $('step-back').disabled = state.frames.length < 2 || state.index <= 0;
  $('step-forward').disabled = state.frames.length < 2 || state.index >= last;
}

function nextPrefetchFrame(excluded = new Set()) {
  const count = state.frames.length;
  for (let step = state.playing ? 1 : 0; step < (state.playing ? Math.min(count, 5) : count); step++) {
    const frame = state.frames[(state.index + step) % count];
    const key = observationKey(frame);
    if (!excluded.has(key) && !isCutoutReady(frame) && !prefetch.failed.has(key)) return frame;
  }
  return null;
}

function schedulePrefetch(delay = 0) {
  clearTimeout(prefetch.timer);
  prefetch.timer = null;
  if (!state.frames.length || prefetch.paused || state.viewMode === 'deep-stack' || state.viewMode === 'six-detector' || document.documentElement?.classList.contains('is-tour-preview')) return;
  prefetch.timer = setTimeout(() => { void runPrefetch(); }, delay);
}

function stopPrefetch() {
  clearTimeout(prefetch.timer);
  prefetch.timer = null;
  prefetch.controller?.abort();
  prefetch.controller = null;
}

function resetPrefetch() {
  stopPrefetch();
  prefetch.fetched.clear();
  prefetch.failed.clear();
  prefetch.running = false;
}

function prefetchAnnounce() {
  if (!prefetchNote || prefetch.paused || state.playing || !state.frames.length) return;
  const total = state.frames.length;
  setStatus(`${total} dated ${total === 1 ? 'frame' : 'frames'} ready. Preloading ${Math.min(prefetch.fetched.size, total)}/${total} for smooth playback…`);
}

function prefetchFinished() {
  if (!prefetchNote || prefetch.paused || state.playing || !state.frames.length) return;
  prefetchNote = false;
  const total = state.frames.length, done = prefetch.fetched.size;
  setStatus(done >= total
    ? `All ${total} frames preloaded.`
    : `${done} of ${total} frames preloaded. The rest will load on demand.`);
}

async function runPrefetch() {
  prefetch.timer = null;
  if (prefetch.running || prefetch.paused || !state.frames.length) return;
  const batch = [], excluded = new Set();
  for (let i = 0; i < 4; i++) {
    const frame = nextPrefetchFrame(excluded);
    if (!frame) break;
    batch.push(frame); excluded.add(observationKey(frame));
  }
  if (!batch.length) { prefetchFinished(); updatePreviewLoading(); return; }
  const controller = new AbortController();
  prefetch.controller = controller;
  prefetch.running = true;
  try {
    await Promise.all(batch.map(async frame => {
      const key = observationKey(frame);
      try {
        await warmCutout(frame, controller.signal);
        if (!controller.signal.aborted) prefetch.fetched.add(key);
      } catch (error) {
        if (!controller.signal.aborted && error?.name !== 'AbortError') prefetch.failed.add(key);
      }
      if (!controller.signal.aborted) { prefetchAnnounce(); updatePreviewLoading(); }
    }));
  } finally {
    // An old batch must never clear a new target's controller or running flag.
    if (prefetch.controller === controller) {
      prefetch.controller = null;
      prefetch.running = false;
      if (!controller.signal.aborted) schedulePrefetch(0);
    }
  }
}

function drawPlaceholder(canvas, frame) {
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#16242a');
  gradient.addColorStop(1, '#0a1114');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#aec4a8';
  context.font = '600 16px "DM Sans", sans-serif';
  context.fillText(`D${frame.detector}`, canvas.width / 2, canvas.height / 2 - 3);
  context.fillStyle = '#68806e';
  context.font = '9px "DM Sans", sans-serif';
  context.fillText('PREVIEW', canvas.width / 2, canvas.height / 2 + 13);
}

function paintThumb(canvas, source) {
  if (!source) return;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
}

function restoreThumb(canvas, dataUrl) {
  const image = new Image();
  image.onload = () => paintThumb(canvas, image);
  image.src = dataUrl;
}

function renderTicks() {
  const ticks = $('timeline-ticks'), gaps = $('timeline-gaps');
  ticks.replaceChildren();
  gaps.replaceChildren();
  state.frames.forEach((frame, index) => {
    const tick = document.createElement('i');
    tick.style.left = `${state.fractions[index] * 100}%`;
    tick.dataset.index = String(index);
    tick.title = frameDate(frame);
    ticks.append(tick);
  });
  const significant = state.axis === 'wavelength' ? [] : frameGaps(state.frames).filter(gap => gap.days >= 1);
  const shown = significant.length > 12
    ? [...significant].sort((a, b) => b.days - a.days).slice(0, 12).sort((a, b) => a.afterIndex - b.afterIndex)
    : significant;
  for (const gap of shown) {
    const width = (state.fractions[gap.afterIndex + 1] - state.fractions[gap.afterIndex]) * 100;
    if (width < 2.5) continue;
    const badge = document.createElement('span');
    badge.className = 'timeline-gap';
    badge.style.left = `${((state.fractions[gap.afterIndex] + state.fractions[gap.afterIndex + 1]) / 2) * 100}%`;
    badge.textContent = formatGapShort(gap.days);
    badge.title = `${formatGap(gap.days)} between ${frameDate(state.frames[gap.afterIndex])} and ${frameDate(state.frames[gap.afterIndex + 1])}`;
    gaps.append(badge);
  }
}

function renderFilmstrip() {
  const strip = $('timeline-filmstrip');
  strip.replaceChildren();
  state.thumbs.clear();
  state.frames.forEach((frame, index) => {
    const key = observationKey(frame);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumb';
    button.dataset.index = String(index);
    button.title = `${frameDate(frame)} · D${frame.detector}${frame.exposureCount > 1 ? ` · ${frame.exposureCount} exposures combined` : ''}`;
    button.setAttribute('aria-label', `Show ${frameDate(frame)}, detector ${frame.detector}`);
    const canvas = document.createElement('canvas');
    canvas.width = 68;
    canvas.height = 68;
    drawPlaceholder(canvas, frame);
    const cached = state.cache.get(key);
    if (cached) restoreThumb(canvas, cached);
    const label = document.createElement('small');
    label.textContent = shortDate(frame);
    button.append(canvas, label);
    if (frame.exposureCount > 1) {
      const meta = document.createElement('span');
      meta.className = 'thumb-meta';
      meta.textContent = `${frame.exposureCount} exposures`;
      button.append(meta);
    }
    button.addEventListener('click', () => {
      pausePlayback({ manual: true });
      void selectFrame(index);
    });
    state.thumbs.set(key, { button, canvas });
    strip.append(button);
  });
}

function updateCurrent({ keepSlider = false } = {}) {
  const frame = state.frames[state.index];
  if (state.viewMode === 'deep-stack') {
    $('timeline-date').textContent = state.frames.length ? 'Deep stack' : 'Waiting for observations';
    $('timeline-meta').hidden = false;
    if (!state.frames.length) $('timeline-meta').textContent = 'Load observations to build one combined image.';
    $('timeline').value = '0';
    $('timeline').style.setProperty('--progress', '0%');
    $('timeline').setAttribute('aria-valuetext', state.frames.length ? 'One combined deep-stack image' : 'No observations loaded');
    updateStepButtons();
    return;
  }
  if (!frame) {
    $('timeline-date').textContent = 'Waiting for observations';
    $('timeline-meta').hidden = false;
    $('timeline-meta').textContent = 'Search for a target to build a dated timeline.';
    $('timeline').value = '0';
    $('timeline').style.setProperty('--progress', '0%');
    $('timeline').setAttribute('aria-valuetext', 'No observations loaded');
    $('frame-provenance-text').textContent = 'Search for observations to see which exposures contribute to a frame.';
    updateStepButtons();
    return;
  }
  $('timeline-date').textContent = state.viewMode === 'deep-stack' ? 'One combined image' : frameDate(frame);
  $('timeline-meta').textContent = '';
  $('timeline-meta').hidden = true;
  const sources = frame.exposures || [frame];
  const ids = sources.map(item => item.observationId || item.productId || 'ID not reported');
  const record = frame.stackRecord;
  const failed = new Set(record?.failedObservationIds || []);
  const pendingText = frame.exposureCount > 1 ? 'Stack record is created when this frame finishes loading. ' : 'Single-exposure frame; no stacking was performed. ';
  $('frame-provenance-text').textContent = `${record ? `${record.method}. ` : pendingText}${record ? `${record.usedExposureCount} of ${record.requestedExposureCount} exposures loaded; ${record.validPixelContributions.toLocaleString()} valid input-pixel contributions covered ${record.coveredOutputPixels.toLocaleString()} output pixels; ${Math.round(record.exposureSeconds)} s total exposure time. ` : ''}UTC period: ${sources[0]?.observedStartUtc || 'unknown'} through ${sources.at(-1)?.observedEndUtc || sources.at(-1)?.observedStartUtc || 'unknown'}. Source observation IDs: ${ids.map(id => `${id}${failed.has(id) ? ' (failed)' : ''}`).join(', ')}.`;
  const fraction = state.frames.length > 1 ? state.fractions[state.index] : 0;
  if (!keepSlider) {
    $('timeline').value = String(Math.round(fraction * 1000));
    $('timeline').style.setProperty('--progress', `${fraction * 100}%`);
  }
  $('timeline').setAttribute('aria-valuetext', `${frameDate(frame)}, frame ${state.index + 1} of ${state.frames.length}`);
  for (const tick of $('timeline-ticks').children) {
    tick.classList.toggle('current', Number(tick.dataset.index) === state.index);
    tick.classList.toggle('reference', Boolean(state.pinnedKey) && observationKey(state.frames[Number(tick.dataset.index)] || {}) === state.pinnedKey);
  }
  const pinnedHere = Boolean(state.pinnedKey) && observationKey(frame) === state.pinnedKey;
  $('set-reference').textContent = pinnedHere ? 'Reference ✓' : 'Set as reference';
  $('set-reference').setAttribute('aria-pressed', String(pinnedHere));
  const currentKey = observationKey(frame);
  for (const [key, entry] of state.thumbs) {
    const active = key === currentKey;
    entry.button.classList.toggle('current', active);
    if (active) entry.button.setAttribute('aria-current', 'true');
    else entry.button.removeAttribute('aria-current');
    if (active && state.playing) {
      const strip = $('timeline-filmstrip');
      const left = entry.button.offsetLeft;
      if (left < strip.scrollLeft || left + entry.button.offsetWidth > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = left - strip.clientWidth / 2 + entry.button.offsetWidth / 2;
      }
    }
  }
  updateStepButtons();
}

function render() {
  const count = state.frames.length;
  updateModeUi();
  $('release-calibration-note').hidden = true;
  // Upper-casing would turn μ into a capital Greek M.
  const edgeLabel = frame => isSlice(frame) ? shortDate(frame) : shortDate(frame).toUpperCase();
  $('timeline-start').textContent = count ? edgeLabel(state.frames[0]) : 'FIRST FRAME';
  $('timeline-end').textContent = count ? edgeLabel(state.frames[count - 1]) : 'LATEST FRAME';
  const gaps = frameGaps(state.frames);
  const largest = gaps.reduce((maximum, gap) => Math.max(maximum, gap.days), 0);
  $('timeline-gap-note').textContent = state.axis === 'wavelength' ? 'SPACED BY WAVELENGTH · AT FIELD CENTRE' : count > 1
    ? largest >= 1 ? `REAL DATES · LARGEST GAP ${formatGapShort(largest).toUpperCase()}` : 'REAL DATES · SAME-DAY EXPOSURES'
    : 'SPACED BY ACTUAL DATE';
  $('timeline').disabled = count < 2;
  $('play-button').disabled = count < 2;
  $('speed-button').disabled = count < 2;
  $('export-frame-csv').disabled = count === 0;
  renderTicks();
  renderFilmstrip();
  updatePlayButton();
  updateCurrent();
}

function rebuild({ keepTime = false, announce = true } = {}) {
  pausePlayback();
  const previousFrame = state.frames[state.index];
  const previous = keepTime && previousFrame && !isSlice(previousFrame) ? frameTime(previousFrame) : null;
  const requestedBand = state.band;
  const slices = state.axis === 'wavelength' && state.wavelengths;
  state.frames = slices
    ? buildWavelengthFrames(state.observations, state.wavelengths)
    : buildFrames(state.observations, { band: requestedBand, combineExposures: state.combineExposures });
  let fallbackBand = null;
  if (!slices && !state.frames.length && state.observations.length && requestedBand !== null) {
    const counts = new Map();
    for (const item of state.observations) {
      const detector = Number(item.detector);
      if (Number.isFinite(detector)) counts.set(detector, (counts.get(detector) || 0) + 1);
    }
    // Prefer the band with the most archive products when the viewer band has none.
    const available = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([detector]) => detector);
    if (available.length) {
      fallbackBand = available[0];
      state.frames = buildFrames(state.observations, { band: fallbackBand, combineExposures: state.combineExposures });
    }
  }
  state.fractions = frameFractions(state.frames);
  state.index = slices && isSlice(previousFrame) && state.frames.length
    ? state.frames.reduce((best, frame, index) => Math.abs(frame.frameWavelengthUm - previousFrame.frameWavelengthUm) < Math.abs(state.frames[best].frameWavelengthUm - previousFrame.frameWavelengthUm) ? index : best, 0)
    : previous === null || !state.frames.length ? 0 : nearestFrameIndexByTime(state.frames, previous);
  state.thumbs.clear();
  window.dispatchEvent(new CustomEvent('sky:timeline-frames-changed', { detail: { frames: state.frames } }));
  render();
  if (slices) {
    const used = state.frames.reduce((n, frame) => n + frame.exposureCount, 0);
    setStatus(state.frames.length
      ? `${state.frames.length} wavelength slices from ${used} exposures across D1–D6, ordered by the wavelength SPHEREx saw at the target. Wavelengths are at the field centre and shift by about one channel across a 10′ field.`
      : 'No exposures had a usable wavelength at this position.');
  } else if (!state.frames.length) {
    setStatus(state.observations.length
      ? `No D${state.band ?? '?'} observations in these results. Choose another detector band or run a new search.`
      : 'No observations loaded. Search the archive to build a dated time-lapse.');
  } else if (fallbackBand !== null) {
    setStatus(`No D${requestedBand} frames in these results. Showing D${fallbackBand} instead; choose a detector band above to change the sequence.`);
  } else if (announce) {
    setStatus(`${state.frames.length} dated ${state.frames.length === 1 ? 'frame' : 'frames'} ready. Frames are ordered by UTC observation date.`);
  }
  resetPrefetch();
  if (state.frames.length > 1) {
    prefetchNote = true;
    prefetchAnnounce();
    schedulePrefetch(0);
  } else {
    prefetchNote = false;
  }
  return state.frames;
}

async function selectFrame(index, { playback = false } = {}) {
  if (!state.frames.length || state.viewMode === 'deep-stack') return;
  state.index = Math.max(0, Math.min(state.frames.length - 1, index));
  updateCurrent();
  const frame = state.frames[state.index];
  const token = state.token;
  let loaded = false;
  window.dispatchEvent(new CustomEvent('sky:frame-exposure-group', { detail: { exposures: frame.exposures || [frame], frame } }));
  const deepStackSelected = state.viewMode === 'deep-stack';
  if (deepStackSelected && document.getElementById('sky-canvas')?.dataset.deepStack === 'true') {
    setStatus(`Deep median remains displayed · timeline selection ${state.index + 1} of ${state.frames.length} changed.`);
    return;
  }
  if (!playback) prefetch.paused++;
  prefetchNote = false;
  if (!playback) setStatus(isSlice(frame) ? `Loading ${frameDate(frame)}…` : `Loading ${frameDate(frame)} · D${frame.detector}…`);
  try {
    // Playback stays quiet: the previous frame remains on screen until the next
    // one is ready, so there is no "loading cutout" flash between frames.
    const result = await showCutout(frame, { quiet: playback, keepImage: playback });
    if (token !== state.token || state.frames[state.index] !== frame) return;
    loaded = Boolean(result);
    if (!result?.stackRecord?.deepStack) frame.stackRecord = result?.stackRecord || null;
    updateCurrent({ keepSlider: true });
  } finally {
    if (!playback) prefetch.paused = Math.max(0, prefetch.paused - 1);
    if (loaded && token === state.token && state.frames[state.index] === frame) {
      // Nothing is said while playing; the timeline already shows the frame.
      setStatus(playback
        ? ''
        : `Frame ${state.index + 1} of ${state.frames.length} · ${frameDate(frame)}. Use ← → or the timeline to scrub.`);
    }
    schedulePrefetch(200);
  }
}

function pausePlayback({ manual = false } = {}) {
  if (manual) state.userPaused = true;
  playbackController?.abort();
  playbackController = null;
  state.playing = false;
  state.token++;
  clearTimeout(state.timer);
  state.timer = null;
  updatePlayButton();
  schedulePrefetch(300);
}

function scheduleNext(delay) {
  clearTimeout(state.timer);
  const token = state.token;
  state.timer = setTimeout(async () => {
    if (!state.playing || token !== state.token) return;
    const nextIndex = (state.index + 1) % state.frames.length;
    const next = state.frames[nextIndex];
    const controller = new AbortController();
    playbackController = controller;
    try {
      if (!isCutoutReady(next)) {
        setStatus(`Buffering next observation · ${frameDate(next)}. Keeping the current image visible…`);
        await warmCutout(next, controller.signal, 0);
      }
      if (!state.playing || token !== state.token || controller.signal.aborted) return;
      await selectFrame(nextIndex, { playback: true });
    } catch (error) {
      if (!controller.signal.aborted && token === state.token) {
        pausePlayback();
        setStatus(`Playback paused: ${error.message || 'the next observation could not be loaded.'}`);
      }
      return;
    } finally {
      if (playbackController === controller) playbackController = null;
    }
    if (state.playing && token === state.token) scheduleNext(frameDelayMs(state.speed));
  }, delay);
}

async function playPlayback() {
  if (state.frames.length < 2 || state.viewMode === 'deep-stack') return;
  // Keep a bounded lookahead running while the selected frame has priority.
  state.playing = true;
  state.token++;
  const token = state.token;
  updatePlayButton();
  const frame = state.frames[state.index];
  if (state.shownKey !== observationKey(frame)) await selectFrame(state.index);
  if (state.playing && token === state.token) { schedulePrefetch(0); scheduleNext(frameDelayMs(state.speed)); }
}

function togglePlayback() {
  if (state.viewMode === 'deep-stack') return;
  if (state.playing) pausePlayback({ manual: true });
  else { state.userPaused = false; void playPlayback(); }
}

$('play-button').addEventListener('click', togglePlayback);
$('set-reference').addEventListener('click', () => {
  const frame = state.frames[state.index];
  if (!frame) return;
  window.dispatchEvent(new CustomEvent('sky:reference-frame-pinned', { detail: { key: observationKey(frame) } }));
});
$('step-back').addEventListener('click', () => { if (state.viewMode === 'deep-stack') return; pausePlayback({ manual: true }); void selectFrame(state.index - 1); });
$('step-forward').addEventListener('click', () => { if (state.viewMode === 'deep-stack') return; pausePlayback({ manual: true }); void selectFrame(state.index + 1); });
$('speed-button').addEventListener('click', () => {
  state.speed = nextSpeed(state.speed);
  $('speed-value').textContent = `${state.speed}×`;
  $('speed-button').setAttribute('aria-label', `Playback speed, ${state.speed} times`);
  if (state.playing) { pausePlayback(); void playPlayback(); }
});
$('timeline').addEventListener('input', event => {
  if (!state.frames.length || state.viewMode === 'deep-stack') return;
  pausePlayback({ manual: true });
  state.index = nearestFrameIndex(state.frames, Number(event.target.value) / 1000);
  updateCurrent({ keepSlider: true });
  clearTimeout(state.scrubTimer);
  state.scrubTimer = setTimeout(() => { void selectFrame(state.index); }, 180);
});
$('timeline').addEventListener('change', () => {
  if (!state.frames.length || state.viewMode === 'deep-stack') return;
  clearTimeout(state.scrubTimer);
  void selectFrame(state.index);
});

// Read-only snapshot of the timeline for the AI guide.
function publishPlaybackState() {
  const frame = state.frames[state.index];
  const pinnedIndex = state.pinnedKey ? state.frames.findIndex(item => observationKey(item) === state.pinnedKey) : -1;
  window.dispatchEvent(new CustomEvent('sky:playback-state', { detail: {
    count: state.frames.length,
    frame: frame ? state.index + 1 : 0,
    frameDate: frame ? new Date(frameTime(frame)).toISOString() : '',
    firstDate: state.frames.length ? new Date(frameTime(state.frames[0])).toISOString().slice(0, 10) : '',
    lastDate: state.frames.length ? new Date(frameTime(state.frames.at(-1))).toISOString().slice(0, 10) : '',
    detector: frame ? Number(frame.detector) : null,
    exposures: frame ? (frame.exposures || [frame]).length : 0,
    wavelength: frame ? wavelength(frame) : '',
    playing: state.playing,
    speed: state.speed,
    pinnedFrame: pinnedIndex >= 0 ? pinnedIndex + 1 : null,
    referenceDate: pinnedIndex >= 0 ? new Date(frameTime(state.frames[pinnedIndex])).toISOString().slice(0, 10) : ''
  } }));
}
function setSpeed(speed) {
  state.speed = speed;
  $('speed-value').textContent = `${state.speed}×`;
  $('speed-button').setAttribute('aria-label', `Playback speed, ${state.speed} times`);
  if (state.playing) { pausePlayback(); void playPlayback(); }
}
window.addEventListener('sky:agent-playback', async event => {
  const detail = event.detail || {};
  const reply = result => { detail.respond?.(result); publishPlaybackState(); };
  if (!state.frames.length) { reply({ ok: false, error: 'No observations are loaded yet.' }); return; }
  if (state.viewMode === 'deep-stack' && detail.action !== 'pause') {
    reply({ ok: false, error: 'Deep stack shows one combined image. Switch to time-lapse, difference, or motion trail to use the timeline.' });
    return;
  }
  const last = state.frames.length - 1;
  try {
    switch (detail.action) {
      case 'play':
        if (state.frames.length < 2) { reply({ ok: false, error: 'Only one frame is available, so there is nothing to play.' }); return; }
        state.userPaused = false; void playPlayback(); break;
      case 'pause': pausePlayback({ manual: true }); break;
      case 'step_forward': pausePlayback({ manual: true }); await selectFrame(Math.min(last, state.index + 1)); break;
      case 'step_back': pausePlayback({ manual: true }); await selectFrame(Math.max(0, state.index - 1)); break;
      case 'first_frame': pausePlayback({ manual: true }); await selectFrame(0); break;
      case 'last_frame': pausePlayback({ manual: true }); await selectFrame(last); break;
      case 'go_to_frame': {
        if (!(detail.frame >= 1 && detail.frame <= state.frames.length)) { reply({ ok: false, error: `Frame must be between 1 and ${state.frames.length}.` }); return; }
        pausePlayback({ manual: true }); await selectFrame(detail.frame - 1); break;
      }
      case 'go_to_date': {
        const index = frameIndexForDate(detail.date);
        if (index < 0) { reply({ ok: false, error: 'That date is not valid.' }); return; }
        pausePlayback({ manual: true }); await selectFrame(index); break;
      }
      case 'set_speed': setSpeed(detail.speed); break;
      case 'pin_reference': {
        const frame = state.frames[state.index];
        window.dispatchEvent(new CustomEvent('sky:reference-frame-pinned', { detail: { key: observationKey(frame) } }));
        break;
      }
      default: reply({ ok: false, error: `Unknown playback action ${detail.action}.` }); return;
    }
    reply({ ok: true });
  } catch (error) { reply({ ok: false, error: error?.message || 'Playback failed.' }); }
});
window.addEventListener('sky:agent-state-requested', publishPlaybackState);
// A YYYY-MM-DD date names the frame observed that UTC day; without one, the
// nearest frame to midday wins.
function frameIndexForDate(date) {
  const time = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(time) || !state.frames.length) return -1;
  const sameDay = state.frames.findIndex(frame => new Date(frameTime(frame)).toISOString().slice(0, 10) === date
    || (frame.observedStartUtc || '').slice(0, 10) === date);
  return sameDay >= 0 ? sameDay : nearestFrameIndexByTime(state.frames, time);
}
// A link from the guide can name a pinned reference date; pin it once frames exist.
let pendingReferenceDate = '';
window.addEventListener('sky:reference-date-requested', event => { pendingReferenceDate = event.detail?.date || ''; });
function applyPendingReference() {
  if (!pendingReferenceDate || !state.frames.length) return;
  const index = frameIndexForDate(pendingReferenceDate);
  pendingReferenceDate = '';
  if (index < 0) return;
  const frame = state.frames[index];
  window.dispatchEvent(new CustomEvent('sky:reference-frame-pinned', { detail: { key: observationKey(frame) } }));
}

document.addEventListener('keydown', event => {
  if (!state.frames.length || state.viewMode === 'deep-stack' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(event.target?.tagName)) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); pausePlayback({ manual: true }); void selectFrame(state.index - 1); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); pausePlayback({ manual: true }); void selectFrame(state.index + 1); }
  else if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
});

window.addEventListener('sky:viewer-settings-changed', event => {
  const detail = event.detail || {};
  const modeChanged = detail.viewMode && detail.viewMode !== state.viewMode;
  if (modeChanged) {
    const leavingSixDetector = state.viewMode === 'six-detector';
    state.viewMode = detail.viewMode;
    // Difference and motion trail can still be played frame by frame; blink
    // animates on its own and a deep stack has no timeline position.
    if (state.viewMode === 'deep-stack' || state.viewMode === 'blink' || state.viewMode === 'six-detector') pausePlayback();
    // The six-detector panels download their own frames; keep warm-up out of their way.
    if (state.viewMode === 'six-detector') stopPrefetch(); else if (leavingSixDetector) schedulePrefetch(0);
    updateModeUi();
    updateCurrent();
  }
  if (detail.pinnedReferenceKey !== undefined && detail.pinnedReferenceKey !== state.pinnedKey) {
    state.pinnedKey = detail.pinnedReferenceKey || '';
    updateCurrent({ keepSlider: true });
    publishPlaybackState();
  }
  const fov = detail.fovArcmin === undefined ? prefetch.fov : Number(detail.fovArcmin);
  if (fov !== prefetch.fov) {
    prefetch.fov = fov;
    // Every cutout URL encodes the field of view, so a new FOV invalidates warm-up.
    resetPrefetch();
    if (state.frames.length > 1) {
      prefetchNote = true;
      prefetchAnnounce();
      schedulePrefetch(0);
    }
  }
  const band = detail.band === undefined ? state.band : Number(detail.band);
  const combine = detail.combineExposures === undefined ? state.combineExposures : Boolean(detail.combineExposures);
  // Slices span every detector; showing one syncs the band, which must not
  // rebuild the sequence.
  if (state.axis === 'wavelength') {
    state.band = band; state.combineExposures = combine;
    if (modeChanged && state.viewMode === 'time-lapse') void activateTimeline();
    return;
  }
  if (band === state.band && combine === state.combineExposures) {
    if (modeChanged && state.viewMode === 'time-lapse') void activateTimeline();
    return;
  }
  // Playing a cutout syncs the viewer to its detector. If the timeline already
  // holds that band (including a fallback band), keep playback running.
  const framesMatchBand = state.frames.length > 0 && state.frames.every(frame => Number(frame.detector) === band);
  if (detail.source === 'cutout' && framesMatchBand) { state.band = band; return; }
  state.band = band;
  state.combineExposures = combine;
  rebuild({ keepTime: true });
  void activateTimeline();
});

// wavelength-slices.js switches the order once it knows each exposure's
// wavelength at the target; 'date' switches back.
window.addEventListener('sky:timeline-axis-changed', event => {
  const axis = event.detail?.axis === 'wavelength' && event.detail?.wavelengths ? 'wavelength' : 'date';
  if (axis === state.axis && event.detail?.wavelengths === state.wavelengths) return;
  state.axis = axis;
  state.wavelengths = axis === 'wavelength' ? event.detail.wavelengths : null;
  rebuild();
  void activateTimeline();
});

window.addEventListener('sky:target-selected', () => {
  pausePlayback();
  state.userPaused = false;
  state.axis = 'date'; state.wavelengths = null;
  state.observations = [];
  state.frames = [];
  state.token++;
  state.shownKey = null;
  prefetchNote = false;
  resetPrefetch();
});

window.addEventListener('sky:observations-loading', () => {
  clearTimeout(loadingProgressTimer);
  searchPending = true; archivePending = true; selectedPending = false;
  paintLoadingProgress(0);
  loadingProgressTimer = setTimeout(tickLoadingProgress, 70);
  updatePreviewLoading();
  state.observations = [];
  rebuild({ announce: false });
  setStatus('Searching the archive for dated observations…');
});

async function activateTimeline() {
  if (!state.frames.length || state.viewMode === 'deep-stack') return;
  // Loading results, changing bands, or restoring a link never starts playback.
  const frames = state.frames;
  try { await selectFrame(state.index); }
  finally {
    if (state.frames === frames) { selectedPending = false; updatePreviewLoading(); }
  }
}

window.addEventListener('sky:observations-loaded', event => {
  archivePending = false;
  // New results need their own wavelengths; go back to date order.
  state.axis = 'date'; state.wavelengths = null;
  selectedPending = Boolean(event.detail?.observations?.length) && !event.detail?.failed;
  state.observations = Array.isArray(event.detail?.observations) ? event.detail.observations : [];
  rebuild();
  if (!state.frames.length || event.detail?.failed) selectedPending = false;
  updatePreviewLoading();
  if (event.detail?.failed) { setStatus('The archive search did not complete. Adjust the filters and try again.'); return; }
  const pending = takePendingFrameDate();
  if (pending && state.frames.length) {
    const index = frameIndexForDate(pending);
    if (index >= 0) {
      state.index = index;
      window.dispatchEvent(new CustomEvent('sky:frame-date-restored'));
    }
  }
  applyPendingReference();
  void activateTimeline();
});

function paintThumbFrom(observation, source) {
  if (!observation || !source) return;
  const key = observationKey(observation);
  const entry = state.thumbs.get(key);
  if (!entry) return;
  paintThumb(entry.canvas, source);
  entry.button.classList.add('has-thumb');
  try { state.cache.set(key, entry.canvas.toDataURL('image/jpeg', 0.72)); } catch {}
}

// Warm-up renders each frame off-screen, so the filmstrip fills in with real
// images while the archive is still downloading the rest of the sequence.
window.addEventListener('sky:cutout-warmed', event => {
  const observation = event.detail?.observation;
  paintThumbFrom(observation, event.detail?.canvas);
  if (observation && event.detail?.stackRecord) {
    const frame = state.frames.find(item => observationKey(item) === observationKey(observation));
    if (frame) frame.stackRecord = event.detail.stackRecord;
  }
});

window.addEventListener('sky:deep-stack-error', () => { selectedPending = false; updatePreviewLoading(); });
window.addEventListener('sky:deep-stack-built', event => {
  selectedPending = false; updatePreviewLoading();
  const record = event.detail?.record;
  if (!record) return;
  $('timeline-status').textContent = record.failedObservationIds.length
    ? `Deep stack ready; ${record.failedObservationIds.length} source exposures were skipped. See the frame contribution CSV for statuses.`
    : `Deep stack ready from ${record.usedFrameCount} UTC-day frames. The median stack excludes masked, missing, and uncovered samples.`;
  if (record.excludedByFrameLimit) $('timeline-status').textContent += ` ${record.excludedByFrameLimit} later frame${record.excludedByFrameLimit === 1 ? ' was' : 's were'} outside the configured limit.`;
  $('timeline-meta').hidden = false;
  $('timeline-meta').textContent = `Deep median · ${record.usedFrameCount}/${record.availableFrameCount} available UTC-day frames · ${record.usedExposureCount} exposures · ${record.validPixelContributions.toLocaleString()} valid frame-pixel contributions · ${Math.round(record.exposureSeconds)} s total`;
  $('frame-provenance-text').textContent = `${record.method}. Source observation IDs: ${record.observationIds.join(', ')}. Skipped IDs: ${record.failedObservationIds.join(', ') || 'none'}. ${record.excludedByFrameLimit || 0} frames excluded by the configured limit. Full product IDs and exposure-level details are available in the contributor CSV.`;
});

window.addEventListener('sky:cutout-rendered', event => {
  const observation = event.detail?.observation;
  if (!observation) return;
  if (event.detail?.stackRecord?.deepStack) return;
  const key = observationKey(observation);
  state.shownKey = key;
  prefetch.fetched.add(key);
  paintThumbFrom(observation, event.detail?.canvas || document.getElementById('sky-canvas'));
  const current = state.frames[state.index];
  if (current && key === observationKey(current)) {
    // The date is already on the timeline, so nothing is said once the frame is up.
    setStatus('');
  }
});

window.addEventListener('sky:cutout-error', event => {
  const observation = event.detail?.observation;
  if (!observation) return;
  const current = state.frames[state.index];
  if (current && observationKey(current) === observationKey(observation)) {
    prefetch.failed.add(observationKey(observation));
    state.shownKey = null;
    setStatus(`Frame ${state.index + 1} could not be loaded: ${event.detail.error?.message || 'the cutout is unavailable.'} Playback is paused.`);
    pausePlayback();
  }
});

$('speed-value').textContent = `${state.speed}×`;
render();
setStatus('Search for a target to build a dated time-lapse. Timeline ticks are placed at the real observation dates, so long gaps appear as long spaces.');

$('export-frame-csv').addEventListener('click', () => {
  if (!state.frames.length) return;
  const headers = ['frame', 'periodUtcDate', 'periodStartUtc', 'periodEndUtc', 'detector', 'stackMethod', 'requestedExposures', 'usedExposures', 'totalExposureSeconds', 'validPixelContributions', 'coveredOutputPixels', 'observationId', 'productId', 'release', 'processingVersion', 'exposureStartUtc', 'exposureSeconds', 'validOutputPixels', 'contributionStatus'];
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = [headers.join(',')];
  state.frames.forEach((frame, index) => {
    const record = frame.stackRecord, contributors = new Map((record?.contributors || []).map(item => [item.observationId, item]));
    const failed = new Set(record?.failedObservationIds || []), exposures = frame.exposures || [frame];
    const periodStart = exposures.map(item => item.observedStartUtc).filter(Boolean).sort()[0] || '';
    const periodEnd = exposures.map(item => item.observedEndUtc || item.observedStartUtc).filter(Boolean).sort().at(-1) || '';
    for (const exposure of exposures) {
      const id = exposure.observationId || '', used = contributors.get(id);
      const status = !record ? 'not loaded' : used ? 'included in median stack' : failed.has(id) ? 'fetch failed' : 'not included';
      const values = [index + 1, periodStart.slice(0, 10), periodStart, periodEnd, exposure.detector, record?.method || (exposures.length > 1 ? 'per-pixel median' : 'single exposure'), record?.requestedExposureCount ?? exposures.length, record?.usedExposureCount ?? '', record?.exposureSeconds ?? '', record?.validPixelContributions ?? '', record?.coveredOutputPixels ?? '', id, exposure.productId, exposure.release || exposure.collection, exposure.processingVersion, exposure.observedStartUtc, exposure.exposureSeconds, used?.validOutputPixels ?? '', status];
      rows.push(values.map(cell).join(','));
    }
  });
  const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'spherex-frame-contributions.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
