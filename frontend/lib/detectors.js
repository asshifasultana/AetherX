// SPHEREx detector bands and spectral channels. One place for the numbers the
// six-detector view, the channel spectrum and the wavelength slices share.
// Pure: no DOM access.

/** Band limits in μm for D1–D6 (index 0 is D1). */
export const DETECTOR_BANDS = Object.freeze([[0.75, 1.09], [1.10, 1.62], [1.63, 2.41], [2.42, 3.82], [3.83, 4.41], [4.42, 5.00]].map(Object.freeze));
export const DETECTOR_COUNT = 6;
export const CHANNELS_PER_DETECTOR = 17;

export function detectorBand(detector) {
  return DETECTOR_BANDS[Number(detector) - 1] || null;
}

export function detectorLabel(detector) {
  const band = detectorBand(detector);
  return band ? `D${detector} · ${band[0].toFixed(2)}–${band[1].toFixed(2)} μm` : `D${detector}`;
}

// Channel centres are spaced evenly in log wavelength across each band, 17 per
// detector, 102 in all. This matches the mission's linear-variable filters to
// within the accuracy a quick-look view needs.
const centresFor = ([low, high]) => Array.from({ length: CHANNELS_PER_DETECTOR }, (_, i) => Number((low * (high / low) ** (i / (CHANNELS_PER_DETECTOR - 1))).toFixed(4)));

/** Per detector: 17 channel centres (μm). */
export const DETECTOR_CHANNELS = Object.freeze(DETECTOR_BANDS.map(band => Object.freeze(centresFor(band))));
/** All 102 channel centres in wavelength order. */
export const CHANNEL_CENTERS = Object.freeze(DETECTOR_CHANNELS.flat());

/**
 * Per detector: 18 channel edges. Inner edges are the geometric midpoints
 * between neighbouring centres; the outer edges are the band limits.
 */
export const DETECTOR_CHANNEL_EDGES = Object.freeze(DETECTOR_CHANNELS.map((centres, index) => {
  const [low, high] = DETECTOR_BANDS[index];
  const edges = [low];
  for (let i = 1; i < centres.length; i++) edges.push(Math.sqrt(centres[i - 1] * centres[i]));
  edges.push(high);
  return Object.freeze(edges);
}));

/**
 * Channel index (0–16) of a wavelength within a detector, or -1 when it falls
 * outside the band. A small tolerance keeps values a hair past the nominal band
 * edge (the real filters overlap slightly) in the end channels.
 */
export function channelOf(wavelengthUm, detector, { toleranceUm = 0.03 } = {}) {
  const edges = DETECTOR_CHANNEL_EDGES[Number(detector) - 1], value = Number(wavelengthUm);
  if (!edges || !Number.isFinite(value)) return -1;
  if (value < edges[0] - toleranceUm || value > edges.at(-1) + toleranceUm) return -1;
  for (let i = 1; i < edges.length - 1; i++) if (value < edges[i]) return i - 1;
  return edges.length - 2;
}

/** The detector whose band holds a wavelength, or null. */
export function detectorFor(wavelengthUm) {
  const value = Number(wavelengthUm);
  const index = DETECTOR_BANDS.findIndex(([low, high]) => value >= low && value <= high);
  return index >= 0 ? index + 1 : null;
}

/** Spectral features worth marking on a 0.75–5 μm spectrum (μm). */
export const SPECTRAL_FEATURES = Object.freeze([
  Object.freeze({ id: 'h2o-ice', label: 'H₂O ice', short: 'H₂O ice', centerUm: 3.0, lowUm: 2.9, highUm: 3.1 }),
  Object.freeze({ id: 'ch4-pah', label: 'CH₄ / PAH 3.3 μm', short: 'CH₄/PAH', centerUm: 3.3, lowUm: 3.25, highUm: 3.35 }),
  Object.freeze({ id: 'co2', label: 'CO₂ 4.26 μm', short: 'CO₂', centerUm: 4.26, lowUm: 4.23, highUm: 4.29 })
]);
