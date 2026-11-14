// The full-screen search loader. While a search runs the page fades away, the
// SPHEREx wordmark appears inside a ring that fills with progress, and once the
// archive answers, the target's name, constellation and distance take its place.
// timelapse.js decides progress and readiness; this module only presents them.
import { constellationAt } from './lib/constellation.js';
import { distanceLabel } from './lib/distance.js';
import { presets } from './presets.js';

const $ = id => document.getElementById(id);
const root = document.documentElement;
const loader = $('preview-loading');
const embedded = root.classList.contains('is-embed');
let cancelling = false;
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
const reduced = () => Boolean(reducedMotion?.matches);

// Timings match the CSS transitions in styles.css.
const PAGE_FADE_MS = 650;      // the page steps aside before the loader opens
const EXIT_MS = 900;           // the loader's own fade-out
const REVEAL_MS = 1200;        // the page fading back in
const RING_SETTLE_MS = 650;    // let a completed ring be seen before leaving
const TARGET_HOLD_MS = 3200;   // the target card stays at least this long
const ms = value => reduced() ? Math.min(value, 250) : value;

// Catalog identifiers that resolve reliably for the curated presets.
const PRESET_LOOKUPS = { barnard: 'GJ 699', epsilon: 'eps Ind B', wise: 'WISEA J085510.74-071442.5', aurigae: 'RW Aur', draconis: 'R Dra' };

let active = false, leaving = false, stage = 'intro', failed = false, ready = false;
let targetShownAt = 0, openTimer = null, exitTimer = null, closeTimer = null, revealTimer = null;
let target = null;
let searchedName = '';         // what the visitor typed, shown instead of a catalog designation
const distances = new Map();   // lower-case lookup name -> label, null, or a pending promise

const setText = (id, text) => { const element = $(id); if (element) element.textContent = text || ''; };
const announce = text => setText('preview-loading-status', text);
const setProgress = value => {
  const ring = $('preview-loading-ring');
  if (ring) ring.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, Number(value) || 0)));
};
const clearTimers = () => { for (const timer of [openTimer, exitTimer, closeTimer]) clearTimeout(timer); openTimer = exitTimer = closeTimer = null; };

// "Did you know?" facts shown under the ring, one at a time, while the loader is open.
// Sources: https://science.nasa.gov/universe/stars/
// https://science.nasa.gov/blogs/spherex/2025/03/11/nasas-spherex-mission-2/
// https://www.nasa.gov/missions/spherex/why-nasas-spherex-mission-will-make-most-colorful-cosmic-map-ever/
// https://science.nasa.gov/solar-system/planet-x/
const LOADING_FACTS = [
  'The Milky Way alone contains more than 100 billion stars.',
  'SPHEREx sees the sky in 102 infrared colors invisible to human eyes.',
  'Some small stars can shine for trillions of years.',
  'Planet Nine is a predicted world beyond Neptune that has yet to be discovered.',
  'Stars are born inside enormous clouds of gas and dust.',
  'SPHEREx is designed to map the entire sky four times in two years.',
  'The most massive stars may live for only a few million years.',
  'SPHEREx will survey more than 450 million galaxies and 100 million stars.',
  'A baby star is called a protostar.',
  'You can help search for distant worlds using infrared images from NASA’s WISE mission.',
  'Stars shine by fusing hydrogen into helium in their cores.',
  'SPHEREx searches for frozen water and other ingredients for life between stars.',
  'Our Sun is roughly halfway through its main-sequence lifetime.',
  'A white dwarf packs a star’s leftover core into roughly Earth’s size.',
  'Massive stars forge elements such as oxygen, neon, and magnesium.',
  'Material shed by dying stars helps build the next generation of stars.'
];
const FACT_INTERVAL_MS = 6000; // how long each fact stays up
const FACT_FADE_MS = 400;      // matches .loader-fact-text's opacity transition
let factIndex = -1, factTimer = null, factFadeTimer = null;

