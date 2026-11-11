// Backyard-Worlds-style vetting: snapping marks onto sources, locating a
// moving target on the frame date, multi-date motion fits, masked-pixel
// residuals, wavelength-matched pairs, multi-catalogue crossmatch rules and the
// case file's suggested next step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapToPeak } from '../lib/peak.js';
import { locateTarget } from '../lib/target-locate.js';
import { fitLinearMotion } from '../lib/motion-fit.js';
import { chooseEpochPair, epochPairScore } from '../lib/epochs.js';
import { findBlobs } from '../lib/blobs.js';
import { createCase, applyEvidence, verdict, summarize } from '../lib/case-file.js';
import { fastStarPasses, yearOf } from '../lib/proper-motion.js';
import { propagateGaia } from '../gaia-core.js';
import { separationArcsec } from '../lib/ecliptic.js';
import { presets } from '../presets.js';
import { validateToolCall } from '../lib/agent-tools.js';
import { readFile } from 'node:fs/promises';

// Deterministic noise (mulberry32 + Box-Muller).
function noise(seed) {
  let a = seed >>> 0;
  const uniform = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}
function field(width, { x0, y0, amplitude = 100, sigma = 1.2, nanCore = 0, seed = 1 }) {
  const gauss = noise(seed), values = new Float32Array(width * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const r = Math.hypot(x - x0, y - y0);
    values[y * width + x] = 10 + gauss() + (amplitude ? amplitude * Math.exp(-(r * r) / (2 * sigma * sigma)) : 0);
    if (r < nanCore) values[y * width + x] = NaN;
  }
  return values;
}

test('snapToPeak finds a Gaussian centre, re-centres on a ring with a NaN core, and finds nothing on flat noise', () => {
  const width = 40;
  const star = snapToPeak(field(width, { x0: 20.3, y0: 15.7 }), width, 19, 17, 2);
  assert.ok(!star.noSource);
  assert.ok(Math.hypot(star.x - 20.3, star.y - 15.7) < 0.25, `${star.x}, ${star.y}`);
  assert.ok(star.peakSigma > 20);

  // A saturated star: the pipeline masks its core, leaving a bright ring.
  const ring = snapToPeak(field(width, { x0: 20, y0: 20, amplitude: 3000, sigma: 1.6, nanCore: 1.6, seed: 2 }), width, 21.5, 19, 3);
  assert.ok(!ring.noSource);
  assert.ok(Math.hypot(ring.x - 20, ring.y - 20) < 0.4, `${ring.x}, ${ring.y}`);

  assert.equal(snapToPeak(field(width, { x0: 20, y0: 20, amplitude: 0, seed: 3 }), width, 20, 20, 2).noSource, true);
});

// Barnard's Star: SIMBAD J2000 position and Gaia EDR3 proper motion (as in presets.js), moved to Gaia's 2016 epoch.
const barnardJ2000 = { raDeg: (17 + 57 / 60 + 48.4984700685 / 3600) * 15, decDeg: 4 + 41 / 60 + 36.113879676 / 3600 };
const barnard2016 = (() => {
  const at2016 = propagateGaia({ ...barnardJ2000, refEpoch: 2000, pmra: -801.551, pmdec: 10362.394 }, 2016);
  return { sourceId: '4472832130942575872', gMag: 8.2, raDeg: at2016.raDeg, decDeg: at2016.decDeg, refEpoch: 2016, pmra: -801.551, pmdec: 10362.394 };
})();
const august2025 = Date.parse('2025-08-21T12:00:00Z');

test('locateTarget puts Barnard’s Star about 4.4′ north of its J2000 position, from the preset or from Gaia', () => {
  const preset = locateTarget({ target: { ...presets.barnard, targetId: 'barnard' }, frameTime: august2025 });
  assert.equal(preset.method, 'preset');
  assert.ok(Math.abs(preset.movedArcmin - 4.4) <= 0.1, `${preset.movedArcmin}′`);
  assert.equal(preset.sinceYear, 2000);
  assert.ok(preset.decDeg - presets.barnard.decDeg > 4.3 / 60);

  // A name lookup that returned the J2000 position, with no preset motion.
  const slow = { sourceId: '1', raDeg: barnardJ2000.raDeg + 0.0005, decDeg: barnardJ2000.decDeg, refEpoch: 2016, pmra: 2, pmdec: 1 };
  const fromGaia = locateTarget({ target: barnardJ2000, frameTime: august2025, gaiaSources: [slow, barnard2016] });
  assert.equal(fromGaia.method, 'fast-star');
  assert.equal(fromGaia.sourceId, barnard2016.sourceId);
  assert.ok(Math.abs(fromGaia.movedArcmin - 4.4) <= 0.1, `${fromGaia.movedArcmin}′`);
  assert.ok(separationArcsec(fromGaia, preset) < 2, 'both methods agree');

  // A slow star within 6″ is moved to the frame date; otherwise the position stays.
  const near = locateTarget({ target: { raDeg: slow.raDeg + 1 / 3600, decDeg: slow.decDeg }, frameTime: august2025, gaiaSources: [slow] });
  assert.equal(near.method, 'catalogue-star');
  assert.equal(locateTarget({ target: { raDeg: 10, decDeg: 5 }, frameTime: august2025, gaiaSources: [slow] }).method, 'catalogue');
});

