// Snap a position onto the source under it: the flux-weighted centroid of the
// pixels that stand above the local background within a small radius. NaN
// (masked or saturated) pixels are skipped, so a star with a blank saturated
// core still centres from the bright ring around it. Pure and DOM-free.

const median = list => {
  if (!list.length) return NaN;
  const sorted = [...list].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Background level and MAD noise from a ring between inner and outer pixels. */
export function localBackground(values, width, x, y, inner, outer) {
  const height = Math.floor(values.length / width), ring = [];
  const cx = Math.round(x), cy = Math.round(y), reach = Math.ceil(outer);
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
    const r = Math.hypot(dx, dy);
    if (r < inner || r > outer) continue;
    const px = cx + dx, py = cy + dy;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const value = values[py * width + px];
    if (Number.isFinite(value)) ring.push(value);
  }
  const level = median(ring);
  return { level, noise: 1.4826 * median(ring.map(value => Math.abs(value - level))), count: ring.length };
}

function centroid(values, width, x, y, radiusPx, background, threshold) {
  const height = Math.floor(values.length / width);
  const cx = Math.round(x), cy = Math.round(y), reach = Math.ceil(radiusPx) + 1;
  let weight = 0, sx = 0, sy = 0, peak = -Infinity, pixels = 0;
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
    const px = cx + dx, py = cy + dy;
    // Measured from the exact (sub-pixel) centre, so re-centring can move by fractions of a pixel.
    if (Math.hypot(px - x, py - y) > radiusPx + 0.5) continue;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const value = values[py * width + px];
    if (!Number.isFinite(value)) continue;
    const above = value - background;
    if (above > peak) peak = above;
    if (above <= threshold) continue;
    weight += above; sx += px * above; sy += py * above; pixels++;
  }
  return weight > 0 ? { x: sx / weight, y: sy / weight, peak, pixels } : { peak, pixels: 0 };
}

/**
 * @param {ArrayLike<number>} values square-ish grid, row-major
 * @param {number} width grid width
 * @param {number} x,y starting pixel position
 * @param {number} radiusPx search radius in pixels
 * @returns {{x:number, y:number, peakSigma:number, pixels:number} | {noSource:true, peakSigma:number|null}}
 */
export function snapToPeak(values, width, x, y, radiusPx = 2, { minSigma = 4 } = {}) {
  if (!values?.length || !(width > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return { noSource: true, peakSigma: null };
  const radius = Math.max(1, Number(radiusPx) || 2);
  // The sky ring sits well outside the search radius and a saturated core.
  const sky = localBackground(values, width, x, y, radius + 3, radius + 8);
  if (!Number.isFinite(sky.level) || sky.count < 8) return { noSource: true, peakSigma: null };
  const noise = sky.noise > 0 ? sky.noise : Math.max(Math.abs(sky.level) * 1e-6, 1e-12);
  let found = centroid(values, width, x, y, radius, sky.level, 2 * noise);
  const peakSigma = Number.isFinite(found.peak) ? found.peak / noise : null;
  if (!found.pixels || !(peakSigma >= minSigma)) return { noSource: true, peakSigma: peakSigma === null ? null : Number(peakSigma.toFixed(1)) };
  // Re-centre the window on the centroid until it settles (a ring seen
  // off-centre pulls the window onto its middle), staying near the start.
  for (let step = 0; step < 6; step++) {
    const again = centroid(values, width, found.x, found.y, radius, sky.level, 2 * noise);
    if (!again.pixels || Math.hypot(again.x - x, again.y - y) > radius + 0.5) break;
    const moved = Math.hypot(again.x - found.x, again.y - found.y);
    found = again;
    if (moved < 0.02) break;
  }
  return { x: found.x, y: found.y, peakSigma: Number(peakSigma.toFixed(1)), pixels: found.pixels };
}
