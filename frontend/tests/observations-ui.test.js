import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Exercise the browser entrypoint with only its DOM and network boundaries stubbed.
const source = (await readFile(new URL('../observations-ui.js', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function mount(initialViewState = { startDate: '', endDate: '' }) {
  function element() {
    return { textContent: '', value: '', hidden: false, disabled: false, children: [], listeners: {},
      setAttribute() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      addEventListener(type, callback) { this.listeners[type] = callback; } };
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const window = element(), requests = [], events = [];
  // Let the module publish its CustomEvents the way a browser would, so the
  // shareable-link contract can be asserted rather than assumed.
  window.dispatchEvent = event => {
    events.push(event);
    const listener = window.listeners[event.type];
    if (typeof listener === 'function') listener(event);
  };
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  get('search-detector').value = '3'; get('search-release').value = 'qr2';
  get('search-start').value = '2025-05-01'; get('search-end').value = '2025-05-31';
  get('object-name').textContent = '* alf CMa';
  runInNewContext(source, {
    document: { getElementById: get, createElement: element, addEventListener() {} }, window,
    AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval() {}, CustomEvent,
    // The module reads the validated share state at import time; the VM harness
    // strips imports, so the decoded state is supplied the same way the page does.
    initialViewState,
    fetch: async (url, options) => {
      if (url === '/api/index-status') return json({ available: false });
      return new Promise(resolve => requests.push({ url, options, resolve }));
    }
  });
  const select = (raDeg = 101.287155333, decDeg = -16.716115861) => window.listeners['sky:target-selected']({ detail: { raDeg, decDeg, frame: 'icrs' } });
  const submit = () => get('observation-search-form').listeners.submit({ preventDefault() {} });
  return { get, requests, select, submit, events };
}
const emptyResult = (source = { kind: 'live', name: 'NASA/IPAC IRSA', retrievedAt: '2026-11-05T00:00:00Z' }) => ({ observations: [], count: 0, duplicatesRemoved: 0, source, warnings: [] });

test('Sirius outage preserves target and filters and supports a successful retry', async () => {
  const { get, requests, select, submit } = mount();
  select();
  assert.equal(get('find-observations').textContent, 'Searching IRSA…');
  const target = get('search-target').textContent;
  const params = new URL(requests[0].url, 'http://localhost').searchParams;
  assert.deepEqual(Object.fromEntries(params), { raDeg: '101.287155333', decDeg: '-16.716115861', detector: '3', release: 'qr2', startDate: '2025-05-01', endDate: '2025-05-31' });
  requests[0].resolve(json({ error: 'upstream error', code: 'IRSA_UNAVAILABLE' }, 502));
  await flush();
  assert.equal(get('search-error').textContent, 'IRSA’s observation service is temporarily unavailable. Your target is selected. Retry shortly.');
  assert.equal(get('search-error').hidden, false);
  assert.equal(get('find-observations').textContent, 'Retry observations');
  assert.equal(get('find-observations').disabled, false);
  assert.equal(get('search-target').textContent, target);
  submit();
  assert.equal(requests[1].url, requests[0].url);
  assert.equal(get('find-observations').textContent, 'Searching IRSA…');
  requests[1].resolve(json(emptyResult()));
  await flush();
  assert.equal(get('find-observations').textContent, 'Find observations ↗');
  assert.equal(get('search-error').hidden, true);
  assert.equal(get('observation-results').hidden, false);
  assert.match(get('search-status').textContent, /^No observations cover this position/);
});

test('a new target clears retry state and preset fallback retains its outage warning', async () => {
  const { get, requests, select } = mount();
  select(); requests[0].resolve(json({ error: 'Search failed.' }, 502)); await flush();
  assert.equal(get('find-observations').textContent, 'Retry observations');
  select(269.4521, 4.6934);
  assert.equal(get('find-observations').textContent, 'Searching IRSA…');
  const data = emptyResult({ kind: 'scheduled-index', fallback: true, name: 'NASA/IPAC IRSA' });
  data.warnings = ['Live IRSA search was unavailable. Showing the last successful preset index; newer observations or revisions may be missing.'];
  requests[1].resolve(json(data)); await flush();
  assert.equal(get('find-observations').textContent, 'Find observations ↗');
  assert.equal(get('archive-mode-label').textContent, 'Preset index fallback');
  assert.match(get('search-status').textContent, /Live IRSA search was unavailable/);
  assert.equal(get('results-warnings').children[0].textContent, data.warnings[0]);
  assert.equal(get('search-error').hidden, true);
});

test('a shared link seeds the date range before the restored target searches', async () => {
  const { get, requests, select } = mount({ startDate: '2025-07-01', endDate: '2025-09-30' });
  assert.equal(get('search-start').value, '2025-07-01');
  assert.equal(get('search-end').value, '2025-09-30');
  select();
  const params = new URL(requests[0].url, 'http://localhost').searchParams;
  assert.equal(params.get('startDate'), '2025-07-01');
  assert.equal(params.get('endDate'), '2025-09-30');
  requests[0].resolve(json(emptyResult()));
  await flush();
});

test('editing a date publishes the complete range for the shareable link', () => {
  const { get, events } = mount();
  get('search-start').value = '2026-01-05';
  get('search-end').value = '2026-02-10';
  get('search-start').listeners.change();
  get('search-end').listeners.change();
  const published = events.filter(event => event.type === 'sky:search-filters-changed');
  assert.equal(published.length, 2);
  // The payload is built inside the VM realm, so compare its fields rather than
  // relying on cross-realm prototype identity.
  const latest = published.at(-1).detail;
  assert.equal(latest.startDate, '2026-01-05');
  assert.equal(latest.endDate, '2026-02-10');
});
