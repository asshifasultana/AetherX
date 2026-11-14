// Plain-language hints from a quick-look SPHEREx spectrum (brightness versus
// wavelength at one position). Hints, not classifications: one noisy
// spectrum can only point in a direction. Pure.

const BANDS = {
  blue: [0.75, 1.6],
  mid: [1.6, 2.4],
  red: [2.4, 3.2],
  methane: [3.2, 3.45],
  shoulder: [3.55, 4.1],
  far: [4.4, 5.0]
};

const median = values => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function spectralHints(samples) {
  const points = (samples || []).filter(sample => Number.isFinite(sample.wavelengthUm) && Number.isFinite(sample.fluxMicroJy));
  const band = ([low, high]) => {
    const inBand = points.filter(point => point.wavelengthUm >= low && point.wavelengthUm < high);
    return { flux: median(inBand.map(point => point.fluxMicroJy)), error: median(inBand.map(point => point.errorMicroJy || 0)) / Math.sqrt(Math.max(1, inBand.length)), count: inBand.length };
  };
  const levels = Object.fromEntries(Object.entries(BANDS).map(([name, range]) => [name, band(range)]));
  const rounded = value => Number.isFinite(value) ? Number(value.toPrecision(3)) : null;
  const result = {
    points: points.length,
    medianFluxMicroJy: Object.fromEntries(Object.entries(levels).map(([name, level]) => [name, rounded(level.flux)])),
    hints: [],
    caveat: 'Hints from one quick-look spectrum, not a classification.'
  };
  if (points.length < 8) { result.hints.push('Too few wavelength samples for a useful hint; load more observations of this spot.'); return result; }
  const { blue, red, methane, shoulder, far } = levels;
  if (blue.count && red.count && blue.flux > 0) {
    const ratio = red.flux / blue.flux;
    result.redToBlueRatio = rounded(ratio);
    if (ratio < 0.5) result.hints.push('It fades toward longer infrared wavelengths, as ordinary stars do.');
    else if (ratio > 1.5) result.hints.push('It gets brighter toward longer wavelengths: something cool, dusty, or a reflected-plus-heat glow.');
  }
  if (methane.count >= 2 && shoulder.count >= 2 && red.count >= 2) {
    const continuum = (red.flux + shoulder.flux) / 2;
    if (continuum > 0 && methane.flux < 0.7 * continuum && continuum - methane.flux > 3 * Math.hypot(methane.error, shoulder.error)) {
      result.methaneDip = true;
      result.hints.push('There is a dip near 3.3 μm, where methane absorbs light — seen in very cold brown dwarfs.');
    }
  }
  if (far.count >= 2 && shoulder.count >= 2 && shoulder.flux > 0 && far.flux > 1.5 * shoulder.flux) {
    result.longWaveRise = true;
    result.hints.push('It is much brighter at 4.4–5 μm than at 3.6–4.1 μm — seen in cold brown dwarfs and in the heat glow of asteroids.');
  }
  if (!result.hints.length) result.hints.push('No strong features: a fairly flat spectrum.');
  return result;
}
