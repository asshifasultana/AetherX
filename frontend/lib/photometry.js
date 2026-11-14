// Quick-look aperture photometry at a sky position in one SPHEREx exposure:
// a 1.5-pixel aperture with a 4.5–8 pixel background annulus, quality-masked,
// with variance-based errors. Shared by the spectrum explorer and the AI
// guide's measure_source and get_spectrum tools.

import { decodeCrop } from './crop-codec.js';
import { projectSkyToPixel } from './fits-engine.js';
import { createWavelengthReader } from './wavelength.js';
import { DEFAULT_MASK_BITS } from './pixel-quality.js';

const sharedWavelengthReader = createWavelengthReader();
const finite = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
const median = values => {
  if (!values.length) return NaN;
  values.sort((a, b) => a - b); const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
const pixelAreaSr = matrix => Math.abs(matrix.determinant) * (Math.PI / 180) ** 2;

/**
 * Measure the flux at {raDeg, decDeg} in one observation.
 * @returns {Promise<{wavelengthUm:number|null, fluxMicroJy:number, errorMicroJy:number, snr:number, time:number, observation:object, detector:number, pixelsUsed:number, raDeg:number, decDeg:number, flagsChecked:true}>}
 */
export async function measureAt(observation, position, signal, { wavelength = true, wavelengthAt = sharedWavelengthReader, fetchImpl = (...args) => fetch(...args) } = {}) {
  const params = new URLSearchParams({
    url: observation.accessUrl, raDeg: String(position.raDeg), decDeg: String(position.decDeg),
    fovArcmin: '3', flags: '1', variance: '1',
    revision: observation.productModifiedAt || observation.metadataModifiedAt || ''
  });
  const response = await fetchImpl(`/api/crop?${params}`, { signal });
  if (!response.ok) {
    let message = `Image request failed (${response.status}).`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const image = decodeCrop(await response.arrayBuffer());
  if (!image.flags || !image.variance) throw new Error('Quality flags or variance are unavailable for this product.');
  if (!/mjy\s*\/\s*sr|mjy\s*sr(?:\^?-1|-1)/i.test(String(image.header.BUNIT || ''))) throw new Error('This product does not report flux in MJy/sr.');
  const pixel = projectSkyToPixel(image, position.raDeg, position.decDeg);
  if (!pixel) throw new Error('The selected sky position is outside this image.');
  const x = Math.round(pixel[0]), y = Math.round(pixel[1]);
  const source = [], background = [], variance = [];
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
    const index = py * image.width + px, value = image.values[index], v = image.variance[index];
    if (!Number.isFinite(value) || (image.flags[index] & DEFAULT_MASK_BITS) !== 0) continue;
    const radius = Math.hypot(dx, dy);
    if (radius <= 1.5 && Number.isFinite(v) && v >= 0) { source.push(value); variance.push(v); }
    else if (radius >= 4.5 && radius <= 8) background.push(value);
  }
  if (source.length < 5 || background.length < 12) throw new Error('Too few unflagged pixels around the target for a stable quick-look measurement.');
  const sky = median(background), scatter = 1.4826 * median(background.map(value => Math.abs(value - sky)));
  const area = pixelAreaSr(image.matrix), sourceSum = source.reduce((sum, value) => sum + value - sky, 0);
  const varianceSum = variance.reduce((sum, value) => sum + value, 0) + source.length ** 2 * (scatter ** 2 / background.length);
  const scale = 1e12 * area; // MJy/sr × pixel solid angle → μJy.
  let wavelengthUm = null;
  if (wavelength) {
    wavelengthUm = await wavelengthAt(observation.accessUrl, image.sourceX + pixel[0], image.sourceY + pixel[1]);
    if (!finite(wavelengthUm) || wavelengthUm <= 0) throw new Error('Wavelength calibration is unavailable at the selected position.');
  }
  const fluxMicroJy = sourceSum * scale, errorMicroJy = Math.sqrt(varianceSum) * scale;
  return {
    wavelengthUm, fluxMicroJy, errorMicroJy, snr: errorMicroJy > 0 ? fluxMicroJy / errorMicroJy : 0,
    time: Date.parse(observation.observedStartUtc || '') || 0,
    observation, detector: Number(observation.detector), pixelsUsed: source.length,
    raDeg: position.raDeg, decDeg: position.decDeg, flagsChecked: true
  };
}
