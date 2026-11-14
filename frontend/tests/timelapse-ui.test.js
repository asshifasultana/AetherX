import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as core from '../timelapse-core.js';

const source = (await readFile(new URL('../timelapse.js', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\s*/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const observations = [1, 2].map(n => ({ observationId: `obs-${n}`, detector: 2, observedStartUtc: `2026-01-0${n}T00:00:00Z`, accessUrl: `https://example.org/${n}.fits` }));
function mount({ pending = null, show, warm, ready = true, tutorial = false } = {}) {
  const elements = new Map(), listeners = new Map(), timers = new Map(), requests = [];
  let timerId = 0;
  const element = () => ({ children: [], dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, contains() { return false; } }, listeners: {},
    textContent: '', value: '', width: 68, height: 68, offsetLeft: 0, offsetWidth: 68,
    setAttribute() {}, removeAttribute() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    getContext() { return { createLinearGradient() { return { addColorStop() {} }; }, fillRect() {}, fillText() {}, clearRect() {}, drawImage() {} }; }
  });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const emit = (type, detail = {}) => { for (const fn of listeners.get(type) || []) fn({ type, detail }); };
  const context = { ...core, document: { documentElement: { classList: { contains: name => tutorial && name === 'is-tour-preview' } }, getElementById: get, createElement: element, querySelector() { return null; }, addEventListener() {} },
    window: { addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }, dispatchEvent(event) { emit(event.type, event.detail); } },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }, AbortController,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    takePendingFrameDate() { const value = pending; pending = null; return value; },
    showCutout: async frame => { requests.push(frame); return show ? show(frame, emit) : {}; },
    warmCutout: warm || (async () => {}), isCutoutReady: () => ready
  };
  // What the search loader sees: the latest progress and how often it was told "ready".
  const loader = { progress: null, ready: 0 };
  context.window.addEventListener('sky:loader-progress', event => { loader.progress = event.detail.value; });
  context.window.addEventListener('sky:loader-ready', () => { loader.ready++; });
  runInNewContext(source + '\nglobalThis.playbackState = state;', context);
  return { get, emit, timers, requests, loader, state: context.playbackState, load(items = observations) { emit('sky:observations-loaded', { observations: items }); } };
}

test('default time-lapse loads the first frame and waits for Play', async () => {
  const ui = mount(); ui.load(); await flush();
  assert.equal(ui.requests[0].observationId, 'obs-1');
  assert.equal(ui.state.playing, false);
  assert.equal(ui.get('play-button').textContent, '▶');
  assert.ok(![...ui.timers.values()].some(timer => timer.delay === core.frameDelayMs(1)));
  ui.get('play-button').listeners.click(); await flush();
  assert.equal(ui.state.playing, true);
  assert.equal(ui.get('play-button').textContent, '❚❚');
});

test('single-frame and empty results never start playback', async () => {
  const ui = mount(); ui.load(observations.slice(0, 1)); await flush();
  assert.equal(ui.requests.length, 1); assert.equal(ui.state.playing, false);
  ui.load([]); await flush(); assert.equal(ui.state.playing, false); assert.equal(ui.state.frames.length, 0);
});

test('manual playback pauses on refreshed results and new targets stay paused', async () => {
  const ui = mount(); ui.load(); await flush(); ui.get('play-button').listeners.click(); await flush();
  assert.equal(ui.state.playing, true);
  ui.get('play-button').listeners.click();
  assert.equal(ui.state.userPaused, true);
  ui.load(); await flush(); assert.equal(ui.state.playing, false);
  ui.emit('sky:target-selected'); ui.load(); await flush(); assert.equal(ui.state.playing, false);
});

test('a late initial frame cannot restart playback after a target change', async () => {
  let finish;
  const ui = mount({ show: () => new Promise(resolve => { finish = resolve; }) });
  ui.load(); ui.emit('sky:target-selected'); finish({}); await flush();
  assert.equal(ui.state.playing, false); assert.equal(ui.state.frames.length, 0);
  assert.ok(![...ui.timers.values()].some(timer => timer.delay === core.frameDelayMs(1)));
});

test('shared dates select the restored frame while playback and other modes remain stopped', async () => {
  const ui = mount({ pending: '2026-01-02' }); ui.load(); await flush();
  assert.equal(ui.requests[0].observationId, 'obs-2');
  assert.equal(ui.state.playing, false);
  ui.emit('sky:viewer-settings-changed', { viewMode: 'deep-stack' });
  ui.load(); await flush(); assert.equal(ui.state.playing, false);
});

