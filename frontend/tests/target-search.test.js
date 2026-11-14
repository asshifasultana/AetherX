import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseCoordinate, formatSexagesimal } from '../coordinates.js';
import { presets } from '../presets.js';
import { objectNames, normalizeName, suggestNames } from '../object-names.js';
import { DEFAULT_VIEW_STATE, decodeViewState, encodeViewState, linkViewSettings } from '../url-state.js';

import { searchMarkup } from '../target-search.js';
import { readSearchEntry, viewerUrl, legacyViewerDestination } from '../search-route.js';
import * as viewerSettings from '../viewer-settings.js';
const [viewerHtml, homeHtml, app, lookup, moving, searchController, home] = await Promise.all(['viewer.html', 'index.html', 'app.js', 'object-lookup.js', 'moving-target.js', 'target-search.js', 'home.js'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')));
const withoutImports = source => source.replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const resolved = { submittedName: 'Sirius', resolvedName: '* alf CMa', raDeg: 101.287, decDeg: -16.716, frame: 'icrs', source: { name: 'SIMBAD', resolver: 'Sesame' }, retrievedAt: '2026-11-07' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// Exercise the real entrypoints together. Every requested ID must exist in the
// shipped HTML; only DOM and network boundaries are replaced, as in observations-ui.test.js.
function mount({ fetchImpl = async () => json(resolved), initial = {}, page = 'viewer', search = '' } = {}) {
  const html = (page === 'home' ? homeHtml : viewerHtml) + searchMarkup;
  const navigations = [];
  const location = { pathname: page === 'home' ? '/' : '/viewer.html', search, hash: '', assign: url => navigations.push(url), replace: url => navigations.push(url) };
  const elements = new Map(), targets = [], requests = [], events = [], workerMessages = [];
  let focused;
  function element(attributes = {}) {
    const listeners = new Map();
    return {
      value: attributes.value || '', hidden: 'hidden' in attributes, disabled: 'disabled' in attributes,
      textContent: '', children: [], dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
      setAttribute(key, value) { attributes[key] = value; }, removeAttribute(key) { delete attributes[key]; },
      getAttribute(key) { return attributes[key]; },
      focus() { focused = this; }, append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelectorAll(selector) {
        const descendants = items => items.flatMap(item => [item, ...descendants(item.children || [])]);
        return descendants(this.children).filter(item => item.type === 'checkbox' && (selector !== 'input:checked' || item.checked));
      },
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); return true; },
      click() { this.dispatchEvent({ type: 'click', preventDefault() {} }); }
    };
  }
  for (const match of html.matchAll(/<[a-z][^>]*>/gi)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (/\shidden(?:\s|>)/.test(match[0])) attrs.hidden = '';
    if (/\sdisabled(?:\s|>)/.test(match[0])) attrs.disabled = '';
    if (attrs.id) { assert.ok(!elements.has(attrs.id), 'duplicate ID ' + attrs.id); elements.set(attrs.id, element(attrs)); }
    if (attrs['data-target']) { const item = element(attrs); item.dataset.target = attrs['data-target']; targets.push(item); }
  }
  const get = id => { assert.ok(elements.has(id), 'missing HTML element ' + id); return elements.get(id); };
  get('coordinate-format').value = 'degrees'; get('target-type').value = 'object';
  const form = get('target-search-form');
  // Named fields used by the existing moving-object workflow.
  const dateFields = [element(), element(), element()];
  form.elements = { object: get('lookup-name'), startDate: dateFields[0], endDate: dateFields[1], detector: dateFields[2] };
  form.reportValidity = () => get('target-type').value === 'coordinates'
    || (Boolean(form.elements.object.value) && (get('target-type').value !== 'moving' || (Boolean(dateFields[0].value) && Boolean(dateFields[1].value))));
  form.requestSubmit = () => form.dispatchEvent({ type: 'submit', preventDefault() {} });
  const window = element(), dispatch = window.dispatchEvent.bind(window);
  window.dispatchEvent = event => { events.push(event); return dispatch(event); };
  window.self = window.top = window;
  const document = { getElementById: id => elements.get(id) || null, createElement: () => element(), documentElement: element(), body: element(), querySelectorAll: selector => selector === '[data-target]' ? targets : [] };
  // The homepage fades its panel before navigating; run that delay at once here.
  const departures = [];
  const timeout = page === 'home' ? (fn, delay) => { departures.push(delay); fn(); return departures.length; } : setTimeout;
  const context = {
    ...viewerSettings, mountStarfield: () => {}, document, window, location, readSearchEntry, viewerUrl, legacyViewerDestination, parseCoordinate, formatSexagesimal, presets, objectNames, normalizeName, suggestNames, encodeViewState, linkViewSettings,
    initialViewState: { ...decodeViewState(search).state, ...initial }, isEmbedded: false, initialViewIssues: [],
    AbortController, URLSearchParams, URL, clearInterval, setInterval, setTimeout: timeout, clearTimeout, Event,
    Worker: class { postMessage(message) { workerMessages.push(message); } terminate() {} },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    FormData: class { constructor(form) { return Object.entries(form.elements).filter(([key]) => key === 'object' || !get('moving-fields').disabled).map(([key, field]) => [key, field.value]); } },
    Option: class { constructor(label, value) { this.textContent = label; this.value = value; } },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); }
  };
  const source = withoutImports(searchController) + '\n' + withoutImports(lookup) + (page === 'home' ? '\n' + withoutImports(home) : '\n(function(){\n' + withoutImports(app) + '\n})();\n(function(){\n' + withoutImports(moving).replaceAll('import.meta.url', "'http://localhost/moving-target.js'") + '\n})();');
  runInNewContext(source, context);
  const mode = value => { get('target-type').value = value; get('target-type').dispatchEvent({ type: 'change' }); };
  const selections = () => events.filter(event => event.type === 'sky:target-selected');
  return { get, mode, form, targets, navigations, requests, selections, events, window, workerMessages, departures, focus: () => focused };
}

