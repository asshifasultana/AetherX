import { createFitsRangeLoader } from './range-fits.js';
import { projectImage, projectSkyToPixel, skyGrid } from './fits-engine.js';
import { estimateBackground } from './background.js';
import { medianStack } from './stack.js';
import { buildFrames } from '../timelapse-core.js';
import { createWavelengthReader } from './wavelength.js';
import { injectProfile } from './comet-profile.js';

const DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;
const settingsFor = size => ({ fovArcmin: size * 6.15 / 60, hideBadPixels: true, includeVariance: true });

export function exposureTiming(header, exposure) {
  const dateObs = header['DATE-BEG'] ?? header['DATE-OBS'];
  const fitsStart = typeof dateObs === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(dateObs) ? dateObs + 'Z' : dateObs;
  const start = [fitsStart, exposure.observedStartUtc].map(value => Date.parse(value)).find(Number.isFinite) ??
    (exposure.mjd - 40587) * DAY;
  const duration = Number(header.EXPTIME ?? exposure.exposureSeconds);
  const endMjd = Number(header['MJD-END'] ?? exposure.endMjd);
  const average = Number(header['MJD-AVG']);
  const startMjd = start / DAY + 40587;
  const hasAverage = Number.isFinite(average) && average >= startMjd;
  const midpoint = hasAverage ? average : endMjd > startMjd ? (startMjd + endMjd) / 2 :
    startMjd + (duration > 0 ? duration / (2 * SECONDS_PER_DAY) : 0);
  return { observedStartUtc: new Date(start).toISOString(), midpoint, hasDuration: hasAverage || duration > 0 || endMjd > startMjd };
}

export function positionAt(points, mjd) {
  const hi = points.findIndex(point => point.mjd >= mjd);
  if (hi < 0 || (hi === 0 && points[0].mjd !== mjd)) throw new Error('Exposure lies outside the ephemeris.');
  if (points[hi].mjd === mjd) return { raDeg: points[hi].ra, decDeg: points[hi].dec };
  const a = points[hi - 1], b = points[hi];
  const fraction = (mjd - a.mjd) / (b.mjd - a.mjd);
  const dra = (b.ra - a.ra + 540) % 360 - 180;
  return { raDeg: (a.ra + fraction * dra + 360) % 360, decDeg: a.dec + fraction * (b.dec - a.dec) };
}

function maskComet(image, field, target, size, radius) {
  const grid = skyGrid(field, settingsFor(size).fovArcmin);
  const cosDec = Math.cos(target.decDeg * Math.PI / 180);
  for (let i = 0; i < image.values.length; i++) {
    const dx = ((grid.coordinates[i * 2] - target.raDeg + 540) % 360 - 180) * cosDec;
    const dy = grid.coordinates[i * 2 + 1] - target.decDeg;
    if (Math.hypot(dx, dy) * 3600 < radius * 6.15) image.values[i] = NaN;
  }
}

function subtractReference(science, references) {
  const values = science.values.slice(), variance = science.variance.slice();
  const counts = new Uint16Array(values.length);
  const sky = medianStack(references.map(reference => reference.values));
  // Propagate the estimated reference noise. The median factor assumes independent Gaussian noise.
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || sky.counts[i] < 2) continue;
    const contributing = references.filter(reference => Number.isFinite(reference.values[i]));
    const sum = contributing.reduce((total, reference) => total + reference.variance[i], 0);
    values[i] -= sky.values[i];
    variance[i] += (contributing.length === 2 ? 1 : Math.PI / 2) * sum / contributing.length ** 2;
    counts[i] = contributing.length;
  }
  return { ...science, values, variance, referenceCounts: counts };
}

