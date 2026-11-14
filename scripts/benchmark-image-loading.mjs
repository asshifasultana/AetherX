// Opt-in live benchmark. It downloads only cutouts/ranges, never full originals.
// Fresh readers per run give cold application caches; archive/CDN caches remain
// outside our control. Example: node scripts/benchmark-image-loading.mjs --days=4 --runs=5
import { readFile } from 'node:fs/promises';
import { createFitsRangeLoader, createRangeReader } from '../frontend/lib/range-fits.js';
import { projectImage, prepareImage, readFits } from '../frontend/lib/fits-engine.js';
import { medianStack } from '../frontend/lib/stack.js';
import { ImageScheduler } from '../frontend/lib/image-scheduler.js';

const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const days = Number(options.days || 16), runs = Number(options.runs || 5), fovArcmin = Number(options.fov || 16);
const index = JSON.parse(await readFile(new URL('../frontend/data/index.json', import.meta.url), 'utf8'));
const target = index.targets.find(t => t.id === (options.target || 'barnard'));
if (!target || !Number.isInteger(days) || days < 1 || !Number.isInteger(runs) || runs < 1 || !Number.isFinite(fovArcmin) || fovArcmin < 1 || fovArcmin > 300) throw new Error('Invalid benchmark options.');
const snapshot = JSON.parse(await readFile(new URL('../frontend/data/' + target.snapshot, import.meta.url), 'utf8'));
const products = snapshot.products.filter(p => p.detector === Number(options.detector || 1)).sort((a, b) => a.observedStartUtc.localeCompare(b.observedStartUtc));
const groups = [...Map.groupBy(products, p => p.observedStartUtc.slice(0, 10)).values()].slice(0, days);
const settings = { fovArcmin, hideBadPixels: true };
async function legacyBytes(url, onRequest) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      onRequest();
      const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`IRSA ${response.status}`); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 24 * 1024 * 1024) throw new Error('Cutout exceeds benchmark byte limit.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const buffer = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.length; }
      return buffer.buffer;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

async function run(mode) {
  let bytes = 0, requests = 0, firstImageMs;
  const start = performance.now(), results = new Map();
  const read = createRangeReader({ fetchImpl: async (...args) => {
    const response = await fetch(...args); bytes += Number(response.headers.get('content-length') || 0); requests++; return response;
  } });
  const load = createFitsRangeLoader({ read }), scheduler = new ImageScheduler(mode === 's3' ? Number(options.concurrency || 4) : 1);
  for (let offset = 0; offset < groups.length; offset += 4) {
    await Promise.all(groups.slice(offset, offset + 4).map(async group => {
      const images = await Promise.all(group.map(product => scheduler.run(product.accessUrl, async () => {
        let image;
        if (mode === 's3') {
          image = await load(product.accessUrl, target, settings, AbortSignal.timeout(90000), product.productModifiedAt);
          image.projection = projectImage(image, target, settings);
        } else {
          const url = new URL(product.accessUrl);
          url.search = new URLSearchParams({ center: `${target.raDeg},${target.decDeg}`, size: `${Math.min(300, fovArcmin * Math.SQRT2 + 1)}arcmin` });
          const buffer = await legacyBytes(url, () => { requests++; }); bytes += buffer.byteLength;
          image = prepareImage(readFits(buffer), target, settings);
        }
        return image.projection;
      })));
      results.set(group[0].observedStartUtc.slice(0, 10), medianStack(images.map(i => i.values)).values);
      firstImageMs ??= performance.now() - start;
    }));
  }
  const ordered = groups.map(g => results.get(g[0].observedStartUtc.slice(0, 10)));
  const stack = medianStack(ordered).values;
  return { totalMs: performance.now() - start, firstImageMs, bytes, requests, stack };
}
const measurements = [];
for (let i = 0; i < runs; i++) {
  const results = {};
  const modes = options.mode ? [options.mode] : i % 2 ? ['irsa', 's3'] : ['s3', 'irsa'];
  for (const mode of modes) {
    if (!['irsa', 's3'].includes(mode)) throw new Error('Invalid benchmark mode.');
    try {
      results[mode] = await run(mode);
      const { stack, ...metrics } = results[mode];
      console.log(JSON.stringify({ run: i + 1, mode, ...metrics }));
    } catch (error) { console.log(JSON.stringify({ run: i + 1, mode, error: error.message })); }
  }
  if (!results.s3 || !results.irsa) { measurements.push({ incomplete: true }); continue; }
  const a = results.s3.stack, b = results.irsa.stack;
  let maxDifference = 0, mismatchedCoverage = 0;
  for (let p = 0; p < a.length; p++) {
    if (Number.isFinite(a[p]) !== Number.isFinite(b[p])) mismatchedCoverage++;
    if (Number.isFinite(a[p]) && Number.isFinite(b[p])) maxDifference = Math.max(maxDifference, Math.abs(a[p] - b[p]));
  }
  measurements.push({ speedup: results.irsa.totalMs / results.s3.totalMs, maxDifference, mismatchedCoverage });
}
console.log(JSON.stringify({ target: target.id, days: groups.length, exposures: groups.flat().length, fovArcmin, runs, measurements }, null, 2));