test('unified entry defaults to names and preserves separate drafts and inactive fieldsets', () => {
  const { get, mode, form } = mount();
  assert.equal(get('target-type').value, 'object');
  assert.equal(get('coordinate-fields').disabled, true);
  assert.equal(get('moving-fields').disabled, true);
  get('lookup-name').value = 'Sirius'; mode('moving');
  assert.equal(get('lookup-name').value, '');
  assert.equal(get('lookup-name').maxLength, 80);
  assert.equal(get('moving-fields').disabled, false);
  assert.equal(get('preset-panel').hidden, true);
  get('lookup-name').value = '4 Vesta'; form.elements.startDate.value = '2025-08-10';
  mode('coordinates'); get('ra').value = '123.45'; get('dec').value = '-6.7';
  assert.equal(get('name-fields').disabled, true);
  assert.equal(get('coordinate-fields').disabled, false);
  mode('object'); assert.equal(get('lookup-name').value, 'Sirius');
  mode('moving'); assert.equal(get('lookup-name').value, '4 Vesta');
  assert.equal(form.elements.startDate.value, '2025-08-10');
  mode('coordinates'); assert.equal(get('ra').value, '123.45'); assert.equal(get('dec').value, '-6.7');
});

test('name submission resolves once without success copy or a catalog confirmation card', async () => {
  const { get, form, requests, selections } = mount();
  get('lookup-name').value = 'Sirius'; form.requestSubmit(); await flush();
  assert.equal(requests.length, 1); assert.match(requests[0].url, /resolve-object\?name=Sirius/);
  assert.equal(selections().length, 1); assert.equal(selections()[0].detail.raDeg, resolved.raDeg);
  assert.equal(get('lookup-status').textContent, '');
  assert.equal(get('search-loading').hidden, true);
  assert.equal(get('target-search-submit').disabled, false);
});

