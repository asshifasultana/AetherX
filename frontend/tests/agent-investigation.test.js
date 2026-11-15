import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSpotList, MAX_SPOTS } from '../lib/spots.js';
import { findBlobs, pairBlobs } from '../lib/blobs.js';
import { parallaxShift, equatorialToEcliptic, eclipticToEquatorial, solarElongationDeg, separationArcsec } from '../lib/ecliptic.js';
import { createCase, applyEvidence, verdict, summarize, createCaseBook } from '../lib/case-file.js';
import { checkReply, stripProblems, forbiddenClaims, correctionPrompt, leakedToolNames, plainToolNames, asksPermission } from '../lib/agent-guard.js';
import { spectralHints } from '../lib/spectral-hints.js';
import { QUESTS, checkQuestAnswer, barnardTrack, distanceToTrackArcsec, randomViewOffset, viewOffsets } from '../lib/quests.js';
import { TOURS } from '../lib/tours.js';
import { fastStarPasses, compassDirection, yearOf } from '../lib/proper-motion.js';
import { propagateGaia } from '../gaia-core.js';
import { presets } from '../presets.js';
import { TOOL_NAMES, validateToolCall } from '../lib/agent-tools.js';
import { encodeViewState, decodeViewState, viewStateSignature, DEFAULT_VIEW_STATE } from '../url-state.js';
import { parseSbident, raToSbident, decToSbident, createKnownObjectsHandler } from '../api/known-objects.js';
import { createAgentHandler, capabilitiesOf, CRITIC_PROMPT } from '../api/agent.js';
import { parseVerdict, createVisionHandler } from '../api/agent-vision.js';
import { cleanPayload, cleanVote, cleanFinding, cleanRecovery, createCasesHandler } from '../api/cases.js';
import { parsePopulation, binRemaining } from '../../scripts/planet-nine-region.mjs';
import { AGENT_PUBLIC_FILES } from '../agent-assets.js';
import { readFile, access } from 'node:fs/promises';

function request(method, body, { url = '/', headers = {} } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  return Object.assign(stream, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
}
function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(text = '') { this.body = text; } };
}

test('spots take the lowest free number, cap at nine and clear by origin', () => {
  const spots = createSpotList();
  assert.equal(spots.add({ raDeg: 10, decDeg: 5 }).n, 1);
  assert.equal(spots.add({ raDeg: 11, decDeg: 5 }, { origin: 'agent' }).n, 2);
  spots.remove(1);
  assert.equal(spots.add({ raDeg: 12, decDeg: 5 }).n, 1, 'freed numbers are reused');
  assert.equal(spots.add({ raDeg: 400, decDeg: 5 }).raDeg, 40, 'RA wraps');
  assert.equal(spots.add({ raDeg: 1, decDeg: 95 }), null, 'invalid Dec is refused');
  spots.clear('agent');
  assert.deepEqual(spots.list().map(spot => spot.origin), ['user', 'user']);
  for (let i = 0; i < 20; i++) spots.add({ raDeg: i, decDeg: 0 });
  assert.equal(spots.list().length, MAX_SPOTS);
});

test('blobs: a moved source becomes a brighter/fainter pair; a hot pixel ranks last', () => {
  const width = 40, values = new Float32Array(width * width), significant = new Uint8Array(width * width);
  const put = (x, y, value) => { values[y * width + x] = value; significant[y * width + x] = value > 0 ? 1 : 2; };
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { put(20 + dx, 20 + dy, 12); put(24 + dx, 20 + dy, -11); }
  put(5, 30, 40);
  const blobs = findBlobs({ values, significant, width, sigma: 1 });
  assert.equal(blobs.length, 3);
  assert.equal(blobs.at(-1).singlePixel, true);
  assert.ok(Math.abs(blobs[0].x - 20.5) < 0.01 || Math.abs(blobs[0].x - 24.5) < 0.01);
  const [pair] = pairBlobs(blobs);
  assert.equal(pair.separationPx, 4);
  assert.equal(pair.adjacent, false);
  assert.deepEqual(findBlobs({ values, significant, width, sigma: 0 }), []);
});

test('ecliptic conversions round-trip and parallax at 500 AU is about 14′ over six months', () => {
  const ecl = equatorialToEcliptic(62.5, 12.5), back = eclipticToEquatorial(ecl.lonDeg, ecl.latDeg);
  assert.ok(separationArcsec({ raDeg: 62.5, decDeg: 12.5 }, back) < 0.01);
  assert.ok(Math.abs(equatorialToEcliptic(270, 66.5607).latDeg - 90) < 0.01, 'north ecliptic pole');
  // A field seen at 90° from the Sun, then six months later on the other side.
  let from = 61000;
  while (Math.abs(solarElongationDeg(62.5, 12.5, from) - 90) > 2) from++;
  const shift = parallaxShift({ raDeg: 62.5, decDeg: 12.5, distanceAu: 500, fromMjd: from, toMjd: from + 182.6 });
  assert.ok(shift.offsetArcmin > 12 && shift.offsetArcmin < 15, `${shift.offsetArcmin}′`);
  const near = parallaxShift({ raDeg: 62.5, decDeg: 12.5, distanceAu: 100, fromMjd: from, toMjd: from + 182.6 });
  assert.ok(near.offsetArcmin > 4.5 * shift.offsetArcmin, 'closer bodies shift more');
});

