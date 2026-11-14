// Robust per-image sky pedestal estimate for display normalization only.
// Clipping limits contamination from isolated bright sources; it cannot model
// gradients or extended emission from a small target cutout.
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function estimateBackground(values, { sigmaClip = 3, iterations = 4 } = {}) {
  let sample = Array.from(values).filter(Number.isFinite);
  if (!sample.length) return { level: 0, noise: 0, used: 0, total: 0 };
  const total = sample.length;
  for (let iteration = 0; iteration < iterations && sample.length >= 8; iteration++) {
    const level = median(sample);
    const mad = median(sample.map(value => Math.abs(value - level)));
    const sigma = 1.4826 * mad;
    if (!(sigma > 0)) break;
    const clipped = sample.filter(value => Math.abs(value - level) <= sigmaClip * sigma);
    if (clipped.length < 8 || clipped.length === sample.length) break;
    sample = clipped;
  }
  const level = median(sample);
  const noise = 1.4826 * median(sample.map(value => Math.abs(value - level)));
  return { level, noise, used: sample.length, total };
}
