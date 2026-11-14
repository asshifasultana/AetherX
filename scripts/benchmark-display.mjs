// Score display pipelines (scale limits + stretch + core fill) on real SPHEREx
// frames. Every metric is measured against the science values, not by eye:
//   holes        masked pixels inside the detector footprint painted as "no data"
//   starsWhite   detected stars whose peak is painted pure white (≥ 254)
//   rankRho      Spearman ρ between star peak flux and painted peak level
//   brightSep    brightest quarter of stars: share whose painted peaks differ from
//                the next-fainter star (1 = every bright star distinguishable)
//   faintΔ       median grey-level lift of faint stars (5–20σ) above the sky
//   skyBlack     sky pixels clipped to pure black (faint detail destroyed)
//   skyLevel     median grey level of the sky; skyNoise its spread (grey levels)
// Core rebuild (injection test): the 3x3 cores of unsaturated 50-1000 sigma stars are
// masked and refilled, rim mean vs PSF fit, and compared with the true pixels.
// node scripts/benchmark-display.mjs --detector=2 --frames=3 [--dump=dir]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { projectImage } from '../frontend/lib/fits-engine.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { ImageScheduler } from '../frontend/lib/image-scheduler.js';
import { maskBitsFor } from '../frontend/lib/pixel-quality.js';
import { DEFAULT_SETTINGS } from '../frontend/viewer-settings.js';
import { exposureCenter } from '../frontend/presets.js';
import { scaleLimits, toneMapper, fillMaskedHoles, robustStats, NOISE_SHADOWS_SIGMA } from '../frontend/lib/display-scale.js';
import { fitPsfCore, gridPsf } from '../frontend/lib/core-fill.js';
import { loadCometEpsf } from '../frontend/lib/comet-native-fit.js';

const { values: options } = parseArgs({ options: {
  detector: { type: 'string', default: '2' },
  frames: { type: 'string', default: '3' },
  targets: { type: 'string', default: '' },
  dump: { type: 'string', default: '' },
  'dump-at': { type: 'string', default: '2025-08-21T23:33:00Z' }
} });
const detector = Number(options.detector), perTarget = Number(options.frames);
const readData = async path => JSON.parse(await readFile(new URL('../frontend/data/' + path, import.meta.url), 'utf8'));
const index = await readData('index.json');
const targets = index.targets.filter(t => !options.targets || options.targets.split(',').includes(t.id));
const settings = { ...DEFAULT_SETTINGS, maskBits: maskBitsFor(DEFAULT_SETTINGS.maskCategories), includeFlags: true };
const epsf = await loadCometEpsf(detector);

// ---------------------------------------------------------------- pipelines
// PixInsight/Siril STF auto-stretch, as an external state-of-the-art baseline.
const mtf = (m, x) => x <= 0 ? 0 : x >= 1 ? 1 : (m - 1) * x / ((2 * m - 1) * x - m);
function stfMapper(values) {
  const sorted = Float64Array.from(values.filter(Number.isFinite)).sort();
  const { median, sigma } = robustStats(sorted), max = sorted[sorted.length - 1];
  const c0 = Math.max(sorted[0], median - NOISE_SHADOWS_SIGMA * sigma), range = max - c0 || 1;
  const m = mtf(0.25, (median - c0) / range);
  return value => Math.round(255 * mtf(m, Math.max(0, Math.min(1, (value - c0) / range))));
}
const tone = (look, fill) => ({ fill, mapper: values => toneMapper({ ...scaleLimits(values, look.scaleMode), ...look }, look.stretch === 'histeq' ? values : null) });
const PIPELINES = {
  'old natural': tone({ stretch: 'asinh', scaleMode: 'p99.5', contrast: 65, brightness: 50 }, false),
  'new natural': tone({ stretch: 'asinh', scaleMode: 'noise', contrast: 50, brightness: 50 }, true),
  'new, rim fill': { ...tone({ stretch: 'asinh', scaleMode: 'noise', contrast: 50, brightness: 50 }, true), rimOnly: true },
  'new, no fill': tone({ stretch: 'asinh', scaleMode: 'noise', contrast: 50, brightness: 50 }, false),
  'faint (zscale)': tone({ stretch: 'linear', scaleMode: 'zscale', contrast: 55, brightness: 50 }, false),
  'contrast (p98)': tone({ stretch: 'linear', scaleMode: 'p98', contrast: 85, brightness: 50 }, false),
  'STF auto + fill': { fill: true, mapper: stfMapper }
};

