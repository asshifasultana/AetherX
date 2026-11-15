import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFits } from './fixtures/fits-builder.js';
import { browserWorkerClass } from './fixtures/browser-worker.js';

class Element extends EventTarget {
  constructor() {
    super(); this.width = 10; this.height = 10; this.hidden = false; this.dataset = {}; this.style = {}; this.textContent = ''; this.draws = 0;
    const names = new Set();
    this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name), toggle: (name, on) => on ? names.add(name) : names.delete(name) };
  }
  getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: data => { this.pixels = data.data; }, drawImage: source => { this.draws++; this.pixels = source.pixels; }, fillRect() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}

test('detector stacks share one grid and the main canvas stays idle in the six-detector view', async () => {
  const elements = new Map(), Worker = browserWorkerClass(makeFits(), { delay: 2 });
  globalThis.Worker = Worker; globalThis.window = new EventTarget();
  globalThis.document = {
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    querySelector: selector => document.getElementById(selector), createElement: () => new Element()
  };
  globalThis.location = { origin: 'http://localhost' };
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
  try {
  const { buildDetectorStack, showCutout, viewerSettings } = await import('../fits-viewer.js');
  emit('sky:target-selected', { raDeg: 359.999, decDeg: 4.69 });
  emit('sky:viewer-settings-changed', { band: 2, fovArcmin: 1, viewMode: 'six-detector' });
  assert.equal(viewerSettings().viewMode, 'six-detector');
  const exposure = (detector, i) => ({ accessUrl: `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/d${detector}-${i}.fits`, detector, observationId: `d${detector}-${i}`, observedStartUtc: `2026-03-${String(1 + Math.floor(i / 2)).padStart(2, '0')}T00:00:00Z`, exposureSeconds: 100 });
  const framesFor = detector => Array.from({ length: 5 }, (_, i) => ({ ...exposure(detector, i * 2), exposures: [exposure(detector, i * 2), exposure(detector, i * 2 + 1)] }));
  const drawsBefore = elements.get('sky-canvas').draws;
  assert.deepEqual(await showCutout(framesFor(1)[0]), { stackRecord: null });
  const progress = [], first = [];
  const d1 = await buildDetectorStack(framesFor(1), { onProgress: p => progress.push(p), onFirstFrame: entry => first.push(entry) });
  const d5 = await buildDetectorStack(framesFor(5));
  assert.equal(first.length, 1);
  assert.equal(progress.at(-1).loadedFrames, 5); assert.equal(progress.at(-1).totalFrames, 5);
  assert.equal(d1.width, 10); assert.equal(d5.width, d1.width);
  assert.equal(d1.values.length, 100); assert.equal(d5.values.length, 100);
  assert.equal(d1.record.usedExposureCount, 10); assert.equal(d1.record.deepStack, true);
  assert.deepEqual(d1.image.pointing, d5.image.pointing);
  assert.equal(elements.get('sky-canvas').draws, drawsBefore);
  // A stack whose caller has moved on stops with an AbortError.
  await assert.rejects(buildDetectorStack(framesFor(3), { isCurrent: () => false }), { name: 'AbortError' });
  } finally { await Worker.close(); for (const key of ['Worker', 'window', 'document', 'location']) delete globalThis[key]; }
});
