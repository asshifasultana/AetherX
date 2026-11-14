// The AI guide's investigation tools: find changes, measure and crossmatch
// spots, keep each spot's case file, run quests, patrols and tours. Executed in
// the browser on the real viewer; every result is plain measured data. Case
// files are updated by lib/case-file.js rules, never by the model.

import { canvasToSky } from './sky-projection.js';
import { findBlobs, pairBlobs } from './lib/blobs.js';
import { createCaseBook, applyEvidence, summarize } from './lib/case-file.js';
import { parallaxShift, separationArcsec, equatorialToEcliptic } from './lib/ecliptic.js';
import { measureAt } from './lib/photometry.js';
import { spectralHints } from './lib/spectral-hints.js';
import { QUESTS, NORTH_ECLIPTIC_POLE, barnardTrack, checkQuestAnswer } from './lib/quests.js';
import { TOURS } from './lib/tours.js';
import { shareUrl } from './share.js';
import { pollUntil } from './lib/background-jobs.js';

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
    if (mark && described.length) {
      // A fresh search replaces the guide's earlier automatic spots.
      await request('sky:agent-spots', { clear: 'agent' });
      for (const n of [...spotMeta.keys()]) if (!(await spots()).some(spot => spot.n === n)) { spotMeta.delete(n); cases.remove(n); }
      marked = await addAgentSpots(described.map(blob => ({ raDeg: blob.raDeg, decDeg: blob.decDeg, origin: 'agent', label: `${blob.sign} ${blob.peakSigma}σ` })));
      marked.forEach((spot, index) => {
        const blob = described[index];
        spotMeta.set(spot.n, { date: blob.sign === 'fainter' ? state.referenceDate : state.date, role: blob.sign === 'fainter' ? 'before' : 'now' });
        record(spot, 'find_changes', { blob, pairedAdjacent: Boolean(blob.pair?.adjacent) });
      });
    }
    const spotFor = blob => marked[described.indexOf(blob)]?.n ?? null;
    return {
      ok: true,
      sigma: round(state.sigma, 4), thresholdSigma: state.threshold,
      comparing: { now: state.date.slice(0, 10), reference: state.referenceDate ? state.referenceDate.slice(0, 10) : state.referenceLabel },
      totalPatches: blobs.length,
      changes: described.map(blob => ({
        spot: spotFor(blob), sign: blob.sign, peakSigma: blob.peakSigma, pixels: blob.pixels,
        raDeg: round(blob.raDeg, 5), decDeg: round(blob.decDeg, 5),
        ...(blob.singlePixel ? { note: 'single pixel: often a glitch' } : {}),
        ...(blob.edge ? { edge: true } : {})
      })),
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
        const value = await measureAt(frame, spot, signal, { wavelength: false });
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
    const result = { ok: true, spot: n, measured: measurements.length, skipped: failed, detectedOnDates: new Set(detected.map(entry => entry.date)).size, measurements, variabilitySigma };
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
        try { samples.push(await measureAt(observation, spot, signal)); }
        catch (error) { if (signal?.aborted) throw error; failed++; }
      }
    }));
    const hints = spectralHints(samples);
    return {
      ok: true, spot: n, measured: samples.length, skipped: failed,
      wavelengthRangeUm: samples.length ? [round(Math.min(...samples.map(s => s.wavelengthUm)), 2), round(Math.max(...samples.map(s => s.wavelengthUm)), 2)] : null,
      ...hints
    };
  }

  // ---- crossmatch ---------------------------------------------------------
  const gaiaLookup = (spot, years, signal) =>
    fetch(`/api/gaia-sources?${new URLSearchParams({ ra: spot.raDeg.toFixed(6), dec: spot.decDeg.toFixed(6), radius: (90 / 3600).toFixed(5) })}`, { signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Gaia lookup failed.')))
      .then(data => {
        const within = (data.sources || []).map(star => {
          const cos = Math.cos(star.decDeg * Math.PI / 180);
          const raDeg = star.raDeg + (Number(star.pmra) || 0) * years / 3.6e6 / cos, decDeg = star.decDeg + (Number(star.pmdec) || 0) * years / 3.6e6;
          return { sourceId: String(star.sourceId), gMag: round(star.gMag, 1), pmra: round(star.pmra, 1), pmdec: round(star.pmdec, 1), separationArcsec: round(separationArcsec(spot, { raDeg, decDeg }), 1) };
        }).filter(star => star.separationArcsec <= 90).sort((a, b) => a.separationArcsec - b.separationArcsec);
        return { nearest: within[0] || null, within: within.slice(0, 8), searchedArcsec: 90 };
      })
      .catch(error => { if (signal?.aborted) throw error; return { error: error.message }; });

  const jplLookup = (spot, time, signal) =>
    fetch(`/api/known-objects?${new URLSearchParams({ ra: spot.raDeg.toFixed(6), dec: spot.decDeg.toFixed(6), time: new Date(time).toISOString(), radius: '60' })}`, { signal })
      .then(response => response.json())
      .then(data => data.checked ? { checked: true, date: data.date, count: data.count, nearest: data.objects?.[0] ? { name: data.objects[0].name, separationArcsec: round(data.objects[0].separationArcsec, 1), vMag: data.objects[0].vMag, rateArcsecPerHour: data.objects[0].rateArcsecPerHour } : null } : { checked: false, ...(data.pending ? { pending: true } : {}), error: data.error })
      .catch(error => { if (signal?.aborted) throw error; return { checked: false, error: 'JPL did not answer.' }; });

  // A lookup that is still computing (JPL) or failed (Gaia) keeps going in the
  // background; when it finishes, the case file updates and the guide is told.
  function backgroundLookup(kind, spot, n, time, years) {
    if (!jobs) return null;
    const label = kind === 'jpl' ? `Known-asteroid check (JPL) for spot ${n}` : `Star catalogue check (Gaia) for spot ${n}`;
    const job = jobs.start(`${kind}:${n}:${spot.raDeg.toFixed(5)}:${spot.decDeg.toFixed(5)}:${isoDay(time)}`, label, async signal => {
      const value = await pollUntil(async pollSignal => {
        const result = kind === 'jpl' ? await jplLookup(spot, time, pollSignal) : await gaiaLookup(spot, years, pollSignal);
        return (kind === 'jpl' ? result.checked : !result.error) ? result : undefined;
      }, { intervalMs: kind === 'jpl' ? 4000 : 8000, timeoutMs: kind === 'jpl' ? 180_000 : 60_000, signal });
      const result = { ok: true, spot: n, date: isoDay(time), [kind]: value };
      return { ...result, case: record(spot, 'crossmatch', result).verdict };
    }, { spot: n });
    return job.id;
  }

  async function crossmatch({ spot: n, date }, { signal }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const meta = spotMeta.get(n);
    const time = date ? Date.parse(date + 'T12:00:00Z') : Date.parse(meta?.date || '') || currentFrameTime();
    const years = (time - Date.UTC(2016, 0, 1)) / (365.25 * DAY_MS);
    const [gaia, jpl] = await Promise.all([gaiaLookup(spot, years, signal), jplLookup(spot, time, signal)]);
    const later = 'It keeps running in the background and its result will arrive on its own; carry on with other checks.';
    if (gaia.error) { const id = backgroundLookup('gaia', spot, n, time, years); if (id) Object.assign(gaia, { background: id, note: later }); }
    if (!jpl.checked) { const id = backgroundLookup('jpl', spot, n, time, years); if (id) Object.assign(jpl, { background: id, note: later }); }
    const result = { ok: true, spot: n, date: isoDay(time), gaia, jpl };
    return { ...result, case: record(spot, 'crossmatch', result).verdict };
  }

  async function getCase({ spot: n }) {
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}.` };
    const summary = summarize(caseFor(spot));
    emit('sky:case-updated', { case: summary, show: true });
    return { ok: true, ...summary };
  }

  async function markSpot({ raDeg, decDeg, label }) {
    const [added] = await addAgentSpots([{ raDeg, decDeg, origin: 'agent', label }]);
    return added ? { ok: true, spot: added.n } : { ok: false, error: 'All 9 spots are in use; remove one first.' };
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
    let best = null;
    for (const later of list) for (const earlier of list) {
      if (earlier.frameTime >= later.frameTime) continue;
      const gap = (later.frameTime - earlier.frameTime) / DAY_MS, score = Math.abs(gap - gapDays) - later.frameTime / 1e13;
      if (!best || score < best.score) best = { score, earlier, later, gap };
    }
    const compared = await base.compare_frames({ reference: 'frame', reference_date: isoDay(best.earlier.frameTime), target_date: isoDay(best.later.frameTime), view: 'difference' }, { signal });
    return { ...compared, reference: isoDay(best.earlier.frameTime), target: isoDay(best.later.frameTime), gapDays: Math.round(best.gap), requestedGapDays: gapDays };
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
      const moved = await base.go_to_target({ preset: setup.preset }, { signal });
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
    emit('sky:agent-notice', { text: `${definition.title}: click the spot you think is the answer, then press Ask.` });
    return { ok: true, quest: id, title: definition.title, goal: definition.goal, frames: [isoDay(first.frameTime), isoDay(last.frameTime)], howToAnswer: 'The visitor clicks the image to mark a spot, then asks you to check it with check_answer. Keep the story for after they find it.' };
  }

  async function checkAnswer({ spot: n }, { signal }) {
    if (!quest) return { ok: false, error: 'No quest is running. Start one with start_quest.' };
    const spot = await spotOrError(n);
    if (!spot) return { ok: false, error: `There is no spot ${n}. Ask the visitor to click the image to mark one.` };
    const definition = QUESTS[quest.id];
    if (quest.id === 'be-tombaugh') {
      const matched = await crossmatch({ spot: n }, { signal });
      const hit = matched.jpl?.nearest && matched.jpl.nearest.separationArcsec <= 30;
      return { ok: true, correct: hit, ...(hit ? { found: matched.jpl.nearest, story: definition.story, lesson: definition.lesson } : { hint: 'JPL lists no moving body there. Look for a dot that shifts a little between the two frames.' }) };
    }
    const result = checkQuestAnswer(quest.id, spot, quest.expected);
    if (quest.id === 'hidden-planet') {
      if (result.correct) { questStats.push({ peakSigma: quest.expected.peakSigma, found: true }); await request('sky:inject-synthetic', { source: null }); quest = null; }
      else if (++quest.misses >= 3) {
        const [shown] = await addAgentSpots([{ ...quest.expected.track[1], origin: 'predicted', label: 'hidden planet' }]);
        questStats.push({ peakSigma: quest.expected.peakSigma, found: false });
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
    const report = { spot: n, raDeg: summary.raDeg, decDeg: summary.decDeg, target: snapshot().target?.name || '', verdict: summary.verdict.label, ruledOut: passed, stillOpen: open, notes: summary.notes, url, canSend: Boolean((await getCapabilities()).store) };
    emit('sky:report-ready', { report });
    return { ok: true, ...report };
  }

  const handlers = {
    find_changes: findChanges,
    mark_spot: markSpot,
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
      return { n: spot.n, origin: spot.origin, raDeg: round(spot.raDeg, 5), decDeg: round(spot.decDeg, 5), ...(spot.label ? { label: spot.label } : {}), ...(file ? { verdict: summarize(file).verdict.label } : {}) };
    });
  }

  return { handlers, spotsSummary, getCapabilities, quest: () => quest, cases, saveRecord, NORTH_ECLIPTIC_POLE };
}
