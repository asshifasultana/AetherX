// Three illustrative spectra for the PlanetX lab's "Spot the methane dip"
// game: an ordinary star, a galaxy and a cold brown dwarf like WISE 0855.
// They are shaped like real ones and sampled where SPHEREx samples
// (0.75–5.0 μm, six detectors of 17 channels), with a little seeded noise.
// They are teaching templates, not measurements. Pure and deterministic.

// SPHEREx detector bands (μm). Channels are spaced evenly in log wavelength.
const DETECTOR_BANDS = [[0.75, 1.09], [1.10, 1.62], [1.63, 2.41], [2.42, 3.82], [3.83, 4.41], [4.42, 5.00]];
export const CHANNELS = DETECTOR_BANDS.flatMap(([low, high]) =>
  Array.from({ length: 17 }, (_, i) => Number((low * (high / low) ** (i / 16)).toFixed(4))));

export const METHANE_BAND_UM = [3.2, 3.45];

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussianNoise = random => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const bump = (w, centre, width) => Math.exp(-(((w - centre) / width) ** 2) / 2);
// Blackbody in F_ν (arbitrary units) at wavelength w (μm) and temperature T (K).
const planckNu = (w, T) => w ** -3 / Math.expm1(14388 / (w * T));

const SHAPES = {
  // A Sun-like star: brightest at short wavelengths, falling smoothly beyond.
  star: w => 1800 * planckNu(w, 5800) / planckNu(1, 5800),
  // A galaxy: the summed starlight peaks near 1.6 μm, then a slow decline, a
  // narrow 3.3 μm PAH emission bump from warm dust grains, and a dust rise.
  galaxy: w => 420 * (0.75 * planckNu(w, 3800) / planckNu(1.6, 3800) + 0.25 * planckNu(w, 2600) / planckNu(1.6, 2600))
    + 130 * bump(w, 3.29, 0.045) + 18 * Math.max(0, w - 3.6) ** 1.5,
  // A ~285 K brown dwarf like WISE 0855: barely there at short wavelengths, a
  // faint shoulder near 3 μm, a deep methane trough at 3.2–3.45 μm, then a
  // steep climb to a bright peak at 4.4–5 μm where its heat escapes.
  'brown-dwarf': w => 1.0 * bump(w, 1.27, 0.06) + 0.7 * bump(w, 1.58, 0.07) + 0.3
    + 7 * bump(w, 2.95, 0.16) * (w < 3.2 ? 1 : 0.15)
    + (w >= 3.2 && w < 3.5 ? 0.4 : 0)
    + (w >= 3.5 ? 70 / (1 + Math.exp(-(w - 4.05) / 0.16)) * (1 - 0.18 * bump(w, 4.3, 0.04)) * (w > 4.7 ? 1 - 0.6 * (w - 4.7) : 1) : 0)
};

export const MYSTERY_SPECTRA = Object.freeze([
  {
    id: 'star', kind: 'Ordinary star', seed: 11, noise: 0.025,
    explanation: 'Brightest at the short end and fading smoothly toward longer wavelengths, like a Sun-like star. No dip at 3.3 μm: it is far too hot for methane to survive.'
  },
  {
    id: 'galaxy', kind: 'Galaxy', seed: 23, noise: 0.03,
    explanation: 'Starlight from billions of stars piles up near 1.6 μm, then fades. The little spike at 3.3 μm is a bump, not a dip: warm dust grains (PAHs) glowing, which is the opposite of methane absorbing light.'
  },
  {
    id: 'brown-dwarf', kind: 'Cold brown dwarf (like WISE 0855)', seed: 37, noise: 0.05,
    explanation: 'Almost dark at short wavelengths, a deep hole at 3.2–3.45 μm where methane absorbs, then very bright at 4.4–5 μm where its heat escapes. Only something colder than about 1,000 °C keeps methane, water and hydrogen in its air to carve these shapes.'
  }
].map(Object.freeze));

/** Samples ({ wavelengthUm, fluxMicroJy, errorMicroJy }) for one mystery spectrum. */
export function spectrumSamples(id) {
  const spec = MYSTERY_SPECTRA.find(entry => entry.id === id);
  if (!spec) throw new Error(`Unknown mystery spectrum: ${id}`);
  const random = seeded(spec.seed), shape = SHAPES[id];
  const peak = Math.max(...CHANNELS.map(shape));
  return CHANNELS.map(wavelengthUm => {
    const flux = shape(wavelengthUm);
    const errorMicroJy = Math.max(spec.noise * flux, 0.012 * peak);
    return { wavelengthUm, fluxMicroJy: Number((flux + errorMicroJy * gaussianNoise(random)).toFixed(4)), errorMicroJy: Number(errorMicroJy.toFixed(4)) };
  });
}
