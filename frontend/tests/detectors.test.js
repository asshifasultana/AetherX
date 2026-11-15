import test from 'node:test';
import assert from 'node:assert/strict';
import { DETECTOR_BANDS, CHANNEL_CENTERS, DETECTOR_CHANNELS, DETECTOR_CHANNEL_EDGES, channelOf, detectorFor, detectorLabel } from '../lib/detectors.js';
import { CHANNELS } from '../lib/mystery-spectra.js';

test('102 channel centres, 17 per detector, in wavelength order', () => {
  assert.equal(CHANNEL_CENTERS.length, 102);
  assert.deepEqual(CHANNELS, CHANNEL_CENTERS);
  for (const [index, centres] of DETECTOR_CHANNELS.entries()) {
    assert.equal(centres.length, 17);
    assert.equal(centres[0], DETECTOR_BANDS[index][0]);
    assert.equal(centres.at(-1), DETECTOR_BANDS[index][1]);
  }
  for (let i = 1; i < CHANNEL_CENTERS.length; i++) assert.ok(CHANNEL_CENTERS[i] > CHANNEL_CENTERS[i - 1]);
});

test('channel edges are monotonic, cover each band and bracket every centre', () => {
  for (const [index, edges] of DETECTOR_CHANNEL_EDGES.entries()) {
    assert.equal(edges.length, 18);
    assert.equal(edges[0], DETECTOR_BANDS[index][0]);
    assert.equal(edges.at(-1), DETECTOR_BANDS[index][1]);
    for (let i = 1; i < edges.length; i++) assert.ok(edges[i] > edges[i - 1]);
    DETECTOR_CHANNELS[index].forEach((centre, channel) => assert.equal(channelOf(centre, index + 1), channel));
  }
});

test('channelOf tolerates the band edge, rejects other bands and bad input', () => {
  assert.equal(channelOf(0.74, 1), 0);
  assert.equal(channelOf(5.02, 6), 16);
  assert.equal(channelOf(3.0, 1), -1);
  assert.equal(channelOf(Number.NaN, 2), -1);
  assert.equal(channelOf(1.2, 9), -1);
  assert.equal(detectorFor(3.3), 4);
  assert.equal(detectorFor(1.095), null);
  assert.equal(detectorLabel(4), 'D4 · 2.42–3.82 μm');
});
