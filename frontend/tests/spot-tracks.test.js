import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotList, MAX_TRACK_POINTS } from '../lib/spots.js';
import { trackArrow, describeTrack, trackUpTo } from '../lib/track-arrow.js';

test('a dated move keeps the old and new places on the spot track', () => {
  const list = createSpotList();
  const spot = list.add({ raDeg: 269.45, decDeg: 4.69 }, { label: 'Barnard', date: '2025-03-01' });
  assert.equal(spot.track.length, 1);
  const moved = list.move(spot.n, { raDeg: 269.45, decDeg: 4.6929 }, { date: '2025-09-01' });
  assert.deepEqual(moved.track.map(point => point.date), ['2025-03-01', '2025-09-01']);
  assert.equal(moved.track[1].decDeg, 4.6929);
  // Marking an earlier frame sorts by date, so the arrow still runs forward in time.
  const back = list.move(spot.n, { raDeg: 269.45, decDeg: 4.688 }, { date: '2024-09-01' });
  assert.deepEqual(back.track.map(point => point.date), ['2024-09-01', '2025-03-01', '2025-09-01']);
  // Marking the same date again replaces that date's place.
  assert.equal(list.move(spot.n, { raDeg: 269.45, decDeg: 4.6881 }, { date: '2024-09-01' }).track.length, 3);
});

test('a drag drops the track, an undated spot starts one with an unknown date, and tracks are capped', () => {
  const list = createSpotList();
  const spot = list.add({ raDeg: 10, decDeg: 5 });
  assert.equal('track' in spot, false, 'spots without a track carry no field');
  const moved = list.move(spot.n, { raDeg: 10.001, decDeg: 5 }, { date: '2025-01-01' });
  assert.deepEqual(moved.track.map(point => point.date), [null, '2025-01-01']);
  assert.equal('track' in list.move(spot.n, { raDeg: 10.002, decDeg: 5 }), false);
  const points = Array.from({ length: MAX_TRACK_POINTS + 20 }, (_, i) => ({ raDeg: 10, decDeg: 5 + i / 3600, date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10) }));
  assert.equal(list.setTrack(spot.n, points).track.length, MAX_TRACK_POINTS);
  assert.equal('track' in list.setTrack(spot.n, points.slice(0, 1)), false);
  assert.equal(list.setTrack(42, points), null);
});

test('describeTrack gives distance, span and direction east of north', () => {
  const north = describeTrack([{ raDeg: 10, decDeg: 0, date: '2024-01-01' }, { raDeg: 10, decDeg: 12 / 3600, date: '2025-01-01' }]);
  assert.equal(north.arcsec, 12);
  assert.equal(north.directionDeg, 0);
  assert.equal(north.text, '12″ in 12 mo');
  const east = describeTrack([{ raDeg: 10, decDeg: 0, date: null }, { raDeg: 10 + 3 / 3600, decDeg: 0, date: null }]);
  assert.equal(east.directionDeg, 90);
  assert.equal(east.text, '3.0″');
  assert.equal(describeTrack([{ raDeg: 1, decDeg: 1 }]), null);
});

test('trackArrow draws the first place, each later place and an arrow on every hop up to the ring', () => {
  const center = { x: 100, y: 50 };
  const path = trackArrow({ points: [{ x: 20, y: 50 }, { x: 60, y: 50 }, center], center, ringPx: 10, unit: 1 });
  assert.equal(path.short, false);
  assert.deepEqual(path.dots.map(dot => dot.kind), ['start', 'step'], 'a hollow first place, a dot after it, none under the ring');
  assert.equal(path.segments.length, 2);
  assert.ok(path.segments.every(segment => segment.head), 'every hop long enough for one gets an arrowhead');
  const [first, second] = path.segments;
  assert.ok(first.head[0].x < 60 && first.head[0].x > 55, 'the first arrow stops short of the next dot');
  assert.ok(second.head[0].x < 90 && second.head[0].x > 85, 'the last arrow stops short of the ring');
  // A hop too short for a head is a bare line; one entirely under the ring is skipped.
  const tiny = trackArrow({ points: [{ x: 20, y: 50 }, { x: 30, y: 50 }, { x: 95, y: 50 }, center], center, ringPx: 10, unit: 1 });
  assert.equal(tiny.segments.length, 2);
  assert.equal(tiny.segments[0].head, null);
  assert.ok(tiny.segments[1].head);
});

test('trackArrow points beside the ring when the whole path fits under it', () => {
  const center = { x: 100, y: 50 };
  const short = trackArrow({ points: [{ x: 97, y: 50 }, center], center, ringPx: 10, unit: 1 });
  assert.equal(short.short, true);
  assert.equal(short.dots.length, 0, 'an old place under the ring is not drawn over the star');
  const [pointer] = short.segments;
  assert.ok(pointer.line.y1 > 60 && pointer.head[0].x > pointer.line.x1, 'moving east on the canvas: the pointer sits below the ring, pointing the same way');
  const north = trackArrow({ points: [{ x: 100, y: 53 }, { x: 100, y: 52 }, center], center, ringPx: 10, unit: 1 });
  assert.ok(north.segments[0].line.x1 > 110 && north.segments[0].head[0].y < north.segments[0].line.y1, 'moving up: the pointer sits right of the ring, clear of the number above it');
  assert.equal(north.label.anchor, 'start');
  assert.equal(trackArrow({ points: [center, center], center, ringPx: 10 }), null);
});

test('restart starts the track over at the new place', () => {
  const list = createSpotList();
  const spot = list.add({ raDeg: 10, decDeg: 5 }, { date: '2025-01-01' });
  list.move(spot.n, { raDeg: 10, decDeg: 5.001 }, { date: '2025-02-01' });
  const restarted = list.move(spot.n, { raDeg: 10, decDeg: 5.002 }, { date: '2025-03-01', restart: true });
  assert.deepEqual(restarted.track.map(point => point.date), ['2025-03-01']);
  assert.deepEqual(list.move(spot.n, { raDeg: 10, decDeg: 5.003 }, { date: '2025-04-01' }).track.map(point => point.date), ['2025-03-01', '2025-04-01']);
});

test('trackUpTo keeps only where the star had been by the frame shown', () => {
  const track = [
    { raDeg: 1, decDeg: 1, date: null },
    { raDeg: 1, decDeg: 1.001, date: '2025-08-21' },
    { raDeg: 1, decDeg: 1.002, date: '2026-03-21' },
    { raDeg: 1, decDeg: 1.003, date: '2026-09-22' }
  ];
  assert.deepEqual(trackUpTo(track, '2025-08-21').map(point => point.date), [null, '2025-08-21']);
  assert.deepEqual(trackUpTo(track, '2026-03-21').map(point => point.date), [null, '2025-08-21', '2026-03-21']);
  assert.equal(trackUpTo(track, null).length, 4, 'a deep stack spans every date');
  assert.deepEqual(trackUpTo(undefined, '2026-01-01'), []);
});
