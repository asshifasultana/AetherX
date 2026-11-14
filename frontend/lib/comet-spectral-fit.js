import { parseHeader } from './fits-engine.js';
import { createRangeReader } from './range-fits.js';

const bucket = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
const qr2Wcs = detector => bucket + `qr2/spectral_wcs/cal-wcs-v4-2025-254/${detector}/spectral_wcs_D${detector}_spx_cal-wcs-v4-2025-254.fits`;

export async function loadD5ResponseCurves(read = createRangeReader()) {
  const url = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/spectral_files_20260812/SPHERExSpectralFiles_202607.tar';
  // Block-aligned window containing the 68 D5 MiddlePixel curves in this pinned tar.
  const bytes = await read(url, 34 * 1048576, 36 * 1048576 - 1);
  const decoder = new TextDecoder('ascii'), curves = [];
  for (let offset = 0; offset + 512 <= bytes.length; offset += 512) {
    if (decoder.decode(bytes.subarray(offset + 257, offset + 262)) !== 'ustar') continue;
    const name = decoder.decode(bytes.subarray(offset, offset + 100)).split('\0')[0];
    if (!/^MiddlePixel\/SubChannel68\/Band5\/.*\.csv$/.test(name)) continue;
    const size = Number.parseInt(decoder.decode(bytes.subarray(offset + 124, offset + 136)), 8);
    if (!Number.isFinite(size) || size <= 0 || offset + 512 + size > bytes.length) throw new Error('Truncated D5 spectral curve.');
    const [header, ...rows] = decoder.decode(bytes.subarray(offset + 512, offset + 512 + size)).trim().split(/\r?\n/);
    if (header !== 'Wavelength_um,NormTransmission') throw new Error('Unsupported spectral curve CSV.');
    curves.push(responseCurve(rows.map(row => row.split(',').map(Number))));
  }
  if (curves.length !== 68) throw new Error('Incomplete D5 spectral calibration archive window.');
  return curves;
}

export function createSpectralMapReader(read = createRangeReader()) {
  const layouts = new Map();
  return async function spectralMaps(image, detector, url = qr2Wcs(detector)) {
    if (!layouts.has(url)) {
      const layout = (async () => {
        const bytes = await read(url, 0, 17279);
        const center = parseHeader(bytes, parseHeader(bytes, 0).dataOffset);
        const length = center.header.NAXIS1 * center.header.NAXIS2 * 4;
        const bandwidthOffset = center.dataOffset + 2880 * Math.ceil(length / 2880);
        const bandwidth = parseHeader(await read(url, bandwidthOffset, bandwidthOffset + 8639), 0);
        if (center.header.EXTNAME !== 'CWAVE' || bandwidth.header.EXTNAME !== 'CBAND' ||
            [center.header, bandwidth.header].some(h => h.BITPIX !== -32 || h.NAXIS1 !== 2040 || h.NAXIS2 !== 2040)) {
          throw new Error('Unsupported CWAVE/CBAND calibration layout.');
        }
        return [center.dataOffset, bandwidthOffset + bandwidth.dataOffset];
      })();
      layouts.set(url, layout);
      layout.catch(() => layouts.delete(url));
    }
    if (image.sourceX < 0 || image.sourceY < 0 || image.sourceX + image.width > 2040 || image.sourceY + image.height > 2040) {
      throw new Error('Cutout lies outside the spectral calibration map.');
    }
    const [center, bandwidth] = await Promise.all((await layouts.get(url)).map(async offset => {
      const stride = 2040 * 4;
      const begin = offset + image.sourceY * stride;
      const bytes = await read(url, begin, begin + image.height * stride - 1);
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Float32Array.from({ length: image.values.length }, (_, i) =>
        data.getFloat32(Math.floor(i / image.width) * stride + (image.sourceX + i % image.width) * 4));
    }));
    return { center, bandwidth };
  };
}

function integral(points, transform = () => 1) {
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, u] = points[i - 1], [b, v] = points[i];
    sum += (b - a) * (u * transform(a) + v * transform(b)) / 2;
  }
  return sum;
}

export function responseCurve(points) {
  const clean = points.filter(([wavelength, transmission]) => Number.isFinite(wavelength) && Number.isFinite(transmission))
    .map(([wavelength, transmission]) => [wavelength, Math.max(0, transmission)]).sort((a, b) => a[0] - b[0]);
  const area = integral(clean);
  if (!(area > 0)) throw new Error('Empty spectral transmission curve.');
  const peak = Math.max(...clean.map(([, transmission]) => transmission));
  let cumulative = 0, center;
  for (let i = 1; i < clean.length; i++) {
    const [a, u] = clean[i - 1], [b, v] = clean[i];
    const segment = (b - a) * (u + v) / 2;
    if (cumulative + segment >= area / 2) {
      center = a + (b - a) * (area / 2 - cumulative) / segment;
      break;
    }
    cumulative += segment;
  }
  return { points: clean, area, center, bandwidth: area / peak };
}

export function makeLineResponse(curves, lineCenter = 4.26, lineSigma = 0.008) {
  if (!curves.length || !(lineSigma > 0)) throw new Error('Spectral response needs curves and a positive line width.');
  const cache = new Map();
  return (center, bandwidth) => {
    if (!(center > 0 && bandwidth > 0)) return NaN;
    // Bin the calibration parameters at 0.1 nm to reuse integrals across the cutout.
    const central = Math.round(center * 10000), width = Math.round(bandwidth * 10000);
    const key = central * 100000 + width;
    if (!cache.has(key)) {
      const curve = curves.reduce((best, candidate) => Math.abs(candidate.center - center) < Math.abs(best.center - center) ? candidate : best);
      const scale = (width / 10000) / curve.bandwidth;
      const weight = integral(curve.points, wavelength => {
        const observed = central / 10000 + scale * (wavelength - curve.center);
        return Math.exp(-0.5 * ((observed - lineCenter) / lineSigma) ** 2);
      }) / curve.area;
      cache.set(key, weight);
    }
    return cache.get(key);
  };
}