test('case files are decided by measured evidence, and unexplained needs every mundane suspect ruled out', () => {
  const file = createCase({ n: 1, raDeg: 10, decDeg: 5 });
  assert.equal(verdict(file).label, 'open');
  applyEvidence(file, 'measure_source', { measurements: [{ date: '2025-08-01', snr: 8, fluxMicroJy: 50, errorMicroJy: 5 }, { date: '2026-02-01', snr: 7, fluxMicroJy: 48, errorMicroJy: 5 }, { date: '2026-08-01', snr: 9, fluxMicroJy: 51, errorMicroJy: 5 }], variabilitySigma: 0.6 });
  assert.equal(file.suspects.glitch.status, 'ruled_out');
  assert.equal(file.suspects.variable_star.status, 'ruled_out');
  applyEvidence(file, 'crossmatch', { gaia: { nearest: { sourceId: 'x', gMag: 17, separationArcsec: 40, pmra: 1, pmdec: 1 }, within: [{ sourceId: 'x', gMag: 17, separationArcsec: 40, pmra: 1, pmdec: 1 }], movedThrough: [] }, jpl: { checked: false } });
  assert.equal(verdict(file).label, 'open', 'JPL not answering leaves known_asteroid open');
  assert.deepEqual(verdict(file).next, ['crossmatch']);
  applyEvidence(file, 'crossmatch', { gaia: { nearest: null, within: [], movedThrough: [] }, jpl: { checked: true, date: '2026-08-01', nearest: null } });
  assert.equal(verdict(file).label, 'unexplained — needs follow-up');

  const asteroid = createCase({ n: 2, raDeg: 10, decDeg: 5 });
  applyEvidence(asteroid, 'crossmatch', { gaia: { nearest: null, within: [], movedThrough: [] }, jpl: { checked: true, date: '2026-08-01', nearest: { name: '(2014 XY)', separationArcsec: 4 } } });
  assert.equal(verdict(asteroid).label, 'known object');

  const ghost = createCase({ n: 3, raDeg: 10, decDeg: 5 });
  applyEvidence(ghost, 'find_changes', { blob: { singlePixel: false, peakSigma: 9 }, pairedAdjacent: true });
  assert.equal(verdict(ghost).label, 'likely artefact');

  const opinion = createCase({ n: 4, raDeg: 10, decDeg: 5 });
  applyEvidence(opinion, 'second_opinion', { label: 'artifact', reason: 'ring' });
  assert.equal(verdict(opinion).label, 'open', 'a vision opinion never decides on its own');
  assert.equal(summarize(opinion).notes.length, 1);

  const book = createCaseBook();
  const first = book.ensure({ n: 1, raDeg: 1, decDeg: 1 });
  assert.equal(book.ensure({ n: 1, raDeg: 1, decDeg: 1 }), first);
  assert.notEqual(book.ensure({ n: 1, raDeg: 2, decDeg: 1 }), first, 'a moved spot starts a new case');
});

