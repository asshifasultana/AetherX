// Compare fixed-sky coadds on identical quality-masked FITS projections.
// node scripts/benchmark-fixed-stack.mjs --target=barnard --detector=2 --limit=21
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { estimateBackground } from '../frontend/lib/background.js';
import { PIXEL_ARCSEC, projectImage } from '../frontend/lib/fits-engine.js';
import { ImageScheduler } from '../frontend/lib/image-scheduler.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { medianStack } from '../frontend/lib/stack.js';
import { exposureCenter } from '../frontend/presets.js';
import { createSearchService } from '../frontend/lib/observations.js';
import { loadCometEpsf } from '../frontend/lib/comet-native-fit.js';
import { canvasToSky } from '../frontend/sky-projection.js';
import { drizzleExposure, drizzleStack, validDetectorPixel } from './fixed-stack-drizzle.mjs';
import { nativeMeasurement, nativeSource } from './fixed-stack-psf.mjs';

const { values: options } = parseArgs({ options: {
  target: { type: 'string', default: 'barnard' },
  detector: { type: 'string', default: '2' },
  limit: { type: 'string', default: '21' },
  from: { type: 'string', default: '' },
  through: { type: 'string', default: '9999' },
  'catalog-center': { type: 'boolean' },
  'fixed-at': { type: 'string' },
  'live-search': { type: 'boolean' },
  'fixed-search': { type: 'boolean' },
  'include-masked-center': { type: 'boolean' },
  'projection-trials': { type: 'boolean' },
  'reconstruction-trials': { type: 'boolean' },
} });
const size = 49, detector = Number(options.detector), limit = Number(options.limit);
if (!Number.isInteger(detector) || detector < 1 || detector > 6 || !Number.isSafeInteger(limit) || limit < 1) {
  throw new Error('Expected detector 1–6 and a positive integer limit.');
}
const readData = async path => JSON.parse(await readFile(new URL('../frontend/data/' + path, import.meta.url), 'utf8'));
const target = (await readData('index.json')).targets.find(t => t.id === options.target);
if (!target) throw new Error('Unknown target: ' + options.target);
const day = product => product.observedStartUtc.slice(0, 10);
const barnardMotion = target.id === 'barnard' && !options['catalog-center'];
const archive = options['live-search'] ? await createSearchService()(new URLSearchParams({
  raDeg: target.raDeg, decDeg: target.decDeg, detector,
  startDate: options.from, endDate: options.through === '9999' ? '' : options.through,
  ...(barnardMotion && !options['fixed-search'] ? { targetId: target.id } : {}),
})) : null;
if (archive?.nextCursor) throw new Error('Narrow the live search dates so the candidate list fits on one page.');
const products = (archive?.observations ?? (await readData(target.snapshot)).products)
  .filter(p => p.detector === detector && day(p) >= options.from && day(p) <= options.through)
  .sort((a, b) => a.observedStartUtc.localeCompare(b.observedStartUtc) || a.productId.localeCompare(b.productId))
  .slice(0, limit);
if (!products.length) throw new Error('No matching exposures.');

