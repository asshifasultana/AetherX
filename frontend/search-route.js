import { decodeViewState, encodeViewState } from './url-state.js';
import { presets } from './presets.js';

const viewKeys = ['ra', 'dec', 'fov', 'band', 'from', 'to', 'at', 'mra', 'mdec', 'target', 'embed','culture','gaia','wise'];
const searchTypes = ['object', 'moving', 'coordinates'];
const paramsFor = input => input instanceof URLSearchParams ? input : new URLSearchParams(String(input).replace(/^\?/, ''));

export function hasSavedPosition(input) {
  const params = paramsFor(input);
  if (presets[params.get('target')]) return true;
  return params.has('ra') && params.has('dec') && params.get('ra').trim() !== '' && params.get('dec').trim() !== ''
    && Number.isFinite(Number(params.get('ra'))) && Number.isFinite(Number(params.get('dec')))
    && Number(params.get('dec')) >= -90 && Number(params.get('dec')) <= 90;
}

export function readSearchEntry(input = '') {
  const params = paramsFor(input), { state } = decodeViewState(params.toString());
  const type = searchTypes.includes(params.get('searchType')) ? params.get('searchType')
    : params.has('target') ? 'object' : params.has('ra') || params.has('dec') ? 'coordinates' : 'object';
  return {
    type, query: params.get('q') || presets[state.targetId]?.name || '',
    startDate: state.startDate, endDate: state.endDate,
    detector: /^[1-6]$/.test(params.get('detector') || '') ? params.get('detector') : '',
    format: params.get('format') === 'sexagesimal' ? 'sexagesimal' : 'degrees',
    resolved: type !== 'moving' && hasSavedPosition(params)
  };
}

// Combine viewer state with entry metadata. Pending names and moving searches
// must never inherit a previous fixed sky position from the viewer.
export function encodeSearchView(state, entry = null) {
  const params = new URLSearchParams(encodeViewState(state));
  if (!entry) return params.toString();
  params.set('searchType', entry.type);
  if (entry.query) params.set('q', entry.query);
  if (entry.type === 'coordinates' && entry.format === 'sexagesimal') params.set('format', entry.format);
  if (entry.type === 'moving' || !entry.resolved) {
    for (const key of ['ra', 'dec', 'target', 'at', 'mra', 'mdec']) params.delete(key);
  } else {
    // Explicit coordinates preserve even the default position and avoid a
    // second catalog lookup on refresh after a successful name search.
    params.set('ra', String(state.raDeg)); params.set('dec', String(state.decDeg));
  }
  if (entry.type === 'moving') {
    for (const [key, value] of [['from', entry.startDate], ['to', entry.endDate], ['detector', entry.detector]]) {
      if (value) params.set(key, value); else params.delete(key);
    }
  }
  return params.toString();
}

export function viewerUrl(entry, position = {}) {
  return '/viewer.html?' + encodeSearchView(position, { ...entry, resolved: Number.isFinite(position.raDeg) && Number.isFinite(position.decDeg) });
}

export function legacyViewerDestination(location, embedded = false) {
  if (!['/', '/index.html'].includes(location.pathname)) return null;
  const params = paramsFor(location.search);
  if (!embedded && !viewKeys.some(key => params.has(key)) && !params.has('searchType')) return null;
  return '/viewer.html' + location.search + location.hash;
}
