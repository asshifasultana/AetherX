import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFits } from './fixtures/fits-builder.js';
import { browserWorkerClass } from './fixtures/browser-worker.js';
import { assessPixelQuality } from '../lib/pixel-quality.js';

class Element extends EventTarget {
  constructor() {
    super(); this.width = 10; this.height = 10; this.hidden = false; this.dataset = {}; this.style = {}; this.textContent = ''; this.draws = 0;
    const names = new Set();
    this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name), toggle: (name, on) => on ? names.add(name) : names.delete(name) };
  }
  getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: data => { this.pixels = data.data; }, drawImage: source => { this.draws++; this.pixels = source.pixels; }, fillRect() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}
const waitFor = async predicate => { for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Viewer timed out'); };

test('viewer paints previews, preserves every contributor and suppresses stale results', async () => {
  const Worker = browserWorkerClass(makeFits(), { delay: 10 }), elements = new Map();
  globalThis.Worker = Worker; globalThis.window = new EventTarget();
  globalThis.document = {
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    querySelector: selector => document.getElementById(selector), createElement: () => new Element()
  };
  globalThis.location = { origin: 'http://localhost' };
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
  try {
    const { showCutout } = await import('../fits-viewer.js');
    emit('sky:target-selected', { raDeg: 359.999, decDeg: 4.69 });
    emit('sky:viewer-settings-changed', { band: 1, fovArcmin: 1, hideBadPixels: true, viewMode: 'time-lapse' });
    const exposure = i => ({ accessUrl: `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/test${i}.fits`, detector: 1, observationId: `obs-${i}`, observedStartUtc: `2026-03-${String(1 + Math.floor(i / 6)).padStart(2, '0')}T00:00:00Z`, exposureSeconds: 100 });
    const frames = Array.from({ length: 5 }, (_, i) => ({ ...exposure(i * 6), exposures: Array.from({ length: 6 }, (_, j) => exposure(i * 6 + j)) }));
    emit('sky:timeline-frames-changed', { frames });
    let record, previews = 0;
    window.addEventListener('sky:cutout-warmed', () => { if (elements.get('export-sky-png').disabled) previews++; });
    window.addEventListener('sky:deep-stack-built', event => { record = event.detail.record; });
    emit('sky:viewer-settings-changed', { viewMode: 'deep-stack', maxStackFrames: 80 });
    await waitFor(() => record);
    assert.equal(record.usedFrameCount, 5); assert.equal(record.usedExposureCount, 30);
    assert.equal(record.exposureSeconds, 3000); assert.equal(record.failedObservationIds.length, 0);
    assert.deepEqual(record.observationIds, frames.flatMap(frame => frame.exposures.map(e => e.observationId)));
    assert.ok(previews > 0); assert.ok(elements.get('sky-canvas').draws >= 2);
    assert.equal(elements.get('export-sky-png').disabled, false);
    // The viewer receives settings before the timeline's detector filter has
    // published its new frames. No old-detector stack may survive that change.
    record = null;
    emit('sky:viewer-settings-changed', { band: 2 });
    emit('sky:timeline-frames-changed', { frames: [{ ...exposure(40), detector: 2 }] });
    await waitFor(() => record);
    assert.equal(record.usedExposureCount, 1);
    assert.deepEqual(record.observationIds, ['obs-40']);
    record = null;
    emit('sky:viewer-settings-changed', { band: 1 });
    emit('sky:timeline-frames-changed', { frames });
    await waitFor(() => record);
    emit('sky:viewer-settings-changed', { viewMode: 'time-lapse' });
    await showCutout(exposure(0));
    assert.ok(elements.get('sky-canvas').pixels?.length);
    const originalFetch = globalThis.fetch;
    let inspected;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/pixel-quality');
      inspected = JSON.parse(options.body);
      return Response.json(assessPixelQuality(inspected));
    };
    try {
      emit('sky:viewer-settings-changed', { inspectPixels: true });
      const click = new Event('click');
      Object.defineProperties(click, { clientX: { value: 45 }, clientY: { value: 45 } });
      elements.get('sky-canvas').dispatchEvent(click);
      await waitFor(() => elements.get('pixel-inspector-result').textContent.includes('Value'));
      assert.ok(inspected.samples.length > 0);
      assert.equal(inspected.flagsAvailable, true);
    } finally { globalThis.fetch = originalFetch; }
    const pending = showCutout(exposure(99));
    emit('sky:target-selected', { raDeg: 12, decDeg: 0 });
    const draws = elements.get('sky-canvas').draws;
    await pending;
    assert.equal(elements.get('sky-canvas').draws, draws);
    assert.equal(elements.get('export-sky-png').disabled, true);
  } finally { await Worker.close(); for (const key of ['Worker', 'window', 'document', 'location']) delete globalThis[key]; }
});
