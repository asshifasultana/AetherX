// The arrow drawn along a spot's track (lib/spots.js): where a star marked on
// one frame had moved to on another. Pure and DOM-free; the viewer draws the
// shapes as SVG on screen and on the canvas for the AI guide's snapshot.

const DAY_MS = 86_400_000;
const D = Math.PI / 180;

/** How far and over how long a track moved, from its oldest to its newest point. */
export function describeTrack(track) {
  if (!Array.isArray(track) || track.length < 2) return null;
  const first = track[0], last = track.at(-1);
  const dec = (first.decDeg + last.decDeg) / 2 * D;
  const east = ((((last.raDeg - first.raDeg) + 540) % 360) - 180) * Math.cos(dec) * 3600;
  const north = (last.decDeg - first.decDeg) * 3600;
  const arcsec = Math.hypot(east, north);
  const days = first.date && last.date ? Math.round((Date.parse(last.date) - Date.parse(first.date)) / DAY_MS) : null;
  const distance = arcsec < 60 ? `${arcsec < 10 ? arcsec.toFixed(1) : Math.round(arcsec)}″` : `${(arcsec / 60).toFixed(1)}′`;
  const span = days === null ? '' : days < 60 ? `${days} d` : days < 730 ? `${Math.round(days / 30.44)} mo` : `${(days / 365.25).toFixed(1)} yr`;
  return {
    arcsec: Number(arcsec.toFixed(1)), days, from: first.date, to: last.date,
    // Position angle, east of north, the way astronomers give a motion's direction.
    directionDeg: Math.round(((Math.atan2(east, north) / D) + 360) % 360),
    text: span ? `${distance} in ${span}` : distance
  };
}

/**
 * Shapes for the path, in canvas pixels: a hollow circle where the star was
 * first marked, a dot at each later place, and an arrow along every hop up to
 * the spot's ring.
 * @param {object} input
 * @param {Array<{x:number,y:number}>} input.points the track on the canvas, oldest first
 * @param {{x:number,y:number}} input.center the spot's centre on the canvas
 * @param {number} input.ringPx the spot ring's radius on the canvas
 * @param {number} input.unit canvas pixels per CSS pixel, so strokes and heads keep a steady size on screen
 * @returns {null | {dots:Array<{x,y,r,kind:'start'|'step'}>, segments:Array<{line:{x1,y1,x2,y2}, head:Array<{x,y}>|null}>,
 *   label:{x,y,anchor:'start'|'middle'|'end'}, width:number, short:boolean}}
 */