test('an initial frame failure stays paused and preserves its error message', async () => {
  const ui = mount({ show: (frame, emit) => { emit('sky:cutout-error', { observation: frame, error: new Error('Unavailable') }); return undefined; } });
  ui.load(); await flush();
  assert.equal(ui.state.playing, false); assert.match(ui.get('timeline-status').textContent, /Unavailable/);
});


test('buffering failures pause playback without replacing the current frame', async () => {
  const ui = mount({ ready: false, warm: async () => { throw new Error('Download failed'); } });
  ui.load(); await flush();
  ui.get('play-button').listeners.click(); await flush();
  const displayed = ui.requests.length;
  const timer = [...ui.timers.values()].find(item => item.delay === core.frameDelayMs(1));
  await timer.fn();
  assert.equal(ui.state.playing, false); assert.equal(ui.requests.length, displayed);
  assert.match(ui.get('timeline-status').textContent, /Download failed/);
});


test('live tutorial previews show the selected frame without autoplay or background downloads', async () => {
  let downloads = 0;
  const ui = mount({ tutorial: true, warm: async () => { downloads++; } });
  ui.load(); await flush();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.state.playing, false);
  assert.equal(downloads, 0);
  assert.equal(ui.timers.size, 0);
});

test('search loader waits for the selected image and every timeline preview', async () => {
  let finishImage, finishPreview;
  const ui = mount({ ready: false,
    show: () => new Promise(resolve => { finishImage = resolve; }),
    warm: () => new Promise(resolve => { finishPreview = resolve; }) });
  ui.emit('sky:observations-loading');
  assert.equal(ui.loader.ready, 0);
  ui.load(); await flush();
  assert.equal(ui.loader.ready, 0);
  ui.emit('sky:cutout-rendered', { observation: observations[0] });
  finishImage({}); await flush();
  assert.equal(ui.loader.ready, 0);
  const timer = [...ui.timers.values()].find(item => item.delay === 200);
  const batch = timer.fn(); await flush();
  assert.equal(ui.loader.ready, 0);
  finishPreview(); await batch; await flush();
  assert.equal(ui.loader.ready, 1);
});

test('empty or failed archive searches dismiss the loader', () => {
  for (const failed of [false, true]) {
    const ui = mount(); ui.emit('sky:observations-loading');
    ui.emit('sky:observations-loaded', { observations: [], failed });
    assert.equal(ui.loader.ready, 1);
  }
});

test('failed image downloads settle loading instead of trapping the viewer', async () => {
  const ui = mount({ ready: false,
    show: (frame, emit) => { emit('sky:cutout-error', { observation: frame }); },
    warm: async () => { throw new Error('Unavailable'); } });
  ui.emit('sky:observations-loading'); ui.load(); await flush();
  const timer = [...ui.timers.values()].find(item => item.delay === 200);
  timer.fn(); await flush();
  assert.equal(ui.loader.ready, 1);
});

test('loader progress sweeps to 90 quickly, slows below 100, and resets for a new search', () => {
  const ui = mount({ ready: false });
  const tick = delay => {
    const entry = [...ui.timers.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `Expected a ${delay}ms progress tick`);
    ui.timers.delete(entry[0]); entry[1].fn();
  };
  ui.emit('sky:observations-loading');
  assert.equal(ui.loader.progress, 0);
  for (let i = 0; i < 10; i++) tick(70);
  assert.equal(ui.loader.progress, 90);
  for (let i = 0; i < 400; i++) tick(250);
  assert.equal(ui.loader.ready, 0);
  assert.ok(ui.loader.progress > 98 && ui.loader.progress < 100);
  ui.emit('sky:observations-loaded', { observations: [] });
  assert.equal(ui.loader.progress, 100);
  assert.equal(ui.loader.ready, 1);
  assert.ok(![...ui.timers.values()].some(timer => timer.delay === 70 || timer.delay === 250));
  ui.emit('sky:observations-loading');
  assert.equal(ui.loader.progress, 0);
  // Readiness is reported once per search, not again on later updates.
  ui.emit('sky:observations-loaded', { observations: [] });
  ui.emit('sky:deep-stack-error');
  assert.equal(ui.loader.ready, 2);
});
