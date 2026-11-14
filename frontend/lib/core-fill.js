// PSF-model repair of masked star cores, for display only.
//
// A saturated star loses its core to the BLOOM/HALO/PERSIST masks. Filling the
// hole from its rim leaves a flat plateau at rim brightness. Instead, as in
// StarFinder's saturated-star repair (Diolaiti et al. 2000) and the pjpipe PSF
// step, fit the instrument PSF to the star's unmasked wings — amplitude plus a
// local sky offset, over a small sub-pixel grid of centres — and paint the core
// from the fitted model.

const WING_RADIUS = 4;
const CENTRE_STEP = 0.25, CENTRE_REACH = 0.75;

/**
 * Turn a detector-frame ePSF lookup into the PSF of a star on the display grid.
 * `epsfAt(x, y)` returns the native-pixel PSF for a star at detector (x, y) as a
 * function of detector-pixel offsets; `frame` is the projection's psfFrame. The
 * display grid is a bilinear resampling of the detector, so a grid pixel is the
 * bilinear blend of the four native pixels around its detector position — which
 * spreads a star's light depending on where it falls within a pixel. The result
 * is `(sx, sy) => (du, dv) => value` for a star at grid (sx, sy).
 */
export function gridPsf(epsfAt, frame) {
  if (typeof epsfAt !== 'function' || !frame?.j) return null;
  const [a, b, c, d] = frame.j;
  return (sx, sy) => {
    const u = sx - frame.gx, v = sy - frame.gy;
    const starX = frame.x + a * u + b * v, starY = frame.y + c * u + d * v;
    const psf = epsfAt(starX, starY);
    return (du, dv) => {
      const px = starX + a * du + b * dv, py = starY + c * du + d * dv;
      const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
      return (psf(x0 - starX, y0 - starY) * (1 - fx) + psf(x0 + 1 - starX, y0 - starY) * fx) * (1 - fy)
        + (psf(x0 - starX, y0 + 1 - starY) * (1 - fx) + psf(x0 + 1 - starX, y0 + 1 - starY) * fx) * fy;
    };
  };
}

/**
 * Fit `psfAt` to the valid pixels around a masked hole and return the model
 * values for the hole, or null when the fit is not trustworthy.
 * `hole` is a list of pixel indices; `rimMax` is the brightest valid neighbour.
 */
export function fitPsfCore(values, width, hole, psfAt, { rimMax = -Infinity } = {}) {
  if (!hole.length || typeof psfAt !== 'function') return null;
  const height = values.length / width, inHole = new Set(hole);
  let cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const at of hole) {
    const x = at % width, y = (at - x) / width;
    cx += x; cy += y;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  cx /= hole.length; cy /= hole.length;

  // Wing pixels: valid, within WING_RADIUS of the hole, and where the PSF has
  // signal. Fixed for every trial centre so the χ² values are comparable.
  const reference = psfAt(cx, cy), peak = Math.max(reference(0, 0), 1e-30);
  const wing = [];
  for (let y = Math.max(0, y0 - WING_RADIUS); y <= Math.min(height - 1, y1 + WING_RADIUS); y++) {
    for (let x = Math.max(0, x0 - WING_RADIUS); x <= Math.min(width - 1, x1 + WING_RADIUS); x++) {
      const at = y * width + x;
      if (inHole.has(at) || !Number.isFinite(values[at])) continue;
      let near = false;
      for (const h of hole) { const hx = h % width, hy = (h - hx) / width; if ((hx - x) ** 2 + (hy - y) ** 2 <= WING_RADIUS ** 2) { near = true; break; } }
      if (near && reference(x - cx, y - cy) > 1e-3 * peak) wing.push(at);
    }
  }
  if (wing.length < 8) return null;

  let best = null;
  for (let oy = -CENTRE_REACH; oy <= CENTRE_REACH + 1e-9; oy += CENTRE_STEP) {
    for (let ox = -CENTRE_REACH; ox <= CENTRE_REACH + 1e-9; ox += CENTRE_STEP) {
      const sx = cx + ox, sy = cy + oy, psf = psfAt(sx, sy);
      // Linear least squares for value ≈ A·psf + B (2×2 normal equations).
      let smm = 0, sm = 0, smy = 0, sy1 = 0, n = 0;
      const model = new Float64Array(wing.length);
      for (let k = 0; k < wing.length; k++) {
        const at = wing[k], x = at % width, y = (at - x) / width, m = psf(x - sx, y - sy), v = values[at];
        model[k] = m; smm += m * m; sm += m; smy += m * v; sy1 += v; n++;
      }
      const det = smm * n - sm * sm;
      if (!(Math.abs(det) > 0)) continue;
      const amplitude = (smy * n - sm * sy1) / det, offset = (smm * sy1 - sm * smy) / det;
      if (!(amplitude > 0)) continue;
      let chi2 = 0;
      for (let k = 0; k < wing.length; k++) chi2 += (values[wing[k]] - amplitude * model[k] - offset) ** 2;
      if (!best || chi2 < best.chi2) best = { chi2, amplitude, offset, sx, sy, psf };
    }
  }
  if (!best) return null;

  let wingPeak = -Infinity;
  for (const at of wing) wingPeak = Math.max(wingPeak, values[at]);
  const rms = Math.sqrt(best.chi2 / wing.length);
  if (!(rms < 0.25 * (wingPeak - best.offset))) return null;

  const filled = new Float32Array(hole.length);
  let holeMax = -Infinity;
  hole.forEach((at, k) => {
    const x = at % width, y = (at - x) / width;
    filled[k] = best.amplitude * best.psf(x - best.sx, y - best.sy) + best.offset;
    holeMax = Math.max(holeMax, filled[k]);
  });
  // A masked core must be at least as bright as the star's own rim.
  if (!(holeMax >= rimMax)) return null;
  return { values: filled, amplitude: best.amplitude, offset: best.offset, center: [best.sx, best.sy], rms };
}