const center = (size - 1) / 2;
const radii = Array.from({ length: size ** 2 }, (_, i) => Math.hypot(i % size - center, Math.floor(i / size) - center));
const sky = radii.flatMap((r, i) => r >= 8 && r <= 20 ? [i] : []);
const core = radii.flatMap((r, i) => r <= 2 ? [i] : []);
const aperture = radii.flatMap((r, i) => r <= 3 ? [i] : []);
// Fit outside the scoring annulus so the sky scatter is measured on pixels
// that were not used to estimate the gradient. Keep the central zero point.
function removeSkyGradient(values) {
  let samples = radii.flatMap((r, i) => r > 20 && Number.isFinite(values[i])
    ? [{ x: i % size - center, y: Math.floor(i / size) - center, z: values[i] }] : []);
  const initial = estimateBackground(samples.map(p => p.z));
  if (initial.noise > 0) samples = samples.filter(p => Math.abs(p.z - initial.level) <= 4 * initial.noise);
  let slopeX = 0, slopeY = 0;
  for (let iteration = 0; iteration < 4 && samples.length >= 100; iteration++) {
    const mean = axis => samples.reduce((sum, p) => sum + p[axis], 0) / samples.length;
    const mx = mean('x'), my = mean('y'), mz = mean('z');
    let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
    for (const p of samples) {
      const x = p.x - mx, y = p.y - my, z = p.z - mz;
      xx += x * x; xy += x * y; yy += y * y; xz += x * z; yz += y * z;
    }
    const determinant = xx * yy - xy * xy;
    if (!(determinant > 0)) break;
    slopeX = (yy * xz - xy * yz) / determinant;
    slopeY = (xx * yz - xy * xz) / determinant;
    const residuals = samples.map(p => p.z - mz - slopeX * (p.x - mx) - slopeY * (p.y - my));
    const { level, noise } = estimateBackground(residuals, { iterations: 0 });
    if (!(noise > 0)) break;
    const next = samples.filter((_, i) => Math.abs(residuals[i] - level) <= 3 * noise);
    if (next.length === samples.length) break;
    samples = next;
  }
  return values.map((value, i) => value - slopeX * (i % size - center) - slopeY * (Math.floor(i / size) - center));
}
const load = createFitsRangeLoader(), scheduler = new ImageScheduler(4);
const reconstruct = options['reconstruction-trials'];
const settings = { fovArcmin: size * PIXEL_ARCSEC / 60, hideBadPixels: true, includeVariance: Boolean(reconstruct) };
const epsf = reconstruct ? await loadCometEpsf(detector) : null;
// Keep the historical image grid for score parity, but fit the unresolved
// RW Aur source at its SIMBAD ICRS position, about 10 arcsec from that center.
const nativePosition = target.id === 'aurigae' ? { raDeg: 76.956526, decDeg: 30.401438 } : null;
const injectedAmplitude = 10;
const injectionOffset = [12, -8];
const controlOffsets = [[-14,-6],[-12,8],[-6,-14],[-6,14],[5,-14],[5,14],[14,-5],[14,6]];
const offsetSky = (p, [x, y]) => canvasToSky({
  x: center + x, y: center + y, size, centerRaDeg: p.raDeg, centerDecDeg: p.decDeg,
});
const fixedAt = options['fixed-at'] ? Date.parse(options['fixed-at']) / 86400000 + 40587 : null;
if (fixedAt !== null && (!barnardMotion || !Number.isFinite(fixedAt))) throw new Error('Expected a valid --fixed-at date for Barnard’s Star.');
function centerFor(product) {
  if (!barnardMotion) return target;
  return exposureCenter({ ...target, targetId: target.id }, fixedAt === null ? product : { startMjd: fixedAt });
}
const loaded = await Promise.all(products.map(product => scheduler.run(product.accessUrl, async () => {
  try {
    const pointing = centerFor(product);
    const image = await load(product.accessUrl, pointing, settings, AbortSignal.timeout(90000), product.productModifiedAt);
    const { values, background } = projectImage(image, pointing, settings);
    const usableCenter = Number.isFinite(values[center * size + center]);
    if (!usableCenter && !options['include-masked-center']) return { product, usableCenter, excluded: 'Target pixel is masked or uncovered.' };
    const { noise, used } = estimateBackground(sky.map(i => values[i]));
    if (used < 100 || !(noise > 0)) return { product, excluded: 'Insufficient sky pixels for a noise estimate.' };
    const frame = { product, values, noise, usableCenter };
    if (reconstruct) {
      const location = offsetSky(pointing, injectionOffset);
      const fitPosition = nativePosition ?? pointing;
      const source = nativeSource(image, fitPosition, epsf);
      const injected = nativeSource(image, location, epsf).column.map(value => value * injectedAmplitude);
      const injectedImage = { ...image, values: image.values.map((value, i) => value + injected[i]) };
      const pixel = Math.round(source.y) * image.width + Math.round(source.x);
      const nativeCoreValid = Math.round(source.x) >= 0 && Math.round(source.x) < image.width &&
        Math.round(source.y) >= 0 && Math.round(source.y) < image.height && validDetectorPixel(image, pixel);
      frame.reconstruction = {
        drizzle: drizzleExposure(image, pointing, background, size, { injection: injected }),
        fine: drizzleExposure(image, pointing, background, size, { scale: 2, injection: injected }),
        baselineInjected: projectImage(injectedImage, pointing, settings).values,
        native: nativeMeasurement(image, fitPosition, epsf),
        controls: controlOffsets.map(offset => nativeMeasurement(image, offsetSky(pointing, offset), epsf)),
        nativeInjection: nativeMeasurement(image, location, epsf, injectedAmplitude),
        nativeCoreValid,
        phase: [source.x - Math.floor(source.x), source.y - Math.floor(source.y)],
      };
    }
    if (options['projection-trials']) {
      const lanczos = projectImage(image, pointing, { ...settings, resampling: 'lanczos3' });
      if (values.some((v, i) => Number.isFinite(v) !== Number.isFinite(lanczos.values[i]))) {
        throw new Error('Lanczos changed the finite-pixel footprint.');
      }
      frame.trials = {
        skyPlane: { values: removeSkyGradient(values) },
        lanczos3: lanczos,
        combined: { values: removeSkyGradient(lanczos.values), lanczosUsed: lanczos.lanczosUsed },
      };
    }
    return frame;
  } catch (cause) {
    if (['No detector coverage for this field.', 'No valid pixels remain after applying the quality mask.'].includes(cause.message)) {
      return { product, excluded: cause.message };
    }
    throw new Error(`Could not use ${product.observationId}: ${cause.message}`, { cause });
  }
})));
const frames = loaded.filter(frame => !frame.excluded);
if (!frames.length) throw new Error('No exposures cover the target with usable sky pixels.');

