import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseCoordinate, formatSexagesimal } from '../coordinates.js';
import { presets } from '../presets.js';
import { suggestNames } from '../object-names.js';
import { DEFAULT_VIEW_STATE, encodeViewState } from '../url-state.js';

const [html, app, lookup, moving] = await Promise.all(['index.html', 'app.js', 'object-lookup.js', 'moving-target.js'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')));
const withoutImports = source => source.replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const resolved = { submittedName: 'Sirius', resolvedName: '* alf CMa', raDeg: 101.287, decDeg: -16.716, frame: 'icrs', source: { name: 'SIMBAD', resolver: 'Sesame' }, retrievedAt: '2026-11-07' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// Exercise the real entrypoints together. Every requested ID must exist in the
// shipped HTML; only DOM and network boundaries are replaced, as in observations-ui.test.js.
function mount({ fetchImpl = async () => json(resolved), initial = {} } = {}) {
  const elements = new Map(), targets = [], requests = [], events = [], workerMessages = [];
  let focused;
  function element(attributes = {}) {
    const listeners = new Map();
    return {
      value: attributes.value || '', hidden: 'hidden' in attributes, disabled: 'disabled' in attributes,
      textContent: '', children: [], dataset: {}, classList: { toggle() {}, add() {} },
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
  const document = { getElementById: get, createElement: () => element(), documentElement: element(), querySelectorAll: selector => selector === '[data-target]' ? targets : [] };
  const context = {
    document, window, parseCoordinate, formatSexagesimal, presets, suggestNames, encodeViewState,
    initialViewState: { ...DEFAULT_VIEW_STATE, ...initial }, isEmbedded: false, initialViewIssues: [],
    AbortController, URLSearchParams, URL, clearInterval, setInterval, setTimeout, clearTimeout, Event,
    Worker: class { postMessage(message) { workerMessages.push(message); } terminate() {} },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    FormData: class { constructor(form) { return Object.entries(form.elements).filter(([key]) => key === 'object' || !get('moving-fields').disabled).map(([key, field]) => [key, field.value]); } },
    Option: class { constructor(label, value) { this.textContent = label; this.value = value; } },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); }
  };
  runInNewContext(withoutImports(lookup) + '\n(function(){\n' + withoutImports(app) + '\n})();\n(function(){\n' + moving.replaceAll('import.meta.url', "'http://localhost/moving-target.js'") + '\n})();', context);
  const mode = value => { get('target-type').value = value; get('target-type').dispatchEvent({ type: 'change' }); };
  const selections = () => events.filter(event => event.type === 'sky:target-selected');
  return { get, mode, form, targets, requests, selections, events, window, workerMessages, focus: () => focused };
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

test('name submission resolves and selects once, retaining catalog provenance without confirmation', async () => {
  const { get, form, requests, selections } = mount();
  get('lookup-name').value = 'Sirius'; form.requestSubmit(); await flush();
  assert.equal(requests.length, 1); assert.match(requests[0].url, /resolve-object\?name=Sirius/);
  assert.equal(selections().length, 1); assert.equal(selections()[0].detail.raDeg, resolved.raDeg);
  assert.equal(get('lookup-confirmation').hidden, false); assert.match(get('resolved-source').textContent, /SIMBAD/);
  assert.equal(get('target-search-submit').disabled, false);
});

test('switching mode or editing cancels resolution and rejects late responses', async () => {
  for (const action of ['mode', 'edit']) {
    let finish;
    const ui = mount({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
    ui.get('lookup-name').value = 'Sirius'; ui.form.requestSubmit();
    assert.equal(ui.get('target-search-submit').disabled, true);
    if (action === 'mode') ui.mode('moving');
    else ui.get('lookup-name').dispatchEvent({ type: 'input' });
    assert.equal(ui.requests[0].options.signal.aborted, true);
    finish(json(resolved)); await flush();
    assert.equal(ui.selections().length, 0); assert.equal(ui.get('target-search-submit').disabled, false);
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
  ui.form.elements.object.value = '4 Vesta'; ui.form.requestSubmit(); assert.equal(ui.requests.length, 0);
  ui.form.elements.startDate.value = '2025-08-15'; ui.form.elements.endDate.value = '2025-08-10'; ui.form.requestSubmit();
  assert.equal(ui.requests.length, 0); assert.match(ui.get('moving-status').textContent, /End date/);
  ui.form.elements.endDate.value = '2025-08-20'; ui.form.elements.detector.value = '2'; ui.form.requestSubmit(); await flush();
  assert.equal(ui.requests.length, 1);
  const url = new URL(ui.requests[0].url, 'http://localhost');
  assert.equal(url.pathname, '/api/moving-observations');
  assert.equal(url.searchParams.get('object'), '4 Vesta'); assert.equal(url.searchParams.get('detector'), '2');
  assert.equal(url.searchParams.get('startDate'), '2025-08-15');
  assert.equal(ui.selections().length, 0); assert.match(ui.get('moving-status').textContent, /No public exposures/);
});

test('moving navigation focuses shared input; designation choices and example resubmit through the same form', async () => {
  let calls = 0;
  const ui = mount({ fetchImpl: async () => ++calls === 1 ? json({ error: 'Ambiguous', choices: [{ designation: '4', label: 'Vesta' }] }, 409) : json({ exposures: [] }) });
  ui.get('moving-search-link').click(); assert.equal(ui.get('target-type').value, 'moving'); assert.equal(ui.focus(), ui.get('lookup-name'));
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

test('archive progress and errors remain visible beside the unified input', () => {
  const ui = mount();
  ui.window.dispatchEvent({ type: 'sky:observations-loading', detail: { targetName: 'Sirius' } });
  assert.match(ui.get('target-search-status').textContent, /Searching observations for Sirius/);
  ui.get('search-error').hidden = false; ui.get('search-error').textContent = 'Archive unavailable';
  ui.window.dispatchEvent({ type: 'sky:observations-loaded', detail: { failed: true } });
  assert.equal(ui.get('target-search-status').textContent, 'Archive unavailable');
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
