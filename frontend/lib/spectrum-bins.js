// Bin per-exposure quick-look measurements into SPHEREx's 102 channels
// (6 detectors × 17), so a spectrum reads as channels rather than a cloud of
// points. Pure: no DOM access.

import { channelOf, DETECTOR_CHANNELS } from './detectors.js';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Standard error of a median: 1.2533 × σ / √n, with σ from the median absolute
// deviation (1.4826 × MAD). With fewer than three points the scatter says too
// little, so the points' own errors are combined instead.
function medianError(points) {
  const n = points.length;
  if (n >= 3) {
    const fluxes = points.map(point => point.fluxMicroJy), centre = median(fluxes);
    const sigma = 1.4826 * median(fluxes.map(flux => Math.abs(flux - centre)));
    if (sigma > 0) return 1.2533 * sigma / Math.sqrt(n);
  }
  const errors = points.map(point => point.errorMicroJy).filter(Number.isFinite);
  return errors.length ? Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0)) / errors.length : Number.NaN;
}

/**
 * Channel medians. Each bin holds the median wavelength and flux of the
 * exposures that fall in one detector channel, an error on that median, the
 * number of points used and how many likely-saturated points were left out.
 * Bins are sorted by wavelength; samples outside every channel are ignored.
 */
export function binSpectrum(samples, { includeSaturated = false } = {}) {
  const groups = new Map();
  for (const sample of samples || []) {
    const detector = Number(sample?.detector), wavelength = Number(sample?.wavelengthUm), flux = Number(sample?.fluxMicroJy);
    if (!Number.isFinite(wavelength) || !Number.isFinite(flux)) continue;
    const channel = channelOf(wavelength, detector);
    if (channel < 0) continue;
    const key = `${detector}:${channel}`;
    if (!groups.has(key)) groups.set(key, { detector, channel, used: [], saturatedCount: 0 });
    const group = groups.get(key);
    if (sample.likelySaturated && !includeSaturated) group.saturatedCount++;
    else group.used.push(sample);
  }
  const bins = [];
  for (const group of groups.values()) {
    const { detector, channel, used, saturatedCount } = group;
    const centreUm = DETECTOR_CHANNELS[detector - 1][channel];
    if (!used.length) { bins.push({ detector, channel, centreUm, wavelengthUm: centreUm, fluxMicroJy: Number.NaN, errorMicroJy: Number.NaN, n: 0, saturatedCount }); continue; }
    bins.push({
      detector, channel, centreUm,
      wavelengthUm: median(used.map(point => point.wavelengthUm)),
      fluxMicroJy: median(used.map(point => point.fluxMicroJy)),
      errorMicroJy: medianError(used),
      n: used.length, saturatedCount
    });
  }
  return bins.sort((a, b) => a.wavelengthUm - b.wavelengthUm || a.detector - b.detector);
}

/** CSV of channel medians, one row per bin. */
export function binsToCsv(bins, { target = '' } = {}) {
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const number = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : '';
  const rows = [['target', 'detector', 'channel', 'channelCentreUm', 'medianWavelengthUm', 'medianFluxMicroJy', 'errorMicroJy', 'pointsUsed', 'saturatedPointsExcluded'].join(',')];
  for (const bin of bins) {
    rows.push([cell(target), bin.detector, bin.channel + 1, number(bin.centreUm, 4), number(bin.wavelengthUm, 4), number(bin.fluxMicroJy, 3), number(bin.errorMicroJy, 3), bin.n, bin.saturatedCount].join(','));
  }
  return rows.join('\r\n');
}
