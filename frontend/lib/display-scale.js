// Display scaling: which data values map to black and white, how values in
// between are stretched, and optional smoothing. Display only — none of this
// changes the measured pixel values used for inspection, stacks or exports.

function finiteSorted(values) {
  let count = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) count++;
  const sorted = new Float64Array(count);
  let at = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) sorted[at++] = values[i];
  return sorted.sort();
}

const quantile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];

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
  if (mode === 'p98') return { low: quantile(sorted, 0.05), high: quantile(sorted, 0.98) };
  return { low: quantile(sorted, 0.02), high: quantile(sorted, 0.995) };
}

/** Non-linear stretch of a 0–1 fraction. */
export function stretchFraction(t, stretch) {
  if (stretch === 'asinh') return Math.asinh(t * 10) / Math.asinh(10);
  if (stretch === 'sqrt') return Math.sqrt(Math.max(0, t));
  if (stretch === 'log') return Math.log1p(Math.max(0, t) * 100) / Math.log(101);
  return t;
}

/**
 * Build a function mapping a data value to a 0–255 colour level.
 * Histogram equalisation needs the value distribution, so it takes `values`.
 */
export function toneMapper({ low, high, stretch = 'asinh', contrast = 65, brightness = 50, invert = false }, values = null) {
  const range = high - low || 1, gain = contrast / 50, bias = (brightness - 50) / 100;
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
    let t = equalise ? equalise(value) : stretchFraction(Math.max(0, Math.min(1, (value - low) / range)), stretch);
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
export function subtractLargeScale(values, width, block = 16) {
  const height = values.length / width, nx = Math.ceil(width / block), ny = Math.ceil(height / block);
  const cells = new Float64Array(nx * ny).fill(NaN), scratch = [];
  for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
    scratch.length = 0;
    for (let y = by * block; y < Math.min(height, (by + 1) * block); y++) for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x++) {
      const value = values[y * width + x];
      if (Number.isFinite(value)) scratch.push(value);
    }
    if (scratch.length >= Math.max(4, block * block / 4)) {
      scratch.sort((a, b) => a - b);
      cells[by * nx + bx] = scratch[scratch.length >> 1];
    }
  }
  const finite = Array.from(cells).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return values;
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
