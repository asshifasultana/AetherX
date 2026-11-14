// Numbered spots marked on the sky: absolute positions shared by the viewer
// (which draws them), the share link and the AI guide. Pure, DOM-free.
//
// A spot is either a point (radiusArcsec null, drawn as a small fixed ring) or
// an area: a circle of radiusArcsec on the sky, drawn to scale.

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

export function createSpotList(max = MAX_SPOTS) {
  let items = [];
  const valid = sky => Number.isFinite(sky?.raDeg) && Number.isFinite(sky?.decDeg) && sky.decDeg >= -90 && sky.decDeg <= 90;
  return {
    /** Add a spot with the lowest free number; null when full or invalid. */
    add(sky, { origin = 'user', label = '', radiusArcsec = sky?.radiusArcsec } = {}) {
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
      items = [...items, spot].sort((a, b) => a.n - b.n);
      return { ...spot };
    },
    /** Change a spot's area radius (null makes it a point); the updated spot or null. */
    resize(n, radiusArcsec) {
      const spot = items.find(entry => entry.n === Number(n));
      if (!spot) return null;
      // A new size is a new case, so an earlier identification no longer holds.
      items = items.map(entry => entry === spot ? { ...entry, radiusArcsec: spotRadius(radiusArcsec), found: false } : entry);
      return { ...items.find(entry => entry.n === Number(n)) };
    },
    /** Move a spot to a new sky position, keeping its number and size; the moved spot or null. */
    move(n, sky) {
      const spot = items.find(entry => entry.n === Number(n));
      if (!spot || !valid(sky)) return null;
      const moved = { ...spot, raDeg: ((Number(sky.raDeg) % 360) + 360) % 360, decDeg: Number(sky.decDeg), found: false };
      items = items.map(entry => entry === spot ? moved : entry);
      return { ...moved };
    },
    /** Mark whether a spot was identified as a known object; the updated spot or null. */
    setFound(n, found) {
      const spot = items.find(entry => entry.n === Number(n));
      if (!spot) return null;
      const updated = { ...spot, found: Boolean(found) };
      items = items.map(entry => entry === spot ? updated : entry);
      return { ...updated };
    },
    remove(n) { items = items.filter(spot => spot.n !== Number(n)); },
    /** Remove every spot, or only spots of one origin. */
    clear(origin = null) { items = origin ? items.filter(spot => spot.origin !== origin) : []; },
    get(n) { const spot = items.find(entry => entry.n === Number(n)); return spot ? { ...spot } : null; },
    list() { return items.map(spot => ({ ...spot })); }
  };
}