function meanStack(frames, weighted) {
  const counts = new Uint16Array(size ** 2);
  const weights = frames.map(frame => weighted ? 1 / frame.noise ** 2 : 1);
  const values = Float32Array.from(counts, (_, i) => {
    let sum = 0, weight = 0;
    for (const [j, frame] of frames.entries()) {
      if (!Number.isFinite(frame.values[i])) continue;
      sum += weights[j] * frame.values[i];
      weight += weights[j];
      counts[i]++;
    }
    return weight ? sum / weight : NaN;
  });
  return { values, counts };
}

function dailyMedian(frames) {
  const daily = [...Map.groupBy(frames, f => day(f.product)).values()]
    .map(group => medianStack(group.map(f => f.values)).values);
  return medianStack(daily);
}

function compare(frames, projectionOnly = false) {
  const stacks = { dailyThenDeepMedian: dailyMedian(frames) };
  if (!projectionOnly) Object.assign(stacks, {
    exposureMedian: medianStack(frames.map(f => f.values)),
    exposureMean: meanStack(frames, false),
    skyWeightedMean: meanStack(frames, true),
  });
  const commonSky = sky.filter(i => Object.values(stacks).every(stack => Number.isFinite(stack.values[i])));
  if (commonSky.length < 100) throw new Error('Insufficient common stack sky coverage.');
  return Object.fromEntries(Object.entries(stacks).map(([name, { values, counts }]) => {
    const { level, noise } = estimateBackground(commonSky.map(i => values[i]));
    const peakIndex = core.reduce((best, i) => Number.isFinite(values[i]) &&
      (best === null || values[i] > values[best]) ? i : best, null);
    const peak = peakIndex === null ? null : values[peakIndex] - level;
    const apertureSum = aperture.every(i => Number.isFinite(values[i]))
      ? aperture.reduce((sum, i) => sum + values[i] - level, 0) : null;
    return [name, { peakContrast: peak === null || !(noise > 0) ? null : peak / noise,
      peak, skyScatter: noise, skyPixels: commonSky.length, apertureSum,
      peakPosition: peakIndex === null ? null : [peakIndex % size, Math.floor(peakIndex / size)],
      peakExposureContributors: peakIndex === null ? 0 : frames.filter(f => Number.isFinite(f.values[peakIndex])).length,
      ...(frames[0].lanczosUsed ? {
        peakLanczosContributors: peakIndex === null ? 0 : frames.filter(f => f.lanczosUsed[peakIndex]).length,
      } : {}),
      ...(name === 'dailyThenDeepMedian' ? { peakDayContributors: peakIndex === null ? 0 : counts[peakIndex] } : {}) }];
  }));
}

const dates = [...new Set(frames.map(frame => day(frame.product)))];
const results = compare(frames);
function projectionScores(sample) {
  return Object.fromEntries(['baseline', 'skyPlane', 'lanczos3', 'combined'].map(name => {
    const inputs = name === 'baseline' ? sample : sample.map(frame => ({ ...frame, ...frame.trials[name] }));
    return [name, compare(inputs, true).dailyThenDeepMedian];
  }));
}

