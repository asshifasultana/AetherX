// 256-entry colour lookup tables. The perceptual maps are interpolated from
// control points sampled from the matplotlib definitions (inferno, magma,
// viridis, cividis), which is accurate to a few levels per channel.
const CONTROL_POINTS = {
  grayscale: [[0, 0, 0], [255, 255, 255]],
  inferno: [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]],
  magma: [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]],
  viridis: [[68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]],
  cividis: [[0, 34, 78], [35, 62, 108], [87, 92, 109], [124, 123, 120], [163, 155, 116], [205, 189, 104], [255, 234, 70]],
  // Dark-centred diverging map for difference images: zero change stays dark
  // so that only real fading (blue) and brightening (orange) draws the eye.
  diverging: [[120, 200, 255], [40, 110, 210], [18, 40, 90], [10, 10, 14], [100, 36, 12], [215, 100, 25], [255, 210, 110]]
};

export const COLORMAP_NAMES = Object.freeze(Object.keys(CONTROL_POINTS));
const cache = new Map();

/** RGB triplets for 256 levels, as a flat Uint8Array (768 bytes). */
export function colormap(name) {
  const key = CONTROL_POINTS[name] ? name : 'grayscale';
  if (cache.has(key)) return cache.get(key);
  const points = CONTROL_POINTS[key], lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const position = (i / 255) * (points.length - 1);
    const lower = Math.min(points.length - 2, Math.floor(position)), fraction = position - lower;
    for (let channel = 0; channel < 3; channel++) {
      lut[i * 3 + channel] = Math.round(points[lower][channel] + (points[lower + 1][channel] - points[lower][channel]) * fraction);
    }
  }
  cache.set(key, lut);
  return lut;
}

/** CSS gradient for legends and colour bars. */
export function colormapGradient(name, invert = false, stops = 12) {
  const lut = colormap(name), parts = [];
  for (let i = 0; i <= stops; i++) {
    const level = Math.round((invert ? 1 - i / stops : i / stops) * 255);
    parts.push(`rgb(${lut[level * 3]} ${lut[level * 3 + 1]} ${lut[level * 3 + 2]}) ${(i / stops * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
