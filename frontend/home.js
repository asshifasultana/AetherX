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
  const navigate = (entry, position) => location.assign(viewerUrl(entry, position));
  mountTargetSearch({
    onObject: query => navigate({ type: 'object', query }),
    onCoordinates: position => navigate({ type: 'coordinates', query: '', format: document.getElementById('coordinate-format').value }, position),
    onPreset: (targetId, target) => navigate({ type: 'object', query: target.name }, { raDeg: target.raDeg, decDeg: target.decDeg, targetId }),
    onMoving: entry => navigate(entry)
  });
}
