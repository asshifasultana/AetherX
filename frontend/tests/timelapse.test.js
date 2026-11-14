import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrames, frameDelayMs, frameFractions, frameGaps, formatGap, formatGapShort,
  frameTime, nearestFrameIndex, nearestFrameIndexByTime, nextSpeed, observationKey
} from '../timelapse-core.js';

const observation = (id, detector, observedStartUtc, extra = {}) => ({
  observationId: id,
  productId: `${id}-product`,
  detector,
  observedStartUtc,
  accessUrl: `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/${id}.fits`,
  wavelengthMinUm: 1.1,
  wavelengthMaxUm: 1.62,
  ...extra
});

test('frames are sorted by real date and filtered to the selected detector', () => {
  const observations = [
    observation('late', 2, '2026-01-03T10:00:00Z'),
    observation('other-band', 1, '2026-01-02T10:00:00Z'),
    observation('early-b', 2, '2026-01-01T18:00:00Z'),
    observation('early-a', 2, '2026-01-01T02:00:00Z'),
    observation('undated', 2, 'not a date')
  ];
  const frames = buildFrames(observations, { band: 2, combineExposures: false });
  assert.deepEqual(frames.map(frame => frame.observationId), ['early-a', 'early-b', 'late']);
  assert.equal(frameTime(frames[0]), Date.parse('2026-01-01T02:00:00Z'));
});

test('same-day exposures collapse to one frame and report how many were combined', () => {
  const frames = buildFrames([
    observation('late', 2, '2026-01-03T10:00:00Z'),
    observation('early-b', 2, '2026-01-01T18:00:00Z'),
    observation('early-a', 2, '2026-01-01T02:00:00Z')
  ], { band: 2, combineExposures: true });
  assert.deepEqual(frames.map(frame => frame.observationId), ['early-a', 'late']);
  assert.equal(frames[0].exposureCount, 2);
  assert.equal(frames[0].frameTime, Date.parse('2026-01-01T02:00:00Z'));
  assert.equal(frames[1].exposureCount, 1);
});

test('timeline ticks are time-proportional, so uneven gaps stay uneven', () => {
  const frames = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-11T00:00:00Z']
    .map((date, index) => ({ frameTime: Date.parse(date), observationId: String(index) }));
  assert.deepEqual(frameFractions(frames), [0, 0.1, 1]);
  assert.deepEqual(frameGaps(frames).map(gap => gap.days), [1, 9]);
  assert.equal(nearestFrameIndex(frames, 0.04), 0);
  assert.equal(nearestFrameIndex(frames, 0.06), 1);
  assert.equal(nearestFrameIndex(frames, 0.4), 1);
  assert.equal(nearestFrameIndex(frames, 0.6), 2);
  assert.equal(nearestFrameIndexByTime(frames, Date.parse('2026-01-02T06:00:00Z')), 1);
});

test('single-frame timelines keep a stable axis instead of dividing by zero', () => {
  const frames = [{ frameTime: Date.parse('2026-01-01T00:00:00Z'), observationId: 'only' }];
  assert.deepEqual(frameFractions(frames), [0]);
  assert.deepEqual(frameGaps(frames), []);
  assert.equal(nearestFrameIndex(frames, 0.8), 0);
  assert.deepEqual(frameFractions([]), []);
});

test('gaps are described in days, hours and minutes for the timeline badges', () => {
  assert.equal(formatGap(12), '12 days');
  assert.equal(formatGap(1), '1 day');
  assert.equal(formatGap(1.5), '1.5 days');
  assert.equal(formatGap(1 / 24), '1 hour');
  assert.equal(formatGap(3 / 24), '3 hours');
  assert.equal(formatGap(30 / 1440), '30 minutes');
  assert.equal(formatGapShort(12.4), '12d');
  assert.equal(formatGapShort(6 / 24), '6h');
  assert.equal(formatGapShort(30 / 1440), '30m');
});

test('speed control cycles through each supported playback rate', () => {
  assert.equal(nextSpeed(0.5), 1);
  assert.equal(nextSpeed(1), 2);
  assert.equal(nextSpeed(2), 4);
  assert.equal(nextSpeed(4), 0.5);
  assert.equal(frameDelayMs(0.5), 1800);
  assert.equal(frameDelayMs(1), 900);
  assert.equal(frameDelayMs(2), 450);
  assert.equal(frameDelayMs(4), 225);
});

test('observation identity prefers the product URL so thumbnails survive re-renders', () => {
  const item = observation('abc', 2, '2026-01-01T00:00:00Z');
  assert.equal(observationKey(item), item.accessUrl);
  assert.equal(observationKey({ observationId: 'abc', detector: 2, observedStartUtc: '2026-01-01T00:00:00Z' }), 'abc|2|2026-01-01T00:00:00Z');
});
