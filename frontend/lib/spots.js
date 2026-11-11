// Numbered spots marked on the sky: absolute positions shared by the viewer
// (which draws them), the share link and the AI guide. Pure, DOM-free.
//
// A spot is either a point (radiusArcsec null, drawn as a small fixed ring) or
// an area: a circle of radiusArcsec on the sky, drawn to scale.
//
// A spot followed across frames carries a track: its positions on earlier
// dates, oldest first, as [{raDeg, decDeg, date}] (date an ISO day or null).
// The viewer draws an arrow along it. Spots without one have no track field.

export const MAX_SPOTS = 9;
export const SPOT_ORIGINS = ['user', 'agent', 'predicted'];
// One SPHEREx pixel (6.15″) up to half the widest field of view (30′).
export const MIN_SPOT_RADIUS_ARCSEC = 6;
export const MAX_SPOT_RADIUS_ARCSEC = 900;

/** A valid area radius in arcseconds (rounded, clamped), or null for a point. */
export function spotRadius(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(Math.max(MIN_SPOT_RADIUS_ARCSEC, Math.min(MAX_SPOT_RADIUS_ARCSEC, number)));
}

export const MAX_TRACK_POINTS = 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const trackPoint = point => ({ raDeg: ((Number(point.raDeg) % 360) + 360) % 360, decDeg: Number(point.decDeg), date: DAY.test(String(point.date || '')) ? String(point.date) : null });
const copy = spot => spot.track ? { ...spot, track: spot.track.map(point => ({ ...point })) } : { ...spot };

export function createSpotList(max = MAX_SPOTS) {
  let items = [];
  const valid = sky => Number.isFinite(sky?.raDeg) && Number.isFinite(sky?.decDeg) && sky.decDeg >= -90 && sky.decDeg <= 90;
  const sortTrack = track => track.slice().sort((a, b) => (a.date === null ? -1 : b.date === null ? 1 : a.date.localeCompare(b.date))).slice(-MAX_TRACK_POINTS);
  return {
    /** Add a spot with the lowest free number; null when full or invalid. */
    add(sky, { origin = 'user', label = '', radiusArcsec = sky?.radiusArcsec, date = null } = {}) {
      if (!valid(sky) || items.length >= max) return null;
      const used = new Set(items.map(spot => spot.n));
      let n = 1;
      while (used.has(n)) n++;
      const spot = {
        n,
        raDeg: ((Number(sky.raDeg) % 360) + 360) % 360,
        decDeg: Number(sky.decDeg),
        radiusArcsec: spotRadius(radiusArcsec),
        origin: SPOT_ORIGINS.includes(origin) ? origin : 'user',
        label: String(label || '').slice(0, 60),
        // True once the AI guide's checks identify it as a known object.
        found: false
      };
      // A dated spot (the frame it was marked on) starts a track a later move extends.
      if (date && DAY.test(String(date))) spot.track = [trackPoint({ ...spot, date })];
      items = [...items, spot].sort((a, b) => a.n - b.n);
      return copy(spot);
    },
    /** Change a spot's area radius (null makes it a point); the updated spot or null. */
    resize(n, radiusArcsec) {
      const spot = items.find(entry => entry.n === Number(n));
      if (!spot) return null;
      // A new size is a new case, so an earlier identification no longer holds.
      items = items.map(entry => entry === spot ? { ...entry, radiusArcsec: spotRadius(radiusArcsec), found: false } : entry);
      return copy(items.find(entry => entry.n === Number(n)));
    },
    /**
     * Move a spot to a new sky position, keeping its number and size; the moved spot or null.
     * With a date (the frame the new position is for) the move is the object's
     * motion, so the old and new positions are kept on its track. Without one it
     * is a correction (a drag), and any track is dropped. With restart, the
     * track starts over at the new position (Track star turned on).
     */
    move(n, sky, { date = null, restart = false } = {}) {
      const spot = items.find(entry => entry.n === Number(n));
      if (!spot || !valid(sky)) return null;
      const { track: oldTrack, ...rest } = spot;
      const moved = { ...rest, raDeg: ((Number(sky.raDeg) % 360) + 360) % 360, decDeg: Number(sky.decDeg), found: false };
      if (date && DAY.test(String(date))) {
        const earlier = restart ? [] : (oldTrack?.length ? oldTrack : [trackPoint({ ...spot, date: null })]).filter(point => point.date !== date);
        moved.track = sortTrack([...earlier, trackPoint({ ...moved, date })]);
      }
      items = items.map(entry => entry === spot ? moved : entry);
      return copy(moved);
    },
    /** Set a spot's track (dated positions, any order); fewer than two points clears it. The spot or null. */
    setTrack(n, points) {
      const spot = items.find(entry => entry.n === Number(n));
      if (!spot) return null;
      const { track: _old, ...rest } = spot;
      const track = (Array.isArray(points) ? points : []).filter(valid).map(trackPoint);
      const updated = track.length >= 2 ? { ...rest, track: sortTrack(track) } : rest;
      items = items.map(entry => entry === spot ? updated : entry);
      return copy(updated);
    },
    /** Mark whether a spot was identified as a known object; the updated spot or null. */
    setFound(n, found) {
      const spot = items.find(entry => entry.n === Number(n));
      if (!spot) return null;
      const updated = { ...spot, found: Boolean(found) };
      items = items.map(entry => entry === spot ? updated : entry);
      return copy(updated);
    },
    remove(n) { items = items.filter(spot => spot.n !== Number(n)); },
    /** Remove every spot, or only spots of one origin. */
    clear(origin = null) { items = origin ? items.filter(spot => spot.origin !== origin) : []; },
    get(n) { const spot = items.find(entry => entry.n === Number(n)); return spot ? copy(spot) : null; },
    list() { return items.map(copy); }
  };
}
