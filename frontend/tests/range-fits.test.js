import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFitsRangeLoader, createRangeReader, cloudUrl } from '../lib/range-fits.js';
import { prepareImage, readFits, projectImage, skyGrid, projectSkyToPixel, matrixFor } from '../lib/fits-engine.js';
import { medianStack } from '../lib/stack.js';
import { makeFits } from './fixtures/fits-builder.js';

const url = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/test.fits';
const target = { raDeg: 359.999, decDeg: 4.69 };
const settings = { fovArcmin: 1, hideBadPixels: true };
const bufferOf = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
function near(actual, expected, tolerance = 1e-4) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) assert.ok((Number.isNaN(actual[i]) && Number.isNaN(expected[i])) || Math.abs(actual[i] - expected[i]) <= tolerance, `pixel ${i}: ${actual[i]} vs ${expected[i]}`);
}

for (const bitpix of [-32, -64]) for (const sip of [false, true]) {
  test(`QR2/QR3-style range/cutout parity: BITPIX ${bitpix}, SIP ${sip}`, async () => {
    const bytes = makeFits({ bitpix, sip }), requests = [];
    const load = createFitsRangeLoader({ read: async (_, start, end) => { requests.push([start, end]); return new Uint8Array(bytes.subarray(start, end + 1)); } });
    const ranged = await load(url, target, settings);
    const fallback = prepareImage(readFits(bufferOf(bytes)), target, settings);
    assert.deepEqual(ranged.flags, fallback.flags);
    near(ranged.values, fallback.values, 0);
    const projection = projectImage(ranged, target, settings);
    near(projection.values, fallback.projection.values);
    assert.deepEqual(projection.flags, fallback.projection.flags);
    assert.equal(projection.background, fallback.projection.background);
    assert.ok(requests.every(([a, b]) => b >= a && b - a + 1 < bytes.length));
    const before = requests.length;
    await load(url, target, settings);
    assert.ok(requests.length - before < before, 'headers reused for repeated load');
    const daily = medianStack([projection.values, fallback.projection.values]);
    near(daily.values, projection.values);
    near(medianStack([daily.values, projection.values]).values, projection.values);
  });
}

test('column-only range decode matches a full-row crop for a target clipped by the detector edge', async () => {
  {
    const settings = { fovArcmin: 2, hideBadPixels: true };
    const bytes = makeFits({ width: 64, height: 48 });
    const edge = { raDeg: 359.999 + 28 * 6.15 / 3600 / Math.cos(4.69 * Math.PI / 180), decDeg: 4.69 - 10 * 6.15 / 3600 };
    const ranged = await createFitsRangeLoader({ read: async (_, a, b) => new Uint8Array(bytes.subarray(a, b + 1)) })(url, edge, settings);
    const full = prepareImage(readFits(bufferOf(bytes)), edge, settings);
    assert.equal(ranged.sourceX, 0, 'crop is clipped at the left detector edge');
    assert.ok(ranged.width < 64 && ranged.height < 48);
    for (const key of ['width', 'height', 'sourceX', 'sourceY']) assert.equal(ranged[key], full[key]);
    near(ranged.values, full.values, 0);
    assert.deepEqual(ranged.flags, full.flags);
    for (const key of ['NAXIS1', 'NAXIS2', 'CRPIX1', 'CRPIX2']) assert.equal(ranged.header[key], full.header[key]);
  }
});

test('Lanczos falls back at masked pixels and preserves constant sky elsewhere', () => {
  const image = readFits(bufferOf(makeFits()));
  image.values.fill(12);
  const masked = Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2);
  image.values[masked] = 1e6;
  const baseline = projectImage(image, target, settings);
  const trial = projectImage(image, target, { ...settings, resampling: 'lanczos3' });
  assert.ok(trial.lanczosUsed.includes(1));
  assert.ok(trial.lanczosUsed.includes(0));
  near(trial.values, baseline.values, 1e-6);
  const center = Math.floor(trial.width / 2) * (trial.width + 1);
  assert.equal(trial.lanczosUsed[center], 0);
});

test('compressed FLAGS rows match Astropy bit-for-bit and full-file decoding', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/spherex-rice-astropy.json', import.meta.url), 'utf8'));
  const compressed = Buffer.from(fixture.rows[0].compressed, 'base64');
  const bytes = makeFits({ width: fixture.width, compressed });
  const load = createFitsRangeLoader({ read: async (_, a, b) => new Uint8Array(bytes.subarray(a, b + 1)) });
  const ranged = await load(url, target, settings), fallback = prepareImage(readFits(bufferOf(bytes)), target, settings);
  assert.deepEqual(ranged.flags, fallback.flags);
  const expected = new Int32Array(bufferOf(Buffer.from(fixture.rows[0].expected, 'base64')));
  for (let y = 0; y < ranged.height; y++) for (let x = 0; x < ranged.width; x++) assert.equal(ranged.flags[y * ranged.width + x], expected[x + ranged.sourceX] >>> 0);
});

test('detector edges, RA wrap and missing coverage retain NaNs and flags', async () => {
  const bytes = makeFits(), image = readFits(bufferOf(bytes)); image.matrix = matrixFor(image.header);
  const point = projectSkyToPixel(image, .001, target.decDeg);
  assert.ok(point && Math.abs(point[0] - image.width / 2) < 3);
  const wide = { ...settings, fovArcmin: 8 };
  const result = prepareImage(image, target, wide);
  assert.ok(result.projection.coverage < 1 && result.projection.coverage > 0);
  assert.ok(result.projection.values.some(Number.isNaN));
  assert.throws(() => prepareImage(image, { raDeg: 180, decDeg: 0 }, settings), /coverage/);
  assert.equal(skyGrid(target, 1).width, 10);
});

test('range reads reject full bodies without consuming them and enforce exact lengths', async () => {
  let cancelled = 0;
  const response = () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 });
  await assert.rejects(createRangeReader({ fetchImpl: async () => response() })('https://example.com', 0, 3), /partial/);
  assert.equal(cancelled, 1);
  for (const [body, headers] of [['12345', {}], ['12', {}], ['1234', { 'content-range': 'bytes 4-7/8' }], ['1234', { 'content-length': '66' }]]) {
    const read = createRangeReader({ fetchImpl: async () => new Response(body, { status: 206, headers }), wait: async () => {} });
    await assert.rejects(read('https://example.com', 0, 3), /limit|Truncated|Mismatched/);
  }
});

test('range reads accept browser-hidden Content-Range, retry transient errors and honor cancellation', async () => {
  let calls = 0; const waits = [];
  const read = createRangeReader({ fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503, headers: { 'retry-after': '2' } }) : new Response('1234', { status: 206 }), wait: async ms => waits.push(ms), random: () => 0 });
  assert.equal(new TextDecoder().decode(await read('https://example.com', 0, 3)), '1234');
  assert.equal(calls, 2); assert.deepEqual(waits, [2000]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(read('https://example.com', 0, 3, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('cloud mapping accepts archive releases and rejects other services', () => {
  assert.equal(cloudUrl(url), 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/level2/test.fits');
  assert.equal(cloudUrl(url.replace('/qr3/', '/dr1/')), 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/test.fits');
  for (const value of ['http://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/x.fits', 'https://evil.example/x.fits', url + '?x=1']) assert.throws(() => cloudUrl(value));
});
