import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { isTourArrival, readBakedView, BAKED_VIEW_PATH } from '../lib/baked-view.js';
import { cropQuery, decodeCrop } from '../lib/crop-codec.js';
import { presets, viewerTarget, exposureCenter } from '../presets.js';
import { DEFAULT_SETTINGS } from '../viewer-settings.js';
import { buildFrames } from '../timelapse-core.js';

const dataUrl = new URL('../' + BAKED_VIEW_PATH, import.meta.url);
const bundle = JSON.parse(await readFile(dataUrl, 'utf8'));

test('only the tour hand-off to Barnard’s Star counts as a tour arrival', () => {
  assert.equal(isTourArrival('?target=barnard&tour=4'), true);
  for (const search of ['', '?target=barnard', '?tour=4', '?target=wise&tour=4', '?target=barnard&tour=x', '?target=barnard&tour=0']) assert.equal(isTourArrival(search), false, search);
});

test('a malformed saved view is ignored rather than trusted', () => {
  const base = 'https://viewer.test/data/tour/barnard.json';
  const good = { schemaVersion: 1, observationsQuery: 'a=1', response: { observations: [] }, crops: { q: 'crops/0123456789abcdef0123.spxc' } };
  assert.equal(readBakedView(good, base).crops.get('q'), 'https://viewer.test/data/tour/crops/0123456789abcdef0123.spxc');
  for (const bad of [null, { ...good, schemaVersion: 2 }, { ...good, observationsQuery: null }, { ...good, response: {} }, { ...good, crops: null }]) assert.equal(readBakedView(bad, base), null);
  // A crop entry can only ever name a file inside the saved view's own folder.
  assert.equal(readBakedView({ ...good, crops: { q: 'https://elsewhere.test/x.spxc', r: '../../api/crop' } }, base).crops.size, 0);
});

test('the saved view answers the tour’s search and every crop its first screen requests', async () => {
  const position = { raDeg: presets.barnard.raDeg, decDeg: presets.barnard.decDeg, frame: 'icrs', targetId: 'barnard' };
  // observations-ui.js builds the search from these fields, in this order.
  const submitted = new URLSearchParams({ raDeg: position.raDeg, decDeg: position.decDeg, detector: 'all', release: 'all', startDate: '', endDate: '', targetId: 'barnard' });
  const view = readBakedView(bundle, dataUrl);
  assert.equal(view.observationsQuery, submitted.toString());
  assert.equal(view.response.source.kind, 'saved-example');
  assert.equal(view.response.truncated, false);

  // fits-viewer.js asks for each exposure at the fixed-sky centre with these settings.
  const settings = { ...DEFAULT_SETTINGS, includeFlags: true };
  const target = viewerTarget(position, settings.followProperMotion);
  const frames = buildFrames(view.response.observations, { band: settings.band, combineExposures: settings.combineExposures });
  assert.ok(frames.length > 1);
  const files = new Set(await readdir(new URL('crops/', dataUrl)));
  const used = new Set();
  for (const exposure of frames.flatMap(frame => frame.exposures || [frame])) {
    const url = view.crops.get(cropQuery({ accessUrl: exposure.accessUrl, target: exposureCenter(target, exposure), settings, revision: exposure.productModifiedAt || exposure.metadataModifiedAt || '' }));
    assert.ok(url, `no saved crop for ${exposure.observationId}`);
    const name = url.slice(url.lastIndexOf('/') + 1);
    assert.ok(files.has(name), `${name} is listed but not on disk`);
    used.add(name);
  }
  assert.deepEqual([...files].sort(), [...used].sort(), 'no unused crop files are shipped');

  const image = decodeCrop(gunzipSync(await readFile(new URL('crops/' + [...used][0], dataUrl))));
  assert.ok(image.width > 100 && image.height > 100 && image.flags);
  // Rounded pixels (see the bake script) must still be real measurements, and
  // the visitor is told about the rounding wherever the saved list is shown.
  assert.ok(image.values.filter(Number.isFinite).length > image.values.length / 2);
  if (bundle.pixelPrecision !== 'exact') assert.ok(view.response.warnings.some(text => /rounded/.test(text)));
});