function showFact(index) {
  factIndex = index % LOADING_FACTS.length;
  setText('loader-fact-text', LOADING_FACTS[factIndex]);
  $('loader-fact-text')?.classList.remove('is-changing');
}
function stopFacts() { clearTimeout(factTimer); clearTimeout(factFadeTimer); factTimer = factFadeTimer = null; }
function startFacts() {
  stopFacts();
  showFact(Math.floor(Math.random() * LOADING_FACTS.length));
  const next = () => {
    factTimer = setTimeout(() => {
      $('loader-fact-text')?.classList.add('is-changing');
      factFadeTimer = setTimeout(() => { showFact(factIndex + 1); next(); }, ms(FACT_FADE_MS));
    }, FACT_INTERVAL_MS);
  };
  next();
}

function open({ instant = false } = {}) {
  if (!loader || cancelling) return;
  clearTimers();
  clearTimeout(revealTimer); root.classList.remove('is-revealing');
  root.classList.add('is-searching');
  if (active && !leaving) return;
  active = true; leaving = false; failed = false; ready = false; targetShownAt = 0;
  resetCard();
  startFacts();
  setProgress(0);
  announce('Loading SPHEREx observations');
  loader.classList.remove('is-leaving');
  loader.classList.toggle('is-instant', instant);
  loader.classList.remove('is-shown');
  loader.hidden = false;
  if (!loader.open) loader.showModal?.();
  // Two frames so the hidden starting state is painted before the fade-in starts.
  const frame = globalThis.requestAnimationFrame || (fn => setTimeout(fn, 16));
  frame(() => frame(() => { if (active && !leaving) loader.classList.add('is-shown'); }));
}

function resetCard() {
  setStage('intro');
  setText('loader-target-name', ''); setText('loader-target-region', ''); setText('loader-target-distance', '');
}

function setStage(next) { stage = next; if (loader) loader.dataset.stage = next; }

// Page fades first, then the loader appears in the space it left.
function beginSearch() {
  if (cancelling || (active && !leaving)) return;
  root.classList.add('is-searching');
  clearTimeout(openTimer);
  openTimer = setTimeout(() => open(), ms(PAGE_FADE_MS));
}

function finish() {
  if (!active || leaving) return;
  clearTimers();
  leaving = true;
  loader.classList.add('is-leaving');
  // The page fades back in underneath while the loader fades out on top.
  root.classList.add('is-revealing');
  root.classList.remove('is-arriving', 'is-searching');
  closeTimer = setTimeout(() => {
    active = false; leaving = false;
    loader.close?.();
    loader.hidden = true;
    loader.classList.remove('is-leaving', 'is-instant', 'is-shown');
    stopFacts();
    resetCard();
  }, ms(EXIT_MS));
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => root.classList.remove('is-revealing'), ms(REVEAL_MS));
}

function abort() {
  clearTimeout(openTimer); openTimer = null;
  if (active) finish();
  else root.classList.remove('is-arriving', 'is-searching');
}

const lookupKey = name => name.normalize('NFKC').replace(/[’‘]/g, "'").trim().toLowerCase();

function requestDistance(name) {
  const key = lookupKey(name);
  if (distances.has(key)) return;
  const pending = fetch('/api/resolve-object?' + new URLSearchParams({ name: name.replace(/[’‘]/g, "'") }))
    .then(response => response.ok ? response.json() : null)
    .then(data => data ? distanceLabel(data) : null)
    .catch(() => null)
    .then(label => { distances.set(key, label); if (target?.lookup && lookupKey(target.lookup) === key) showDistance(label); return label; });
  distances.set(key, pending);
}

function showDistance(label) {
  if (stage !== 'target' || !label) return;
  setText('loader-target-distance', `${label} away`);
  announce([target?.name, target?.region && `in ${target.region}`, `${label} away`].filter(Boolean).join(', '));
}

