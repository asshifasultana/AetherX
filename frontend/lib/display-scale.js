// Display scaling: which data values map to black and white, how values in
// between are stretched, and optional smoothing. Display only — none of this
// changes the measured pixel values used for inspection, stacks or exports.
import { fitPsfCore } from './core-fill.js';

// A masked hole is treated as a star core when its brightest rim pixel is this
// many robust σ above the sky.
const STAR_RIM_SIGMA = 10;

function finiteSorted(values) {
  let count = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) count++;
  const sorted = new Float64Array(count);
  let at = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) sorted[at++] = values[i];
  return sorted.sort();
}

const quantile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];

// Black point in robust sigma below the sky median (PixInsight/Siril STF uses −2.8σ).
export const NOISE_SHADOWS_SIGMA = 2.8;
// Lupton et al. (2004) asinh softening β in robust sigma: values within a few σ
// of the sky stay on the linear part of the curve, brighter ones go logarithmic.
export const ASINH_SOFTENING_SIGMA = 3;

/** Median and MAD-based robust sigma (1.4826 × MAD) of a sorted sample. */
export function robustStats(sorted) {
  if (!sorted.length) return { median: 0, sigma: 0 };
  const n = sorted.length, median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const deviations = new Float64Array(n);
  for (let i = 0; i < n; i++) deviations[i] = Math.abs(sorted[i] - median);
  deviations.sort();
  const mad = n % 2 ? deviations[(n - 1) / 2] : (deviations[n / 2 - 1] + deviations[n / 2]) / 2;
  return { median, sigma: 1.4826 * mad };
}

/**
 * IRAF/DS9 ZScale: fit a line to the sorted sample with iterative k-sigma
 * rejection and spread the limits around the median by slope / contrast.
 * It ignores bright stars and shows faint structure near the sky level.
 */
export function zscale(values, { samples = 1000, contrast = 0.25, rejection = 2.5, iterations = 5 } = {}) {
  const all = finiteSorted(values);
  if (!all.length) return { low: 0, high: 0 };
  const stride = Math.max(1, Math.floor(all.length / samples));
  const sample = [];
  for (let i = 0; i < all.length; i += stride) sample.push(all[i]);
  const n = sample.length, minimum = sample[0], maximum = sample[n - 1];
  const center = (n - 1) / 2, median = n % 2 ? sample[(n - 1) / 2] : (sample[n / 2 - 1] + sample[n / 2]) / 2;
  if (n < 5) return { low: minimum, high: maximum };
  let keep = new Array(n).fill(true), slope = 0, intercept = median;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, count = 0;
    for (let i = 0; i < n; i++) if (keep[i]) { const x = i - center; sx += x; sy += sample[i]; sxx += x * x; sxy += x * sample[i]; count++; }
    const denominator = count * sxx - sx * sx;
    if (count < Math.max(5, n * 0.5) || !denominator) break;
    slope = (count * sxy - sx * sy) / denominator;
    intercept = (sy - slope * sx) / count;
    let squares = 0;
    for (let i = 0; i < n; i++) if (keep[i]) squares += (sample[i] - (intercept + slope * (i - center))) ** 2;
    const sigma = Math.sqrt(squares / count);
    let changed = false;
    const next = keep.map((kept, i) => {
      const inside = Math.abs(sample[i] - (intercept + slope * (i - center))) <= rejection * sigma;
      if (kept !== inside) changed = true;
      return inside;
    });
    if (!changed) break;
    keep = next;
  }
  const spread = slope / contrast;
  const low = Math.max(minimum, median - center * spread);
  const high = Math.min(maximum, median + (n - 1 - center) * spread);
  return high > low ? { low, high } : { low: minimum, high: maximum };
}

