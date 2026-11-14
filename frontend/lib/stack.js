function median(values) {
  if (!values.length) return Number.NaN;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

// Mean after a 3σ (MAD-based) clip around the median. Lower noise than the
// median for well-behaved data while still rejecting one-off outliers.
function clippedMean(values) {
  if (values.length < 3) return values.reduce((sum, value) => sum + value, 0) / values.length;
  const center = median(values);
  const sigma = 1.4826 * median(values.map(value => Math.abs(value - center)));
  if (!(sigma > 0)) return center;
  let sum = 0, count = 0;
  for (const value of values) if (Math.abs(value - center) <= 3 * sigma) { sum += value; count++; }
  return count ? sum / count : center;
}

function maximum(values) {
  let best = -Infinity;
  for (const value of values) if (value > best) best = value;
  return best;
}

const REDUCERS = { median, 'clipped-mean': clippedMean, max: maximum };

// Per-pixel stack. NaN samples represent masked, missing, or uncovered pixels
// and do not dilute the result as zeros would.
export function combineStack(images, { statistic = 'median' } = {}) {
  if (!images.length || !images[0]?.length || images.some(image => image.length !== images[0].length)) {
    throw new TypeError('A stack requires equal-sized projected images.');
  }
  const reduce = REDUCERS[statistic] || median;
  const length = images[0].length, values = new Float32Array(length), counts = new Uint16Array(length), scratch = [];
  let validPixelContributions = 0, coveredPixels = 0;
  for (let pixel = 0; pixel < length; pixel++) {
    scratch.length = 0;
    for (const image of images) if (Number.isFinite(image[pixel])) scratch.push(image[pixel]);
    counts[pixel] = scratch.length;
    if (scratch.length) {
      values[pixel] = reduce(scratch);
      validPixelContributions += scratch.length;
      coveredPixels++;
    } else values[pixel] = Number.NaN;
  }
  return { values, counts, validPixelContributions, coveredPixels, totalPixels: length, statistic: REDUCERS[statistic] ? statistic : 'median' };
}

export function medianStack(images) {
  return combineStack(images, { statistic: 'median' });
}