// Paint exactly as paintGrid does: optional fill, then limits from the shown values.
function paint(projection, pipeline) {
  const psf = pipeline.rimOnly ? null : gridPsf(epsf, projection.psfFrame);
  const shown = pipeline.fill ? fillMaskedHoles(projection.values, projection.width, { covered: projection.covered, psf }) : projection.values;
  const level = pipeline.mapper(shown);
  return Int16Array.from(shown, value => Number.isFinite(value) ? level(value) : -1);
}

// ---------------------------------------------------------------- truth from data
function analyse(projection) {
  const { values, width, covered } = projection;
  const sorted = Float64Array.from(values.filter(Number.isFinite)).sort();
  const { median, sigma } = robustStats(sorted);
  const stars = [];
  for (let y = 2; y < width - 2; y++) for (let x = 2; x < width - 2; x++) {
    const at = y * width + x, v = values[at];
    if (!(v > median + 5 * sigma)) continue;
    let peak = true;
    for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) {
      const n = values[at + dy * width + dx];
      if ((dx || dy) && Number.isFinite(n) && n > v) { peak = false; break; }
    }
    if (peak) stars.push({ at, flux: v, snr: (v - median) / sigma });
  }
  const sky = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]) && Math.abs(values[i] - median) < 2 * sigma) sky.push(i);
  const footprintHoles = [];
  for (let i = 0; i < values.length; i++) if (covered[i] && !Number.isFinite(values[i])) footprintHoles.push(i);
  return { stars, sky, footprintHoles, median, sigma };
}