/** Black and white points for one of the supported scale modes. */
export function scaleLimits(values, mode = 'p99.5', manual = {}) {
  if (mode === 'manual' && Number.isFinite(manual.low) && Number.isFinite(manual.high) && manual.high > manual.low) {
    return { low: manual.low, high: manual.high };
  }
  if (mode === 'zscale') return zscale(values);
  const sorted = finiteSorted(values);
  if (!sorted.length) return { low: 0, high: 0 };
  if (mode === 'minmax') return { low: sorted[0], high: sorted[sorted.length - 1] };
  if (mode === 'noise') {
    // Noise-referenced limits: black just below the sky, white at the brightest
    // few pixels. Nothing in between is clipped; the asinh curve compresses it.
    const { median, sigma } = robustStats(sorted);
    const high = quantile(sorted, 0.9995);
    if (!(sigma > 0)) return { low: sorted[0], high: sorted[sorted.length - 1] };
    const low = Math.max(sorted[0], median - NOISE_SHADOWS_SIGMA * sigma);
    return high > low ? { low, high, sigma } : { low: sorted[0], high: sorted[sorted.length - 1], sigma };
  }
  if (mode === 'p98') return { low: quantile(sorted, 0.05), high: quantile(sorted, 0.98) };
  return { low: quantile(sorted, 0.02), high: quantile(sorted, 0.995) };
}

/**
 * Non-linear stretch of a 0–1 fraction. `asinhGain` is the scale range in units
 * of the asinh softening β; 10 is the fixed legacy curve.
 */
export function stretchFraction(t, stretch, asinhGain = 10) {
  if (stretch === 'asinh') return Math.asinh(t * asinhGain) / Math.asinh(asinhGain);
  if (stretch === 'sqrt') return Math.sqrt(Math.max(0, t));
  if (stretch === 'log') return Math.log1p(Math.max(0, t) * 100) / Math.log(101);
  return t;
}

/**
 * Build a function mapping a data value to a 0–255 colour level.
 * Histogram equalisation needs the value distribution, so it takes `values`.
 */
export function toneMapper({ low, high, sigma = null, stretch = 'asinh', contrast = 50, brightness = 50, invert = false }, values = null) {
  const range = high - low || 1, gain = contrast / 50, bias = (brightness - 50) / 100;
  // With a measured noise level the asinh knee sits a few σ above the black
  // point (Lupton et al. 2004); without one, keep the fixed legacy curve.
  const asinhGain = sigma > 0 ? Math.max(1e-3, range / (ASINH_SOFTENING_SIGMA * sigma)) : 10;
  let equalise = null;
  if (stretch === 'histeq' && values) {
    const sorted = finiteSorted(values);
    equalise = value => {
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
      return sorted.length ? lo / sorted.length : 0;
    };
  }
  return value => {
    let t = equalise ? equalise(value) : stretchFraction(Math.max(0, Math.min(1, (value - low) / range)), stretch, asinhGain);
    t = (t - 0.5) * gain + 0.5 + bias;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (invert) t = 1 - t;
    return Math.round(t * 255);
  };
}

/**
 * Symmetric mapping for difference images in units of the noise: zero → the
 * middle of the diverging map, ±range σ → its ends, with an asinh soft knee.
 */
export function differenceMapper(sigma, rangeSigma) {
  const scale = sigma > 0 ? sigma : 1, knee = Math.asinh(rangeSigma);
  return value => {
    const t = 0.5 + 0.5 * Math.sign(value) * Math.min(1, Math.asinh(Math.abs(value) / scale) / knee);
    return Math.round(t * 255);
  };
}

/**
 * Display-only fill of small masked holes, such as saturated star cores whose
 * pixels carry BLOOM/HALO/PERSIST flags. Each hole is filled from its rim inward
 * with the mean of the valid 8-neighbours, layer by layer, as in the PixelClip
 * core fill used for the JWST Early Release Observations. Holes that touch the
 * grid edge, include uncovered pixels or exceed `maxHole` pixels stay empty, so
 * missing detector data and the field edge still read as "no data".
 * With `psf` (grid PSF from gridPsf), a hole whose rim is a star (> sky + 10σ)
 * is first rebuilt from the PSF fitted to the star's wings; the rim fill is the
 * fallback when there is no PSF or the fit is rejected.
 * Returns the input unchanged when nothing is filled.
 */
