// Quick-look aperture photometry at a sky position in one SPHEREx exposure:
// a 1.5-pixel aperture with a 4.5–8 pixel background annulus, quality-masked,
// with variance-based errors. Shared by the spectrum explorer and the AI
// guide's measure_source and get_spectrum tools.
//
// An area spot (radiusArcsec) is measured as one big aperture: the total flux
// inside the circle above a local background ring 1.5–2× its radius. Masked or
// off-image pixels inside it are filled with the mean of the usable ones, and
// at least 60% of the area must be usable.

import { decodeCrop } from './crop-codec.js';
import { projectSkyToPixel } from './fits-engine.js';
import { createWavelengthReader } from './wavelength.js';
import { DEFAULT_MASK_BITS } from './pixel-quality.js';
import { snapToPeak } from './peak.js';

const sharedWavelengthReader = createWavelengthReader();
const finite = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
const median = values => {
  if (!values.length) return NaN;
  values.sort((a, b) => a - b); const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
const pixelAreaSr = matrix => Math.abs(matrix.determinant) * (Math.PI / 180) ** 2;

const PIXEL_ARCSEC = 6.15;
const MAX_CROP_FOV_ARCMIN = 30;
const MIN_AREA_COVERAGE = 0.6;

/** Aperture and background ring in pixels, and the crop size that holds them. */
export function apertureFor(radiusArcsec) {
  const area = Number(radiusArcsec) > 0;
  const radius = area ? Math.max(1.5, radiusArcsec / PIXEL_ARCSEC) : 1.5;
  const inner = Math.max(4.5, radius * 1.5), outer = Math.max(8, radius * 2);
  const fovArcmin = Math.min(MAX_CROP_FOV_ARCMIN, Math.max(3, Math.ceil(2 * (outer + 2) * PIXEL_ARCSEC / 60)));
  return { area, radius, inner, outer, fovArcmin };
}

/**
 * Measure the flux at {raDeg, decDeg} in one observation.
 * @returns {Promise<{wavelengthUm:number|null, fluxMicroJy:number, errorMicroJy:number, snr:number, time:number, observation:object, detector:number, pixelsUsed:number, raDeg:number, decDeg:number, flagsChecked:true}>}
 */
export async function measureAt(observation, position, signal, { wavelength = true, radiusArcsec = null, wavelengthAt = sharedWavelengthReader, fetchImpl = (...args) => fetch(...args) } = {}) {
  const aperture = apertureFor(radiusArcsec);
  const params = new URLSearchParams({
    url: observation.accessUrl, raDeg: String(position.raDeg), decDeg: String(position.decDeg),
    fovArcmin: String(aperture.fovArcmin), flags: '1', variance: '1',
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
  const source = [], background = [], beyond = [], variance = [];
  const reach = Math.ceil(aperture.outer);
  let inAperture = 0;
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
    const radius = Math.hypot(dx, dy);
    if (radius > reach) continue;
    if (radius <= aperture.radius) inAperture++;
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
    const index = py * image.width + px, value = image.values[index], v = image.variance[index];
    if (!Number.isFinite(value) || (image.flags[index] & DEFAULT_MASK_BITS) !== 0) continue;
    if (radius <= aperture.radius) { if (Number.isFinite(v) && v >= 0) { source.push(value); variance.push(v); } }
    else if (radius >= aperture.inner && radius <= aperture.outer) background.push(value);
    else if (aperture.area && radius > aperture.radius + 2) beyond.push(value);
  }
  // A large area's ring can run off the crop; then any sky clear of the area is used.
  const sample = background.length >= 12 || !aperture.area ? background : beyond;
  if (source.length < 5 || sample.length < 12) throw new Error('Too few unflagged pixels around the target for a stable quick-look measurement.');
  const coverage = source.length / inAperture;
  if (aperture.area && coverage < MIN_AREA_COVERAGE) throw new Error(`Only ${Math.round(coverage * 100)}% of the area has usable pixels in this exposure.`);
  const fill = aperture.area ? inAperture / source.length : 1;
  const sky = median(sample.slice()), scatter = 1.4826 * median(sample.map(value => Math.abs(value - sky)));
  const area = pixelAreaSr(image.matrix), sourceSum = fill * source.reduce((sum, value) => sum + value - sky, 0);
  const counted = aperture.area ? inAperture : source.length;
  const varianceSum = fill ** 2 * variance.reduce((sum, value) => sum + value, 0) + counted ** 2 * (scatter ** 2 / sample.length);
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
    ...(aperture.area ? { radiusArcsec: Number(radiusArcsec), areaCoverage: coverage } : {}),
    raDeg: position.raDeg, decDeg: position.decDeg, flagsChecked: true
  };
}

async function fetchCrop(observation, position, signal, { fovArcmin, flags, variance, fetchImpl }) {
  const params = new URLSearchParams({
    url: observation.accessUrl, raDeg: String(position.raDeg), decDeg: String(position.decDeg),
    fovArcmin: String(fovArcmin), flags: flags ? '1' : '0', variance: variance ? '1' : '0',
    revision: observation.productModifiedAt || observation.metadataModifiedAt || ''
  });
  const response = await fetchImpl(`/api/crop?${params}`, { signal });
  if (!response.ok) {
    let message = `Image request failed (${response.status}).`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return decodeCrop(await response.arrayBuffer());
}

/**
 * The wavelength SPHEREx saw at a sky position in one exposure (μm). No flag
 * checks, so it also works on a saturated star; used to pair frames taken at
 * matching wavelengths before subtracting them.
 */
export async function wavelengthAtSky(observation, position, signal, { wavelengthAt = sharedWavelengthReader, fetchImpl = (...args) => fetch(...args) } = {}) {
  const image = await fetchCrop(observation, position, signal, { fovArcmin: 1, flags: false, variance: false, fetchImpl });
  const pixel = projectSkyToPixel(image, position.raDeg, position.decDeg);
  if (!pixel) throw new Error('The sky position is outside this image.');
  const value = await wavelengthAt(observation.accessUrl, image.sourceX + pixel[0], image.sourceY + pixel[1]);
  if (!finite(value) || value <= 0) throw new Error('Wavelength calibration is unavailable here.');
  return Number(value);
}

/**
 * Where the source near a sky position really is in one exposure: the
 * flux-weighted centroid of unflagged pixels within searchPx, its local
 * (MAD) signal-to-noise, and its sky position. The pixel offset is turned
 * into arcseconds with a local Jacobian of the image's WCS.
 */
export async function centroidAt(observation, position, signal, { searchPx = 3, minSnr = 3, fetchImpl = (...args) => fetch(...args) } = {}) {
  // With flags on, the crop service already blanks pixels its quality mask
  // rejects. Masking the full photometry bit set again would also blank the
  // bright ring of a saturated star, which is what centres it.
  const image = await fetchCrop(observation, position, signal, { fovArcmin: 3, flags: true, variance: false, fetchImpl });
  const values = image.values;
  const project = (ra, dec) => projectSkyToPixel(image, ra, dec);
  const base = project(position.raDeg, position.decDeg);
  if (!base) throw new Error('The sky position is outside this image.');
  const time = Date.parse(observation.observedStartUtc || '') || 0;
  const peak = snapToPeak(values, image.width, base[0], base[1], searchPx, { minSigma: minSnr });
  if (peak.noSource) return { detected: false, snr: peak.peakSigma, time, raDeg: position.raDeg, decDeg: position.decDeg };
  // Local Jacobian: pixels per arcsecond east and north.
  const step = 6, cos = Math.cos(position.decDeg * Math.PI / 180);
  const east = project(position.raDeg + step / 3600 / cos, position.decDeg), north = project(position.raDeg, position.decDeg + step / 3600);
  if (!east || !north) throw new Error('The image WCS could not be evaluated here.');
  const a = (east[0] - base[0]) / step, b = (north[0] - base[0]) / step, c = (east[1] - base[1]) / step, d = (north[1] - base[1]) / step;
  const det = a * d - b * c;
  if (!(Math.abs(det) > 0)) throw new Error('The image WCS is degenerate here.');
  const dx = peak.x - base[0], dy = peak.y - base[1];
  const eastArcsec = (d * dx - b * dy) / det, northArcsec = (-c * dx + a * dy) / det;
  return {
    detected: true, snr: peak.peakSigma, time,
    raDeg: ((position.raDeg + eastArcsec / 3600 / cos) % 360 + 360) % 360, decDeg: position.decDeg + northArcsec / 3600,
    offsetArcsec: Number(Math.hypot(eastArcsec, northArcsec).toFixed(1))
  };
}