function ranks(list) {
  const order = list.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), out = new Array(list.length);
  for (let i = 0; i < order.length;) {
    let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return out;
}
function spearman(a, b) {
  const ra = ranks(a), rb = ranks(b), n = a.length, ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
const med = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

function score(levels, truth) {
  const peaks = truth.stars.map(star => levels[star.at]);
  const skyLevels = truth.sky.map(i => levels[i]);
  const skyLevel = med(skyLevels);
  const faint = truth.stars.filter(star => star.snr >= 5 && star.snr <= 20).map(star => levels[star.at] - skyLevel);
  const bright = truth.stars.slice().sort((a, b) => a.flux - b.flux).slice(Math.floor(truth.stars.length * 0.75)).map(star => levels[star.at]);
  let separated = 0;
  for (let i = 1; i < bright.length; i++) if (bright[i] !== bright[i - 1]) separated++;
  const sorted = skyLevels.slice().sort((a, b) => a - b);
  return {
    holes: truth.footprintHoles.filter(i => levels[i] < 0).length,
    starsWhite: peaks.filter(level => level >= 254).length / (peaks.length || 1),
    rankRho: spearman(truth.stars.map(star => star.flux), peaks),
    brightSep: bright.length > 1 ? separated / (bright.length - 1) : 0,
    faintLift: med(faint),
    skyBlack: skyLevels.filter(level => level === 0).length / (skyLevels.length || 1),
    skyLevel,
    skyNoise: (sorted[Math.floor(sorted.length * 0.84)] - sorted[Math.floor(sorted.length * 0.16)]) / 2
  };
}

// ---------------------------------------------------------------- core rebuild
// Real masked star cores in SPHEREx frames are mostly 1–5 pixels; 3×3 is larger
// than the undersampled PSF core and is the hard case.
const HOLE_SHAPES = {
  '1 px': [[0, 0]],
  'plus 5 px': [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]],
  '3x3 9 px': [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => [dx, dy]))
};
function coreRebuild(projection, truth) {
  const { values, width } = projection, psf = gridPsf(epsf, projection.psfFrame), out = [];
  for (const star of truth.stars) {
    if (star.snr < 50 || star.snr > 1000) continue;
    const x = star.at % width, y = (star.at - x) / width;
    if (x < 8 || y < 8 || x >= width - 8 || y >= width - 8) continue;
    let clean = true;
    for (let dy = -4; dy <= 4 && clean; dy++) for (let dx = -4; dx <= 4; dx++) if (!Number.isFinite(values[star.at + dy * width + dx])) { clean = false; break; }
    if (!clean) continue;
    const scale = values[star.at] - truth.median;
    for (const [shape, offsets] of Object.entries(HOLE_SHAPES)) {
      const hole = offsets.map(([dx, dy]) => star.at + dy * width + dx);
      const masked = Float32Array.from(values);
      for (const at of hole) masked[at] = NaN;
      let rimMax = -Infinity;
      for (const at of hole) for (const step of [-1, 1, -width, width, -width - 1, -width + 1, width - 1, width + 1]) if (Number.isFinite(masked[at + step])) rimMax = Math.max(rimMax, masked[at + step]);
      // Same path as the viewer: fillMaskedHoles with and without the PSF.
      const rim = fillMaskedHoles(masked, width, {});
      const fitted = psf ? fillMaskedHoles(masked, width, { psf }) : rim;
      const accepted = Boolean(psf && fitPsfCore(masked, width, hole, psf, { rimMax }));
      const errors = fill => ({
        peak: (fill[star.at] - values[star.at]) / scale,
        rms: Math.sqrt(hole.reduce((sum, at) => sum + (fill[at] - values[at]) ** 2, 0) / hole.length) / scale
      });
      out.push({ shape, rim: errors(rim), psf: errors(fitted), accepted });
    }
  }
  return out;
}

// ---------------------------------------------------------------- run
const load = createFitsRangeLoader(), scheduler = new ImageScheduler(4);
const jobs = [];
for (const target of targets) {
  const products = (await readData(target.snapshot)).products.filter(p => p.detector === detector)
    .sort((a, b) => a.observedStartUtc.localeCompare(b.observedStartUtc));
  if (!products.length) continue;
  const picks = new Set(Array.from({ length: Math.min(perTarget, products.length) }, (_, i) => Math.round(i * (products.length - 1) / Math.max(1, perTarget - 1))));
  const chosen = [...picks].map(i => products[i]);
  if (options.dump && target.id === 'barnard') {
    const at = Date.parse(options['dump-at']);
    const nearest = products.reduce((best, p) => Math.abs(Date.parse(p.observedStartUtc) - at) < Math.abs(Date.parse(best.observedStartUtc) - at) ? p : best);
    if (!chosen.includes(nearest)) chosen.push(nearest);
    nearest.dump = true;
  }
  for (const product of chosen) jobs.push({ target, product });
}

const results = await Promise.all(jobs.map(({ target, product }) => scheduler.run(product.accessUrl, async () => {
  const pointing = target.id === 'barnard' ? exposureCenter({ ...target, targetId: target.id }, product) : target;
  try {
    const image = await load(product.accessUrl, pointing, settings, AbortSignal.timeout(120000), product.productModifiedAt);
    const projection = projectImage(image, pointing, settings);
    const truth = analyse(projection);
    const scores = {}, painted = {};
    for (const [name, pipeline] of Object.entries(PIPELINES)) { painted[name] = paint(projection, pipeline); scores[name] = score(painted[name], truth); }
    const cores = coreRebuild(projection, truth);
    if (product.dump && options.dump) {
      await mkdir(options.dump, { recursive: true });
      for (const name of ['old natural', 'new natural']) {
        const file = `${options.dump}/barnard-${product.observedStartUtc.slice(0, 16).replace(':', '')}-${name.replace(/ /g, '_')}.json`;
        await writeFile(file, JSON.stringify({ width: projection.width, observedStartUtc: product.observedStartUtc, levels: Array.from(painted[name]) }));
      }
    }
    return { target: target.id, date: product.observedStartUtc.slice(0, 16), stars: truth.stars.length, holes: truth.footprintHoles.length, scores, cores };
  } catch (error) { return { target: target.id, date: product.observedStartUtc.slice(0, 16), error: error.message }; }
})));