export function weightedStack(images) {
  const values = new Float32Array(images[0].values.length).fill(NaN);
  const counts = new Uint16Array(values.length), variance = values.slice();
  for (let i = 0; i < values.length; i++) {
    const good = images.filter(image => Number.isFinite(image.values[i]) && Number.isFinite(image.variance[i]) && image.variance[i] > 0);
    if (!good.length) continue;
    const sorted = good.map(image => image.values[i]).sort((a, b) => a - b);
    const center = (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2;
    const scatter = good.length >= 5 ? estimateBackground(sorted).noise : 0;
    let sum = 0, weight = 0;
    for (const image of good) {
      if (good.length >= 5 && Math.abs(image.values[i] - center) > 5 * Math.max(scatter, Math.sqrt(image.variance[i]))) continue;
      const w = 1 / image.variance[i];
      sum += w * image.values[i];
      weight += w;
      counts[i]++;
    }
    if (weight) {
      values[i] = sum / weight;
      variance[i] = 1 / weight;
    }
  }
  return { values, variance, counts };
}

export function trackedMedian(frames, field = 'projection') {
  const days = buildFrames(frames);
  return medianStack(days.map(day => medianStack(day.exposures.map(frame => frame[field].values)).values));
}

export async function stackMovingTarget({
  exposures, ephemeris, size = 49, referenceExposures = exposures,
  referenceRadius = 6, referenceWavelengthTolerance = 0.025,
  load = createFitsRangeLoader(), wavelengthAt = createWavelengthReader(), onStage = () => {}, injectionAmplitude = 0,
  injections = injectionAmplitude ? [{ amplitude: injectionAmplitude }] : []
}) {
  if (!Number.isInteger(size) || size < 21 || size > 241) throw new Error('Grid size must be 21–241 pixels.');
  if (!exposures.length) throw new Error('No exposures in the requested epoch and wavelength bin.');
  const settings = settingsFor(size);
  const frames = [], failures = [];
  for (let start = 0; start < exposures.length; start += 4) {
    await Promise.all(exposures.slice(start, start + 4).map(async exposure => {
      try {
        const first = positionAt(ephemeris, exposure.mjd);
        let image = await load(exposure.url, first, settings);
        const timing = exposureTiming(image.header, exposure);
        const target = positionAt(ephemeris, timing.midpoint);
        if (first.raDeg !== target.raDeg || first.decDeg !== target.decDeg) image = await load(exposure.url, target, settings);
        const projection = projectImage(image, target, settings);
        const [x, y] = projectSkyToPixel(image, target.raDeg, target.decDeg);
        const wavelength = await wavelengthAt(exposure.url, x + image.sourceX, y + image.sourceY);
        const injected = injections.map(shape => projectImage(injectProfile(image, target, shape), target, settings));
        frames.push({ ...exposure, ...timing, wavelength, target, projection, injected });
      } catch (error) {
        failures.push({ url: exposure.url, error: error.message });
      }
    }));
  }
  frames.sort((a, b) => a.mjd - b.mjd || a.url.localeCompare(b.url));
  if (!frames.length) throw new Error(`All exposures failed: ${failures[0]?.error}`);
  const tracked = trackedMedian(frames);
  const injectionMedians = field => injections.map((_, i) =>
    trackedMedian(frames.map(frame => ({ ...frame, simulation: frame[field][i] })), 'simulation'));
  const report = (stage, stack, simulated) => onStage(stage, stack, frames, simulated[0], simulated);
  await report('trackedMedian', tracked, injectionMedians('injected'));
  const byUrl = new Map(frames.map(frame => [frame.url, frame]));
  const referenceTargets = referenceExposures.map(reference => {
    const target = byUrl.get(reference.url)?.target ??
      (reference.cometFree ? null : positionAt(ephemeris, reference.mjd + (reference.exposureSeconds || 0) / (2 * SECONDS_PER_DAY)));
    return { ...reference, target };
  });
  for (const frame of frames) {
    const candidates = referenceTargets.filter(other => other.url !== frame.url && other.detector === frame.detector &&
      (!other.target || Math.hypot(((other.target.raDeg - frame.target.raDeg + 540) % 360 - 180) *
        Math.cos(frame.target.decDeg * Math.PI / 180), other.target.decDeg - frame.target.decDeg) < 5));
    const references = [];
    for (let start = 0; start < candidates.length; start += 4) {
      await Promise.all(candidates.slice(start, start + 4).map(async other => {
        let image;
        try { image = await load(other.url, frame.target, settings); }
        catch (error) {
          if (error.message === 'No detector coverage for this field.') return;
          throw error;
        }
        const pixel = projectSkyToPixel(image, frame.target.raDeg, frame.target.decDeg);
        if (!pixel) return;
        const wavelength = await wavelengthAt(other.url, pixel[0] + image.sourceX, pixel[1] + image.sourceY);
        if (Math.abs(wavelength - frame.wavelength) > referenceWavelengthTolerance) return;
        const projection = projectImage(image, frame.target, settings);
        const target = other.target ? byUrl.get(other.url)?.target ??
          positionAt(ephemeris, exposureTiming(image.header, other).midpoint) : null;
        const simulations = injections.map(shape => {
          const injected = target ? injectProfile(image, target, shape) : image;
          const simulated = projectImage(injected, frame.target, settings);
          if (target) maskComet(simulated, frame.target, target, size, referenceRadius);
          return simulated;
        });
        if (target) {
          maskComet(projection, frame.target, target, size, referenceRadius);
        }
        references.push({ projection, simulations });
      }));
    }
    frame.cleaned = references.length >= 2 ? subtractReference(frame.projection, references.map(ref => ref.projection)) : frame.projection;
    frame.injectedCleaned = frame.injected.map((injected, i) => references.length >= 2 ?
      subtractReference(injected, references.map(ref => ref.simulations[i])) : injected);
  }
  const cleaned = trackedMedian(frames, 'cleaned');
  await report('starSubtractedMedian', cleaned, injectionMedians('injectedCleaned'));
  const weighted = weightedStack(frames.map(frame => frame.cleaned));
  await report('starSubtractedWeighted', weighted, injections.map((_, i) => weightedStack(frames.map(frame => frame.injectedCleaned[i]))));
  return { tracked, cleaned, weighted, frames, failures };
}