export function trackArrow({ points, center, ringPx, unit = 1 }) {
  if (!Array.isArray(points) || points.length < 2 || !(unit > 0)) return null;
  const dotR = 2.5 * unit, startR = 3.5 * unit, gap = 2 * unit, headLength = 7 * unit, headWidth = 4.5 * unit, width = 1.6 * unit;
  const hops = points.slice(1).map((b, i) => ({ a: points[i], b, length: Math.hypot(b.x - points[i].x, b.y - points[i].y) }));
  if (!(hops.reduce((sum, hop) => sum + hop.length, 0) >= 0.1)) return null;
  const start = points[0], end = points.at(-1), total = Math.hypot(end.x - start.x, end.y - start.y);
  // The overall direction, or the longest hop's when the path comes back on itself.
  const longest = hops.reduce((best, hop) => hop.length > best.length ? hop : best);
  const u = total >= 0.1 ? { x: (end.x - start.x) / total, y: (end.y - start.y) / total }
    : { x: (longest.b.x - longest.a.x) / longest.length, y: (longest.b.y - longest.a.y) / longest.length };
  const head = (tip, d) => {
    const back = { x: tip.x - d.x * headLength, y: tip.y - d.y * headLength };
    return [tip, { x: back.x - d.y * headWidth, y: back.y + d.x * headWidth }, { x: back.x + d.y * headWidth, y: back.y - d.x * headWidth }];
  };
  const fromCenter = p => Math.hypot(p.x - center.x, p.y - center.y);
  const disc = ringPx + gap;
  if (points.every(p => fromCenter(p) <= disc)) {
    // The whole path fits under the ring: a pointer beside it, parallel to the
    // motion, on the lower or right side (the spot's number sits above).
    let n = { x: -u.y, y: u.x };
    if (n.y < 0 || (n.y === 0 && n.x < 0)) n = { x: -n.x, y: -n.y };
    const offset = ringPx + 7 * unit, half = 9 * unit;
    const mid = { x: center.x + n.x * offset, y: center.y + n.y * offset };
    const tail = { x: mid.x - u.x * half, y: mid.y - u.y * half }, tip = { x: mid.x + u.x * half, y: mid.y + u.y * half };
    const neck = { x: tip.x - u.x * headLength * 0.8, y: tip.y - u.y * headLength * 0.8 };
    const labelAt = { x: center.x + n.x * (offset + 8 * unit), y: center.y + n.y * (offset + 8 * unit) };
    return {
      dots: [], segments: [{ line: { x1: tail.x, y1: tail.y, x2: neck.x, y2: neck.y }, head: head(tip, u) }],
      label: { ...labelAt, anchor: n.x > 0.35 ? 'start' : n.x < -0.35 ? 'end' : 'middle' }, width, short: true
    };
  }
  // Places under the ring are not drawn, so they do not cover the star.
  const radius = i => i === 0 ? startR : dotR;
  const shown = i => fromCenter(points[i]) > ringPx + radius(i);
  const dots = points.map((p, i) => ({ x: p.x, y: p.y, r: radius(i), kind: i === 0 ? 'start' : 'step' })).filter((_, i) => shown(i));
  const segments = [];
  hops.forEach(({ a, b, length }, i) => {
    if (length < 0.1) return;
    const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    // The part of the hop outside the ring: solve |a + t(b-a) - c| = disc.
    const fx = a.x - center.x, fy = a.y - center.y, B = fx * d.x + fy * d.y, C = fx * fx + fy * fy - disc * disc;
    const root = B * B - C;
    let pieces = [[0, length]];
    if (root > 0) {
      const t1 = -B - Math.sqrt(root), t2 = -B + Math.sqrt(root);
      pieces = [[0, Math.min(length, t1)], [Math.max(0, t2), length]].filter(([from, to]) => to - from > 0);
    }
    pieces.forEach(([from, to], k) => {
      if (from === 0 && shown(i)) from += radius(i) + gap / 2;
      if (to === length && shown(i + 1)) to -= radius(i + 1) + gap / 2;
      if (to - from < 0.5 * unit) return;
      const tip = { x: a.x + d.x * to, y: a.y + d.y * to }, tail = { x: a.x + d.x * from, y: a.y + d.y * from };
      const withHead = k === pieces.length - 1 && to - from >= headLength + 2 * unit;
      const neck = withHead ? { x: tip.x - d.x * headLength * 0.8, y: tip.y - d.y * headLength * 0.8 } : tip;
      segments.push({ line: { x1: tail.x, y1: tail.y, x2: neck.x, y2: neck.y }, head: withHead ? head(tip, d) : null });
    });
  });
  // The total, beside the middle of the path on the upper side.
  let n = { x: -u.y, y: u.x };
  if (n.y > 0 || (n.y === 0 && n.x < 0)) n = { x: -n.x, y: -n.y };
  const mid = { x: (start.x + end.x) / 2 + n.x * 9 * unit, y: (start.y + end.y) / 2 + n.y * 9 * unit };
  return { dots, segments, label: { ...mid, anchor: n.x > 0.35 ? 'start' : n.x < -0.35 ? 'end' : 'middle' }, width, short: false };
}

/**
 * The part of a track up to a frame's day (ISO YYYY-MM-DD): where the star had
 * been by then, never where it goes later. Undated points count as earliest.
 * No day (a deep stack, or no frame on screen) keeps the whole track.
 */
export function trackUpTo(track, day) {
  if (!Array.isArray(track)) return [];
  return day ? track.filter(point => !point.date || point.date <= day) : track.slice();
}
