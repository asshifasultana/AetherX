// Painting helpers for the six-detector view: one detector grid through a
// colour table, or three detector grids as a false-colour RGB composite.
// Pure: they return pixel bytes and never touch the DOM.

import { scaleLimits, toneMapper, fillMaskedHoles } from './display-scale.js';

export const NO_DATA_RGB = Object.freeze([15, 12, 22]);

/**
 * Black and white points for one detector's grid. Each detector is scaled on
 * its own, because the sky is far brighter at 1 μm than at 5 μm; manual
 * limits typed for one detector would be meaningless for the others, so they
 * fall back to the noise-based limits.
 */
export function channelLimits(values, { scaleMode = 'noise' } = {}) {
  const mode = scaleMode === 'manual' ? 'noise' : scaleMode;
  const limits = scaleLimits(values, mode);
  if (limits.high > limits.low) return limits;
  return { low: 0, high: 1 };
}

/** Display copy of a grid: small masked holes (saturated cores) filled from the rim. */
export function displayValues(values, width, { fillMaskedCores = true } = {}) {
  return fillMaskedCores ? fillMaskedHoles(values, width) : values;
}

function skyMedian(values) {
  const finite = Float32Array.from(values).filter(Number.isFinite).sort();
  if (!finite.length) return Number.NaN;
  const middle = finite.length >> 1;
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

/**
 * One level function per grid, from its own limits and the shared stretch.
 * `neutralSky` puts the black point at the grid's median (the sky), so the
 * background is equally dark in every channel of a composite instead of
 * taking the colour of whichever detector has the lowest dynamic range.
 */
export function channelMapper(values, options = {}) {
  const limits = { ...channelLimits(values, options) };
  if (options.neutralSky) {
    const sky = skyMedian(values);
    if (Number.isFinite(sky) && sky < limits.high) limits.low = sky;
  }
  const { stretch = 'asinh', contrast = 50, brightness = 50, invert = false } = options;
  return { limits, level: toneMapper({ ...limits, stretch, contrast, brightness, invert }, stretch === 'histeq' ? values : null) };
}

/** RGBA bytes for one grid through a 256-entry colour table (Uint8Array(768)). */
export function paintChannel(values, lut, options = {}) {
  const shown = displayValues(values, options.width || Math.round(Math.sqrt(values.length)), options);
  const { limits, level } = channelMapper(shown, options);
  const rgba = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < shown.length; i++) {
    const at = i * 4, value = shown[i];
    if (Number.isFinite(value)) {
      const index = level(value) * 3;
      rgba[at] = lut[index]; rgba[at + 1] = lut[index + 1]; rgba[at + 2] = lut[index + 2];
    } else { rgba[at] = NO_DATA_RGB[0]; rgba[at + 1] = NO_DATA_RGB[1]; rgba[at + 2] = NO_DATA_RGB[2]; }
    rgba[at + 3] = 255;
  }
  return { rgba, limits };
}

/**
 * False-colour composite of three equal-sized grids mapped to red, green and
 * blue. Each channel gets its own limits and the shared stretch. A channel with
 * no data at a pixel paints 0 there; a pixel with no data in any channel is
 * painted as "no data". A missing grid (null) leaves its channel dark.
 */
export function compositeRgb({ r = null, g = null, b = null }, width, options = {}) {
  const grids = [r, g, b];
  const length = grids.find(grid => grid)?.length;
  if (!length) throw new TypeError('A composite needs at least one channel.');
  if (grids.some(grid => grid && grid.length !== length)) throw new TypeError('Composite channels must share one grid.');
  const shown = grids.map(grid => grid ? displayValues(grid, width, options) : null);
  const mappers = shown.map(grid => grid ? channelMapper(grid, { ...options, neutralSky: options.neutralSky ?? true }) : null);
  const rgba = new Uint8ClampedArray(length * 4);
  for (let i = 0; i < length; i++) {
    const at = i * 4;
    let any = false;
    for (let channel = 0; channel < 3; channel++) {
      const grid = shown[channel], value = grid ? grid[i] : Number.NaN;
      if (Number.isFinite(value)) { rgba[at + channel] = mappers[channel].level(value); any = true; }
    }
    if (!any) { rgba[at] = NO_DATA_RGB[0]; rgba[at + 1] = NO_DATA_RGB[1]; rgba[at + 2] = NO_DATA_RGB[2]; }
    rgba[at + 3] = 255;
  }
  return { rgba, limits: mappers.map(mapper => mapper?.limits || null) };
}
