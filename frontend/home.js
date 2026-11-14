import { mountTargetSearch } from './target-search.js';
import { legacyViewerDestination, viewerUrl } from './search-route.js';

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
