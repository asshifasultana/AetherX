// Shared by the bake scripts (bake-planted-lab.mjs, bake-recovery-pairs.mjs):
// list SPHEREx exposures covering a sky position, load and project one onto a
// north-up grid around that position, and serialise it as a baked frame.
import { validateSearch, buildQuery, queryArchive, deduplicate } from '../../frontend/lib/observations.js';
import { createFitsRangeLoader } from '../../frontend/lib/range-fits.js';
import { createWavelengthReader } from '../../frontend/lib/wavelength.js';
import { projectImage } from '../../frontend/lib/fits-engine.js';
import { estimateBackground } from '../../frontend/lib/background.js';

export const midMjd = product => (product.startMjd + product.endMjd) / 2;

/** Exposures covering `target`, deduplicated, with an access URL, date and detector, oldest first. */
export async function productsAt(target) {
  const search = validateSearch(new URLSearchParams({ raDeg: String(target.raDeg), decDeg: String(target.decDeg) }));
  return deduplicate(await queryArchive(buildQuery(search)))
    .filter(p => p.accessUrl && Number.isFinite(p.startMjd) && p.detector)
    .sort((a, b) => a.startMjd - b.startMjd);
}

/**
 * frameOf(product, target): the exposure's pixels projected onto a north-up
 * grid of `fovArcmin` centred on `target`, its wavelength there, and the
 * share of finite pixels. Cached per product and target.
 */
export function createFrameLoader({ fovArcmin }) {
  const load = createFitsRangeLoader();
  const wavelengthAt = createWavelengthReader();
  const settings = { fovArcmin, hideBadPixels: true, subtractBackground: true };
  const cache = new Map();
  function frameOf(product, target) {
    const key = `${product.accessUrl}@${target.raDeg},${target.decDeg}`;
    if (cache.has(key)) return cache.get(key);
    const job = (async () => {
      const image = await load(product.accessUrl, target, settings, AbortSignal.timeout(60000), product.productModifiedAt || '');
      const projection = projectImage(image, target, settings);
      const frame = projection.psfFrame;
      const wavelengthUm = frame ? await wavelengthAt(product.accessUrl, frame.x, frame.y) : NaN;
      const finite = projection.values.reduce((n, v) => n + Number.isFinite(v), 0) / projection.values.length;
      return { product, image, projection, wavelengthUm, finite };
    })();
    cache.set(key, job);
    job.catch(() => cache.delete(key));
    return job;
  }
  frameOf.cache = cache;
  return frameOf;
}

const base64 = values => Buffer.from(new Float32Array(Array.from(values, v => Number.isFinite(v) ? v : NaN)).buffer).toString('base64');

/** A loaded frame as stored in the baked JSON (base64 little-endian float32 plane). */
export function bakeFrame({ product, image, projection, wavelengthUm }) {
  const { level, noise } = estimateBackground(projection.values);
  return {
    observationId: product.observationId, accessUrl: product.accessUrl, detector: product.detector, release: product.release,
    midMjd: Number(midMjd(product).toFixed(6)), date: new Date((midMjd(product) - 40587) * 86400000).toISOString(),
    exposureSeconds: product.exposureSeconds, wavelengthUm: Number(wavelengthUm.toFixed(4)),
    bunit: String(image.header.BUNIT || 'MJy/sr'), level, noise, values: base64(projection.values)
  };
}

/**
 * Same-detector pairs whose gap lies in [minDays, maxDays], ordered short
 * detectors first, then by closeness to `wantDays`.
 */
export function candidatePairs(products, { minDays, maxDays, wantDays }) {
  const pairs = [];
  for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
    const a = products[i], b = products[j], gap = b.startMjd - a.startMjd;
    if (a.detector === b.detector && gap >= minDays && gap <= maxDays) pairs.push([a, b, gap]);
  }
  return pairs.sort((x, y) => x[0].detector - y[0].detector || Math.abs(x[2] - wantDays) - Math.abs(y[2] - wantDays));
}

/**
 * Load candidate pairs until one has full coverage and a wavelength mismatch
 * below `goodMismatch`; otherwise return the best under `maxMismatch`, or null.
 * At most `maxLoads` exposures are downloaded.
 */
export async function bestPair(frameOf, target, pairs, { goodMismatch = 0.12, maxMismatch = 0.15, minFinite = 0.97, maxLoads = 90, log = console.log } = {}) {
  let chosen = null, best = Infinity;
  const loaded = new Set();
  for (const [a, b, gap] of pairs) {
    if (loaded.size >= maxLoads && !(loaded.has(a.accessUrl) && loaded.has(b.accessUrl))) continue;
    loaded.add(a.accessUrl); loaded.add(b.accessUrl);
    try {
      const [fa, fb] = await Promise.all([frameOf(a, target), frameOf(b, target)]);
      if (fa.finite < minFinite || fb.finite < minFinite) continue;
      const mismatch = Math.abs(fa.wavelengthUm - fb.wavelengthUm) / fa.wavelengthUm;
      log(`D${a.detector} ${a.observationId} / ${b.observationId}: gap ${gap.toFixed(2)} d, λ ${fa.wavelengthUm.toFixed(3)} / ${fb.wavelengthUm.toFixed(3)} μm`);
      if (mismatch < best) { best = mismatch; chosen = [fa, fb]; }
      if (mismatch < goodMismatch) break;
    } catch (error) { log(`skip ${a.observationId}: ${error.message}`); }
  }
  return chosen && best <= maxMismatch ? { frames: chosen, mismatch: best } : null;
}
