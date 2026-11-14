import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findSuspicionPatches, communityScore, intensity, patchId, CASE_ID_PATTERN } from '../lib/planetx-suspects.js';

const cell = (raDeg, decDeg, share) => ({ raDeg, decDeg, share, medianDistanceAu: 600, medianVMag: 22 });

test('intensity is a 0–1 log scale relative to the strongest tile', () => {
  assert.equal(intensity(0.02, 0.02), 1);
  assert.equal(intensity(0, 0.02), 0);
  assert.ok(intensity(0.001, 0.02) > 0 && intensity(0.001, 0.02) < intensity(0.01, 0.02));
  assert.equal(intensity(0.01, 0), 0);
});

test('patch ids are stable and match the API pattern', () => {
  assert.equal(patchId(cell(62.5, 12.5)), 'p9-ra062.5-dec+12.5');
  assert.equal(patchId(cell(2.5, -2.5)), 'p9-ra002.5-dec-02.5');
  assert.match(patchId(cell(357.5, -87.5)), CASE_ID_PATTERN);
});

test('hot tiles split into separate patches; faint sky makes none', () => {
  const model = { cellDeg: 5, cells: [
    cell(62.5, 12.5, 0.02), cell(67.5, 12.5, 0.015), cell(62.5, 17.5, 0.012),
    cell(182.5, -32.5, 0.018), cell(187.5, -32.5, 0.01),
    cell(122.5, 2.5, 0.00001)
  ] };
  const patches = findSuspicionPatches(model);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map(patch => patch.number), [1, 2]);
  assert.equal(patches[0].id, 'p9-ra062.5-dec+12.5');
  assert.equal(patches[0].cells.length, 3);
  assert.ok(patches[0].totalShare > patches[1].totalShare);
  assert.ok(patches.every(patch => !patch.cells.some(member => member.share < 0.001)));
});

test('a patch across RA 0° stays whole with a wrapped centre', () => {
  const model = { cellDeg: 5, cells: [cell(357.5, 2.5, 0.02), cell(2.5, 2.5, 0.02)] };
  const [patch] = findSuspicionPatches(model);
  assert.equal(patch.cells.length, 2);
  assert.ok(patch.centroid.raDeg < 1 || patch.centroid.raDeg > 359, `centre ${patch.centroid.raDeg}`);
  assert.equal(patch.centroid.decDeg, 2.5);
});

test('the real model gives a manageable set of compact cases', () => {
  const model = JSON.parse(readFileSync(new URL('../data/planet-nine.json', import.meta.url)));
  const patches = findSuspicionPatches(model);
  assert.ok(patches.length >= 6 && patches.length <= 25, `${patches.length} patches`);
  assert.equal(new Set(patches.map(patch => patch.id)).size, patches.length);
  for (const patch of patches) assert.match(patch.id, CASE_ID_PATTERN);
});

test('community votes brighten or dim a case, neutral with none', () => {
  const none = communityScore();
  assert.equal(none.brightness, 1);
  assert.equal(none.label, 'No votes yet');
  const yes = [1, 5, 20].map(n => communityScore({ something: n }).brightness);
  const no = [1, 5, 20].map(n => communityScore({ nothing: n }).brightness);
  assert.ok(yes[0] > 1 && yes[1] > yes[0] && yes[2] > yes[1] && yes[2] <= 1.6);
  assert.ok(no[0] < 1 && no[1] < no[0] && no[2] < no[1] && no[2] >= 0.35);
  assert.equal(communityScore({ something: 4, nothing: 4 }).brightness, 1);
  assert.equal(communityScore({ something: 20 }).label, 'Brightening');
  assert.equal(communityScore({ nothing: 20 }).label, 'Dimming');
});

test('candidate tile ids differ from case ids and promoted tiles keep them', async () => {
  const { candidateId, CANDIDATE_ID_PATTERN, ANY_CASE_ID_PATTERN, cellForCandidate, promotedPatches, publicCases } = await import('../lib/planetx-suspects.js');
  const tile = cell(122.5, 2.5, 0.00001);
  assert.equal(candidateId(tile), 't9-ra122.5-dec+02.5');
  assert.match(candidateId(tile), CANDIDATE_ID_PATTERN);
  assert.match(candidateId(tile), ANY_CASE_ID_PATTERN);
  assert.doesNotMatch(candidateId(tile), CASE_ID_PATTERN);
  assert.notEqual(candidateId(tile), patchId(tile));
  const model = { cellDeg: 5, cells: [cell(62.5, 12.5, 0.02), cell(67.5, 12.5, 0.015), tile] };
  assert.equal(cellForCandidate(model, 't9-ra122.5-dec+02.5'), tile);
  assert.equal(cellForCandidate(model, 'p9-ra122.5-dec+02.5'), null);
  const [promoted] = promotedPatches(model, ['t9-ra122.5-dec+02.5', 't9-ra001.0-dec+00.0'], 4);
  assert.equal(promoted.id, 't9-ra122.5-dec+02.5');
  assert.equal(promoted.number, 4);
  assert.equal(promoted.promoted, true);
  const all = publicCases(model, ['t9-ra122.5-dec+02.5', 't9-ra062.5-dec+12.5']);
  // The second id is already inside the model's own patch, so it is not added twice.
  assert.deepEqual(all.map(patch => patch.id), ['p9-ra062.5-dec+12.5', 't9-ra122.5-dec+02.5']);
  assert.deepEqual(all.map(patch => patch.number), [1, 2]);
});
