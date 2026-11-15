// The AI guide's investigation tools: find changes, measure and crossmatch
// spots, keep each spot's case file, run quests, patrols and tours. Executed in
// the browser on the real viewer; every result is plain measured data. Case
// files are updated by lib/case-file.js rules, never by the model.

import { canvasToSky } from './sky-projection.js';
import { findBlobs, pairBlobs } from './lib/blobs.js';
import { createCaseBook, applyEvidence, summarize } from './lib/case-file.js';
import { parallaxShift, separationArcsec, equatorialToEcliptic } from './lib/ecliptic.js';
import { measureAt, wavelengthAtSky, centroidAt } from './lib/photometry.js';
import { fitLinearMotion } from './lib/motion-fit.js';
import { chooseEpochPair, WAVELENGTH_WARN_UM } from './lib/epochs.js';
import { locateTarget } from './lib/target-locate.js';
import { propagateGaia } from './gaia-core.js';
import { spectralHints } from './lib/spectral-hints.js';
import { QUESTS, NORTH_ECLIPTIC_POLE, barnardTrack, checkQuestAnswer, randomViewOffset } from './lib/quests.js';
import { TOURS } from './lib/tours.js';
import { submitRecovery } from './lib/planetx-votes.js';
import { shareUrl } from './share.js';
import { pollUntil } from './lib/background-jobs.js';
import { fastStarPasses, yearOf } from './lib/proper-motion.js';

