// Run from the connection being measured: node scripts/benchmark-moving-loading.mjs [pairs]
// Measures cutout delivery and the moving viewer's scan, excluding initial discovery.
// IRSA is called directly, with the fallback's padded size and the scan's concurrency.
// This benchmarks preview loading only; the fallback FITS reader does not decode
// variance for enhanced contrast.
import { createMovingSearch } from '../frontend/api/moving-observations.js';
import { createMovingView } from '../frontend/lib/moving-view.js';
import { cropImage, readFits, skyGrid, sourceBounds } from '../frontend/lib/fits-engine.js';
import { createFitsRangeLoader, createRangeReader } from '../frontend/lib/range-fits.js';
import { createWavelengthReader } from '../frontend/lib/wavelength.js';

const pairs = Number(process.argv[2] ?? 2);
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10) throw new Error('Specify 1–10 pairs.');
const only = process.argv[3];
if (only && !['s3', 'irsa'].includes(only)) throw new Error('Specify s3 or irsa, or omit to run both.');
const query = { object: '3I/ATLAS', startDate: '2025-08-10', endDate: '2025-08-15', detector: '1' };
const search = createMovingSearch();
const session = await search(new URLSearchParams(query));
if (session.trajectoryError) throw new Error(session.trajectoryError);
const exposures = session.exposures.slice(0, 20);
if (exposures.length !== 20) throw new Error(`Expected 20 exposures, got ${exposures.length}.`);
console.log(JSON.stringify({ query, solution: session.solution, productIds: exposures.map(e => e.productId) }));

async function run(mode) {
  let requests = 0, bodyBytes = 0, firstPreviewMs = null;
  const countedFetch = async (...args) => {
    requests++;
    return fetch(...args);
  };
  const range = createRangeReader({ fetchImpl: countedFetch });
  const read = async (...args) => {
    const bytes = await range(...args);
    bodyBytes += bytes.byteLength;
    return bytes;
  };
  const load = mode === 's3' ? createFitsRangeLoader({ read }) : async (accessUrl, target, settings, signal) => {
    const url = new URL(accessUrl);
    url.search = new URLSearchParams({
      center: `${target.raDeg},${target.decDeg}`,
      size: `${settings.fovArcmin * Math.SQRT2 + 1}arcmin`,
    });
    const response = await countedFetch(url, { signal });
    if (!response.ok || Number(response.headers.get('content-length')) > 24 * 1024 * 1024) {
      await response.body?.cancel();
      throw new Error(`IRSA cutout failed (HTTP ${response.status} or oversized body).`);
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      bodyBytes += chunk.byteLength;
      if ((length += chunk.byteLength) > 24 * 1024 * 1024) throw new Error('Oversized IRSA cutout.');
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const image = readFits(bytes.buffer);
    if (!image.flags) throw new Error('IRSA cutout is missing the pixel flags.');
    return cropImage(image, sourceBounds(image, skyGrid(target, settings.fovArcmin)));
  };
  const view = createMovingView({
    load,
    wavelengthAt: createWavelengthReader(async (...args) => {
      const response = await countedFetch(...args);
      if (response.status === 206) bodyBytes += Number(response.headers.get('content-length') ?? 0);
      return response;
    }),
    fetchImpl: async path => Response.json(await search(new URL(path, 'http://localhost').searchParams)),
  });
  const start = performance.now();
  try {
    const result = await view.scan(session, exposures, update => {
      if (update.preview) firstPreviewMs ??= performance.now() - start;
    });
    return { firstPreviewMs, finishMs: performance.now() - start, requests, bodyBytes,
      usable: result.frames.length, failures: result.failures, days: result.days };
  } catch (error) {
    return { firstPreviewMs, elapsedMs: performance.now() - start, requests, bodyBytes, error: error.message };
  }
}

for (let pair = 1; pair <= pairs; pair++) {
  const results = {};
  for (const mode of only ? [only] : pair % 2 ? ['s3', 'irsa'] : ['irsa', 's3']) {
    const { days, ...metrics } = await run(mode);
    results[mode] = { days, ...metrics };
    console.log(JSON.stringify({ pair, mode, ...metrics }));
  }
  const { s3, irsa } = results;
  if (only) {
    if (results[only].usable !== 20) process.exitCode = 1;
    continue;
  }
  if (s3.usable !== 20 || irsa.usable !== 20) { process.exitCode = 1; continue; }
  let maxAbsDifference = 0, coverageMismatches = 0;
  for (const { date, values } of s3.days) {
    const other = irsa.days.find(day => day.date === date).values;
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i]) !== Number.isFinite(other[i])) coverageMismatches++;
      if (Number.isFinite(values[i]) && Number.isFinite(other[i])) {
        maxAbsDifference = Math.max(maxAbsDifference, Math.abs(values[i] - other[i]));
      }
    }
  }
  console.log(JSON.stringify({ pair, maxAbsDifference, coverageMismatches }));
}
