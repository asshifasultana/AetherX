// Numbered spots marked on the sky: absolute positions shared by the viewer
// (which draws them), the share link and the AI guide. Pure, DOM-free.

export const MAX_SPOTS = 9;
export const SPOT_ORIGINS = ['user', 'agent', 'predicted'];

export function createSpotList(max = MAX_SPOTS) {
  let items = [];
  const valid = sky => Number.isFinite(sky?.raDeg) && Number.isFinite(sky?.decDeg) && sky.decDeg >= -90 && sky.decDeg <= 90;
  return {
    /** Add a spot with the lowest free number; null when full or invalid. */
    add(sky, { origin = 'user', label = '' } = {}) {
      if (!valid(sky) || items.length >= max) return null;
      const used = new Set(items.map(spot => spot.n));
      let n = 1;
      while (used.has(n)) n++;
      const spot = {
        n,
        raDeg: ((Number(sky.raDeg) % 360) + 360) % 360,
        decDeg: Number(sky.decDeg),
        origin: SPOT_ORIGINS.includes(origin) ? origin : 'user',
        label: String(label || '').slice(0, 60)
      };
      items = [...items, spot].sort((a, b) => a.n - b.n);
      return { ...spot };
    },
    remove(n) { items = items.filter(spot => spot.n !== Number(n)); },
    /** Remove every spot, or only spots of one origin. */
    clear(origin = null) { items = origin ? items.filter(spot => spot.origin !== origin) : []; },
    get(n) { const spot = items.find(entry => entry.n === Number(n)); return spot ? { ...spot } : null; },
    list() { return items.map(spot => ({ ...spot })); }
  };
}