test('fitLinearMotion recovers 10.4″/yr from synthetic detections and flags an outlier date', () => {
  const gauss = noise(7), start = Date.parse('2025-03-01T00:00:00Z');
  const detections = Array.from({ length: 10 }, (_, i) => {
    const time = start + i * 40 * 86_400_000, years = (time - start) / (365.25 * 86_400_000);
    const north = 10.4 * years + gauss() * 0.6, east = -0.8 * years + gauss() * 0.6;
    return { time, date: new Date(time).toISOString().slice(0, 10), snr: 20, raDeg: 269.45 + east / 3600 / Math.cos(4.7 * Math.PI / 180), decDeg: 4.7 + north / 3600 };
  });
  detections[6] = { ...detections[6], decDeg: detections[6].decDeg + 30 / 3600 };
  const fit = fitLinearMotion(detections);
  assert.ok(Math.abs(fit.motionArcsecPerYear - 10.43) < 0.8, `${fit.motionArcsecPerYear}″/yr`);
  assert.ok(fit.directionDeg > 350 || fit.directionDeg < 5, `${fit.directionDeg}°`);
  assert.ok(fit.significance > 5);
  assert.equal(fit.consistent, true);
  assert.equal(fit.agreeing, 9);
  assert.deepEqual(fit.dates.filter(entry => !entry.agrees).map(entry => entry.date), [detections[6].date]);

  // Positions that jump around are not one line.
  const jumpy = Array.from({ length: 6 }, (_, i) => ({ time: start + i * 30 * 86_400_000, raDeg: 10 + (i % 2 ? 20 : -20) / 3600, decDeg: 5 + (i % 3) * 15 / 3600, snr: 10 }));
  assert.equal(fitLinearMotion(jumpy).consistent, false);
  assert.equal(fitLinearMotion(detections.slice(0, 1)), null);
});

test('findBlobs marks a change next to masked pixels and ranks it last', () => {
  const width = 30, values = new Float32Array(width * width), significant = new Uint8Array(width * width);
  const put = (x, y, value) => { values[y * width + x] = value; significant[y * width + x] = 1; };
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { put(8 + dx, 8 + dy, 12); put(20 + dx, 20 + dy, 12); }
  values[19 * width + 20] = NaN; // a saturated core right next to the second patch
  const blobs = findBlobs({ values, significant, width, sigma: 1 });
  assert.equal(blobs.length, 2);
  assert.equal(blobs[0].touchesMask, false);
  assert.equal(blobs[1].touchesMask, true);
  const file = createCase({ n: 1, raDeg: 10, decDeg: 5 });
  applyEvidence(file, 'find_changes', { blob: blobs[1], pairedAdjacent: false });
  assert.equal(file.suspects.colour_shift.status, 'supported');
  assert.match(file.suspects.colour_shift.evidence[0], /masked pixels/);
});

test('epoch pairs prefer matched wavelengths over the exact time gap', () => {
  const day = 86_400_000;
  const a = { frameTime: 0, name: 'a' }, b = { frameTime: 180 * day, name: 'b' }, c = { frameTime: 150 * day, name: 'c' };
  const wave = new Map([[a, 1.000], [b, 1.060], [c, 1.002]]);
  const matched = chooseEpochPair([a, b, c], { gapDays: 180, wavelengthOf: frame => wave.get(frame) });
  assert.deepEqual([matched.earlier.name, matched.later.name], ['a', 'c']);
  assert.equal(matched.wavelengthMatched, true);
  assert.ok(Math.abs(matched.deltaUm - 0.002) < 1e-9);
  const timeOnly = chooseEpochPair([a, b, c], { gapDays: 180 });
  assert.deepEqual([timeOnly.earlier.name, timeOnly.later.name], ['a', 'b']);
  assert.equal(timeOnly.wavelengthMatched, false);
  assert.ok(epochPairScore({ gapDays: 180, wantedDays: 180, deltaUm: 0.04 }) > epochPairScore({ gapDays: 120, wantedDays: 180, deltaUm: 0 }));
});