export function fillMaskedHoles(values, width, { covered = null, maxHole = Math.max(25, Math.round(values.length * 0.01)), psf = null } = {}) {
  const height = values.length / width, seen = new Uint8Array(values.length);
  let output = null, stats = null;
  const starThreshold = () => {
    stats ||= robustStats(finiteSorted(values));
    return stats.median + STAR_RIM_SIGMA * stats.sigma;
  };
  const component = [], stack = [];
  for (let start = 0; start < values.length; start++) {
    if (seen[start] || Number.isFinite(values[start])) continue;
    component.length = 0; stack.push(start); seen[start] = 1;
    let fillable = true;
    while (stack.length) {
      const at = stack.pop(), x = at % width, y = (at - x) / width;
      component.push(at);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || (covered && !covered[at])) fillable = false;
      const neighbours = [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, y > 0 ? at - width : -1, y < height - 1 ? at + width : -1];
      for (const next of neighbours) if (next >= 0 && !seen[next] && !Number.isFinite(values[next])) { seen[next] = 1; stack.push(next); }
    }
    if (!fillable || component.length > maxHole) continue;
    output ||= Float32Array.from(values);
    if (psf) {
      let rimMax = -Infinity;
      for (const at of component) {
        const x = at % width, y = (at - x) / width;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx, py = y + dy;
          if (px >= 0 && py >= 0 && px < width && py < height && Number.isFinite(values[py * width + px])) rimMax = Math.max(rimMax, values[py * width + px]);
        }
      }
      const fit = rimMax > starThreshold() ? fitPsfCore(values, width, component, psf, { rimMax }) : null;
      if (fit) { component.forEach((at, k) => { output[at] = fit.values[k]; }); continue; }
    }
    let remaining = component.slice();
    while (remaining.length) {
      const layer = [];
      for (const at of remaining) {
        const x = at % width, y = (at - x) / width;
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const px = x + dx, py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const value = output[py * width + px];
          if (Number.isFinite(value)) { sum += value; count++; }
        }
        if (count) layer.push([at, sum / count]);
      }
      if (!layer.length) break;
      // Commit a whole ring at once so the fill has no directional bias.
      for (const [at, value] of layer) output[at] = value;
      remaining = remaining.filter(at => !Number.isFinite(output[at]));
    }
  }
  return output || values;
}

/** NaN-aware separable Gaussian blur of a square grid. */
export function gaussianSmooth(values, width, sigma) {
  if (!(sigma > 0)) return values;
  const radius = Math.ceil(sigma * 3), kernel = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const height = values.length / width;
  const pass = (input, horizontal) => {
    const output = new Float32Array(input.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!Number.isFinite(values[at])) { output[at] = NaN; continue; }
      let sum = 0, weight = 0;
      for (let k = -radius; k <= radius; k++) {
        const px = horizontal ? x + k : x, py = horizontal ? y : y + k;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const value = input[py * width + px];
        if (Number.isFinite(value)) { sum += value * kernel[k + radius]; weight += kernel[k + radius]; }
      }
      output[at] = weight ? sum / weight : NaN;
    }
    return output;
  };
  return pass(pass(values, true), false);
}

/** Short human-readable number for colour-bar labels and readouts. */
export function formatValue(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e5)) return value.toExponential(2);
  return Number(value.toPrecision(3)).toString();
}

/**
 * Remove large-scale structure (sky offsets, gradients, scattered light) by
 * subtracting a bilinearly interpolated grid of block medians. Point sources
 * and real compact changes, much smaller than a block, survive.
 */
// Least-squares plane z = a + b·x + c·y with three rounds of 3σ clipping.
function clippedPlane(values, width) {
  let keep = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) keep.push(i);
  let a = 0, b = 0, c = 0;
  for (let round = 0; round < 4 && keep.length >= 3; round++) {
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (const i of keep) { sx += i % width; sy += Math.floor(i / width); sz += values[i]; n++; }
    const mx = sx / n, my = sy / n, mz = sz / n;
    let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
    for (const i of keep) {
      const x = i % width - mx, y = Math.floor(i / width) - my, z = values[i] - mz;
      xx += x * x; xy += x * y; yy += y * y; xz += x * z; yz += y * z;
    }
    const det = xx * yy - xy * xy;
    b = det > 0 ? (yy * xz - xy * yz) / det : 0; c = det > 0 ? (xx * yz - xy * xz) / det : 0; a = mz - b * mx - c * my;
    // Re-centre on the median residual so bright sources cannot pull the plane up.
    const res = Float64Array.from(keep, i => values[i] - a - b * (i % width) - c * Math.floor(i / width)).sort();
    const { median, sigma } = robustStats(res);
    a += median;
    if (round === 3 || !(sigma > 0)) break;
    keep = keep.filter(i => Math.abs(values[i] - a - b * (i % width) - c * Math.floor(i / width)) <= 3 * sigma);
  }
  return (x, y) => a + b * x + c * y;
}

