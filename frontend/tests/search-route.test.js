import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { readSearchEntry, hasSavedPosition, encodeSearchView, viewerUrl, legacyViewerDestination } from '../search-route.js';
import { DEFAULT_VIEW_STATE, decodeViewState, VIEW_SETTING_PARAMS } from '../url-state.js';

const shareSource = (await readFile(new URL('../share.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '').replace(/^export /gm, '');
function mountShare(search) {
  const listeners = new Map(), writes = [], timers = [];
  const location = { origin: 'https://atlas.example', pathname: '/viewer.html', search, hash: '#explorer' };
  const context = {
    location, readSearchEntry, encodeSearchView, decodeViewState, VIEW_SETTING_PARAMS,
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    history: { state: null, replaceState: (_state, _title, url) => writes.push(url) },
    setTimeout: callback => { timers.push(callback); return timers.length; }
  };
  context.window.parent = context.window;
  runInNewContext(shareSource, context);
  return { url: () => context.shareUrl(), emit: (type, detail) => listeners.get(type)({ detail }), flush: () => { while (timers.length) timers.shift()(); }, writes };
}

test('entry parsing recognizes explicit positions, presets, moving dates and coordinate formats', () => {
  assert.equal(hasSavedPosition('?ra=269.4521&dec=4.6934'), true);
  assert.equal(hasSavedPosition('?ra=&dec=2'), false);
  assert.equal(hasSavedPosition('?ra=1&dec=91'), false);
  assert.equal(hasSavedPosition('?target=epsilon'), true);
  assert.equal(readSearchEntry('?ra=120&dec=-7.5&format=sexagesimal').type, 'coordinates');
  assert.equal(readSearchEntry('?ra=120&dec=-7.5&format=sexagesimal').format, 'sexagesimal');
  assert.equal(readSearchEntry('?searchType=unexpected&q=Sirius').type, 'object');
  assert.equal(readSearchEntry('?searchType=moving&detector=9').detector, '');
});

test('viewer destinations encode names safely and retain default coordinates when resolved', () => {
  const name = 'Barnard’s Star & a+b';
  const pending = new URL(viewerUrl({ type: 'object', query: name }), 'https://atlas.example');
  assert.equal(pending.searchParams.get('q'), name); assert.equal(pending.searchParams.has('ra'), false);
  const saved = new URL(viewerUrl({ type: 'object', query: name }, DEFAULT_VIEW_STATE), 'https://atlas.example');
  assert.equal(saved.searchParams.get('ra'), '269.4521'); assert.equal(saved.searchParams.get('dec'), '4.6934');
  assert.equal(readSearchEntry(saved.search).resolved, true);
});

test('legacy home links preserve their complete search and fragment and do not loop on viewer', () => {
  for (const search of ['?ra=1&dec=2&band=3', '?embed=1', '?target=wise', '?searchType=moving&q=4+Vesta', '?ra=invalid']) {
    assert.equal(legacyViewerDestination({ pathname: '/', search, hash: '#explorer' }), '/viewer.html' + search + '#explorer');
    assert.equal(legacyViewerDestination({ pathname: '/viewer.html', search, hash: '' }), null);
  }
  assert.equal(legacyViewerDestination({ pathname: '/index.html', search: '', hash: '' }, true), '/viewer.html');
  assert.equal(legacyViewerDestination({ pathname: '/', search: '?utm_source=test', hash: '' }), null);
});

test('URL updates preserve pending names, then save resolved coordinates for refresh and sharing', () => {
  const share = mountShare('?searchType=object&q=Sirius');
  share.emit('sky:search-entry', { type: 'object', query: 'M31' });
  share.emit('sky:viewer-settings-changed', { band: 3 }); share.flush();
  let params = new URL(share.url()).searchParams;
  assert.equal(params.get('q'), 'M31'); assert.equal(params.has('ra'), false); assert.equal(params.get('band'), '3');
  share.emit('sky:target-selected', { raDeg: 10.6847, decDeg: 41.269 }); share.flush();
  params = new URL(share.url()).searchParams;
  assert.equal(params.get('q'), 'M31'); assert.equal(params.get('ra'), '10.6847');
  assert.equal(readSearchEntry(params).resolved, true);
  assert.ok(share.writes.at(-1).endsWith('#explorer')); assert.equal(new URL(share.url()).pathname, '/viewer.html');
});

test('moving search URLs retain their filters through viewer updates and never inherit a fixed target', () => {
  const share = mountShare('?ra=1&dec=2&target=barnard');
  share.emit('sky:search-entry', { type: 'moving', query: '4 Vesta', startDate: '2025-08-10', endDate: '2025-08-15', detector: '2' });
  share.emit('sky:viewer-settings-changed', { band: 4 });
  share.emit('sky:search-filters-changed', { startDate: '2026-01-01', endDate: '2026-02-01' }); share.flush();
  const url = new URL(share.url()), params = url.searchParams;
  assert.equal(params.get('searchType'), 'moving'); assert.equal(params.get('q'), '4 Vesta');
  assert.equal(params.get('from'), '2025-08-10'); assert.equal(params.get('to'), '2025-08-15'); assert.equal(params.get('detector'), '2');
  assert.equal(params.has('ra'), false); assert.equal(params.has('target'), false);
});
