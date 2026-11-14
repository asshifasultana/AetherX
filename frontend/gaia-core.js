import { vector, fromVector } from './sky-context-core.js';
const D = Math.PI / 180, MAS = D / 3600000;
export const GAIA_MIN_EPOCH = 2025;
export const GAIA_MAX_EPOCH = 2035;
// 20 arcsec/year exceeds the largest known stellar proper motion. Covers the
// interval 2025–2035 from Gaia DR3's 2016 reference epoch, including field corners.
export const GAIA_MOTION_MARGIN_DEG = 20 * (GAIA_MAX_EPOCH - 2016) / 3600;
export const fieldRadiusDeg = fovArcmin => Math.sqrt(2) * fovArcmin / 120;
export function julianEpoch(utc) {
  const ms = typeof utc === 'number' ? utc : Date.parse(utc);
  return Number.isFinite(ms) ? 2000 + (ms - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000) : null;
}
export function propagateGaia(source, epoch) {
  const propagated = Number.isFinite(epoch) && Number.isFinite(source.refEpoch) && Number.isFinite(source.pmra) && Number.isFinite(source.pmdec);
  if (!propagated) return { raDeg: source.raDeg, decDeg: source.decDeg, propagated: false, epoch: source.refEpoch };
  const a = source.raDeg * D, d = source.decDeg * D;
  const east = [-Math.sin(a), Math.cos(a), 0], north = [-Math.cos(a)*Math.sin(d), -Math.sin(a)*Math.sin(d), Math.cos(d)];
  const v = vector(source), dt = (epoch - source.refEpoch) * MAS;
  return { ...fromVector(v.map((x,i) => x + dt * (source.pmra * east[i] + source.pmdec * north[i]))), propagated: true, epoch };
}
export function markerSuspension({ mode, entryMode, grid }) {
  if (entryMode === 'moving') return 'Gaia markers are unavailable in the moving-target viewer.';
  if (['deep-stack', 'difference', 'motion-trail'].includes(mode)) return 'Gaia markers are suspended for this comparison or multi-date stack.';
  if (!grid) return 'Gaia markers will appear when an image is displayed.';
  if (!Number.isFinite(grid.epoch) || grid.epoch < GAIA_MIN_EPOCH || grid.epoch > GAIA_MAX_EPOCH) return 'Gaia marker epochs are supported from 2025 through 2035.';
  return '';
}
// Latest-result controller: cancellation also invalidates transports that ignore AbortSignal.
export function createCatalogLoader(fetchImpl = fetch) {
  let generation = 0, controller;
  return {
    cancel() { generation++; controller?.abort(); },
    async load(url) {
      const mine = ++generation; controller?.abort(); controller = new AbortController();
      try {
        const response = await fetchImpl(url, { signal: controller.signal });
        const data = await response.json();
        if (mine !== generation) return null;
        if (!response.ok) throw new Error(data.error || 'Gaia lookup failed.');
        return data;
      } catch (error) { if (mine !== generation) return null; throw error; }
    }
  };
}
