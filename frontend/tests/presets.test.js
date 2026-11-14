import test from 'node:test';
import assert from 'node:assert/strict';
import { presets, presetMotion, exposureCenter, viewerTarget, FIXED_SKY_MJD, motionPosition } from '../presets.js';
import { validateSearch } from '../lib/observations.js';

const arcsec = (a, b) => ({
  east: (b.raDeg - a.raDeg) * Math.cos(a.decDeg * Math.PI / 180) * 3600,
  north: (b.decDeg - a.decDeg) * 3600,
});
const at = iso => ({ startMjd: Date.parse(iso) / 86400000 + 40587 });
const preset = id => ({ ...presets[id], targetId: id });

test('Barnard’s Star, Epsilon Indi B and WISE 0855 follow proper motion; the others do not', () => {
  for (const id of ['barnard', 'epsilon', 'wise']) assert.ok(presetMotion(preset(id)), id);
  for (const id of ['aurigae', 'draconis']) assert.equal(presetMotion(preset(id)), null, id);
  // A custom position at the same place, or a moved preset, is never tracked.
  assert.equal(presetMotion({ ...presets.wise }), null);
  assert.equal(presetMotion({ ...preset('wise'), raDeg: presets.wise.raDeg + 1e-6 }), null);
});

test('Barnard’s Star is predicted about 4.4′ north of its J2000 position in August 2025', () => {
  const offset = arcsec(presets.barnard, exposureCenter(preset('barnard'), at('2025-08-25T00:00:00Z')));
  assert.ok(Math.abs(offset.north - 265.8) < 1, `north ${offset.north}`);
  assert.ok(Math.abs(offset.east + 20.6) < 1, `east ${offset.east}`);
});

// Forced photometry of SPHEREx D5/D6 epoch stacks found WISE 0855 at S/N 7–9 at
// this predicted place in every epoch, about 2′ west of the challenge position.
test('WISE 0855 is predicted about 2′ west of the 2013 discovery coordinates in 2026', () => {
  const offset = arcsec(presets.wise, exposureCenter(preset('wise'), at('2026-05-01T00:00:00Z')));
  assert.ok(offset.east < -125 && offset.east > -133, `east ${offset.east}`);
  assert.ok(offset.north > 8 && offset.north < 14, `north ${offset.north}`);
});

test('the Epsilon Indi B preset points at the brown dwarfs, not the bright primary', () => {
  const primary = { raDeg: 330.8413, decDeg: -56.7859 }; // the former preset: eps Ind A
  const offset = arcsec(primary, presets.epsilon);
  assert.ok(Math.hypot(offset.east, offset.north) > 380, 'B is 6.7′ from A');
  const drift = arcsec(presets.epsilon, exposureCenter(preset('epsilon'), at('2026-01-01T00:00:00Z')));
  assert.ok(drift.east > 100 && drift.north < -60, `the pair moves ~4.7″/yr to the south-east (${drift.east}, ${drift.north})`);
});

test('a fixed-sky view holds one position, so the star moves across the frames', () => {
  const tracked = viewerTarget(preset('barnard'), true);
  assert.equal(tracked.targetId, 'barnard');
  const fixed = viewerTarget(preset('barnard'), false);
  assert.equal(fixed.targetId, undefined);
  assert.equal(fixed.fixedSkyFor, 'barnard');
  assert.equal(presetMotion(fixed), null);
  assert.deepEqual(exposureCenter(fixed, at('2025-08-25T00:00:00Z')), fixed);
  const expected = motionPosition(presetMotion(preset('barnard')), FIXED_SKY_MJD);
  assert.equal(fixed.raDeg, expected.raDeg);
  assert.equal(fixed.decDeg, expected.decDeg);
  // Targets without known motion are unaffected by the setting.
  const aurigae = preset('aurigae');
  assert.equal(viewerTarget(aurigae, false), aurigae);
  assert.equal(viewerTarget(preset('aurigae'), false).targetId, 'aurigae');
});

test('archive searches keep the tracked preset id so footprints follow the star', () => {
  const search = validateSearch(new URLSearchParams({ raDeg: presets.wise.raDeg, decDeg: presets.wise.decDeg, targetId: 'wise' }));
  assert.equal(search.targetId, 'wise');
  const untracked = validateSearch(new URLSearchParams({ raDeg: presets.aurigae.raDeg, decDeg: presets.aurigae.decDeg, targetId: 'aurigae' }));
  assert.equal(untracked.targetId, undefined);
});