const measuredOn = (dates, detectedOn = []) => ({ measurements: dates.map(date => ({ date, snr: detectedOn.includes(date) ? 8 : 0.4, fluxMicroJy: 1, errorMicroJy: 1 })), variabilitySigma: null });
const elevenDates = Array.from({ length: 11 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}-15`);

test('case files: nothing on any date is "no source", not a glitch; one date only is still a glitch', () => {
  const empty = createCase({ n: 1, raDeg: 10, decDeg: 5 });
  applyEvidence(empty, 'measure_source', measuredOn(elevenDates));
  assert.notEqual(empty.suspects.glitch.status, 'supported');
  assert.equal(verdict(empty).label, 'no source');
  assert.match(verdict(empty).detail, /any of 11 measured dates/);
  assert.equal(verdict(empty).next, undefined, 'no source is final, so the guide does not loop on measuring');
  applyEvidence(empty, 'measure_source', measuredOn(elevenDates, elevenDates.slice(0, 4)));
  assert.notEqual(verdict(empty).label, 'no source', 'a later detection clears it');

  const once = createCase({ n: 2, raDeg: 10, decDeg: 5 });
  applyEvidence(once, 'measure_source', measuredOn(elevenDates.slice(0, 4), [elevenDates[0]]));
  assert.equal(once.suspects.glitch.status, 'supported');
  assert.equal(verdict(once).label, 'likely artefact');
});

// Barnard's Star: SIMBAD J2000 position and Gaia EDR3 proper motion (as in presets.js), moved to Gaia's 2016 epoch.
const barnard2016 = (() => {
  const j2000 = { raDeg: (17 + 57 / 60 + 48.4984700685 / 3600) * 15, decDeg: 4 + 41 / 60 + 36.113879676 / 3600, refEpoch: 2000, pmra: -801.551, pmdec: 10362.394 };
  const at2016 = propagateGaia(j2000, 2016);
  return { sourceId: '4472832130942575872', gMag: 8.2, raDeg: at2016.raDeg, decDeg: at2016.decDeg, refEpoch: 2016, pmra: j2000.pmra, pmdec: j2000.pmdec };
})();

test('proper motion: Barnard’s Star passed its J2000 spot in 2000 and is about 4.4′ north in August 2025', () => {
  const year = yearOf(Date.parse('2025-08-21T12:00:00Z'));
  const slow = { ...barnard2016, sourceId: '1', pmra: 5, pmdec: 5 };
  const [pass, ...rest] = fastStarPasses(presets.barnard, [barnard2016, slow], { fromYear: 2000, toYear: year, nowYear: year });
  assert.equal(rest.length, 0, 'slow stars are not tracked');
  assert.ok(pass.closestArcsec < 1, `${pass.closestArcsec}″`);
  assert.equal(pass.closestYear, 2000);
  assert.ok(Math.abs(pass.now.offsetArcmin - 4.4) <= 0.1, `${pass.now.offsetArcmin}′`);
  assert.equal(pass.now.direction, 'north');
  assert.equal(pass.pmArcsecPerYear, 10.39);
  assert.deepEqual(fastStarPasses({ raDeg: presets.barnard.raDeg + 1, decDeg: presets.barnard.decDeg }, [barnard2016], { toYear: year }), []);
  assert.equal(compassDirection(-10, -10), 'south-west');
});

test('case files: an empty spot a fast star left is "moved away" and points to where the star is now', () => {
  const year = yearOf(Date.parse('2025-08-21T12:00:00Z'));
  const movedThrough = fastStarPasses(presets.barnard, [barnard2016], { toYear: year, nowYear: year });
  const file = createCase({ n: 1, ...presets.barnard });
  applyEvidence(file, 'measure_source', measuredOn(elevenDates));
  applyEvidence(file, 'crossmatch', { date: '2025-08-21', gaia: { nearest: null, within: [], movedThrough, trackedSince: 2000 }, jpl: { checked: true, date: '2025-08-21', nearest: null } });
  const result = verdict(file);
  assert.equal(result.label, 'moved away');
  assert.match(result.detail, /^Nothing is here now\. .*4\.4′ north/);
  assert.equal(result.star.raDeg, movedThrough[0].now.raDeg);
  assert.match(file.suspects.proper_motion_star.evidence.at(-1), /10\.39″ per year and was here around 2000/);

  const onStar = createCase({ n: 2, ...movedThrough[0].now });
  applyEvidence(onStar, 'crossmatch', { date: '2025-08-21', gaia: { nearest: { sourceId: barnard2016.sourceId, gMag: 8.2, separationArcsec: 0.4, pmra: barnard2016.pmra, pmdec: barnard2016.pmdec }, within: [], movedThrough }, jpl: { checked: true, date: '2025-08-21', nearest: null } });
  assert.equal(verdict(onStar).label, 'known object');
  assert.match(onStar.suspects.proper_motion_star.evidence.at(-1), /moves 10393 mas per year/);

  const quiet = createCase({ n: 3, raDeg: 10, decDeg: 5 });
  applyEvidence(quiet, 'crossmatch', { date: '2025-08-21', gaia: { nearest: null, within: [], movedThrough: [], truncated: true }, jpl: { checked: false } });
  assert.match(quiet.suspects.proper_motion_star.evidence.at(-1), /passed within 12″ of here between 2000 and 2025-08-21 \(only the brightest 1000/);
});

test('the guard blocks discovery claims and unmeasured numbers but allows history and measurements', () => {
  const sources = [JSON.stringify({ sigma: 0.0123, changes: [{ peakSigma: 8.4, raDeg: 62.51234 }] }), 'is anything here?'];
  assert.equal(checkReply('Spot 1 is 8.4σ above the noise at RA 62.512°.', sources).ok, true);
  assert.equal(checkReply('Barnard noticed it in 1916 by comparing plates from 1894.', sources).ok, true);
  const bad = checkReply('Spot 1 moved 47.3 arcseconds. We discovered a new planet!', sources);
  assert.deepEqual(bad.ungrounded, ['47.3']);
  assert.equal(bad.forbidden.length, 1);
  assert.equal(stripProblems('Spot 1 moved 47.3 arcseconds. It is 8.4σ bright.', bad), 'It is 8.4σ bright.');
  assert.ok(forbiddenClaims('This could be Planet Nine.').length);
  assert.equal(forbiddenClaims('These are the Planet Nine region cells.').length, 0);
  assert.match(correctionPrompt(bad), /47\.3/);
});

test('the guard catches tool names and permission questions in replies', () => {
  assert.deepEqual(leakedToolNames('• `get_case 3` — see the full file. Or run second_opinion on spot 2.'), ['get_case', 'second_opinion']);
  assert.deepEqual(leakedToolNames('I will crossmatch all three against Gaia and precover older photos.'), [], 'plain-English verbs are fine');
  assert.deepEqual(leakedToolNames('Next: `crossmatch` spot 1, then precover(spot=2).'), ['crossmatch', 'precover']);
  assert.equal(checkReply('Run `get_case 3` next.', []).ok, false);
  assert.equal(plainToolNames('Open `get_case 3` or measure_source spot 2.'), 'Open the case file for spot 3 or a brightness measurement on every date for spot 2.');
  assert.match(stripProblems('See `get_case 3`.', { ungrounded: [], forbidden: [] }), /the case file for spot 3/);
  assert.ok(asksPermission('Want me to run a brightness check on spots 1 and 2?'));
  assert.ok(asksPermission('Next steps (pick one):'));
  assert.ok(!asksPermission('Spot 2 changes brightness at a fixed position. I can also look at its colours.'));
  assert.match(correctionPrompt({}, { askedPermission: true }), /permission/);
  assert.match(correctionPrompt({ leaked: ['get_case'] }), /tool names/);
});

test('spectral hints need enough points and flag a methane-like dip', () => {
  assert.match(spectralHints([{ wavelengthUm: 1, fluxMicroJy: 1 }]).hints[0], /Too few/);
  const samples = [];
  for (let w = 0.8; w <= 5; w += 0.1) {
    const dip = w >= 3.2 && w < 3.45 ? 0.3 : 1;
    samples.push({ wavelengthUm: Number(w.toFixed(2)), fluxMicroJy: (w > 4.4 ? 300 : 100) * dip, errorMicroJy: 2 });
  }
  const hints = spectralHints(samples);
  assert.equal(hints.methaneDip, true);
  assert.equal(hints.longWaveRise, true);
});

test('quests: a click on Barnard’s Star track is correct, a far click is not', () => {
  const track = barnardTrack(60900, 61270);
  assert.ok(separationArcsec(track[0], track[1]) > 9 && separationArcsec(track[0], track[1]) < 12, 'about 10″ in a year');
  const mid = { raDeg: (track[0].raDeg + track[1].raDeg) / 2, decDeg: (track[0].decDeg + track[1].decDeg) / 2 };
  assert.ok(distanceToTrackArcsec(mid, track) < 0.5);
  const right = checkQuestAnswer('be-barnard', mid, { track });
  assert.equal(right.correct, true);
  assert.match(right.story, /1916/);
  const wrong = checkQuestAnswer('be-barnard', { raDeg: mid.raDeg + 0.05, decDeg: mid.decDeg }, { track });
  assert.equal(wrong.correct, false);
  assert.ok(!wrong.story, 'the story is kept until the answer is found');
  assert.deepEqual(Object.keys(QUESTS).sort(), ['be-barnard', 'be-leverrier', 'be-tombaugh', 'hidden-planet']);
});

test('quests: Be Barnard frames the star off-centre but inside the default field', () => {
  const setup = QUESTS['be-barnard'].setup.offCentre;
  const offsets = viewOffsets(setup);
  // A fixed, repeatable set of framings, so their image crops can be cached.
  assert.equal(offsets.length, 16);
  assert.deepEqual(viewOffsets(setup), offsets);
  assert.equal(new Set(offsets.map(offset => `${offset.eastArcmin},${offset.northArcmin}`)).size, 16, 'all different');
  for (const offset of offsets) {
    const distance = Math.hypot(offset.eastArcmin, offset.northArcmin);
    assert.ok(distance >= 2.5 && distance <= 5, `clear of the centre, well inside a 16′ field (${distance})`);
  }
  assert.deepEqual(offsets[0], { eastArcmin: 3, northArcmin: 0 });
  assert.deepEqual(offsets[2], { eastArcmin: 0, northArcmin: 3 });
  // Every framing can be drawn, and the ends of the random range stay in the list.
  assert.deepEqual(Array.from({ length: 16 }, (_, i) => randomViewOffset(setup, () => (i + 0.5) / 16)), offsets);
  assert.deepEqual(randomViewOffset(setup, () => 0), offsets[0]);
  assert.deepEqual(randomViewOffset(setup, () => 0.999999), offsets[15]);
});

test('tour steps only use real tools with valid arguments', () => {
  for (const step of TOURS.highlights.steps) {
    assert.ok(TOOL_NAMES.includes(step.tool), step.tool);
    if (['go_to_target', 'compare_frames', 'find_changes', 'planet_nine_region'].includes(step.tool)) assert.equal(validateToolCall(step.tool, step.args).ok, true, step.tool);
  }
});

test('new tools validate spots, distances and quest ids', () => {
  assert.deepEqual(validateToolCall('crossmatch', { spot: 2, date: '2026-01-05' }), { ok: true, name: 'crossmatch', args: { spot: 2, date: '2026-01-05' } });
  assert.equal(validateToolCall('crossmatch', { spot: 0 }).ok, false);
  assert.equal(validateToolCall('predict_parallax_pair', { spot: 1, distance_au: 5 }).ok, false);
  assert.equal(validateToolCall('precover', { from_spot: 1, to_spot: 1 }).ok, false);
  assert.equal(validateToolCall('start_quest', { id: 'be-galileo' }).ok, false);
  assert.deepEqual(validateToolCall('find_changes', {}).args, { limit: 3, mark: true });
  assert.deepEqual(validateToolCall('pick_epochs', {}).args, { gap_days: 180 });
});

test('extra spots travel in the link next to the original mark', () => {
  const state = { ...DEFAULT_VIEW_STATE, markRaDeg: 10, markDecDeg: 5, extraSpots: [{ raDeg: 10.01, decDeg: 5.02 }, { raDeg: 9.99, decDeg: -4 }] };
  const encoded = encodeViewState(state);
  assert.match(encoded, /mra=10/);
  assert.match(encoded, /spots=10\.01%2C5\.02%3B9\.99%2C-4|spots=10\.01,5\.02;9\.99,-4/);
  const { state: decoded, issues } = decodeViewState('?' + encoded);
  assert.equal(issues.length, 0);
  assert.deepEqual(decoded.extraSpots, [{ raDeg: 10.01, decDeg: 5.02 }, { raDeg: 9.99, decDeg: -4 }]);
  assert.notEqual(viewStateSignature(state), viewStateSignature({ ...state, extraSpots: [] }));
  const broken = decodeViewState('?spots=1,2;x,3');
  assert.equal(broken.state.extraSpots.length, 1);
  assert.equal(broken.issues.length, 1);
  assert.equal(decodeViewState('?mra=1&mdec=2').state.markRaDeg, 1, 'old links still work');
});

// A trimmed real SBIdent response (2025-09-01, RA 00:30, Dec +02°).
const SBIDENT = { fields_second: ['Object name', 'Astrometric RA (hh:mm:ss)', 'Astrometric Dec (dd mm\'ss")', 'Dist. from center RA (")', 'Dist. from center Dec (")', 'Dist. from center Norm (")', 'Visual magnitude (V)', 'RA rate ("/h)', 'Dec rate ("/h)'],
  data_second_pass: [['402535 (2006 FC24)', '00:30:33.30', '+02 06\'12.1"', '499.', '372.', '622.6', '21.1', '-1.956E+01', '-1.452E+01'], ['871441 (2017 RN94)', '00:29:48.40', '+01 59\'39.6"', '-174.', '-20.4', '175.1', '21.9', '-1.952E+01', '-1.171E+01']] };

test('JPL SBIdent coordinates are formatted and parsed, nearest first', () => {
  assert.equal(raToSbident(7.5), '00-30-00.00');
  assert.equal(decToSbident(-2.5), 'M02-30-00.0');
  const objects = parseSbident(SBIDENT);
  assert.equal(objects[0].name, '871441 (2017 RN94)');
  assert.equal(objects[0].separationArcsec, 175.1);
  assert.ok(Math.abs(objects[0].raDeg - 7.4517) < 0.001);
  assert.ok(Math.abs(objects[0].decDeg - 1.9943) < 0.001);
  assert.equal(objects[0].rateArcsecPerHour, 22.76);
  assert.deepEqual(parseSbident({}), []);
});

test('the known-objects endpoint validates input and caches JPL answers', async () => {
  let calls = 0, asked;
  const handler = createKnownObjectsHandler({ fetchImpl: async url => { calls++; asked = url; return { ok: true, json: async () => SBIDENT }; } });
  let res = response();
  await handler(request('GET', undefined, { url: '/api/known-objects?ra=7.5&dec=2' }), res);
  assert.equal(res.statusCode, 400);
  res = response();
  await handler(request('GET', undefined, { url: '/api/known-objects?ra=7.5&dec=2&time=2025-09-01T00:00:00Z&radius=600' }), res);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.checked, true);
  assert.equal(data.count, 2);
  assert.match(String(asked), /sb_ident\.api/);
  assert.match(String(asked), /mpc-code=500/);
  await handler(request('GET', undefined, { url: '/api/known-objects?ra=7.5&dec=2&time=2025-09-01T00:00:00Z&radius=600' }), response());
  assert.equal(calls, 1);
});

test('a slow JPL check answers "pending" and the finished result is served next time', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const handler = createKnownObjectsHandler({ waitMs: 10, fetchImpl: async () => { await slow; return { ok: true, json: async () => SBIDENT }; } });
  const url = '/api/known-objects?ra=100&dec=-20&time=2025-10-01T00:00:00Z&radius=600';
  let res = response();
  await handler(request('GET', undefined, { url }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(JSON.parse(res.body).pending, true);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  res = response();
  await handler(request('GET', undefined, { url }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).count, 2);
});

test('capabilities report only the features with keys and models', async () => {
  assert.deepEqual(capabilitiesOf({}), { agent: false, vision: false, critic: false, fast: false, store: false });
  assert.deepEqual(capabilitiesOf({ OPENROUTER_API_KEYS: 'a', OPENROUTER_VISION_MODEL: 'v', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' }), { agent: true, vision: true, critic: false, fast: false, store: true });
  const res = response();
  await createAgentHandler({ env: { OPENROUTER_API_KEY: 'k' } })(request('GET', undefined, { url: '/api/agent?capabilities=1' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).agent, true);
});

test('the sceptic uses its own model and prompt, without tools', async () => {
  let sent;
  const fetchImpl = async (url, options) => { sent = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A bright star sits 12″ away; check the same band.' } }] }) }; };
  let res = response();
  await createAgentHandler({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl })(request('POST', { mode: 'critic', case: { spot: 1 } }), res);
  assert.equal(res.statusCode, 404, 'off without OPENROUTER_CRITIC_MODEL');
  res = response();
  await createAgentHandler({ env: { OPENROUTER_API_KEY: 'k', OPENROUTER_CRITIC_MODEL: 'critic-model' }, fetchImpl })(request('POST', { mode: 'critic', case: { spot: 1, verdict: { label: 'unexplained — needs follow-up' } } }, { headers: { 'x-forwarded-for': '10.9.9.9' } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(JSON.parse(res.body).objection, /bright star/);
  assert.equal(sent.model, 'critic-model');
  assert.equal(sent.messages[0].content, CRITIC_PROMPT);
  assert.equal(sent.tools, undefined);
});

test('the proxy flags discovery claims in a final reply', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'We discovered a new planet in spot 1!' } }] }) });
  const res = response();
  await createAgentHandler({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl })(request('POST', { messages: [{ role: 'user', content: 'what is spot 1?' }] }, { headers: { 'x-forwarded-for': '10.8.8.8' } }), res);
  assert.equal(JSON.parse(res.body).flagged.length, 1);
});

test('vision verdicts are parsed strictly and disagreement means unsure', async () => {
  assert.deepEqual(parseVerdict('ok {"label":"real","reason":"compact dot","interest":0.8}'), { label: 'real', reason: 'compact dot', interest: 0.8 });
  assert.equal(parseVerdict('{"label":"maybe"}'), null);
  const stamp = 'data:image/png;base64,iVBORw0KGgo=';
  let call = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ label: call++ ? 'artifact' : 'real', reason: 'r', interest: 0.5 }) } }] }) });
  let res = response();
  await createVisionHandler({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl })(request('POST', { stamps: { difference: stamp } }), res);
  assert.equal(res.statusCode, 404, 'off without OPENROUTER_VISION_MODEL');
  res = response();
  await createVisionHandler({ env: { OPENROUTER_API_KEY: 'k', OPENROUTER_VISION_MODEL: 'vision' }, fetchImpl })(request('POST', { stamps: { current: stamp, reference: stamp, difference: stamp } }), res);
  const data = JSON.parse(res.body);
  assert.equal(data.label, 'unsure');
  assert.equal(data.agreed, false);
  res = response();
  await createVisionHandler({ env: { OPENROUTER_API_KEY: 'k', OPENROUTER_VISION_MODEL: 'vision' }, fetchImpl })(request('POST', { stamps: { difference: 'javascript:alert(1)' } }), res);
  assert.equal(res.statusCode, 400);
});

test('saved records are cleaned and need Supabase', async () => {
  assert.deepEqual(cleanPayload({ a: 'x\u0000y', b: Infinity, c: [1, { d: true }], e: () => 1 }), { a: 'x y', b: null, c: [1, { d: true }], e: null });
  let res = response();
  await createCasesHandler({ env: {} })(request('POST', { kind: 'report', payload: {} }), res);
  assert.equal(res.statusCode, 503);
  let sent;
  const fetchImpl = async (url, options) => { sent = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => [{ id: 7 }] }; };
  res = response();
  await createCasesHandler({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret' }, fetchImpl })(request('POST', { kind: 'report', payload: { raDeg: 10, decDeg: 5, verdict: 'open' } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(sent.url, 'https://x.supabase.co/rest/v1/agent_records');
  assert.equal(sent.body.ra_deg, 10);
  res = response();
  await createCasesHandler({ env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' }, fetchImpl })(request('POST', { kind: 'spam', payload: {} }), res);
  assert.equal(res.statusCode, 400);
});

test('PlanetX votes keep only a case id, verdict and anonymous voter', async () => {
  const voter = '7f1c2a9e-3b4d-4c5e-8f60-123456789abc';
  assert.deepEqual(cleanVote({ caseId: 'p9-ra062.5-dec+12.5', verdict: 'something', voter, raDeg: 62.5, decDeg: 12.5, email: 'x@y.z' }), { caseId: 'p9-ra062.5-dec+12.5', verdict: 'something', voter, raDeg: 62.5, decDeg: 12.5 });
  assert.equal(cleanVote({ caseId: 'p9-ra062.5-dec+12.5', verdict: 'maybe', voter }), null);
  assert.equal(cleanVote({ caseId: 'drop table', verdict: 'nothing', voter }), null);
  assert.equal(cleanVote({ caseId: 'p9-ra062.5-dec+12.5', verdict: 'nothing', voter: 'x' }), null);
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret' };
  let sent;
  const fetchImpl = async (url, options = {}) => {
    sent = { url, body: options.body && JSON.parse(options.body) };
    return url.includes('planetx_vote_tally')
      ? { ok: true, json: async () => [{ case_id: 'p9-ra062.5-dec+12.5', something: 3, nothing: 1 }, { case_id: 'bad', something: 9, nothing: 0 }] }
      : { ok: true, json: async () => [{ id: 9 }] };
  };
  let res = response();
  await createCasesHandler({ env, fetchImpl })(request('POST', { kind: 'vote', payload: { caseId: 'p9-ra062.5-dec+12.5', verdict: 'nothing', voter, raDeg: 62.5, decDeg: 12.5 } }, { headers: { 'x-forwarded-for': '10.0.0.9' } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(sent.body.kind, 'vote');
  assert.equal(sent.body.payload.verdict, 'nothing');
  assert.equal(sent.body.ra_deg, 62.5);
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('POST', { kind: 'vote', payload: { caseId: 'p9-ra062.5-dec+12.5', verdict: 'yes', voter } }, { headers: { 'x-forwarded-for': '10.0.0.10' } }), res);
  assert.equal(res.statusCode, 400);
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('GET', undefined, { url: '/api/cases?kind=vote&tally=1' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sent.url, 'https://x.supabase.co/rest/v1/planetx_vote_tally?select=case_id,something,nothing&limit=500');
  assert.deepEqual(JSON.parse(res.body), { tallies: { 'p9-ra062.5-dec+12.5': { something: 3, nothing: 1 } } });
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('GET', undefined, { url: '/api/cases?kind=vote' }), res);
  assert.equal(res.statusCode, 400, 'individual votes (with voter ids) are never listed');
});

test('the Planet Nine map keeps only synthetic planets no survey would have seen', async () => {
  const csv = '# comment\nindex, ra, dec, R, V, ZTF, DES, PS1\n0, 62.0, 12.0, 600, 22.5, 0, 0, 0\n1, 63.0, 13.0, 400, 21.0, 0, 0, 0\n2, 10.0, -5.0, 300, 19.0, 1, 0, 1\n3, 200.0, -30.0, 800, 23.0, 0, 0, 0';
  const binned = binRemaining(parsePopulation(csv));
  assert.equal(binned.total, 4);
  assert.equal(binned.remaining, 3);
  assert.equal(binned.cells[0].raDeg, 62.5);
  assert.equal(binned.cells[0].share, 0.66667);
  const committed = JSON.parse(await readFile(new URL('../data/planet-nine.json', import.meta.url), 'utf8'));
  assert.ok(committed.cells.length > 100);
  assert.match(committed.source, /Brown & Batygin 2021/);
});

test('every guide module is published and exists', async () => {
  for (const file of AGENT_PUBLIC_FILES) await access(new URL(`../${file}`, import.meta.url));
  // Every module a guide file imports must be published too, or the guide 404s.
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const { CONTEXT_PUBLIC_FILES } = await import('../context-assets.js');
  const served = new Set([...server.matchAll(/'([\w./-]+\.js)'/g)].map(match => match[1]).concat(AGENT_PUBLIC_FILES, CONTEXT_PUBLIC_FILES));
  for (const file of AGENT_PUBLIC_FILES.filter(name => name.endsWith('.js'))) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, spec] of source.matchAll(/^import[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const resolved = new URL(spec, new URL(`http://x/${file}`)).pathname.slice(1);
      assert.ok(served.has(resolved), `${file} imports ${resolved}, which the server does not publish`);
    }
  }
  const html = await readFile(new URL('../viewer.html', import.meta.url), 'utf8');
  for (const id of ['spot-layer', 'agent-notice', 'ai-guide-activity', 'ai-guide-spots', 'ai-guide-more']) assert.match(html, new RegExp(`id="${id}"`));
});