const empty = { nearest: null, within: [] };
const jplNone = { checked: true, date: '2025-08-21', nearest: null };
const allClear = { date: '2025-08-21', gaia: empty, catwise: { nearest: null, count: 0 }, simbad: { nearest: null, count: 0 }, movedThrough: [], jpl: jplNone };
const steady = { measurements: ['2025-03-01', '2025-06-01', '2025-09-01'].map(date => ({ date, snr: 8, fluxMicroJy: 50, errorMicroJy: 5 })), variabilitySigma: 0.5 };

test('known_star comes from SIMBAD or CatWISE alone, and is ruled out only when every answering catalogue agrees', () => {
  const brownDwarf = createCase({ n: 1, raDeg: 133.78, decDeg: -7.24 });
  applyEvidence(brownDwarf, 'crossmatch', { ...allClear, gaia: empty, simbad: { nearest: { sourceId: 'WISEA J085510.74-071442.5', name: 'WISEA J085510.74-071442.5', otype: 'BD*', separationArcsec: 1.4, pmra: -8123.7, pmdec: 673.2 }, count: 1 } });
  assert.equal(brownDwarf.suspects.known_star.status, 'supported');
  assert.match(brownDwarf.suspects.known_star.evidence.at(-1), /SIMBAD WISEA J085510\.74-071442\.5 \(type BD\*\)/);
  assert.equal(brownDwarf.suspects.proper_motion_star.status, 'supported');
  assert.equal(verdict(brownDwarf).label, 'known object');
  assert.ok(summarize(brownDwarf).notes.some(text => /not that its nature is understood/.test(text)));

  const infrared = createCase({ n: 2, raDeg: 133.78, decDeg: -7.24 });
  applyEvidence(infrared, 'crossmatch', { ...allClear, catwise: { nearest: { sourceId: 'J085508.34-071439.2', w2: 13.8, separationArcsec: 2.1, pmra: 0, pmdec: 0 }, count: 1 } });
  assert.equal(infrared.suspects.known_star.status, 'supported');
  assert.match(infrared.suspects.known_star.evidence.at(-1), /CatWISE2020 source J085508\.34-071439\.2/);

  const partial = createCase({ n: 3, raDeg: 10, decDeg: 5 });
  applyEvidence(partial, 'crossmatch', { ...allClear, gaia: { error: 'Gaia lookup failed.' } });
  assert.equal(partial.suspects.known_star.status, 'ruled_out');
  assert.match(partial.suspects.known_star.evidence.at(-1), /CatWISE2020 or SIMBAD \(Gaia did not answer\)/);
  // A later answer from one catalogue never overturns another's match.
  applyEvidence(infrared, 'crossmatch', { date: '2025-08-21', gaia: empty, movedThrough: [] });
  assert.equal(infrared.suspects.known_star.status, 'supported');
});

test('an uncatalogued mover needs three or more dates on one line; jumping positions point to a residual', () => {
  const make = n => { const file = createCase({ n, raDeg: 10, decDeg: 5 }); applyEvidence(file, 'measure_source', steady); applyEvidence(file, 'crossmatch', allClear); return file; };
  const mover = make(1);
  assert.equal(verdict(mover).label, 'unexplained — needs follow-up');
  applyEvidence(mover, 'confirm_motion', { detectedOnDates: 2, of: 8, motionArcsecPerYear: 3, directionDeg: 90, significance: 8, consistent: false });
  assert.notEqual(verdict(mover).label, 'uncatalogued mover — needs follow-up', 'two dates are not enough');
  applyEvidence(mover, 'confirm_motion', { detectedOnDates: 6, of: 8, motionArcsecPerYear: 2.1, directionDeg: 90, significance: 6.5, consistent: true });
  const result = verdict(mover);
  assert.equal(result.label, 'uncatalogued mover — needs follow-up');
  assert.match(result.detail, /towards the east .*only a spectrum can identify it\.$/);
  assert.equal(mover.suspects.glitch.status, 'ruled_out');
  assert.deepEqual(result.suggest.map(entry => entry.tool), ['get_spectrum']);

  const slow = make(2);
  applyEvidence(slow, 'confirm_motion', { detectedOnDates: 6, of: 8, motionArcsecPerYear: 0.3, directionDeg: 0, significance: 1.1, consistent: true });
  assert.equal(slow.suspects.glitch.status, 'ruled_out', 'three or more dates on one line rule out a glitch');
  assert.notEqual(verdict(slow).label, 'uncatalogued mover — needs follow-up', 'no significant motion');

  const ghost = createCase({ n: 3, raDeg: 10, decDeg: 5 });
  applyEvidence(ghost, 'confirm_motion', { detectedOnDates: 5, of: 8, motionArcsecPerYear: 40, directionDeg: 10, significance: 1, consistent: false });
  assert.equal(ghost.suspects.colour_shift.status, 'supported');
  assert.match(ghost.suspects.colour_shift.evidence.at(-1), /positions jump between dates/i);
});

