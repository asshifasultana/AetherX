import { createFitsRangeLoader } from './range-fits.js';
import { projectImage, projectSkyToPixel, skyGrid } from './fits-engine.js';
import { estimateBackground } from './background.js';
import { createWavelengthReader } from './wavelength.js';
import { positionAt, exposureTiming, trackedMedian, weightedStack } from './moving-stack.js';
import { kernelAt, crossSubtract } from './moving-psf.js';
import { injectProfile, profileValue } from './comet-profile.js';
import { angularSeparationArcsec } from '../sky-projection.js';

export const movingSize = 49;
const scale = 6.15, day = 86400000;
const settings = { fovArcmin: movingSize * scale / 60, hideBadPixels: true, includeVariance: true };
const center = (movingSize - 1) / 2;
const protectedRadius = 12;
const profiles = [{ name: 'compact', amplitude: 0.4, radius: 4, scale: 0.9 },
  { name: 'diffuse', amplitude: 0.4, radius: 20, scale: 4, east: .35, north: -.25 }];
const distance = (a, b) => angularSeparationArcsec(a.raDeg, a.decDeg, b.raDeg, b.decDeg);
const utcDay = exposure => exposure.observedStartUtc.slice(0, 10);
const finite = array => array.some(Number.isFinite);

async function json(fetchImpl, path, params) {
  const response = await fetchImpl(path + '?' + new URLSearchParams(params), { signal: AbortSignal.timeout(90000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Archive request failed.');
  return data;
}

function fitsEpochs(image, exposure) {
  const timing = exposureTiming(image.header, exposure);
  const start = Date.parse(timing.observedStartUtc) / day + 40587;
  const endDate = image.header['DATE-END'];
  const utc = typeof endDate === 'string' ? Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/i.test(endDate) ? endDate : endDate + 'Z') : NaN;
  const fitsEnd = Number(image.header['MJD-END']);
  const end = fitsEnd > start ? fitsEnd : Number.isFinite(utc) && utc / day + 40587 > start ? utc / day + 40587 :
    exposure.endMjd > start ? exposure.endMjd : start + exposure.exposureSeconds / 86400;
  if (!(start <= timing.midpoint && timing.midpoint <= end && end > start)) throw new Error('Invalid FITS exposure timing.');
  return [start, timing.midpoint, end];
}

function targetPixel(image, target) {
  const point = projectSkyToPixel(image, target.raDeg, target.decDeg);
  if (!point || !point.every(Number.isFinite) || point[0] < 0 || point[1] < 0 ||
      point[0] > image.width - 1 || point[1] > image.height - 1) {
    throw new Error('The predicted target position is outside this detector cutout.');
  }
  return point;
}

export function movingMetrics(values) {
  const aperture = (x, y) => {
    const i = y * movingSize + x;
    const pixels = [values[i], values[i - 1], values[i + 1], values[i - movingSize], values[i + movingSize]];
    return pixels.every(Number.isFinite) ? pixels.reduce((a, b) => a + b, 0) : NaN;
  };
  const controls = [];
  for (let dy = -18; dy <= 18; dy += 5) for (let dx = -18; dx <= 18; dx += 5) {
    if (Math.hypot(dx, dy) >= 8 && Math.hypot(dx, dy) <= 19) controls.push(aperture(center + dx, center + dy));
  }
  const sky = estimateBackground(controls, { iterations: 0 });
  const signal = aperture(center, center) - sky.level;
  return { apertureSignal: signal, apertureSkyScatter: sky.noise,
    apertureContrast: sky.used >= 8 && sky.noise > 0 ? signal / sky.noise : null, controlApertures: sky.used };
}

function protect(projection, pointing, track, smearArcsec = 0) {
  if (!track) return projection;
  const { coordinates } = skyGrid(pointing, settings.fovArcmin);
  const cos = Math.cos(track.decDeg * Math.PI / 180);
  for (let i = 0; i < projection.values.length; i++) {
    const dra = (coordinates[2 * i] - track.raDeg + 540) % 360 - 180;
    if (Math.hypot(dra * cos, coordinates[2 * i + 1] - track.decDeg) * 3600 <= protectedRadius * scale + smearArcsec) {
      projection.values[i] = NaN;
    }
  }
  return projection;
}

function withSupportedPixels(science, references) {
  const cleaned = crossSubtract(science, references);
  for (let i = 0; i < cleaned.values.length; i++) if (cleaned.referenceCounts[i] < 2) cleaned.values[i] = NaN;
  return cleaned;
}

function recovery(base, simulated, profile, inner, outer) {
  let expected = 0, recovered = 0, covered = 0, total = 0;
  for (let i = 0; i < base.length; i++) {
    const east = center - i % movingSize, north = center - Math.floor(i / movingSize);
    const radius = Math.hypot(east, north);
    if (radius < inner || radius > outer) continue;
    expected += profile.amplitude * profileValue(east - (profile.east || 0), north - (profile.north || 0), profile);
    total++;
    if (!Number.isFinite(base[i]) || !Number.isFinite(simulated[i])) continue;
    recovered += simulated[i] - base[i];
    covered++;
  }
  return { fraction: expected > 0 ? recovered / expected : null, coverage: covered / total };
}

export function createMovingView({ load = createFitsRangeLoader(), wavelengthAt = createWavelengthReader(),
  fetchImpl = fetch, psf = kernelAt } = {}) {
  let session, frames = [], failures = [];
  let positionQueue = Promise.resolve();

  function trajectory(times) {
    const job = positionQueue.then(async () => {
      const result = await json(fetchImpl, '/api/moving-observations', [
        ['action', 'positions'], ['object', session.object], ...times.map(t => ['mjd', t]),
      ]);
      if (result.observer !== session.observer || result.solution !== session.solution || result.name !== session.name) {
        throw new Error('The orbit solution changed. Repeat the moving-object search.');
      }
      return result.points;
    });
    positionQueue = job.catch(() => {});
    return job;
  }

  const cutout = (url, target) => load(url, target, settings, AbortSignal.timeout(30000));
  const dateTime = mjd => new Date((mjd - 40587) * day).toISOString();
  async function prepare(exposure) {
    const preliminary = positionAt(exposure.positions, (exposure.startMjd + exposure.endMjd) / 2);
    let image = await cutout(exposure.accessUrl, preliminary);
    const epochs = fitsEpochs(image, exposure);
    const points = epochs[0] < exposure.positions[0].mjd - 1e-9 ||
      epochs[2] > exposure.positions.at(-1).mjd + 1e-9 ? await trajectory(epochs) : exposure.positions;
    const bounded = t => positionAt(points, Math.min(points.at(-1).mjd, Math.max(points[0].mjd, t)));
    const [start, target, end] = epochs.map(bounded);
    if (distance(preliminary, target) > 0.01) image = await cutout(exposure.accessUrl, target);
    const [x, y] = targetPixel(image, target);
    const wavelength = await wavelengthAt(exposure.accessUrl, x + image.sourceX, y + image.sourceY);
    if (!(wavelength > 0)) throw new Error('Local wavelength calibration is unavailable.');
    const projection = projectImage(image, target, settings);
    if (!finite(projection.values)) throw new Error('No usable projected pixels.');
    return { ...exposure, image, target, midpoint: epochs[1], wavelength, projection,
      observedStartUtc: dateTime(epochs[0]), observedEndUtc: dateTime(epochs[2]),
      mjd: epochs[0], smearArcsec: distance(start, target) + distance(target, end) };
  }

  const describe = ({ observationId, productId, accessUrl, detector, observedStartUtc, observedEndUtc,
    midpoint, wavelength, target, smearArcsec, projection }) => ({
    observationId, productId, accessUrl, detector, observedStartUtc, observedEndUtc, midpoint, wavelength, target,
    smearArcsec, centerValid: Number.isFinite(projection.values[center * movingSize + center]),
    coverage: projection.values.filter(Number.isFinite).length / projection.values.length,
  });
  function days(selected) {
    return [...Map.groupBy(selected, utcDay)].map(([date, members]) => ({
      date, ...trackedMedian(members), exposures: members.map(describe),
    }));
  }
  function selectedRange(min, max) {
    if (!(Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min)) throw new Error('Select a valid wavelength interval.');
    const selected = frames.filter(frame => frame.wavelength >= min && frame.wavelength <= max);
    if (!selected.length) throw new Error('No usable exposures fall inside this wavelength range.');
    return selected;
  }

  async function scan(search, exposures, progress = () => {}) {
    if (!exposures.length || exposures.length > 80 || new Set(exposures.map(e => e.detector)).size !== 1) {
      throw new Error('Select 1–80 exposures from one detector.');
    }
    session = search;
    frames = [];
    failures = [];
    let completed = 0;
    for (const [, members] of Map.groupBy(exposures, utcDay)) {
      for (let i = 0; i < members.length; i += 4) {
        const batch = members.slice(i, i + 4);
        const prepared = await Promise.allSettled(batch.map(prepare));
        prepared.forEach((item, index) => {
          if (item.status === 'fulfilled') frames.push(item.value);
          else {
            const exposure = batch[index];
            failures.push({ observationId: exposure.observationId, productId: exposure.productId, reason: item.reason.message });
          }
        });
        completed += batch.length;
        if (i + batch.length < members.length) progress({ completed, total: exposures.length });
      }
      const first = frames[0] && frames.filter(frame => utcDay(frame) === utcDay(frames[0]));
      progress({ completed, total: exposures.length, preview: first ? days(first)[0] : null });
    }
    if (!frames.length) throw new Error(`No exposures could be aligned. ${failures[0]?.reason || ''}`);
    return { frames: frames.map(describe), days: days(frames), failures };
  }

  async function enhance(selected, progress) {
    if (selected.length > 24) throw new Error('Enhanced contrast supports up to 24 science exposures. Narrow the selection.');
    const cleaned = [], injections = profiles.map(() => []), referenceReport = [];
    const scienceIds = new Set(frames.map(frame => frame.observationId));
    for (const science of selected) {
      const refs = [], simulatedRefs = profiles.map(() => []), sources = [];
      const date = mjd => dateTime(mjd).slice(0, 10);
      const independent = [];
      let referenceSearchError;
      try {
        const result = await json(fetchImpl, '/api/observations', {
          raDeg: science.target.raDeg, decDeg: science.target.decDeg, detector: science.detector,
          startDate: date(science.midpoint - 30), endDate: date(science.midpoint + 30),
        });
        if (!result.nextCursor) {
          independent.push(...result.observations.filter(e => !scienceIds.has(e.observationId) &&
            Number.isFinite(e.startMjd) && e.endMjd > e.startMjd)
            .sort((a, b) => Math.abs(a.startMjd - science.midpoint) - Math.abs(b.startMjd - science.midpoint)).slice(0, 4));
        } else referenceSearchError = 'Independent reference search was incomplete.';
      } catch (err) { referenceSearchError = err.message; }
      const project = (image, kernel, target, profile) => {
        const native = profile && target ? injectProfile(image, target, profile) : image;
        return { ...projectImage(native, science.target, settings), kernel };
      };
      async function addReference(exposure, reuse) {
        try {
          const image = await cutout(exposure.accessUrl, science.target);
          const [x, y] = targetPixel(image, science.target);
          const wavelength = await wavelengthAt(exposure.accessUrl, x + image.sourceX, y + image.sourceY);
          if (!Number.isFinite(wavelength) || Math.abs(wavelength - science.wavelength) > .025) return;
          const target = reuse ? exposure.target : null;
          if (!reuse) {
            const epochs = fitsEpochs(image, exposure);
            const track = await trajectory(epochs);
            const [start, mid, end] = epochs.map(t => positionAt(track, t));
            const fieldRadius = Math.SQRT2 * center * scale;
            const travel = distance(start, mid) + distance(mid, end);
            if (!(distance(science.target, mid) > fieldRadius + protectedRadius * scale + travel)) return;
          }
          const kernel = await psf(image, science.target, science.detector, settings);
          const projected = protect(project(image, kernel), science.target, target, exposure.smearArcsec);
          if (!finite(projected.values)) return;
          refs.push(projected);
          profiles.forEach((profile, i) => simulatedRefs[i].push(target
            ? protect(project(image, kernel, target, profile), science.target, target, exposure.smearArcsec)
            : projected));
          sources.push({ productId: exposure.productId, strategy: reuse ? 'masked other UTC day' : 'independent', wavelength });
        } catch (err) { referenceSearchError ??= err.message; }
      }
      for (const exposure of independent) await addReference(exposure, false);
      if (refs.length < 2) {
        const otherDays = selected.filter(e => utcDay(e) !== utcDay(science) && distance(e.target, science.target) < 5 * 3600)
          .sort((a, b) => distance(b.target, science.target) - distance(a.target, science.target))
          .slice(0, 8 - independent.length);
        for (const exposure of otherDays) await addReference(exposure, true);
      }
      const record = { productId: science.productId, sources, supportedPixels: 0, ...(referenceSearchError ? { warning: referenceSearchError } : {}) };
      if (refs.length >= 2) {
        const kernel = await psf(science.image, science.target, science.detector, settings);
        const result = withSupportedPixels({ ...science.projection, kernel }, refs);
        if (finite(result.values)) {
          cleaned.push(result);
          profiles.forEach((profile, i) => injections[i].push(withSupportedPixels(project(science.image, kernel, science.target, profile), simulatedRefs[i])));
          record.supportedPixels = result.values.filter(Number.isFinite).length;
        }
      }
      referenceReport.push(record);
      progress({ completed: referenceReport.length, total: selected.length });
    }
    if (!cleaned.length) return { unavailable: 'No pixels have two usable wavelength-matched references.', referenceReport };
    const stack = weightedStack(cleaned);
    return { ...stack, referenceReport, metrics: movingMetrics(stack.values),
      referenceCoverage: stack.values.filter(Number.isFinite).length / stack.values.length,
      injectionRecovery: profiles.map((profile, i) => {
        const { values } = weightedStack(injections[i]);
        return { profile: profile.name, core: recovery(stack.values, values, profile, 0, 2),
          outer: recovery(stack.values, values, profile, 9, 15) };
      }) };
  }

  return {
    scan,
    async stack({ min, max, enhanced }, progress) {
      const selected = selectedRange(min, max);
      const tracked = trackedMedian(selected);
      return { tracked: { ...tracked, metrics: movingMetrics(tracked.values) }, days: days(selected),
        enhanced: enhanced ? await enhance(selected, progress) : null, frames: selected.map(describe),
        failures: [...failures, ...frames.filter(frame => !selected.includes(frame)).map(frame => ({
          productId: frame.productId, reason: 'Outside selected wavelength interval.',
        }))] };
    },
  };
}