test('PlanetX votes accept candidate tiles; findings keep only answers, verdict, AI read and spot', async () => {
  const voter = '7f1c2a9e-3b4d-4c5e-8f60-123456789abc';
  assert.equal(cleanVote({ caseId: 't9-ra062.5-dec+12.5', verdict: 'something', voter }).caseId, 't9-ra062.5-dec+12.5');
  assert.equal(cleanVote({ caseId: 'x9-ra062.5-dec+12.5', verdict: 'something', voter }), null);
  const finding = cleanFinding({
    caseId: 't9-ra062.5-dec+12.5', verdict: 'something', voter, note: 'call me', email: 'x@y.z',
    answers: { glitch: 'ruled_out', known_star: 'supported', variable_star: 'maybe', hacked: 'ruled_out' },
    ai: { label: 'known object', suspects: { known_star: 'supported', glitch: 'bogus' }, extra: 1 },
    spot: { raDeg: 62.512345678, decDeg: 12.5, radiusArcsec: 30 }
  });
  assert.deepEqual(finding, {
    caseId: 't9-ra062.5-dec+12.5', verdict: 'something', voter,
    answers: { glitch: 'ruled_out', known_star: 'supported' },
    ai: { label: 'known object', suspects: { known_star: 'supported' } },
    spot: { raDeg: 62.51235, decDeg: 12.5, radiusArcsec: 30 }, raDeg: 62.51235, decDeg: 12.5
  });
  assert.equal(cleanFinding({ caseId: 'p9-ra062.5-dec+12.5', verdict: 'maybe', voter }), null);
  assert.deepEqual(cleanFinding({ caseId: 'p9-ra062.5-dec+12.5', verdict: 'nothing', voter, spot: { raDeg: 999, decDeg: 0 } }).spot, null);

  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret' };
  let sent;
  const fetchImpl = async (url, options = {}) => {
    sent = { url, body: options.body && JSON.parse(options.body) };
    return url.includes('kind=eq.finding')
      ? { ok: true, json: async () => [{ payload: { caseId: 'p9-ra062.5-dec+12.5', voter, verdict: 'nothing', answers: { glitch: 'supported' }, ai: null, spot: null }, created_at: '2026-11-13T10:00:00Z' }] }
      : { ok: true, json: async () => [{ id: 11 }] };
  };
  let res = response();
  await createCasesHandler({ env, fetchImpl })(request('POST', { kind: 'finding', payload: { caseId: 'p9-ra062.5-dec+12.5', verdict: 'something', voter, answers: { glitch: 'ruled_out' }, spot: { raDeg: 62.5, decDeg: 12.5 } } }, { headers: { 'x-forwarded-for': '10.0.0.21' } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(sent.body.kind, 'finding');
  assert.equal(sent.body.ra_deg, 62.5);
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('GET', undefined, { url: '/api/cases?kind=finding&caseId=p9-ra062.5-dec%2B12.5' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sent.url, 'https://x.supabase.co/rest/v1/agent_records?kind=eq.finding&payload->>caseId=eq.p9-ra062.5-dec%2B12.5&select=payload,created_at&order=created_at.desc&limit=20');
  const body = JSON.parse(res.body);
  assert.deepEqual(body.findings, [{ verdict: 'nothing', answers: { glitch: 'supported' }, ai: null, spot: null, createdAt: '2026-11-13T10:00:00Z' }]);
  assert.ok(!JSON.stringify(body).includes(voter));
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('GET', undefined, { url: '/api/cases?kind=finding' }), res);
  assert.equal(res.statusCode, 400);
});

test('hidden-planet rounds keep only the game, brightness and result, and are read back only as totals', async () => {
  const voter = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
  assert.deepEqual(cleanRecovery({ game: 'lab', peakSigma: 6.4321, found: true, misses: 1, voter, mag: 17.25, distanceAu: 412.3, baselineDays: 4.75, email: 'x@y.z', note: 'hi' }),
    { game: 'lab', peakSigma: 6.43, found: true, voter, misses: 1, mag: 17.25, distanceAu: 412.3, baselineDays: 4.75 });
  assert.deepEqual(cleanRecovery({ game: 'quest', peakSigma: 5, found: false, misses: 9, voter, mag: 99 }), { game: 'quest', peakSigma: 5, found: false, voter, misses: 0 });
  assert.equal(cleanRecovery({ game: 'chess', peakSigma: 5, found: true, voter }), null);
  assert.equal(cleanRecovery({ game: 'lab', peakSigma: -1, found: true, voter }), null);
  assert.equal(cleanRecovery({ game: 'lab', peakSigma: 5, found: 'yes', voter }), null);
  assert.equal(cleanRecovery({ game: 'lab', peakSigma: 5, found: true, voter: 'x' }), null);

  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret' };
  const urls = [];
  let sent;
  const fetchImpl = async (url, options = {}) => {
    urls.push(url); sent = { url, body: options.body && JSON.parse(options.body) };
    if (url.includes('planetx_recovery_tally')) return { ok: true, json: async () => [{ game: 'lab', sigma: 6, trials: 4, found: 3 }, { game: 'spam', sigma: 1, trials: 9, found: 9 }, { game: 'quest', sigma: 8, trials: 2, found: 5 }] };
    if (url.includes('planetx_recovery_lab_cells')) return { ok: true, json: async () => [{ mag: 17.25, distance_au: 400, trials: 2, found: 1 }] };
    return { ok: true, json: async () => [{ id: 12 }] };
  };
  let res = response();
  await createCasesHandler({ env, fetchImpl })(request('POST', { kind: 'recovery', payload: { game: 'quest', peakSigma: 7.2, found: true, misses: 0, voter } }, { headers: { 'x-forwarded-for': '10.0.0.31' } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(sent.body.kind, 'recovery');
  assert.deepEqual(sent.body.payload, { game: 'quest', peakSigma: 7.2, found: true, voter, misses: 0 });
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('POST', { kind: 'recovery', payload: { game: 'quest', peakSigma: 7.2, voter } }, { headers: { 'x-forwarded-for': '10.0.0.32' } }), res);
  assert.equal(res.statusCode, 400);
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('GET', undefined, { url: '/api/cases?kind=recovery&tally=1' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    bins: [{ game: 'lab', sigma: 6, trials: 4, found: 3 }, { game: 'quest', sigma: 8, trials: 2, found: 2 }],
    cells: [{ mag: 17.25, distanceAu: 400, trials: 2, found: 1 }]
  });
  assert.ok(urls.some(url => url === 'https://x.supabase.co/rest/v1/planetx_recovery_tally?select=game,sigma,trials,found&limit=2000'));
  res = response();
  await createCasesHandler({ env, fetchImpl })(request('GET', undefined, { url: '/api/cases?kind=recovery' }), res);
  assert.equal(res.statusCode, 400, 'single rounds (with voter ids) are never listed');
});