function showTarget() {
  if (!active || leaving || stage === 'target' || !target) return;
  setText('loader-target-name', target.name);
  setText('loader-target-region', target.region ? `In ${target.region}` : '');
  const known = target.lookup ? distances.get(lookupKey(target.lookup)) : null;
  setStage('target');
  targetShownAt = Date.now();
  if (typeof known === 'string') showDistance(known);
  else announce([target.name, target.region && `in ${target.region}`].filter(Boolean).join(', '));
}

function scheduleExit() {
  if (!active || leaving) return;
  if (failed || !target) { finish(); return; }
  showTarget();
  const held = Date.now() - targetShownAt;
  clearTimeout(exitTimer);
  exitTimer = setTimeout(finish, Math.max(ms(RING_SETTLE_MS), ms(TARGET_HOLD_MS) - held));
}

window.addEventListener('sky:search-entry', event => {
  searchedName = event.detail?.type === 'object' ? String(event.detail.query || '').trim() : '';
  if (event.detail?.type === 'moving') abort();
  else beginSearch();
});
window.addEventListener('sky:moving-search-requested', abort);
window.addEventListener('sky:lookup-failed', abort);

// The resolver already sent distance hints for a name search; reuse them.
window.addEventListener('sky:target-distance', event => {
  const detail = event.detail || {};
  if (!detail.name) return;
  const label = distanceLabel(detail);
  distances.set(lookupKey(detail.name), label);
  if (target?.lookup && lookupKey(target.lookup) === lookupKey(detail.name)) showDistance(label);
});

// "Your sky position" and similar placeholders say less than the position itself.
const namedLabel = label => { const text = String(label || '').trim(); return /sky position$/i.test(text) ? '' : text; };
const coordinateName = ({ raDeg, decDeg }) => Number.isFinite(raDeg) && Number.isFinite(decDeg)
  ? `${raDeg.toFixed(3)}°, ${decDeg < 0 ? '−' : '+'}${Math.abs(decDeg).toFixed(3)}°`
  : 'Your sky position';

window.addEventListener('sky:target-selected', event => {
  const detail = event.detail || {}, star = detail.starTarget || {};
  const lookup = star.name || PRESET_LOOKUPS[detail.targetId] || presets[detail.targetId]?.name || null;
  target = {
    name: searchedName || namedLabel(star.label || $('object-name')?.textContent) || coordinateName(detail),
    region: constellationAt(Number(detail.raDeg), Number(detail.decDeg)),
    lookup
  };
  searchedName = '';
  if (lookup) requestDistance(lookup);
});

window.addEventListener('sky:observations-loading', event => {
  // The guided tour's example opens from files saved with the site: there is
  // nothing to wait for, so the viewer is shown straight away.
  if (event.detail?.instant && (!active || leaving)) return;
  if (!active || leaving) { open(); return; }
  // A new search while the previous card is still up starts the card over.
  clearTimeout(exitTimer); exitTimer = null;
  failed = false; ready = false;
  if (stage === 'target') { resetCard(); announce('Loading SPHEREx observations'); }
});
window.addEventListener('sky:loader-progress', event => { if (active && !leaving) setProgress(event.detail?.value); });
window.addEventListener('sky:observations-loaded', event => {
  if (!active || leaving) return;
  if (event.detail?.failed) { failed = true; abort(); return; }
  showTarget();
  if (ready) scheduleExit();
});
window.addEventListener('sky:loader-ready', () => {
  if (!active || leaving) return;
  ready = true;
  setProgress(100);
  if (window.spherexObservationState?.failed) failed = true;
  scheduleExit();
});

function cancelSearch() {
  if (embedded || cancelling) return;
  cancelling = true;
  clearTimers();
  clearTimeout(revealTimer);
  stopFacts();
  window.dispatchEvent(new Event('sky:search-cancel'));
  announce('Search cancelled. Returning to the search page.');
  location.replace('/');
}

$('loader-cancel')?.addEventListener('click', cancelSearch);
loader?.addEventListener('cancel', event => {
  event.preventDefault();
  cancelSearch();
});

if (root.classList.contains('is-arriving')) open({ instant: true });