const DAY_MS = 86_400_000;
const mjdOf = ms => ms / DAY_MS + 40587;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const round = (value, digits = 1) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export function createInvestigator({ base, latest, emit, settle, needFrames, snapshot, jobs }) {
  const cases = createCaseBook();
  const spotMeta = new Map(); // spot number → { date, role }
  let quest = null;
  const questStats = [];
  let capabilities = null;

  /** Ask a viewer module over the event bus and wait for its respond() call. */
  function request(type, detail = {}, timeout = 5000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeout);
      emit(type, { ...detail, respond: value => { clearTimeout(timer); resolve(value); } });
    });
  }

  async function getCapabilities() {
    if (capabilities) return capabilities;
    try {
      const response = await fetch('/api/agent?capabilities=1');
      capabilities = response.ok ? await response.json() : {};
    } catch { capabilities = {}; }
    return capabilities;
  }

  const spots = async () => (await request('sky:spots-requested')) || [];
  async function spotOrError(n) {
    const spot = (await spots()).find(entry => entry.n === n);
    return spot || null;
  }
  function caseFor(spot) { return cases.ensure(spot); }
  function record(spot, tool, result) {
    const file = applyEvidence(caseFor(spot), tool, result);
    const summary = summarize(file);
    // Marking a spot is not news; a card appears once a real check updates it.
    emit('sky:case-updated', { case: summary, quiet: tool === 'find_changes' });
    // The viewer colours a spot once its case identifies a known object.
    emit('sky:agent-spots', { found: [{ n: spot.n, found: summary.verdict.label === 'known object' }] });
    return summary;
  }

  const frames = () => (Array.isArray(latest.frames) ? latest.frames : []);
  const currentFrameTime = () => {
    const date = latest.playback?.frameDate;
    const time = Date.parse(date || '');
    return Number.isFinite(time) ? time : frames().at(-1)?.frameTime ?? Date.now();
  };
  function frameNear(time) {
    let best = null;
    for (const frame of frames()) if (!best || Math.abs(frame.frameTime - time) < Math.abs(best.frameTime - time)) best = frame;
    return best;
  }
  function spread(list, count) {
    if (list.length <= count) return list;
    return Array.from({ length: count }, (_, index) => list[Math.round(index * (list.length - 1) / (count - 1))]);
  }

  async function addAgentSpots(entries) {
    const result = await request('sky:agent-spots', { add: entries });
    return result?.added || [];
  }

  // ---- wavelengths ------------------------------------------------------------
  // SPHEREx sees the field centre at a different wavelength on each visit;
  // comparisons use frames whose wavelengths match. Cached per frame and place.
  const wavelengths = new Map();
  function fieldCentre(frameTime) {
    const target = latest.target;
    if (!Number.isFinite(target?.raDeg)) return null;
    return locateTarget({ target, frameTime }) || target;
  }
  function wavelengthFor(frame, signal) {
    const centre = fieldCentre(frame.frameTime);
    if (!frame?.accessUrl || !centre) return Promise.resolve(null);
    const key = `${frame.accessUrl}|${centre.raDeg.toFixed(3)}|${centre.decDeg.toFixed(3)}`;
    if (!wavelengths.has(key)) {
      const pending = wavelengthAtSky(frame, centre, signal).catch(() => null);
      wavelengths.set(key, pending);
      pending.then(value => { if (value === null) wavelengths.delete(key); });
    }
    return wavelengths.get(key);
  }
  async function wavelengthsOf(list, signal) {
    const found = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < list.length) {
        if (signal?.aborted) return;
        const frame = list[next++];
        const value = await wavelengthFor(frame, signal);
        if (Number.isFinite(value)) found.set(frame, value);
      }
    }));
    return found;
  }
  async function differenceWavelengthGap(state) {
    const now = frameNear(Date.parse(state.date || '')), before = frameNear(Date.parse(state.referenceDate || ''));
    if (!now || !before || now === before) return null;
    const [a, b] = await Promise.all([wavelengthFor(now), wavelengthFor(before)]);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
  }

  // ---- find_changes -------------------------------------------------------
  async function findChanges({ limit = 3, mark = true }) {
    const state = await request('sky:difference-requested');
    if (!state) return { ok: false, error: 'No difference image is on screen. Call compare_frames with view "difference" (or pick_epochs) first.' };
    const blobs = findBlobs(state, { limit: 12 });
    const pairs = pairBlobs(blobs);
    const toSky = blob => canvasToSky({ x: blob.x, y: blob.y, size: state.width, centerRaDeg: state.center.raDeg, centerDecDeg: state.center.decDeg });
    const described = blobs.slice(0, limit).map(blob => {
      const sky = toSky(blob);
      const pair = pairs.find(entry => entry.now === blob || entry.before === blob);
      return { ...blob, raDeg: sky?.raDeg, decDeg: sky?.decDeg, pair };
    }).filter(blob => Number.isFinite(blob.raDeg));
    let marked = [];
    const spotFor = blob => marked[described.indexOf(blob)]?.n ?? null;
    if (mark && described.length) {
      // A fresh search replaces the guide's earlier automatic spots.
      await request('sky:agent-spots', { clear: 'agent' });
      for (const n of [...spotMeta.keys()]) if (!(await spots()).some(spot => spot.n === n)) { spotMeta.delete(n); cases.remove(n); }
      marked = await addAgentSpots(described.map(blob => ({ raDeg: blob.raDeg, decDeg: blob.decDeg, origin: 'agent', label: `${blob.sign} ${blob.peakSigma}σ` })));
      marked.forEach((spot, index) => {
        const blob = described[index];
        spotMeta.set(spot.n, { date: blob.sign === 'fainter' ? state.referenceDate : state.date, role: blob.sign === 'fainter' ? 'before' : 'now' });
        // The other half of a moved pair, when both halves were marked.
        const same = (a, b) => a.x === b.x && a.y === b.y && a.sign === b.sign;
        const other = blob.pair && !blob.pair.adjacent ? (same(blob.pair.now, blob) ? blob.pair.before : blob.pair.now) : null;
        const partner = other ? marked[described.findIndex(entry => same(entry, other))]?.n ?? null : null;
        record(spot, 'find_changes', { blob, pairedAdjacent: Boolean(blob.pair?.adjacent), ...(partner ? { pairedWith: partner } : {}) });
      });
    }
    const wavelengthGapUm = await differenceWavelengthGap(state);
    return {
      ok: true,
      sigma: round(state.sigma, 4), thresholdSigma: state.threshold,
      comparing: { now: state.date.slice(0, 10), reference: state.referenceDate ? state.referenceDate.slice(0, 10) : state.referenceLabel },
      ...(Number.isFinite(wavelengthGapUm) ? { wavelengthGapUm: round(wavelengthGapUm, 3) } : {}),
      totalPatches: blobs.length,
      changes: described.map(blob => ({
        spot: spotFor(blob), sign: blob.sign, peakSigma: blob.peakSigma, pixels: blob.pixels,
        raDeg: round(blob.raDeg, 5), decDeg: round(blob.decDeg, 5),
        ...(blob.singlePixel ? { note: 'single pixel: often a glitch' } : blob.touchesMask ? { note: 'next to masked pixels: often a saturated-star residual' } : {}),
        ...(blob.edge ? { edge: true } : {})
      })),
      ...(Math.abs(wavelengthGapUm) > WAVELENGTH_WARN_UM ? { wavelengthNote: `The two frames were taken ${round(Math.abs(wavelengthGapUm), 3)} μm apart in wavelength, so residuals around stars are likely colour, not change.` } : {}),
      movedPairs: pairs.filter(pair => described.includes(pair.now) || described.includes(pair.before)).map(pair => ({
        nowSpot: spotFor(pair.now), beforeSpot: spotFor(pair.before),
        separationArcsec: round(pair.separationPx * 6.15, 1),
        ...(pair.adjacent ? { note: 'touching pair: often a colour residual around a star, not motion' } : {})
      })),
      ...(blobs.length ? {} : { note: 'Nothing changed beyond the threshold.' })
    };
  }

  // ---- measure_source -----------------------------------------------------
  async function measureSource({ spot: n, max_frames: maxFrames = 8 }, { signal }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    if (!(await needFrames(signal))) return { ok: false, error: 'No observations are loaded for this target yet.' };
    const chosen = spread(frames(), maxFrames);
    const measurements = [];
    let failed = 0;
    await Promise.all(chosen.map(async frame => {
      try {
        const value = await measureAt(frame, spot, signal, { wavelength: false, radiusArcsec: spot.radiusArcsec });
        measurements.push({ date: isoDay(frame.frameTime), fluxMicroJy: round(value.fluxMicroJy, 2), errorMicroJy: round(value.errorMicroJy, 2), snr: round(value.snr, 1) });
      } catch (error) { if (signal?.aborted) throw error; failed++; }
    }));
    measurements.sort((a, b) => a.date.localeCompare(b.date));
    const detected = measurements.filter(entry => entry.snr >= 3);
    let variabilitySigma = null;
    if (detected.length >= 3) {
      const weights = detected.map(entry => 1 / Math.max(entry.errorMicroJy, 1e-6) ** 2);
      const mean = detected.reduce((sum, entry, index) => sum + entry.fluxMicroJy * weights[index], 0) / weights.reduce((a, b) => a + b, 0);
      variabilitySigma = round(Math.max(...detected.map(entry => Math.abs(entry.fluxMicroJy - mean) / entry.errorMicroJy)), 1);
    }
    const result = { ok: true, spot: n, ...areaNote(spot, 'Fluxes are the total brightness inside the whole area above the local sky, not one source.'), measured: measurements.length, skipped: failed, detectedOnDates: new Set(detected.map(entry => entry.date)).size, measurements, variabilitySigma };
    return { ...result, case: record(spot, 'measure_source', result).verdict };
  }

  // ---- get_spectrum -------------------------------------------------------
  async function getSpectrum({ spot: n }, { signal }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const all = (window.spherexObservationState?.observations || []).filter(observation => observation.accessUrl);
    if (!all.length) return { ok: false, error: 'No observations are loaded for this position yet.' };
    const byWave = [...all].sort((a, b) => (Number(a.wavelengthMinUm) || Number(a.detector)) - (Number(b.wavelengthMinUm) || Number(b.detector)));
    const chosen = spread(byWave, 24), samples = [];
    let failed = 0, next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < chosen.length) {
        const observation = chosen[next++];
        try { samples.push(await measureAt(observation, spot, signal, { radiusArcsec: spot.radiusArcsec })); }
        catch (error) { if (signal?.aborted) throw error; failed++; }
      }
    }));
    const hints = spectralHints(samples);
    return {
      ok: true, spot: n, ...areaNote(spot, 'This is the combined spectrum of everything inside the area.'), measured: samples.length, skipped: failed,
      wavelengthRangeUm: samples.length ? [round(Math.min(...samples.map(s => s.wavelengthUm)), 2), round(Math.max(...samples.map(s => s.wavelengthUm)), 2)] : null,
      ...hints
    };
  }

  // ---- crossmatch ---------------------------------------------------------
  // A point is matched against the nearest entries of three star catalogues
  // (Gaia, CatWISE2020 for cold infrared sources, SIMBAD for named objects),
  // each moved to the frame date, and JPL's known asteroids. An area lists
  // what lies inside its circle instead.
  const STAR_CATALOGUES = {
    gaia: { path: '/api/gaia-sources', label: 'Gaia' },
    catwise: { path: '/api/catwise-sources', label: 'CatWISE2020' },
    simbad: { path: '/api/simbad-sources', label: 'SIMBAD' }
  };
  const starAt = (star, year) => propagateGaia({ ...star, refEpoch: Number(star.refEpoch) || 2016, pmra: Number(star.pmra) || 0, pmdec: Number(star.pmdec) || 0 }, year);
  const starFields = {
    gaia: star => ({ sourceId: String(star.sourceId), gMag: round(star.gMag, 1) }),
    catwise: star => ({ sourceId: String(star.sourceId), w1: round(star.w1, 2), w2: round(star.w2, 2) }),
    simbad: star => ({ sourceId: String(star.sourceId), name: star.mainId || String(star.sourceId), otype: star.otype || null })
  };

  // Raw sources from one catalogue around a spot, or { error }.
  function starLookup(kind, spot, year, signal) {
    const area = spot.radiusArcsec || 0, searched = area || 90;
    const { path, label } = STAR_CATALOGUES[kind];
    // A slow catalogue does not hold up the others: past 10 s it finishes in the background.
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)].filter(Boolean));
    return fetch(`${path}?${new URLSearchParams({ ra: spot.raDeg.toFixed(6), dec: spot.decDeg.toFixed(6), radius: (searched / 3600).toFixed(5) })}`, { signal: bounded })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`${label} lookup failed.`)))
      .then(data => {
        const sources = (data.sources || []).map(star => ({ ...star, catalog: label }));
        const within = sources.map(star => ({ ...starFields[kind](star), pmra: round(star.pmra, 1), pmdec: round(star.pmdec, 1), separationArcsec: round(separationArcsec(spot, starAt(star, year)), 1) }))
          .filter(star => star.separationArcsec <= searched).sort((a, b) => a.separationArcsec - b.separationArcsec);
        return { sources, within, truncated: Boolean(data.truncated) };
      })
      .catch(error => { if (signal?.aborted) throw error; return { error: error.name === 'TimeoutError' ? `${label} is slow to answer.` : error.message }; });
  }

  // What the model and the case file see from one catalogue.
  function describeStars(kind, found, spot) {
    if (found.error) return { error: found.error };
    const { within, truncated } = found, area = spot.radiusArcsec || 0;
    if (!area) return { nearest: within[0] || null, ...(kind === 'gaia' ? { within: within.slice(0, 8) } : { count: within.length }), searchedArcsec: 90, ...(truncated ? { truncated: true } : {}) };
    if (kind === 'simbad') return { areaRadiusArcsec: area, objectsInside: within.length, named: within.slice(0, 8).map(star => `${star.name}${star.otype ? ` (${star.otype})` : ''}`) };
    if (kind === 'catwise') return { areaRadiusArcsec: area, sourcesInside: within.length, ...(truncated ? { countIsLowerLimit: true } : {}) };
    const fast = within.filter(star => Math.hypot(star.pmra || 0, star.pmdec || 0) >= 100);
    return {
      areaRadiusArcsec: area, starsInside: within.length, ...(truncated ? { countIsLowerLimit: true, note: 'Gaia returned only the brightest 1000 stars here, so there are more.' } : {}),
      brightest: [...within].sort((a, b) => a.gMag - b.gMag).slice(0, 5), fastMoving: fast.slice(0, 5), fastMovingCount: fast.length
    };
  }

  // Fast stars are tracked over every loaded source of every catalogue, before
  // the 90″ cut: one that sat here in 2000 can be several arcminutes away by now.
  function movedThrough(spot, sources, time) {
    const nowYear = yearOf(time), lastFrame = frames().at(-1)?.frameTime;
    const toYear = Math.max(nowYear, Number.isFinite(lastFrame) ? yearOf(lastFrame) : nowYear);
    const byId = new Map(sources.map(star => [String(star.sourceId), star]));
    const seen = new Set();
    return fastStarPasses(spot, sources, { fromYear: 2000, toYear, nowYear }).map(pass => {
      const star = byId.get(pass.sourceId) || {};
      return { ...pass, catalog: star.catalog || 'Gaia', ...(star.mainId ? { name: star.mainId, otype: star.otype || null } : {}) };
    }).filter(pass => {
      // The same star listed by two catalogues is one pass.
      const key = `${pass.now.raDeg.toFixed(3)}|${pass.now.decDeg.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 3);
  }

  const jplObject = object => ({ name: object.name, separationArcsec: round(object.separationArcsec, 1), vMag: object.vMag, rateArcsecPerHour: object.rateArcsecPerHour });
  const jplLookup = (spot, time, signal) => {
    const area = spot.radiusArcsec || 0;
    return fetch(`/api/known-objects?${new URLSearchParams({ ra: spot.raDeg.toFixed(6), dec: spot.decDeg.toFixed(6), time: new Date(time).toISOString(), radius: String(area ? Math.max(5, Math.min(1800, area)) : 60) })}`, { signal })
      .then(response => response.json())
      .then(data => {
        if (!data.checked) return { checked: false, ...(data.pending ? { pending: true } : {}), error: data.error };
        if (!area) return { checked: true, date: data.date, count: data.count, nearest: data.objects?.[0] ? jplObject(data.objects[0]) : null };
        const inside = (data.objects || []).filter(object => !(object.separationArcsec > area)).map(jplObject);
        return { checked: true, date: data.date, areaRadiusArcsec: area, objectsInside: inside.length, objects: inside.slice(0, 8) };
      })
      .catch(error => { if (signal?.aborted) throw error; return { checked: false, error: 'JPL did not answer.' }; });
  };
  const areaNote = (spot, note) => spot.radiusArcsec ? { areaRadiusArcsec: spot.radiusArcsec, note } : {};

  // A lookup that is still computing (JPL) or failed (a star catalogue) keeps
  // going in the background; when it finishes, the case file updates and the
  // guide is told.
  function backgroundLookup(kind, spot, n, time) {
    if (!jobs) return null;
    const label = kind === 'jpl' ? `Known-asteroid check (JPL) for spot ${n}` : `Star catalogue check (${STAR_CATALOGUES[kind].label}) for spot ${n}`;
    const job = jobs.start(`${kind}:${n}:${spot.raDeg.toFixed(5)}:${spot.decDeg.toFixed(5)}:${spot.radiusArcsec || 0}:${isoDay(time)}`, label, async signal => {
      const value = await pollUntil(async pollSignal => {
        const result = kind === 'jpl' ? await jplLookup(spot, time, pollSignal) : await starLookup(kind, spot, yearOf(time), pollSignal);
        return (kind === 'jpl' ? result.checked : !result.error) ? result : undefined;
      }, { intervalMs: kind === 'jpl' ? 4000 : 8000, timeoutMs: kind === 'jpl' ? 180_000 : 60_000, signal });
      const result = kind === 'jpl'
        ? { ok: true, spot: n, date: isoDay(time), jpl: value }
        : { ok: true, spot: n, date: isoDay(time), [kind]: describeStars(kind, value, spot), ...(spot.radiusArcsec ? {} : { movedThrough: movedThrough(spot, value.sources, time), trackedSince: 2000 }) };
      return { ...result, case: record(spot, 'crossmatch', result).verdict };
    }, { spot: n });
    return job.id;
  }

  async function crossmatch({ spot: n, date }, { signal }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const meta = spotMeta.get(n);
    const time = date ? Date.parse(date + 'T12:00:00Z') : Date.parse(meta?.date || '') || currentFrameTime();
    const year = yearOf(time), kinds = Object.keys(STAR_CATALOGUES);
    const [found, jpl] = await Promise.all([Promise.all(kinds.map(kind => starLookup(kind, spot, year, signal))), jplLookup(spot, time, signal)]);
    const later = 'It keeps running in the background and its result will arrive on its own; carry on with other checks.';
    const stars = Object.fromEntries(kinds.map((kind, i) => [kind, describeStars(kind, found[i], spot)]));
    kinds.forEach((kind, i) => { if (found[i].error) { const id = backgroundLookup(kind, spot, n, time); if (id) Object.assign(stars[kind], { background: id, note: later }); } });
    if (!jpl.checked) { const id = backgroundLookup('jpl', spot, n, time); if (id) Object.assign(jpl, { background: id, note: later }); }
    const answered = found.filter(entry => !entry.error);
    const point = !spot.radiusArcsec;
    const result = {
      ok: true, spot: n, ...areaNote(spot, 'This lists what is inside the area; it does not explain any one source in it.'), date: isoDay(time), ...stars, jpl,
      ...(point && answered.length ? { movedThrough: movedThrough(spot, answered.flatMap(entry => entry.sources), time), trackedSince: 2000, ...(found[0].truncated ? { truncated: true } : {}) } : {})
    };
    // A matching catalogued star's motion seeds the multi-date motion check.
    if (point) {
      // Gaia and SIMBAD first: CatWISE motions of saturated stars can be wild.
      const match = ['gaia', 'simbad', 'catwise'].map(kind => stars[kind].nearest).find(star => star && star.separationArcsec <= 6 && Math.hypot(star.pmra || 0, star.pmdec || 0) > 0);
      if (match) spotMeta.set(n, { ...(spotMeta.get(n) || {}), pm: { pmra: match.pmra, pmdec: match.pmdec } });
    }
    return { ...result, case: record(spot, 'crossmatch', result).verdict };
  }

  async function getCase({ spot: n }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const summary = summarize(caseFor(spot));
    emit('sky:case-updated', { case: summary, show: true });
    return { ok: true, ...summary };
  }

  async function markSpot({ raDeg, decDeg, label, radiusArcsec }) {
    const [added] = await addAgentSpots([{ raDeg, decDeg, origin: 'agent', label, radiusArcsec }]);
    return added ? { ok: true, spot: added.n, ...(added.radiusArcsec ? { radiusArcsec: added.radiusArcsec } : {}) } : { ok: false, error: 'All 9 spots are in use; remove one first.' };
  }

  // Same path as the Mark star button (mark-target.js): moved to the frame
  // date for proper motion, then snapped onto the source.
  async function markTarget() {
    const result = await request('sky:mark-target-requested', { origin: 'agent' }, 30000);
    if (!result) return { ok: false, error: 'The viewer did not answer; is an image on screen?' };
    if (result.ok) spotMeta.set(result.spot, { date: new Date(Date.parse(result.date + 'T12:00:00Z') || currentFrameTime()).toISOString(), role: 'target' });
    return result;
  }

  // ---- confirm_motion -------------------------------------------------------
  // Backyard Worlds style vetting: follow the source across many dates. A real
  // mover sits on one straight line; glitches show once and colour residuals
  // jump around.
  async function confirmMotion({ spot: n, to_spot: toN }, { signal, progress = () => {} }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    if (spot.radiusArcsec) return { ok: false, error: `Spot ${n} is an area; mark a point on one object to follow its motion.` };
    if (!(await needFrames(signal))) return { ok: false, error: 'No observations are loaded for this target yet.' };
    const refTime = Date.parse(spotMeta.get(n)?.date || '') || currentFrameTime();
    // Seed: the moved pair, a matching catalogued star's motion, or none.
    let rate = { ra: 0, dec: 0 }, seed = 'none';
    if (toN) {
      const other = await spotOrError(toN);
      const otherTime = Date.parse(spotMeta.get(toN)?.date || '');
      if (!other) return { ok: false, error: `There is no spot ${toN}.` };
      if (Number.isFinite(otherTime) && Math.abs(otherTime - refTime) > DAY_MS / 2) {
        const days = (otherTime - refTime) / DAY_MS;
        rate = { ra: (((other.raDeg - spot.raDeg + 540) % 360) - 180) / days, dec: (other.decDeg - spot.decDeg) / days };
        seed = `spots ${n} and ${toN}`;
      }
    } else if (spotMeta.get(n)?.pm) {
      const { pmra, pmdec } = spotMeta.get(n).pm;
      rate = { ra: pmra / 3.6e6 / 365.25 / Math.cos(spot.decDeg * Math.PI / 180), dec: pmdec / 3.6e6 / 365.25 };
      seed = 'catalogue proper motion';
    }
    const chosen = spread([...frames()].sort((a, b) => a.frameTime - b.frameTime), 12);
    // Nearest dates first, so each prediction leans on a fit to closer dates.
    const order = [...chosen].sort((a, b) => Math.abs(a.frameTime - refTime) - Math.abs(b.frameTime - refTime));
    const detections = [], misses = [];
    let fit = null;
    const predict = time => fit ? fit.at(time) : { raDeg: spot.raDeg + rate.ra * (time - refTime) / DAY_MS, decDeg: spot.decDeg + rate.dec * (time - refTime) / DAY_MS };
    for (let i = 0; i < order.length && !signal?.aborted; i += 4) {
      progress(`Following spot ${n}: dates ${i + 1}-${Math.min(order.length, i + 4)} of ${order.length}…`);
      await Promise.all(order.slice(i, i + 4).map(async frame => {
        const date = isoDay(frame.frameTime);
        try {
          let found = await centroidAt(frame, predict(frame.frameTime), signal, { searchPx: 3 });
          // Refine with a tighter box around the first centroid.
          if (found.detected) { const refined = await centroidAt(frame, found, signal, { searchPx: 2 }).catch(() => null); if (refined?.detected) found = refined; }
          if (found.detected && found.snr >= 3) detections.push({ time: frame.frameTime, raDeg: found.raDeg, decDeg: found.decDeg, snr: found.snr, date });
          else misses.push({ date, snr: found.snr ?? null });
        } catch (error) { if (signal?.aborted) throw error; misses.push({ date, error: 'outside image or flagged' }); }
      }));
      // A fit over a few days is mostly noise; predictions lean on it only once
      // it spans a couple of months and the dates agree.
      const running = detections.length >= 3 ? fitLinearMotion(detections) : null;
      if (running?.consistent && running.spanYears >= 0.15) fit = running;
    }
    detections.sort((a, b) => a.time - b.time);
    fit = detections.length >= 2 ? fitLinearMotion(detections) : null;
    const dates = new Set(detections.map(entry => entry.date)).size;
    const motion = fit ? { motionArcsecPerYear: fit.motionArcsecPerYear, directionDeg: fit.directionDeg, significance: fit.significance, consistent: fit.consistent, rmsArcsec: fit.rmsArcsec, spanYears: fit.spanYears, offLine: fit.dates.filter(entry => !entry.agrees).map(entry => entry.date) } : { consistent: false };
    const comovers = fit && fit.significance >= 3 && fit.motionArcsecPerYear >= 0.1 ? await findComovers(spot, fit, signal) : [];
    // A real, measured motion goes on the spot's track, so the viewer draws an
    // arrow along the fitted line from the first date it was seen to the last.
    if (fit?.consistent && fit.significance >= 3) {
      const first = detections[0].time, last = detections.at(-1).time;
      await request('sky:agent-spots', { track: [{ n, points: [{ ...fit.at(first), date: isoDay(first) }, { ...fit.at(last), date: isoDay(last) }] }] });
    }
    const result = {
      ok: true, spot: n, seededFrom: seed, detectedOnDates: dates, of: order.length, ...motion,
      ...(comovers.length ? { comovers } : {}),
      ...(misses.length ? { notDetected: misses.slice(0, 6).map(entry => entry.date) } : {}),
      note: fit?.consistent ? 'The positions line up across the dates.' : dates >= 2 ? 'The positions do not line up on one straight line.' : 'Too few detections to follow it across dates.'
    };
    return { ...result, case: record(spot, 'confirm_motion', result).verdict };
  }

  // Catalogue stars within 5′ moving the same way (proper motion within 20%):
  // a wide companion would share the motion.
  async function findComovers(spot, fit, signal) {
    const direction = fit.directionDeg * Math.PI / 180, pm = fit.motionArcsecPerYear * 1000;
    const want = { pmra: pm * Math.sin(direction), pmdec: pm * Math.cos(direction) };
    const query = new URLSearchParams({ ra: spot.raDeg.toFixed(6), dec: spot.decDeg.toFixed(6), radius: (300 / 3600).toFixed(5) });
    const lists = await Promise.all(['/api/gaia-sources', '/api/simbad-sources'].map(path => fetch(`${path}?${query}`, { signal }).then(response => response.ok ? response.json() : null).catch(() => null)));
    const year = yearOf(currentFrameTime()), seen = new Set();
    return lists.flatMap((data, i) => (data?.sources || []).map(star => ({ star, catalog: i ? 'SIMBAD' : 'Gaia' })))
      .filter(({ star }) => Number.isFinite(Number(star.pmra)) && Number.isFinite(Number(star.pmdec)) && Math.hypot(star.pmra - want.pmra, star.pmdec - want.pmdec) <= 0.2 * pm)
      .map(({ star, catalog }) => ({ catalog, id: star.mainId || String(star.sourceId), separationArcsec: round(separationArcsec(spot, starAt(star, year)), 0), pmMasYr: round(Math.hypot(star.pmra, star.pmdec), 0) }))
      .filter(entry => entry.separationArcsec > 6 && entry.separationArcsec <= 300 && !seen.has(entry.id) && seen.add(entry.id))
      .sort((a, b) => a.separationArcsec - b.separationArcsec).slice(0, 5);
  }

  async function resizeSpot({ spot: n, radiusArcsec }) {
    const result = await request('sky:agent-spots', { resize: [{ n, radiusArcsec }] });
    const [resized] = result?.resized || [];
    if (!resized) return { ok: false, error: `There is no spot ${n}.`, spots: (await spots()).map(spot => spot.n) };
    return { ok: true, spot: n, ...(resized.radiusArcsec ? { radiusArcsec: resized.radiusArcsec } : { point: true }) };
  }

  async function removeSpots({ spots: listed, keep, all }) {
    const before = await spots();
    const missing = [...(listed || []), ...(keep || [])].filter(n => !before.some(spot => spot.n === n));
    if (missing.length && !all) return { ok: false, error: `There is no spot ${missing.join(', ')}.`, spots: before.map(spot => spot.n) };
    const remove = all ? before.map(spot => spot.n) : keep ? before.map(spot => spot.n).filter(n => !keep.includes(n)) : listed;
    await request('sky:agent-spots', { remove });
    for (const n of remove) { spotMeta.delete(n); cases.remove(n); }
    return { ok: true, removed: remove, remaining: (await spots()).map(spot => spot.n) };
  }

  // ---- epochs and parallax --------------------------------------------------
  async function pickEpochs({ gap_days: gapDays = 180 }, { signal }) {
    if (!(await needFrames(signal))) return { ok: false, error: 'No observations are loaded for this target yet.' };
    const list = frames();
    if (list.length < 2) return { ok: false, error: 'Only one frame is available here.' };
    // Read the wavelength at the field centre on up to 16 frames, then pick the
    // pair whose gap is close to the one asked for and whose wavelengths match.
    const known = await wavelengthsOf(spread(list, 16), signal);
    const best = chooseEpochPair(list, { gapDays, wavelengthOf: frame => known.get(frame) ?? null });
    const compared = await base.compare_frames({ reference: 'frame', reference_date: isoDay(best.earlier.frameTime), target_date: isoDay(best.later.frameTime), view: 'difference' }, { signal });
    return {
      ...compared, reference: isoDay(best.earlier.frameTime), target: isoDay(best.later.frameTime), gapDays: Math.round(best.gapDays), requestedGapDays: gapDays,
      ...(best.wavelengthMatched
        ? { referenceWavelengthUm: round(known.get(best.earlier), 3), targetWavelengthUm: round(known.get(best.later), 3), wavelengthGapUm: round(best.deltaUm, 3) }
        : { note: 'The wavelengths of these frames could not be read, so the pair was chosen on the time gap alone; residuals around stars may be colour, not change.' })
    };
  }

  async function predictParallax({ spot: n, distance_au: distanceAu, date }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const difference = await request('sky:difference-requested');
    const fromTime = Date.parse(spotMeta.get(n)?.date || '') || currentFrameTime();
    const toTime = date ? Date.parse(date + 'T12:00:00Z') : Date.parse(difference?.referenceDate || '') || frames()[0]?.frameTime;
    if (!Number.isFinite(toTime)) return { ok: false, error: 'Give a date or open a difference view first.' };
    const shift = parallaxShift({ raDeg: spot.raDeg, decDeg: spot.decDeg, distanceAu, fromMjd: mjdOf(fromTime), toMjd: mjdOf(toTime) });
    const center = latest.target || spot, halfFieldArcsec = (latest.settings.fovArcmin || 16) * 30;
    const inside = separationArcsec(center, shift) <= halfFieldArcsec;
    const [added] = await addAgentSpots([{ raDeg: shift.raDeg, decDeg: shift.decDeg, origin: 'predicted', label: `spot ${n} at ${distanceAu} AU` }]);
    if (added) spotMeta.set(added.n, { date: new Date(toTime).toISOString(), role: 'predicted' });
    const ecl = equatorialToEcliptic(spot.raDeg, spot.decDeg);
    return {
      ok: true, spot: n, distanceAu, from: isoDay(fromTime), to: isoDay(toTime),
      predicted: { raDeg: round(shift.raDeg, 5), decDeg: round(shift.decDeg, 5), spot: added?.n ?? null },
      shiftArcmin: round(shift.offsetArcmin, 2), directionDeg: round(shift.positionAngleDeg, 0), eclipticLatitudeDeg: round(ecl.latDeg, 1),
      insideField: inside,
      ...(inside ? {} : { note: `The predicted position is outside the ${latest.settings.fovArcmin || 16}′ field; widen the field (set_view arcmin up to 30) to see it.` }),
      assumption: 'Parallax only: the body is assumed to stay put in space between the dates (a small error beyond about 100 AU).'
    };
  }

  async function precover({ from_spot: fromN, to_spot: toN }, { signal }) {
    const [from, to] = [await spotOrError(fromN), await spotOrError(toN)];
    if (!from || !to) return { ok: false, error: 'Both spots must exist.' };
    const difference = await request('sky:difference-requested');
    const fromTime = Date.parse(spotMeta.get(fromN)?.date || difference?.referenceDate || '');
    const toTime = Date.parse(spotMeta.get(toN)?.date || difference?.date || '');
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime === toTime) return { ok: false, error: 'I need the dates of the two spots: mark them from a difference view with find_changes.' };
    if (!(await needFrames(signal))) return { ok: false, error: 'No observations are loaded.' };
    const days = (toTime - fromTime) / DAY_MS;
    const rate = { ra: ((to.raDeg - from.raDeg + 540) % 360 - 180) / days, dec: (to.decDeg - from.decDeg) / days };
    const others = spread(frames().filter(frame => Math.abs(frame.frameTime - fromTime) > DAY_MS / 2 && Math.abs(frame.frameTime - toTime) > DAY_MS / 2), 6);
    const checks = [];
    await Promise.all(others.map(async frame => {
      const dt = (frame.frameTime - fromTime) / DAY_MS;
      const position = { raDeg: from.raDeg + rate.ra * dt, decDeg: from.decDeg + rate.dec * dt };
      try {
        const value = await measureAt(frame, position, signal, { wavelength: false });
        checks.push({ date: isoDay(frame.frameTime), snr: round(value.snr, 1), found: value.snr >= 4 });
      } catch (error) { if (signal?.aborted) throw error; checks.push({ date: isoDay(frame.frameTime), error: 'outside image or flagged' }); }
    }));
    checks.sort((a, b) => a.date.localeCompare(b.date));
    const result = { ok: true, fromSpot: fromN, toSpot: toN, rateArcsecPerDay: round(Math.hypot(rate.ra * Math.cos(from.decDeg * Math.PI / 180), rate.dec) * 3600, 2), checked: checks.length, recovered: checks.filter(check => check.found).length, checks };
    return { ...result, case: record(to, 'precover', result).verdict };
  }

  // ---- vision second opinion --------------------------------------------------
  async function secondOpinion({ spot: n }, { signal }) {
    if (!(await getCapabilities()).vision) return { ok: false, error: 'The vision second opinion is not enabled on this server.' };
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const stamps = await request('sky:stamps-requested', { raDeg: spot.raDeg, decDeg: spot.decDeg });
    if (!stamps?.difference) return { ok: false, error: 'Open a difference view that contains this spot first.' };
    const response = await fetch('/api/agent-vision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stamps }), signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: data.error || 'The vision model did not answer.' };
    const result = { ok: true, spot: n, label: data.label, reason: data.reason, interest: data.interest, agreed: data.agreed, model: data.model };
    return { ...result, case: record(spot, 'second_opinion', result).verdict };
  }

  // ---- Planet Nine region and patrol -----------------------------------------
  let planetNine = null;
  async function planetNineCells() {
    if (!planetNine) planetNine = await fetch('/data/planet-nine.json').then(response => { if (!response.ok) throw new Error('The Planet Nine map is unavailable.'); return response.json(); });
    return planetNine;
  }
  async function planetNineRegion({ top = 3, go = false }, { signal }) {
    const map = await planetNineCells();
    const cells = map.cells.slice(0, go ? top : top).map((cell, index) => ({ cell: index + 1, raDeg: cell.raDeg, decDeg: cell.decDeg, sharePercent: round(cell.share * 100, 2), medianDistanceAu: cell.medianDistanceAu, medianVMag: cell.medianVMag }));
    const result = { ok: true, source: map.source, url: map.url, note: map.note, stillUndetectedPercent: round(map.remaining / map.total * 100, 1), cellDeg: map.cellDeg, cells: go ? [cells.at(-1)] : cells };
    if (!go) return result;
    const cell = cells.at(-1);
    const moved = await base.go_to_target({ raDeg: cell.raDeg, decDeg: cell.decDeg, name: `Planet Nine cell ${cell.cell}` }, { signal });
    return { ...result, moved: moved.ok !== false, ...(moved.pending ? { pending: moved.pending } : {}), ...(moved.ok === false ? { error: moved.error } : {}) };
  }

  async function patrol({ cells: count = 3 }, { signal, progress = () => {} }) {
    const map = await planetNineCells();
    const results = [];
    for (let index = 0; index < count && !signal?.aborted; index++) {
      const cell = map.cells[index];
      progress(`Patrol cell ${index + 1}/${count}: moving to RA ${cell.raDeg}°, Dec ${cell.decDeg}°…`);
      const moved = await base.go_to_target({ raDeg: cell.raDeg, decDeg: cell.decDeg, name: `Planet Nine cell ${index + 1}` }, { signal });
      if (moved.ok === false) { results.push({ cell: index + 1, raDeg: cell.raDeg, decDeg: cell.decDeg, result: 'no data', reason: moved.error }); progress(`Cell ${index + 1}: no data (${moved.error})`); continue; }
      const epochs = await pickEpochs({ gap_days: 180 }, { signal });
      if (epochs.ok === false) { results.push({ cell: index + 1, raDeg: cell.raDeg, decDeg: cell.decDeg, result: 'too few frames', reason: epochs.error }); progress(`Cell ${index + 1}: too few frames to compare.`); continue; }
      const changes = await findChanges({ limit: 2, mark: true });
      const found = changes.ok ? changes.changes.filter(change => change.spot) : [];
      const verdicts = [];
      for (const change of found) {
        const matched = await crossmatch({ spot: change.spot }, { signal });
        verdicts.push({ spot: change.spot, peakSigma: change.peakSigma, verdict: matched.case?.label || 'open' });
      }
      const summary = { cell: index + 1, raDeg: cell.raDeg, decDeg: cell.decDeg, compared: [epochs.reference, epochs.target], gapDays: epochs.gapDays, changes: found.length, verdicts };
      results.push(summary);
      progress(`Cell ${index + 1}: ${found.length ? `${found.length} change(s) — ${verdicts.map(v => `spot ${v.spot} ${v.verdict}`).join(', ')}` : 'nothing changed'}.`);
      void saveRecord('patrol', summary);
    }
    return {
      ok: true, searched: results.length, cells: results,
      unexplained: results.flatMap(cell => (cell.verdicts || []).filter(v => v.verdict.startsWith('unexplained')).map(v => ({ cell: cell.cell, spot: v.spot }))),
      note: 'A patrol looks for compact changes only; a quiet cell is not proof that nothing is there, because SPHEREx single images reach only moderately faint objects.'
    };
  }

  async function saveRecord(kind, payload) {
    if (!(await getCapabilities()).store) return false;
    try {
      const response = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, payload }) });
      return response.ok;
    } catch { return false; }
  }

  // ---- quests -----------------------------------------------------------------
  async function startQuest({ id }, { signal }) {
    const definition = QUESTS[id];
    const setup = definition.setup;
    quest = { id, misses: 0, expected: null };
    if (setup.preset) {
      const moved = await base.go_to_target({ preset: setup.preset, ...(setup.offCentre ? { viewOffset: randomViewOffset(setup.offCentre) } : {}) }, { signal });
      if (moved.ok === false) return moved;
    } else if (Number.isFinite(setup.raDeg)) {
      const moved = await base.go_to_target({ raDeg: setup.raDeg, decDeg: setup.decDeg, name: setup.name }, { signal });
      if (moved.ok === false) return moved;
    } else if (Number.isInteger(setup.planetNineCell)) {
      const moved = await planetNineRegion({ top: setup.planetNineCell + 1, go: true }, { signal });
      if (moved.moved === false) return { ok: false, error: moved.error || 'Could not move to the Planet Nine cell.' };
    }
    if (!(await needFrames(signal))) return { ok: false, error: 'No observations are loaded here yet; try again in a moment.' };
    const list = frames();
    if (list.length < 2) return { ok: false, error: 'This field has only one frame, so the game cannot be played here.' };
    if (setup.followProperMotion === false) await base.set_view_mode({ changes: { viewMode: setup.mode, followProperMotion: false } }, { signal });
    let first = list[0], last = list.at(-1);
    if (setup.compare === 'days-apart') {
      let best = null;
      for (let i = 1; i < list.length; i++) {
        const gap = (list[i].frameTime - list[i - 1].frameTime) / DAY_MS;
        if (gap >= 0.5 && gap <= 7 && (!best || list[i].frameTime > best[1].frameTime)) best = [list[i - 1], list[i]];
      }
      if (best) [first, last] = best;
    }
    if (setup.compare === 'six-months') {
      const epochs = await pickEpochs({ gap_days: 180 }, { signal });
      const changes = epochs.ok === false ? null : await findChanges({ limit: 3, mark: true });
      return { ok: true, quest: id, title: definition.title, goal: definition.goal, story: definition.story, lesson: definition.lesson, epochs: epochs.ok === false ? null : { reference: epochs.reference, target: epochs.target, gapDays: epochs.gapDays }, changes: changes?.changes || [], next: 'Investigate each spot with crossmatch, then get_case. Reporting "nothing unexplained here" is a real result.' };
    }
    if (setup.inject) {
      const pointing = latest.target || { raDeg: 0, decDeg: 0 };
      const fieldDeg = (latest.settings.fovArcmin || 16) / 60;
      const angle = Math.random() * 2 * Math.PI, offset = Math.random() * fieldDeg * 0.25;
      const start = { raDeg: pointing.raDeg + offset * Math.cos(angle) / Math.cos(pointing.decDeg * Math.PI / 180), decDeg: pointing.decDeg + offset * Math.sin(angle) };
      const days = Math.max(1, (last.frameTime - first.frameTime) / DAY_MS), shiftDeg = (4 + Math.random() * 4) * 6.15 / 3600, direction = Math.random() * 2 * Math.PI;
      const peakSigma = Number((4 + Math.random() * 6).toFixed(1));
      // Brightness relative to the noise of one frame on screen (blink shows single frames).
      if (latest.settings.viewMode === 'difference' || latest.settings.viewMode === 'deep-stack') await base.set_view_mode({ changes: { viewMode: 'time-lapse' } }, { signal });
      const noise = await request('sky:noise-requested');
      if (!(noise > 0)) return { ok: false, error: 'I could not measure the image noise to hide the planet; try again once a frame is on screen.' };
      const source = { raDeg: start.raDeg, decDeg: start.decDeg, epochMjd: mjdOf(first.frameTime), raPerDay: shiftDeg * Math.cos(direction) / days / Math.cos(start.decDeg * Math.PI / 180), decPerDay: shiftDeg * Math.sin(direction) / days, peakSigma, peak: peakSigma * noise };
      await request('sky:inject-synthetic', { source });
      const end = { raDeg: source.raDeg + source.raPerDay * days, decDeg: source.decDeg + source.decPerDay * days };
      quest.expected = { track: [start, end], peakSigma };
    }
    await base.compare_frames({ reference: 'frame', reference_date: isoDay(first.frameTime), target_date: isoDay(last.frameTime), view: 'blink' }, { signal });
    if (id === 'be-barnard') quest.expected = { track: barnardTrack(mjdOf(first.frameTime), mjdOf(last.frameTime)) };
    emit('sky:spot-tool', { tool: 'mark' });
    emit('sky:agent-notice', { text: `${definition.title}: with Mark on, click the spot you think is the answer, then press Ask.` });
    return { ok: true, quest: id, title: definition.title, goal: definition.goal, frames: [isoDay(first.frameTime), isoDay(last.frameTime)], howToAnswer: 'The visitor picks the Mark tool beside the image and clicks to mark a spot, then asks you to check it with check_answer. Keep the story for after they find it.' };
  }

  async function checkAnswer({ spot: n }, { signal }) {
    if (!quest) return { ok: false, error: 'No quest is running. Start one with start_quest.' };
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}. Ask the visitor to pick the Mark tool beside the image and click to mark one.` };
    const definition = QUESTS[quest.id];
    if (quest.id === 'be-tombaugh') {
      const matched = await crossmatch({ spot: n }, { signal });
      const hit = matched.jpl?.nearest && matched.jpl.nearest.separationArcsec <= 30;
      return { ok: true, correct: hit, ...(hit ? { found: matched.jpl.nearest, story: definition.story, lesson: definition.lesson } : { hint: 'JPL lists no moving body there. Look for a dot that shifts a little between the two frames.' }) };
    }
    const result = checkQuestAnswer(quest.id, spot, quest.expected);
    if (quest.id === 'hidden-planet') {
      if (result.correct) { questStats.push({ peakSigma: quest.expected.peakSigma, found: true }); void submitRecovery({ game: 'quest', peakSigma: quest.expected.peakSigma, found: true, misses: quest.misses }); await request('sky:inject-synthetic', { source: null }); quest = null; }
      else if (++quest.misses >= 3) {
        const [shown] = await addAgentSpots([{ ...quest.expected.track[1], origin: 'predicted', label: 'hidden planet' }]);
        questStats.push({ peakSigma: quest.expected.peakSigma, found: false });
        void submitRecovery({ game: 'quest', peakSigma: quest.expected.peakSigma, found: false, misses: quest.misses });
        const reveal = { revealedSpot: shown?.n ?? null, peakSigma: quest.expected.peakSigma };
        await request('sky:inject-synthetic', { source: null });
        quest = null;
        return { ...result, ...reveal, sessionResults: questStats, story: definition.story };
      }
      return { ...result, ...(result.correct ? { peakSigma: questStats.at(-1).peakSigma, sessionResults: questStats } : { triesLeft: 3 - quest.misses }) };
    }
    if (result.correct) quest = null;
    return result;
  }

  // ---- tour and report ----------------------------------------------------------
  async function startTour({ id = 'highlights' }, { signal, progress = () => {} }) {
    const tour = TOURS[id];
    let played = 0;
    for (const step of tour.steps) {
      if (signal?.aborted) break;
      progress(step.caption);
      const handler = handlers[step.tool] || base[step.tool];
      const result = await handler(step.args, { signal, progress });
      played++;
      if (result?.ok === false) { progress(`(Skipped: ${result.error})`); continue; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return { ok: true, tour: id, played, of: tour.steps.length, outro: tour.outro, scripted: true };
  }

  async function prepareReport({ spot: n }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const summary = summarize(caseFor(spot));
    const passed = summary.suspects.filter(s => s.status === 'ruled_out').map(s => s.label);
    const open = summary.suspects.filter(s => s.status === 'open').map(s => s.label);
    const url = shareUrl({ embed: false, note: `Spot ${n}: ${summary.verdict.label}` });
    const report = { spot: n, raDeg: summary.raDeg, decDeg: summary.decDeg, target: snapshot().target?.name || '', verdict: summary.verdict.label, ...(summary.findings ? { areaRadiusArcsec: summary.radiusArcsec, findings: summary.findings } : {}), ruledOut: passed, stillOpen: open, notes: summary.notes, url, canSend: Boolean((await getCapabilities()).store) };
    emit('sky:report-ready', { report });
    return { ok: true, ...report };
  }

  const handlers = {
    find_changes: findChanges,
    mark_spot: markSpot,
    mark_target: markTarget,
    confirm_motion: confirmMotion,
    resize_spot: resizeSpot,
    remove_spots: removeSpots,
    measure_source: measureSource,
    get_spectrum: getSpectrum,
    crossmatch,
    get_case: getCase,
    pick_epochs: pickEpochs,
    predict_parallax_pair: predictParallax,
    precover,
    second_opinion: secondOpinion,
    start_quest: startQuest,
    check_answer: checkAnswer,
    planet_nine_region: planetNineRegion,
    patrol,
    start_tour: startTour,
    prepare_report: prepareReport
  };

  async function spotsSummary() {
    return (await spots()).map(spot => {
      const file = cases.get(spot.n);
      return { n: spot.n, origin: spot.origin, raDeg: round(spot.raDeg, 5), decDeg: round(spot.decDeg, 5), ...(spot.radiusArcsec ? { radiusArcsec: spot.radiusArcsec } : {}), ...(spot.label ? { label: spot.label } : {}), ...(file ? { verdict: summarize(file).verdict.label } : {}) };
    });
  }

  return { handlers, spotsSummary, getCapabilities, quest: () => quest, cases, saveRecord, NORTH_ECLIPTIC_POLE };
}
