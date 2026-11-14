import test from 'node:test';
import assert from 'node:assert/strict';
import { ImagePipeline } from '../image-pipeline.js';
import { prepareImage, readFits } from '../lib/fits-engine.js';
import { makeFits } from './fixtures/fits-builder.js';
import { browserWorkerClass } from './fixtures/browser-worker.js';

const accessUrl = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/test.fits';
const target = { raDeg: 359.999, decDeg: 4.69 }, settings = { fovArcmin: 1, hideBadPixels: true };
const url = '/api/cutout?' + new URLSearchParams({ url: accessUrl, ...target, fovArcmin: 1 });

test('actual worker loads, projects, transfers and stacks without backend image requests', async () => {
  const bytes = makeFits(), Worker = browserWorkerClass(bytes);
  globalThis.Worker = Worker;
  try {
    const pipeline = new ImagePipeline();
    const image = await pipeline.load(url, accessUrl, target, settings);
    assert.equal(image.transport, 's3');
    assert.ok(image.values.byteLength > 0 && image.projection.values.byteLength > 0);
    const projected = await pipeline.project(image, target, settings);
    assert.deepEqual(projected.values, image.projection.values);
    const result = await pipeline.median([projected.values, image.projection.values]);
    assert.deepEqual(result.values, projected.values);
    assert.ok(image.values.byteLength > 0, 'caller source remains available for inspection');
  } finally { delete globalThis.Worker; await Worker.close(); }
});

test('missing S3 object falls back once and decodes in the worker', async () => {
  const bytes = makeFits(), Worker = browserWorkerClass(bytes, { failS3: true }), originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.Worker = Worker;
  globalThis.fetch = async endpoint => { assert.equal(endpoint, url); calls++; return new Response(bytes); };
  try {
    const image = await new ImagePipeline().load(url, accessUrl, target, settings);
    assert.equal(image.transport, 'irsa'); assert.equal(calls, 1);
    const expected = prepareImage(readFits(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), target, settings);
    assert.deepEqual(image.projection.values, expected.projection.values);
  } finally { globalThis.fetch = originalFetch; delete globalThis.Worker; await Worker.close(); }
});

test('worker startup failure retains the legacy path and cancelled jobs cannot publish', async () => {
  const bytes = makeFits(), originalFetch = globalThis.fetch;
  globalThis.Worker = class { constructor() { throw new Error('blocked worker'); } };
  globalThis.fetch = async () => new Response(bytes);
  try {
    const pipeline = new ImagePipeline();
    assert.equal((await pipeline.load(url, accessUrl, target, settings)).transport, 'irsa');
    assert.equal(pipeline.disabled, true);
  } finally { globalThis.fetch = originalFetch; delete globalThis.Worker; }
  const Worker = browserWorkerClass(bytes, { delay: 40 }); globalThis.Worker = Worker;
  try {
    const pipeline = new ImagePipeline(), controller = new AbortController();
    await pipeline.start();
    const pending = pipeline.load(url, accessUrl, target, settings, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { delete globalThis.Worker; await Worker.close(); }
});