test('every verdict suggests the next check (or none once settled)', () => {
  const tools = file => verdict(file).suggest.map(entry => entry.tool);
  const open = createCase({ n: 1, raDeg: 10, decDeg: 5 });
  assert.equal(verdict(open).suggest[0].tool, 'crossmatch');
  assert.deepEqual(verdict(open).suggest[0].args, { spot: 1 });
  assert.match(verdict(open).suggest[0].why, /catalogues/);

  const pair = createCase({ n: 2, raDeg: 10, decDeg: 5 });
  applyEvidence(pair, 'find_changes', { blob: { peakSigma: 9 }, pairedAdjacent: false, pairedWith: 3 });
  assert.deepEqual(verdict(pair).suggest.find(entry => entry.tool === 'confirm_motion').args, { spot: 2, to_spot: 3 });

  const unexplained = createCase({ n: 4, raDeg: 10, decDeg: 5 });
  applyEvidence(unexplained, 'measure_source', steady);
  applyEvidence(unexplained, 'crossmatch', allClear);
  assert.deepEqual(tools(unexplained), ['confirm_motion', 'get_spectrum']);
  assert.match(verdict(unexplained).suggest[1].why, /methane dip near 3\.3 µm/);

  const year = yearOf(august2025);
  const movedAway = createCase({ n: 5, raDeg: barnardJ2000.raDeg, decDeg: barnardJ2000.decDeg });
  applyEvidence(movedAway, 'crossmatch', { ...allClear, movedThrough: fastStarPasses(barnardJ2000, [barnard2016], { toYear: year, nowYear: year }) });
  assert.equal(verdict(movedAway).label, 'moved away');
  const [mark] = verdict(movedAway).suggest;
  assert.equal(mark.tool, 'mark_spot');
  assert.equal(mark.args.decDeg, verdict(movedAway).star.decDeg);
  assert.equal(mark.why, 'Mark the star where it is now');

  const artefact = createCase({ n: 6, raDeg: 10, decDeg: 5 });
  applyEvidence(artefact, 'find_changes', { blob: { peakSigma: 9 }, pairedAdjacent: true });
  assert.deepEqual(tools(artefact), ['second_opinion']);

  const known = createCase({ n: 7, raDeg: 10, decDeg: 5 });
  applyEvidence(known, 'crossmatch', { ...allClear, gaia: { nearest: { sourceId: '9', gMag: 12, separationArcsec: 0.5, pmra: 1, pmdec: 1 }, within: [] } });
  assert.equal(verdict(known).label, 'known object');
  assert.deepEqual(tools(known), []);

  const nothing = createCase({ n: 8, raDeg: 10, decDeg: 5 });
  applyEvidence(nothing, 'measure_source', { measurements: ['2025-01-01', '2025-02-01', '2025-03-01'].map(date => ({ date, snr: 0.2, fluxMicroJy: 0, errorMicroJy: 1 })) });
  assert.equal(verdict(nothing).label, 'no source');
  assert.deepEqual(tools(nothing), []);

  const area = createCase({ n: 9, raDeg: 10, decDeg: 5, radiusArcsec: 120 });
  assert.deepEqual(tools(area), []);
});

test('mark_target and confirm_motion validate their arguments, and the Mark star button is served', async () => {
  assert.deepEqual(validateToolCall('mark_target', {}).args, {});
  assert.deepEqual(validateToolCall('confirm_motion', { spot: 2 }).args, { spot: 2 });
  assert.deepEqual(validateToolCall('confirm_motion', { spot: 2, to_spot: 3 }).args, { spot: 2, to_spot: 3 });
  assert.equal(validateToolCall('confirm_motion', { spot: 2, to_spot: 2 }).ok, false);
  assert.equal(validateToolCall('confirm_motion', {}).ok, false);
  const html = await readFile(new URL('../viewer.html', import.meta.url), 'utf8');
  assert.match(html, /id="mark-target-button"[^>]*disabled/);
  assert.match(html, /<script type="module" src="mark-target.js"><\/script>/);
  const { AGENT_PUBLIC_FILES } = await import('../agent-assets.js');
  assert.ok(AGENT_PUBLIC_FILES.includes('mark-target.js'));
});
