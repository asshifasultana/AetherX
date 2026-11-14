// Shared server-side interpretation of the SPHEREx IMAGE FLAGS bit plane.
// Overflow, nonlinear response, source, and streak indicators are retained for
// visual inspection; they do not automatically erase bright or moving targets.
export const MASKED_FLAG_BITS = Object.freeze([0, 2, 6, 7, 9, 10, 11, 14, 17, 19, 20, 22, 24, 26, 27, 28, 29]);
export const FLAG_CATEGORIES = Object.freeze({
  transient: Object.freeze({ label: 'Transient / outlier', colour: '#f26e85' }),
  detector: Object.freeze({ label: 'Detector defect', colour: '#efaa4f' }),
  correction: Object.freeze({ label: 'Correction / persistence', colour: '#78b7d1' }),
  artifact: Object.freeze({ label: 'Optical / electronic artifact', colour: '#b48ae0' }),
  caution: Object.freeze({ label: 'Caution / informational', colour: '#a9c981' }),
  missing: Object.freeze({ label: 'Missing pixel data', colour: '#f3d365' }),
  uncovered: Object.freeze({ label: 'Outside detector', colour: '#7866a7' })
});
export const QUALITY_FLAGS = Object.freeze([
  [0, 'TRANSIENT', 'Transient signal such as a cosmic-ray hit', 'transient'], [1, 'OVERFLOW', 'Signal near saturation; retained for display', 'caution'],
  [2, 'SUR_ERROR', 'Possible sample-up-the-ramp error', 'transient'], [6, 'NONFUNC', 'Unusable detector pixel', 'detector'],
  [7, 'DICHROIC', 'Low-throughput detector region', 'detector'], [9, 'MISSING_DATA', 'Pixel data is missing', 'missing'],
  [10, 'HOT', 'Noisy or spurious pixel', 'detector'], [11, 'COLD', 'Anomalously low-response pixel', 'detector'],
  [12, 'FULLSAMPLE', 'Full sample history (informational)', 'caution'], [14, 'PHANMISS', 'Phantom-pixel correction unavailable', 'correction'],
  [15, 'NONLINEAR', 'Nonlinear response; retained for display', 'caution'], [17, 'PERSIST', 'Persistence affected pixel', 'correction'],
  [19, 'OUTLIER', 'Statistical outlier', 'transient'], [20, 'CROSSTALK', 'Detector crosstalk', 'artifact'], [21, 'SOURCE', 'Known source (informational)', 'caution'],
  [22, 'GHOST', 'Ghost artifact', 'artifact'], [23, 'GHOST_FPA', 'Focal-plane ghost (not currently reported)', 'artifact'],
  [24, 'GHOST_EXT', 'External ghost artifact', 'artifact'], [25, 'STREAK', 'Streak artifact; retained for moving-source inspection', 'caution'],
  [26, 'BLOOM', 'Saturation bloom', 'artifact'], [27, 'SNOWBALL', 'Snowball artifact', 'artifact'], [28, 'HALO', 'Bright-source halo artifact', 'artifact'],
  [29, 'SATELLITE_HALO', 'Satellite halo artifact', 'artifact']
].map(([bit, name, description, category]) => Object.freeze({ bit, name, description, category })));
const KNOWN_FLAG_MASK = QUALITY_FLAGS.reduce((mask, flag) => mask | (2 ** flag.bit), 0) >>> 0;

export function assessPixelQuality({ covered, value, flags = 0, flagsAvailable = true, maskEnabled = true }) {
  const unknownBits = (flags & ~KNOWN_FLAG_MASK) >>> 0;
  const setFlags = QUALITY_FLAGS.filter(flag => (flags & (2 ** flag.bit)) !== 0);
  if (unknownBits) setFlags.push({ bit: null, name: 'UNKNOWN_FLAG_BITS', description: `Unrecognized flag bits 0x${unknownBits.toString(16).toUpperCase()}`, category: 'caution' });
  if (!covered) return { state: 'outside_coverage', label: 'Outside detector coverage', missing: true, excluded: true, setFlags };
  if ((flags & (2 ** 9)) !== 0 || !Number.isFinite(value)) {
    return { state: 'missing_data', label: 'Missing pixel data', missing: true, excluded: true, setFlags };
  }
  if (!flagsAvailable) return { state: 'unassessed', label: 'Science value present; FITS quality flags unavailable', missing: false, excluded: false, setFlags };
  const masked = unknownBits !== 0 || setFlags.some(flag => MASKED_FLAG_BITS.includes(flag.bit));
  if (masked && maskEnabled) return { state: 'masked', label: 'Excluded by quality mask', missing: false, excluded: true, setFlags };
  if (masked) return { state: 'flagged_included', label: 'Flagged but currently included', missing: false, excluded: false, setFlags };
  return { state: 'valid', label: 'Valid measured pixel', missing: false, excluded: false, setFlags };
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

// Conservative within-observation check: only a single >5-sigma outlier among
// at least three usable exposures from the same OBSID is rejected. This never
// compares observations from different dates, so real long-term fading remains.
export function detectSingleExposureGlitches(samples) {
  const visits = new Map();
  samples.forEach((sample, index) => {
    if (!sample.visitId || !Number.isFinite(sample.signal) || !Number.isFinite(sample.noise)) return;
    if (assessPixelQuality({ ...sample, maskEnabled: true }).state !== 'valid') return;
    if (!visits.has(sample.visitId)) visits.set(sample.visitId, []);
    visits.get(sample.visitId).push({ index, signal: sample.signal, noise: sample.noise });
  });
  const glitches = [];
  for (const visit of visits.values()) {
    if (visit.length < 3) continue;
    const center = median(visit.map(sample => sample.signal));
    const mad = median(visit.map(sample => Math.abs(sample.signal - center)));
    const noise = median(visit.map(sample => sample.noise));
    const threshold = Math.max(5 * 1.4826 * mad, 6 * noise, 1e-9);
    const outliers = visit.filter(sample => Math.abs(sample.signal - center) > threshold);
    if (outliers.length === 1) glitches.push(outliers[0].index);
  }
  return glitches;
}

export function summarizeExposureSamples(samples, maskEnabled = true, glitches = new Set()) {
  const counts = { examined: 0, valid: 0, masked: 0, missing: 0, uncovered: 0, flaggedIncluded: 0, unassessed: 0, glitches: 0 };
  for (const [index, sample] of samples.entries()) {
    const status = assessPixelQuality({ ...sample, maskEnabled });
    counts.examined++;
    if (glitches.has(index)) { counts.glitches++; continue; }
    if (status.state === 'valid') counts.valid++;
    else if (status.state === 'masked') counts.masked++;
    else if (status.state === 'missing_data') counts.missing++;
    else if (status.state === 'outside_coverage') counts.uncovered++;
    else if (status.state === 'flagged_included') counts.flaggedIncluded++;
    else if (status.state === 'unassessed') counts.unassessed++;
  }
  return counts;
}