function reconstructionScores(sample) {
  const inputs = sample.map(frame => frame.reconstruction);
  const baseline = dailyMedian(sample);
  const drizzle = drizzleStack(inputs.map(frame => frame.drizzle));
  const commonSky = sky.filter(i => Number.isFinite(baseline.values[i]) && Number.isFinite(drizzle.values[i]));
  const commonCore = core.filter(i => Number.isFinite(baseline.values[i]) && Number.isFinite(drizzle.values[i]));
  const apertureAt = (values, width, scale, offset, level) => {
    const [dx, dy] = offset, midpoint = (width - 1) / 2;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      if (Math.hypot((i % width - midpoint) / scale - dx, (Math.floor(i / width) - midpoint) / scale - dy) > 3) continue;
      if (!Number.isFinite(values[i])) return NaN;
      sum += (values[i] - level) / scale ** 2;
    }
    return sum;
  };
  const score = (stack, injected, scale, frames) => {
    const width = size * scale;
    const atRadius = i => Math.hypot(i % width - (width - 1) / 2, Math.floor(i / width) - (width - 1) / 2) / scale;
    const indices = Array.from(stack.values.keys());
    const skyPixels = scale === 1 ? commonSky : indices.filter(i => atRadius(i) >= 8 && atRadius(i) <= 20);
    const corePixels = scale === 1 ? commonCore : indices.filter(i => atRadius(i) <= 2);
    const { level, noise } = estimateBackground(skyPixels.map(i => stack.values[i]));
    const peakIndex = corePixels.filter(i => Number.isFinite(stack.values[i]))
      .reduce((best, i) => best < 0 || stack.values[i] > stack.values[best] ? i : best, -1);
    const peak = stack.values[peakIndex] - level;
    const delta = injected.values.map((value, i) => value - stack.values[i]);
    const blanks = controlOffsets.map(offset => apertureAt(stack.values, width, scale, offset, level)).filter(Number.isFinite);
    return { peakContrast: peak / noise, peak, skyScatter: noise, skyPixels: skyPixels.filter(i => Number.isFinite(stack.values[i])).length,
      peakExposureContributors: frames.filter(frame => frame.weight ? frame.weight[peakIndex] > 1e-10 : Number.isFinite(frame.values[peakIndex])).length,
      injectionApertureRecovery: apertureAt(delta, width, scale, injectionOffset, 0) / injectedAmplitude,
      blankApertureScatter: blanks.length >= 4 ? estimateBackground(blanks, { iterations: 0 }).noise : null,
      blankApertures: blanks.length,
    };
  };
  const median = values => estimateBackground(values, { iterations: 0 }).level;
  const native = inputs.filter(frame => frame.native);
  const controlFits = controlOffsets.map((_, i) => native.map(frame => frame.controls[i]).filter(Boolean));
  const controls = controlFits.filter(fits => fits.length >= 3).map(fits => median(fits.map(fit => fit.amplitude)));
  const control = estimateBackground(controls, { iterations: 0 });
  const amplitude = native.length ? median(native.map(frame => frame.native.amplitude)) : null;
  const phases = frames => new Set(frames.map(({ phase: [x, y] }) => `${Math.floor(4 * x)},${Math.floor(4 * y)}`)).size;
  const injectedFits = inputs.filter(frame => frame.nativeInjection);
  const drizzleFrames = inputs.map(frame => frame.drizzle), fineFrames = inputs.map(frame => frame.fine);
  return {
    baseline: score(baseline, dailyMedian(sample.map(frame => ({ ...frame, values: frame.reconstruction.baselineInjected }))), 1, sample),
    drizzle: score(drizzle, drizzleStack(drizzleFrames, { injected: true }), 1, drizzleFrames),
    drizzleHalfPixel: score(drizzleStack(fineFrames), drizzleStack(fineFrames, { injected: true }), 2, fineFrames),
    sampling: { occupiedPhaseBins: phases(inputs), validCorePhaseBins: phases(inputs.filter(frame => frame.nativeCoreValid)), totalPhaseBins: 16,
      validCoreExposures: inputs.filter(frame => frame.nativeCoreValid).length },
    nativePsf: {
      position: nativePosition ?? 'exposure pointing',
      exposures: native.length, exposuresWithMaskedOrUncoveredCore: native.filter(frame => !frame.nativeCoreValid).length,
      medianAmplitude: amplitude, blankScatter: control.noise, controlExposureCounts: controlFits.map(fits => fits.length),
      empiricalContrast: amplitude !== null && controls.length >= 4 && control.noise > 0 ? (amplitude - control.level) / control.noise : null,
      injectionRecovery: injectedFits.length ? median(injectedFits.map(frame => frame.nativeInjection.recovery)) : null,
      injectionExposures: injectedFits.length,
    },
  };
}
console.log(JSON.stringify({
  target: target.name, catalogCoordinates: [target.raDeg, target.decDeg],
  alignment: !barnardMotion ? 'fixed catalog position' : fixedAt === null ? 'linear proper motion' : `fixed at ${options['fixed-at']}`,
  ...(archive ? { archiveCandidates: archive.count } : { snapshot: target.hash }), detector, size,
  inputs: loaded.map(({ product, noise, usableCenter, excluded }) => ({ day: day(product), observationId: product.observationId,
    productId: product.productId, center: centerFor(product), skyScatter: noise, usableCenter, excluded })),
  results,
  ...(reconstruct ? { reconstructionTrials: reconstructionScores(frames) } : {}),
  ...(options['projection-trials'] ? {
    projectionTrials: projectionScores(frames),
    projectionLeaveOneDateOut: dates.length < 2 ? [] : dates.map(date => ({
      omitted: date,
      contrasts: Object.fromEntries(Object.entries(projectionScores(frames.filter(f => day(f.product) !== date)))
        .map(([name, score]) => [name, score.peakContrast])),
    })),
  } : {}),
  leaveOneDateOut: dates.length < 2 ? [] : dates.map(date => {
    const stacks = compare(frames.filter(f => day(f.product) !== date));
    return { omitted: date, contrasts: Object.fromEntries(Object.entries(stacks).map(([key, value]) => [key, value.peakContrast])) };
  }),
}, null, 2));
