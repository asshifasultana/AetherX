import { mountTargetSearch } from './target-search.js';
import { legacyViewerDestination, viewerUrl } from './search-route.js';
import { mountStarfield } from './starfield.js';

const starfield = document.getElementById('starfield');
if (starfield) mountStarfield(starfield);

// Pointer launches fade the homepage chrome out over the still-running
// starfield before the viewer document takes over. Keyboard launches and
// reduced-motion visitors keep the instant navigation they expect.
const FADE_MS = 170;
const POINTER_WINDOW_MS = 1000;
const canFade = typeof window.matchMedia === 'function' && Boolean(document.body);
let lastPointerAt = -Infinity;
let leaving = false;
const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);
window.addEventListener('pointerdown', () => { lastPointerAt = now(); }, { capture: true, passive: true });
window.addEventListener('pageshow', () => {
  leaving = false;
  document.body?.classList.remove('is-leaving');
});

function go(url) {
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!canFade || reduced || leaving || now() - lastPointerAt > POINTER_WINDOW_MS) {
    location.assign(url);
    return;
  }
  leaving = true;
  document.body.classList.add('is-leaving');
  setTimeout(() => location.assign(url), FADE_MS);
}

const destination = legacyViewerDestination(location, window.self !== window.top);
if (destination) location.replace(destination);
else {
  const navigate = (entry, position) => go(viewerUrl(entry, position));
  mountTargetSearch({
    onObject: query => navigate({ type: 'object', query }),
    onCoordinates: position => navigate({ type: 'coordinates', query: '', format: document.getElementById('coordinate-format').value }, position),
    onPreset: (targetId, target) => navigate({ type: 'object', query: target.name }, { raDeg: target.raDeg, decDeg: target.decDeg, targetId }),
    onMoving: entry => navigate(entry)
  });
}
