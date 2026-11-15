// "Where SPHEREx looks" explainer for the wavelength map in viewer.html.
// Draws the rainbow + infrared slice SPHEREx covers,
// animates a light wave whose crests spread apart as wavelength grows, and
// links the D1–D6 lanes (rendered by observations-ui.js) to the zoomed strip.
// Keep AXIS_MIN / AXIS_MAX in sync with the lane maths in observations-ui.js.
export const AXIS_MIN = 0.38, AXIS_MAX = 5;
import { DETECTOR_BANDS } from './lib/detectors.js';
export const DETECTORS = DETECTOR_BANDS;
const pct = um => 100 * (um - AXIS_MIN) / (AXIS_MAX - AXIS_MIN);
const VISIBLE_END = pct(0.75);

const $ = id => document.getElementById(id);
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const map = document.querySelector('.spectral-map');

function buildZoomStrip() {
  const strip = $('zoom-strip');
  if (!strip) return;
  strip.style.setProperty('--visible-end', `${VISIBLE_END}%`);
  const bands = strip.querySelector('.zoom-detectors');
  DETECTORS.forEach(([low, high], index) => {
    const band = document.createElement('span');
    band.style.left = `${pct(low)}%`; band.style.width = `${pct(high) - pct(low)}%`;
    band.style.setProperty('--band-color', `var(--d${index + 1})`);
    band.title = `D${index + 1} stand-in color · ${low.toFixed(2)}–${high.toFixed(2)} μm`;
    bands?.append(band);
  });
  const ticks = $('spectral-ticks');
  for (const value of [0.4, 1, 2, 3, 4, 5]) {
    const tick = document.createElement('span');
    tick.style.left = `${pct(value)}%`;
    tick.textContent = value === 5 ? '5 μm' : String(value);
    ticks?.append(tick);
  }
}

// A light wave whose period is proportional to its wavelength: crests are
// tight under the rainbow and spread out across the infrared.
// Points are spaced evenly in phase, so the tight violet crests stay smooth.
const WIDTH = 1000, MID = 30, AMPLITUDE = 15, POINTS_PER_CYCLE = 20;
const UNITS_PER_UM = WIDTH / (AXIS_MAX - AXIS_MIN), PERIOD_PER_UM = 30;
const PHASE_SCALE = 2 * Math.PI * UNITS_PER_UM / PERIOD_PER_UM;
const totalPhase = PHASE_SCALE * Math.log(AXIS_MAX / AXIS_MIN);
const pointCount = Math.ceil(totalPhase / (2 * Math.PI) * POINTS_PER_CYCLE);
const samples = Array.from({ length: pointCount + 1 }, (_, i) => {
  const phase = totalPhase * i / pointCount;
  return [(AXIS_MIN * Math.exp(phase / PHASE_SCALE) - AXIS_MIN) * UNITS_PER_UM, phase];
});
const wavePaths = [...document.querySelectorAll('#spectrum-wave .wave-path')];
function drawWave(time) {
  let d = '';
  for (let i = 0; i < samples.length; i++) {
    const [x, phase] = samples[i], y = MID + AMPLITUDE * Math.sin(phase - time * 0.0042);
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(2)}`;
  }
  for (const path of wavePaths) path.setAttribute('d', d);
}

let visible = false, frame = 0, lastDraw = 0;
function tick(time) {
  frame = 0;
  if (!visible || document.hidden || reducedMotion?.matches) return;
  if (time - lastDraw > 30) { drawWave(time); lastDraw = time; }
  frame = requestAnimationFrame(tick);
}
function startWave() {
  if (reducedMotion?.matches) { drawWave(900); return; }
  if (!frame) frame = requestAnimationFrame(tick);
}

// Detector scan-in: replays each time new lanes arrive and the map is on screen.
let scanPending = true, scanTimer;
function playScan() {
  if (!scanPending || !visible || reducedMotion?.matches || !map) return;
  if (!$('spectral-lanes')?.children.length) return;
  scanPending = false;
  map.classList.remove('is-scanning');
  void map.offsetWidth; // restart the CSS animations
  map.classList.add('is-scanning');
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => map.classList.remove('is-scanning'), 2400);
}

function linkLanes() {
  const lanes = $('spectral-lanes'), highlight = $('zoom-highlight');
  if (!lanes || !highlight) return;
  const label = highlight.querySelector('span');
  const show = lane => {
    if (!lane) return;
    const low = Number(lane.dataset.low), high = Number(lane.dataset.high), detector = lane.dataset.detector;
    highlight.style.left = `${pct(low)}%`; highlight.style.width = `${pct(high) - pct(low)}%`;
    highlight.style.setProperty('--band-color', `var(--d${detector})`);
    highlight.classList.toggle('align-end', pct(low) > 62);
    label.textContent = `D${detector} · ${low.toFixed(2)}–${high.toFixed(2)} μm`;
    highlight.hidden = false;
    lanes.classList.add('is-focusing');
    for (const other of lanes.children) other.classList.toggle('is-active', other === lane);
  };
  const hide = () => {
    highlight.hidden = true;
    lanes.classList.remove('is-focusing');
    for (const other of lanes.children) other.classList.remove('is-active');
  };
  lanes.addEventListener('pointerover', event => show(event.target.closest?.('.spectral-lane')));
  lanes.addEventListener('pointerleave', () => { if (!lanes.contains(document.activeElement)) hide(); });
  lanes.addEventListener('focusin', event => show(event.target.closest?.('.spectral-lane')));
  lanes.addEventListener('focusout', event => { if (!lanes.contains(event.relatedTarget)) hide(); });
}

if (map) {
  buildZoomStrip();
  linkLanes();
  drawWave(0);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) { startWave(); playScan(); }
  }, { threshold: 0.25 });
  observer.observe(map);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) startWave(); });
  reducedMotion?.addEventListener?.('change', () => (visible ? startWave() : drawWave(900)));
  window.addEventListener('sky:spectral-lanes-rendered', () => { scanPending = true; playScan(); });
}