test('switching mode or editing cancels resolution and rejects late responses', async () => {
  for (const action of ['mode', 'edit']) {
    let finish;
    const ui = mount({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    ui.get('lookup-name').value = 'Sirius'; ui.form.requestSubmit();
    assert.equal(ui.get('target-search-submit').disabled, true);
    assert.equal(ui.get('target-search-submit').textContent, 'Search ↗');
    assert.equal(ui.get('lookup-status').textContent, '');
    assert.equal(ui.get('search-loading').hidden, false);
    if (action === 'mode') ui.mode('moving');
    else ui.get('lookup-name').dispatchEvent({ type: 'input' });
    assert.equal(ui.requests[0].options.signal.aborted, true);
    finish(json(resolved)); await flush();
    assert.equal(ui.selections().length, 0); assert.equal(ui.get('target-search-submit').disabled, false);
    assert.equal(ui.get('search-loading').hidden, true);
  }
});

test('failed resolution leaves the selected position unchanged and offers verified retries', async () => {
  const ui = mount({ fetchImpl: async () => json({ error: 'Not found', code: 'NOT_FOUND' }, 404) });
  ui.targets[0].click(); ui.get('lookup-name').value = 'Siriu'; ui.form.requestSubmit(); await flush();
  assert.equal(ui.selections().length, 1); assert.equal(ui.get('lookup-status').textContent, 'Not found');
  assert.equal(ui.get('lookup-name').getAttribute('aria-invalid'), 'true');
  assert.ok(ui.get('lookup-suggestions').children.length > 1);
});

test('each compact preset publishes exactly one selection with its proper-motion identity', () => {
  const ui = mount();
  ui.targets.forEach((target, i) => { target.click(); assert.equal(ui.selections().length, i + 1); assert.equal(ui.selections()[i].detail.targetId, target.dataset.target); });
  assert.equal(ui.requests.length, 0);
});

test('coordinate submission validates both axes and selects once in either format', () => {
  const ui = mount(); ui.mode('coordinates'); ui.get('ra').value = '360'; ui.get('dec').value = '-91'; ui.form.requestSubmit();
  assert.equal(ui.selections().length, 0); assert.equal(ui.focus(), ui.get('ra'));
  assert.ok(ui.get('ra-error').textContent); assert.ok(ui.get('dec-error').textContent);
  ui.get('ra').value = '123'; ui.get('dec').value = '-45'; ui.form.requestSubmit();
  assert.equal(ui.selections().length, 1); assert.equal(ui.selections()[0].detail.raDeg, 123);
  ui.get('coordinate-format').value = 'sexagesimal'; ui.get('ra').value = '08:00:00'; ui.get('dec').value = '-07:30:00'; ui.form.requestSubmit();
  assert.equal(ui.selections().length, 2); assert.equal(ui.selections()[1].detail.raDeg, 120); assert.equal(ui.selections()[1].detail.decDeg, -7.5);
  assert.equal(ui.requests.length, 0);
});

test('moving searches validate dates and use the existing endpoint and parameter names', async () => {
  const ui = mount({ fetchImpl: async () => json({ exposures: [] }) }); ui.mode('moving');
  ui.form.elements.startDate.value = ''; ui.form.elements.endDate.value = '';
  ui.form.elements.object.value = '4 Vesta'; ui.form.requestSubmit(); assert.equal(ui.requests.length, 0);
  ui.form.elements.startDate.value = '2025-08-15'; ui.form.elements.endDate.value = '2025-08-10'; ui.form.requestSubmit();
  assert.equal(ui.requests.length, 0); assert.match(ui.get('moving-status').textContent, /End date/);
  ui.form.elements.endDate.value = '2025-08-20'; ui.form.elements.detector.value = '2'; ui.form.requestSubmit(); await flush();
  assert.equal(ui.requests.length, 1);
  const url = new URL(ui.requests[0].url, 'http://localhost');
  assert.equal(url.pathname, '/api/moving-observations');
  assert.equal(url.searchParams.get('object'), '4 Vesta'); assert.equal(url.searchParams.get('detector'), '2');
  assert.equal(url.searchParams.get('startDate'), '2025-08-15');
  assert.equal(ui.selections().length, 0);
  assert.match(ui.get('moving-status').textContent, /No public exposures matched this object in this date range/);
  assert.equal(ui.get('moving-choices').children[0].href, 'https://irsa.ipac.caltech.edu/applications/MOST/');
});

test('moving designation choices and example resubmit through the same form', async () => {
  let calls = 0;
  const ui = mount({ fetchImpl: async () => ++calls === 1 ? json({ error: 'Ambiguous', choices: [{ designation: '4', label: 'Vesta' }] }, 409) : json({ exposures: [] }) });
  ui.mode('moving'); assert.equal(ui.get('target-type').value, 'moving');
  ui.get('moving-example').click(); await flush();
  assert.equal(ui.requests.length, 1); assert.match(ui.requests[0].url, /object=3I%2FATLAS/);
  ui.get('moving-choices').children[0].click(); await flush();
  assert.equal(ui.requests.length, 2); assert.equal(new URL(ui.requests[1].url, 'http://localhost').searchParams.get('object'), '4');
});

test('moving results still select exposures and pass them to the existing image worker', async () => {
  const exposure = { productId: 'test-product', detector: 1, observedStartUtc: '2025-08-11T00:00:00Z', observationId: 'test-observation', release: 'qr2' };
  const ui = mount({ fetchImpl: async () => json({ object: '3I', name: '3I/ATLAS', observer: 'SPHEREx', solution: 'test-solution', exposures: [exposure] }) });
  ui.get('moving-detector').value = '1'; ui.mode('moving'); ui.get('moving-example').click(); await flush();
  assert.equal(ui.get('moving-selection').hidden, false);
  assert.equal(ui.get('moving-exposures').querySelectorAll('input:checked').length, 1);
  ui.get('moving-load').click();
  assert.equal(ui.workerMessages.length, 1); assert.equal(ui.workerMessages[0].type, 'scan');
  assert.equal(ui.workerMessages[0].exposures[0].productId, 'test-product');
});

test('archive progress uses a bar and errors stay visible beside the unified input', () => {
  const ui = mount();
  ui.window.dispatchEvent({ type: 'sky:observations-loading', detail: { targetName: 'Sirius' } });
  assert.equal(ui.get('target-search-status').textContent, '');
  assert.equal(ui.get('search-loading').hidden, false);
  ui.get('search-error').hidden = false; ui.get('search-error').textContent = 'Archive unavailable';
  ui.window.dispatchEvent({ type: 'sky:observations-loaded', detail: { failed: true } });
  assert.equal(ui.get('target-search-status').textContent, 'Archive unavailable');
  assert.equal(ui.get('search-loading').hidden, true);
  ui.mode('moving'); assert.equal(ui.get('target-search-status').hidden, true);
});

test('shared links restore their exact position and preset identity through the existing selection event', () => {
  const ui = mount({ initial: { raDeg: 12.34, decDeg: -5.67, targetId: 'barnard' } });
  assert.equal(ui.selections().length, 0);
  ui.window.dispatchEvent({ type: 'load' });
  assert.equal(ui.selections().length, 1);
  assert.equal(ui.selections()[0].detail.raDeg, 12.34);
  assert.equal(ui.selections()[0].detail.decDeg, -5.67);
  assert.equal(ui.selections()[0].detail.targetId, 'barnard');
});

test('homepage name searches navigate without resolving or loading viewer modules', () => {
  const ui = mount({ page: 'home' }); ui.get('lookup-name').value = 'Sirius'; ui.form.requestSubmit();
  assert.equal(ui.navigations.length, 1); assert.equal(ui.requests.length, 0);
  // The panel fades out before the page changes.
  assert.deepEqual(ui.departures, [700]);
  const url = new URL(ui.navigations[0], 'http://localhost');
  assert.equal(url.pathname, '/viewer.html'); assert.equal(url.searchParams.get('q'), 'Sirius');
  assert.equal(url.searchParams.get('searchType'), 'object'); assert.equal(url.searchParams.has('ra'), false);
});

test('homepage validates coordinates and moving dates before navigating', () => {
  const ui = mount({ page: 'home' }); ui.mode('coordinates'); ui.get('ra').value = '360'; ui.form.requestSubmit();
  assert.equal(ui.navigations.length, 0); assert.ok(ui.get('ra-error').textContent);
  ui.get('coordinate-format').value = 'sexagesimal'; ui.get('ra').value = '08:00:00'; ui.get('dec').value = '-07:30:00'; ui.form.requestSubmit();
  const coords = new URL(ui.navigations[0], 'http://localhost');
  assert.equal(coords.searchParams.get('ra'), '120'); assert.equal(coords.searchParams.get('dec'), '-7.5');
  assert.equal(coords.searchParams.get('format'), 'sexagesimal');
  ui.mode('moving'); ui.form.elements.object.value = '4 Vesta'; ui.form.elements.startDate.value = '2025-08-15'; ui.form.elements.endDate.value = '2025-08-10'; ui.form.requestSubmit();
  assert.equal(ui.navigations.length, 1); assert.match(ui.get('moving-status').textContent, /End date/);
  ui.form.elements.endDate.value = '2025-08-20'; ui.form.elements.detector.value = '2'; ui.form.requestSubmit();
  const moving = new URL(ui.navigations[1], 'http://localhost');
  assert.equal(moving.searchParams.get('q'), '4 Vesta'); assert.equal(moving.searchParams.get('from'), '2025-08-15');
  assert.equal(moving.searchParams.get('detector'), '2'); assert.equal(ui.requests.length, 0);
});

test('homepage quick picks carry preset identity and explicit coordinates into the viewer', () => {
  const ui = mount({ page: 'home' }); ui.targets[1].click();
  const url = new URL(ui.navigations[0], 'http://localhost');
  assert.equal(url.searchParams.get('target'), 'epsilon');
  assert.equal(Number(url.searchParams.get('ra')), presets.epsilon.raDeg);
  assert.equal(Number(url.searchParams.get('dec')), presets.epsilon.decDeg);
});

test('viewer startup resolves an incoming name once and restores resolved names without another lookup', async () => {
  const pending = mount({ search: '?searchType=object&q=Sirius' }); pending.window.dispatchEvent({ type: 'load' }); await flush();
  assert.equal(pending.requests.length, 1); assert.equal(pending.selections().length, 1);
  const saved = mount({ search: '?searchType=object&q=Sirius&ra=101.287&dec=-16.716' }); saved.window.dispatchEvent({ type: 'load' }); await flush();
  assert.equal(saved.requests.length, 0); assert.equal(saved.selections().length, 1);
  assert.equal(saved.selections()[0].detail.raDeg, 101.287); assert.equal(saved.get('lookup-name').value, 'Sirius');
  assert.equal(saved.get('object-name').textContent, 'Sirius');
});

test('moving-object startup restores its form and submits only the moving pipeline once', async () => {
  const ui = mount({ search: '?searchType=moving&q=4+Vesta&from=2025-08-10&to=2025-08-15&detector=2', fetchImpl: async () => json({ exposures: [] }) });
  assert.equal(ui.get('target-type').value, 'moving'); ui.window.dispatchEvent({ type: 'load' }); await flush();
  assert.equal(ui.requests.length, 1); assert.match(ui.requests[0].url, /^\/api\/moving-observations/);
  assert.equal(ui.selections().length, 0); assert.equal(ui.form.elements.detector.value, '2');
});

test('coordinate format changes convert the current draft rather than discarding it', () => {
  const ui = mount({ page: 'home' }); ui.mode('coordinates'); ui.get('ra').value = '120'; ui.get('dec').value = '-7.5';
  ui.get('coordinate-format').value = 'sexagesimal'; ui.get('coordinate-format').dispatchEvent({ type: 'change' });
  assert.equal(ui.get('ra').value, '08:00:00.000'); assert.equal(ui.get('dec').value, '-07:30:00.000');
});

test('Back navigation reconciles restored native form values with visible fields', () => {
  const ui = mount({ page: 'home' });
  ui.get('target-type').value = 'coordinates';
  ui.window.dispatchEvent({ type: 'pageshow' });
  assert.equal(ui.get('coordinate-fields').hidden, false);
  assert.equal(ui.get('name-fields').hidden, true);
  ui.get('target-type').value = 'moving'; ui.get('lookup-name').value = '4 Vesta';
  ui.window.dispatchEvent({ type: 'pageshow' });
  assert.equal(ui.get('moving-fields').hidden, false);
  assert.equal(ui.get('lookup-name').value, '4 Vesta');
});

test('FOV dragging only updates the readout and commits one viewer-settings event', () => {
  const ui = mount();
  const changes = () => ui.events.filter(event => event.type === 'sky:viewer-settings-changed');
  for (const value of ['17', '18', '19']) { ui.get('field-of-view').value = value; ui.get('field-of-view').dispatchEvent({ type: 'input' }); }
  assert.equal(changes().length, 0); assert.equal(ui.get('field-of-view-value').value, '19′');
  ui.get('field-of-view').dispatchEvent({ type: 'change' });
  assert.equal(changes().length, 1); assert.equal(changes()[0].detail.fovArcmin, 19);
  ui.get('field-of-view').dispatchEvent({ type: 'change' }); assert.equal(changes().length, 1);
  ui.get('colours').value = 'magma'; ui.get('colours').dispatchEvent({ type: 'change' });
  ui.get('reset-button').click();
  assert.equal(ui.get('field-of-view').value, 16);
  assert.equal(ui.get('colours').value, 'grayscale');
});

test('every new search starts from the default viewer settings', () => {
  const ui = mount();
  for (const [id, value] of [['detector-array', '5'], ['colours', 'magma'], ['view-mode', 'difference']]) {
    ui.get(id).value = value; ui.get(id).dispatchEvent({ type: 'change' });
  }
  ui.get('lookup-name').value = 'Sirius'; ui.form.requestSubmit();
  assert.equal(ui.get('detector-array').value, '2');
  assert.equal(ui.get('colours').value, 'grayscale');
  assert.equal(ui.get('view-mode').value, 'time-lapse');
});

test('sidebar dropdowns retain detector and view-mode behavior and moving targets never show fixed coordinates', () => {
  const ui = mount();
  ui.get('detector-array').value = '3'; ui.get('detector-array').dispatchEvent({ type: 'change' });
  ui.get('view-mode').value = 'deep-stack'; ui.get('view-mode').dispatchEvent({ type: 'change' });
  const changes = ui.events.filter(event => event.type === 'sky:viewer-settings-changed');
  assert.equal(changes.at(-1).detail.band, 3); assert.equal(changes.at(-1).detail.viewMode, 'deep-stack');
  ui.mode('moving'); assert.equal(ui.get('target-coordinates').hidden, true); assert.equal(ui.get('moving-position-note').hidden, false);
  ui.get('lookup-name').value = '4 Vesta'; ui.get('lookup-name').dispatchEvent({ type: 'input' });
  assert.equal(ui.get('object-name').textContent, '4 Vesta');
  ui.mode('object'); assert.equal(ui.get('target-coordinates').hidden, false);
});


test('one name field recognizes comets and asteroids without a type dropdown', () => {
  for (const query of ['3I/ATLAS', '4 Vesta', 'C/2025 A1', '2024 YR4', 'Bennu']) {
    const ui = mount({ page: 'home' });
    ui.get('lookup-name').value = query;
    ui.get('lookup-name').dispatchEvent({ type: 'input' });
    assert.equal(ui.get('target-type').value, 'moving', query);
    assert.equal(ui.get('lookup-name').value, query);
    assert.equal(ui.get('moving-fields').hidden, false);
    ui.form.requestSubmit();
    const url = new URL(ui.navigations[0], 'http://localhost');
    assert.equal(url.searchParams.get('searchType'), 'moving');
    assert.ok(url.searchParams.get('from')); assert.ok(url.searchParams.get('to'));
  }
});

test('numbered stars stay in fixed-object search and coordinates have their own toggle', () => {
  const ui = mount({ page: 'home' });
  ui.get('lookup-name').value = '61 Cygni'; ui.get('lookup-name').dispatchEvent({ type: 'input' });
  assert.equal(ui.get('target-type').value, 'object');
  ui.get('coordinate-toggle').click(); assert.equal(ui.get('coordinate-fields').hidden, false);
  ui.get('coordinate-toggle').click(); assert.equal(ui.get('lookup-name').value, '61 Cygni');
});


test('an unfamiliar asteroid name falls back to the moving resolver after a catalog miss', async () => {
  const ui = mount({ fetchImpl: async url => url.startsWith('/api/resolve-object')
    ? json({ error: 'Not found', code: 'NOT_FOUND' }, 404) : json({ exposures: [] }) });
  ui.get('lookup-name').value = '1036 Ganymed'; ui.form.requestSubmit(); await flush();
  assert.equal(ui.requests.length, 2);
  assert.match(ui.requests[1].url, /^\/api\/moving-observations/);
  assert.equal(ui.get('lookup-name').value, '1036 Ganymed');
  assert.equal(ui.selections().length, 0);
});