const ok = results.filter(r => !r.error);
for (const r of results.filter(r => r.error)) console.log(`skipped ${r.target} ${r.date}: ${r.error}`);
console.log(`\n${ok.length} frames · detector D${detector} · ${ok.reduce((n, r) => n + r.stars, 0)} detected stars · ${ok.reduce((n, r) => n + r.holes, 0)} masked footprint pixels\n`);
const metrics = [['holes', 'holes', v => v.toFixed(1)], ['starsWhite', 'stars white', v => (100 * v).toFixed(1) + '%'], ['rankRho', 'rank ρ', v => v.toFixed(3)],
  ['brightSep', 'bright sep', v => (100 * v).toFixed(1) + '%'], ['faintLift', 'faint Δ', v => v.toFixed(1)], ['skyBlack', 'sky black', v => (100 * v).toFixed(1) + '%'], ['skyLevel', 'sky level', v => v.toFixed(1)], ['skyNoise', 'sky noise', v => v.toFixed(1)]];
const pad = (s, n) => String(s).padStart(n);
console.log(pad('pipeline', 16) + metrics.map(([, label]) => pad(label, 12)).join(''));
for (const name of Object.keys(PIPELINES)) {
  const mean = key => ok.reduce((sum, r) => sum + r.scores[name][key], 0) / ok.length;
  console.log(pad(name, 16) + metrics.map(([key, , format]) => pad(format(mean(key)), 12)).join(''));
}
console.log('\nper frame (old natural → new natural: stars white, bright sep, faint Δ, holes)');
for (const r of ok) {
  const n = r.scores['new natural'], o = r.scores['old natural'];
  console.log(`  ${r.target.padEnd(9)} ${r.date}  ${r.stars} stars  white ${(100 * o.starsWhite).toFixed(0)}%→${(100 * n.starsWhite).toFixed(0)}%  sep ${(100 * o.brightSep).toFixed(0)}%→${(100 * n.brightSep).toFixed(0)}%  faint ${o.faintLift}→${n.faintLift}  holes ${o.holes}→${n.holes}`);
}

const cores = ok.flatMap(r => r.cores);
const pct = v => (100 * v).toFixed(1) + '%';
const stars = cores.filter(c => c.shape === '1 px').length;
console.log(`\ncore rebuild: ${stars} unsaturated 50–1000σ stars, core hidden and refilled (errors relative to the true peak above sky)`);
console.log(pad('hole', 12) + pad('method', 12) + pad('PSF used', 10) + pad('|peak err|', 12) + pad('peak bias', 12) + pad('core rms', 12));
for (const shape of Object.keys(HOLE_SHAPES)) {
  const group = cores.filter(c => c.shape === shape), used = pct(group.filter(c => c.accepted).length / (group.length || 1));
  for (const method of ['rim', 'psf']) {
    console.log(pad(method === 'rim' ? shape : '', 12) + pad(method === 'rim' ? 'rim mean' : 'PSF fit*', 12) + pad(method === 'rim' ? '' : used, 10)
      + pad(pct(med(group.map(c => Math.abs(c[method].peak)))), 12) + pad(pct(med(group.map(c => c[method].peak))), 12) + pad(pct(med(group.map(c => c[method].rms))), 12));
  }
}
console.log('  * as the viewer does it: PSF fit where accepted, rim mean otherwise');
