import { mountTargetSearch } from './target-search.js';
import { legacyViewerDestination, viewerUrl } from './search-route.js';
import { mountStarfield } from './starfield.js';

const starfield = document.getElementById('starfield');
if (starfield) mountStarfield(starfield, {
  labels: true,
  // Keep names clear of the header and of each visible block of the search panel.
  avoid: ['.site-header', '.home-search .eyebrow', '#home-title', '.home-description', '#target-picker']
});

const destination = legacyViewerDestination(location, window.self !== window.top);
if (destination) location.replace(destination);
else {
  // The search panel fades away first, leaving only the sky; the viewer then opens
  // straight onto its loading screen (see search-loader.js and viewer.html).
  // A second search during the fade (Enter pressed twice) replaces the first.
  let departure = null;
  const navigate = (entry, position) => {
    const url = viewerUrl(entry, position);
    try {
      if (entry.type === 'moving') sessionStorage.removeItem('spherex-arrival');
      else sessionStorage.setItem('spherex-arrival', '1');
    } catch { /* storage may be blocked; the viewer then simply opens without the hand-off */ }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.body?.classList.add('is-departing');
    document.activeElement?.blur?.();
    clearTimeout(departure);
    departure = setTimeout(() => location.assign(url), reduced ? 200 : 700);
  };
  // Back/Forward restores this page from the cache with the panel still faded.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    clearTimeout(departure);
    document.body?.classList.remove('is-departing');
  });
  mountTargetSearch({
    onObject: query => navigate({ type: 'object', query }),
    onCoordinates: position => navigate({ type: 'coordinates', query: '', format: document.getElementById('coordinate-format').value }, position),
    onPreset: (targetId, target) => navigate({ type: 'object', query: target.name }, { raDeg: target.raDeg, decDeg: target.decDeg, targetId }),
    onMoving: entry => navigate(entry)
  });
}