export function subtractLargeScale(values, width, block = 16) {
  const height = values.length / width, nx = Math.ceil(width / block), ny = Math.ceil(height / block);
  // Compact and extended sources (a bright star and its halo) must not set the
  // local background, or each block they dominate is over-subtracted and a
  // square negative "moat" appears around the star. Exclude pixels far from the
  // global sky, grown by two pixels to catch their wings, before the block
  // medians (SExtractor-style source masking). "Far" is measured from a clipped
  // plane, so a genuine sky gradient is not mistaken for a source.
  const plane = clippedPlane(values, width);
  const residual = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) residual[i] = values[i] - plane(i % width, Math.floor(i / width));
  const { sigma } = robustStats(finiteSorted(residual));
  const source = new Uint8Array(values.length);
  if (sigma > 0) {
    const limit = 3 * sigma;
    for (let i = 0; i < values.length; i++) {
      if (!(Math.abs(residual[i]) > limit)) continue;
      const x0 = i % width, y0 = (i - x0) / width;
      for (let y = Math.max(0, y0 - 2); y <= Math.min(height - 1, y0 + 2); y++)
        for (let x = Math.max(0, x0 - 2); x <= Math.min(width - 1, x0 + 2); x++) source[y * width + x] = 1;
    }
  }
  const cells = new Float64Array(nx * ny).fill(NaN), scratch = [];
  for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
    scratch.length = 0;
    for (let y = by * block; y < Math.min(height, (by + 1) * block); y++) for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x++) {
      const value = values[y * width + x];
      if (Number.isFinite(value) && !source[y * width + x]) scratch.push(value);
    }
    if (scratch.length >= Math.max(4, block * block / 4)) {
      scratch.sort((a, b) => a - b);
      cells[by * nx + bx] = scratch[scratch.length >> 1];
    }
  }
  const finite = Array.from(cells).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return values;
  // Blocks covered by a source take the mean of their measured neighbours,
  // growing inward ring by ring, instead of one global value.
  for (let pass = 0; pass < nx + ny && cells.some(value => !Number.isFinite(value)); pass++) {
    const next = Float64Array.from(cells);
    for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
      if (Number.isFinite(cells[by * nx + bx])) continue;
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cx = bx + dx, cy = by + dy;
        if ((dx || dy) && cx >= 0 && cy >= 0 && cx < nx && cy < ny && Number.isFinite(cells[cy * nx + cx])) { sum += cells[cy * nx + cx]; count++; }
      }
      if (count) next[by * nx + bx] = sum / count;
    }
    cells.set(next);
  }
  const fallback = finite[finite.length >> 1];
  for (let i = 0; i < cells.length; i++) if (!Number.isFinite(cells[i])) cells[i] = fallback;
  const output = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    const gy = Math.max(0, Math.min(ny - 1, (y + 0.5) / block - 0.5)), y0 = Math.floor(gy), y1 = Math.min(ny - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!Number.isFinite(values[at])) { output[at] = NaN; continue; }
      const gx = Math.max(0, Math.min(nx - 1, (x + 0.5) / block - 0.5)), x0 = Math.floor(gx), x1 = Math.min(nx - 1, x0 + 1), fx = gx - x0;
      const level = (cells[y0 * nx + x0] * (1 - fx) + cells[y0 * nx + x1] * fx) * (1 - fy) + (cells[y1 * nx + x0] * (1 - fx) + cells[y1 * nx + x1] * fx) * fy;
      output[at] = values[at] - level;
    }
  }
  return output;
}
