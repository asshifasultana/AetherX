import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFits } from './fixtures/fits-builder.js';
import { browserWorkerClass } from './fixtures/browser-worker.js';
import { colormap } from '../lib/colormaps.js';


class Element extends EventTarget {
  constructor() {
    super(); this.width = 10; this.height = 10; this.hidden = false; this.dataset = {}; this.style = {}; this.textContent = ''; this.draws = 0;
    const names = new Set();
    this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name), toggle: (name, on) => on ? names.add(name) : names.delete(name) };
  }
  getContext() { return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: data => { this.pixels = data.data; }, drawImage: source => { this.draws++; this.pixels = source.pixels; }, fillRect() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}
const waitFor = async predicate => { for (let i = 0; i < 600; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Viewer timed out'); };

test('difference, motion-trail and blink modes compose frames on the shared sky grid', async () => {
  const Worker = browserWorkerClass(makeFits()), elements = new Map();
  globalThis.Worker = Worker; globalThis.window = new EventTarget();
  globalThis.document = {
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    querySelector: selector => document.getElementById(selector), createElement: () => new Element()
  };
  globalThis.location = { origin: 'http://localhost' };
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
  const grids=[];window.addEventListener('sky:display-grid-changed',event=>grids.push(event.detail));
  try {
    const { showCutout } = await import('../fits-viewer.js');
    emit('sky:target-selected', { raDeg: 359.999, decDeg: 4.69 });
    emit('sky:viewer-settings-changed', { band: 1, fovArcmin: 1, viewMode: 'time-lapse' });
    const frames = [0, 1, 2].map(i => ({ accessUrl: `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/mode${i}.fits`, detector: 1, observationId: `obs-${i}`, observedStartUtc: `2026-04-0${i + 1}T00:00:00Z`, exposureSeconds: 100 }));
    emit('sky:timeline-frames-changed', { frames });

    emit('sky:viewer-settings-changed', { viewMode: 'difference', referenceFrame: 'previous', differenceThreshold: 5 });
    emit('sky:frame-exposure-group', { exposures: [frames[1]], frame: frames[1] });
    await showCutout(frames[1]);
    await waitFor(() => elements.get('cutout-caption').textContent.startsWith('Difference'));
    assert.match(elements.get('cutout-caption').textContent, /2026-04-02 − 2026-04-01/);
    assert.match(elements.get('cutout-caption').textContent, /0 pixels brighter and 0 fainter/);
    assert.equal(elements.get('colour-bar-mid').textContent, 'no change');
    assert.equal(grids.at(-1),null);
    // Identical frames difference to zero, which is the dark centre of the diverging map.
    const pixels = elements.get('sky-canvas').pixels, lut = colormap('diverging');
    assert.deepEqual([pixels[0], pixels[1], pixels[2]], [lut[128 * 3], lut[128 * 3 + 1], lut[128 * 3 + 2]]);

    emit('sky:viewer-settings-changed', { referenceFrame: 'pinned', pinnedReferenceKey: 'missing' });
    await waitFor(() => /2026-04-02 − 2026-04-01/.test(elements.get('cutout-caption').textContent));

    emit('sky:viewer-settings-changed', { viewMode: 'motion-trail', trailWindow: 1 });
    await waitFor(() => elements.get('cutout-caption').textContent.startsWith('Motion trail'));
    assert.match(elements.get('cutout-caption').textContent, /maximum of 3 frames · 2026-04-01 to 2026-04-03/);

    emit('sky:viewer-settings-changed', { viewMode: 'blink', referenceFrame: 'first', blinkIntervalMs: 200 });
    await waitFor(() => elements.get('cutout-caption').textContent.startsWith('Blink'));
    assert.match(elements.get('cutout-caption').textContent, /2026-04-02 ⇄ 2026-04-01/);
    assert.equal(elements.get('blink-badge').hidden, false);
    const draws = elements.get('sky-canvas').draws;
    await waitFor(() => elements.get('sky-canvas').draws > draws + 1);
    assert.match(elements.get('blink-badge').textContent, /^[AB] · /);
    assert.ok(grids.some(g=>g?.startUtc.startsWith('2026-04-01')),'Blink reference publishes its own epoch');
    assert.ok(grids.some(g=>g?.startUtc.startsWith('2026-04-02')),'Blink science frame publishes its own epoch');

    emit('sky:viewer-settings-changed', { viewMode: 'time-lapse' });
    await waitFor(() => !elements.get('cutout-caption').textContent.startsWith('Blink'));
    assert.equal(elements.get('blink-badge').hidden, true);
  } finally {
    await Worker.close();
  }
});
