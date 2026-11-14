import { decodeRice32 } from './rice.js';
import { estimateBackground } from './background.js';
import { MASKED_FLAG_BITS } from './pixel-quality.js';
const BAD_PIXEL_MASK = MASKED_FLAG_BITS.reduce((mask, bit) => mask | (1 << bit), 0) >>> 0;
export function parseHeader(bytes, offset) {
  const values = {};
  let cursor = offset, ended = false;
  while (cursor + 80 <= bytes.length && !ended) {
    const endBlock = Math.min(cursor + 2880, bytes.length);
    for (let start = cursor; start + 80 <= endBlock; start += 80) {
      const card = new TextDecoder('ascii').decode(bytes.subarray(start, start + 80));
      const key = card.slice(0, 8).trim();
      if (key === 'END') { cursor = start + 80; ended = true; break; }
      if (card[8] !== '=') continue;
      const raw = card.slice(10).trim();
      if (raw.startsWith("'")) values[key] = raw.slice(1, raw.indexOf("'", 1)).trim();
      else {
        const field = raw.split('/')[0].trim();
        if (field) values[key] = field === 'T' ? true : field === 'F' ? false : Number(field.replace(/D/g, 'E'));
      }
    }
    if (!ended) cursor = endBlock;
  }
  if (!ended) throw new Error('Incomplete FITS header.');
  return { header: values, dataOffset: Math.ceil(cursor / 2880) * 2880 };
}

export function readFits(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (new TextDecoder('ascii').decode(bytes.subarray(0, 8)) !== 'SIMPLE  ') throw new Error('This file is not a FITS image.');
  let offset = 0, selected = null, flags = null;
  while (offset + 2880 <= bytes.length) {
    if (selected && !['SIMPLE', 'XTENSION'].includes(new TextDecoder('ascii').decode(bytes.subarray(offset, offset + 8)).trim())) break;
    const { header, dataOffset } = parseHeader(bytes, offset);
    const count = Math.max(0, Number(header.NAXIS) || 0);
    const axes = Array.from({ length: count }, (_, i) => Number(header[`NAXIS${i + 1}`]) || 0);
    const bitpix = Number(header.BITPIX) || 0;
    const elements = count ? axes.reduce((a, b) => a * b, 1) : 0;
    const bytesPerPixel = Math.abs(bitpix) / 8;
    const tableLength = Number(header.NAXIS1 || 0) * Number(header.NAXIS2 || 0);
    const dataLength = header.XTENSION === 'BINTABLE' || header.XTENSION === 'TABLE'
      ? tableLength + (Number(header.PCOUNT) || 0)
      : elements * bytesPerPixel;
    if (selected && header.EXTNAME === 'FLAGS' && header.ZCMPTYPE === 'RICE_1' && dataOffset + dataLength <= bytes.length) {
      const width = Number(header.ZNAXIS1), height = Number(header.ZNAXIS2), tileHeight = Number(header.ZTILE2);
      if (Number(header.ZBITPIX) !== 32 || tileHeight !== 1 || width !== selected.axes[0] || height !== selected.axes[1]) throw new Error('The compressed FLAGS image has an unsupported tile layout.');
      const heapStart = dataOffset + (Number(header.THEAP) || tableLength);
      const viewRows = new DataView(buffer, dataOffset, tableLength);
      flags = new Uint32Array(width * height);
      for (let row = 0; row < height; row++) {
        const rowOffset = row * Number(header.NAXIS1);
        const compressedLength = viewRows.getInt32(rowOffset, false), heapOffset = viewRows.getInt32(rowOffset + 4, false);
        const start = heapStart + heapOffset, end = start + compressedLength;
        if (compressedLength < 5 || start < dataOffset + tableLength || end > dataOffset + dataLength) throw new Error('A compressed FLAGS row is outside its FITS heap.');
        const decoded = decodeRice32(bytes.subarray(start, end), new Int32Array(width), 32);
        for (let x = 0; x < width; x++) flags[row * width + x] = decoded[x] >>> 0;
      }
    }
    if (count >= 2 && axes[0] > 1 && axes[1] > 1 && [-64, -32, 8, 16, 32, 64].includes(bitpix) && dataOffset + dataLength <= bytes.length) {
      if (header.EXTNAME === 'FLAGS' && bitpix === 32 && selected && axes[0] === selected.axes[0] && axes[1] === selected.axes[1]) {
        flags = new Uint32Array(axes[0] * axes[1]);
        for (let i = 0; i < flags.length; i++) flags[i] = view.getInt32(dataOffset + i * 4, false) >>> 0;
      } else if (!selected && header.EXTNAME !== 'FLAGS' && bitpix < 0) selected = { header, axes, bitpix, offset: dataOffset, count: axes[0] * axes[1] };
    }
    if (!dataLength) { if (dataOffset <= offset) break; offset = dataOffset; continue; }
    offset = dataOffset + Math.ceil(dataLength / 2880) * 2880;
  }
  if (!selected) throw new Error('No science image was found in the FITS cutout.');
  const { header, axes, bitpix, offset: dataOffset, count } = selected;
  const values = new Float32Array(count), scale = Number(header.BSCALE ?? 1), zero = Number(header.BZERO ?? 0), blank = header.BLANK;
  for (let i = 0; i < count; i++) {
    const p = dataOffset + i * (Math.abs(bitpix) / 8); let value;
    if (bitpix === -32) value = view.getFloat32(p, false);
    else if (bitpix === -64) value = view.getFloat64(p, false);
    else if (bitpix === 8) value = view.getUint8(p);
    else if (bitpix === 16) value = view.getInt16(p, false);
    else if (bitpix === 32) value = view.getInt32(p, false);
    else value = Number.NaN;
    values[i] = value === blank ? Number.NaN : value * scale + zero;
  }
  const sourceX = Math.round(Number(header.CRVAL1A || 0) + 1 - Number(header.CRPIX1A ?? 1));
  const sourceY = Math.round(Number(header.CRVAL2A || 0) + 1 - Number(header.CRPIX2A ?? 1));
  return { values, width: axes[0], height: axes[1], header, flags, sourceX, sourceY };
}

export function matrixFor(header) {
  const firstAxis = String(header.CTYPE1 || '');
  const secondAxis = String(header.CTYPE2 || '');
  if (!/^RA---TAN(?:-SIP)?$/.test(firstAxis) || !/^DEC--TAN(?:-SIP)?$/.test(secondAxis)) throw new Error('This image uses an unsupported sky projection; its pixels cannot be aligned safely.');
  let a = Number(header.CD1_1), b = Number(header.CD1_2), c = Number(header.CD2_1), d = Number(header.CD2_2);
  if (![a, b, c, d].every(Number.isFinite)) {
    const sx = Number(header.CDELT1), sy = Number(header.CDELT2);
    const p11 = Number(header.PC1_1 ?? 1), p12 = Number(header.PC1_2 ?? 0), p21 = Number(header.PC2_1 ?? 0), p22 = Number(header.PC2_2 ?? 1);
    a = sx * p11; b = sx * p12; c = sy * p21; d = sy * p22;
  }
  const determinant = a * d - b * c;
  if (![a, b, c, d].every(Number.isFinite) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) throw new Error('The FITS image has no usable sky-coordinate grid.');
  return { a, b, c, d, determinant };
}

function bilinear(image, x, y, settings, variance, outputIndex) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let sum = 0, weight = 0, varianceSum = 0;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const px = x0 + dx, py = y0 + dy;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), value = image.values[py * image.width + px];
    const index = py * image.width + px;
    const flagged = (settings.hideBadPixels && image.flags && (image.flags[index] & BAD_PIXEL_MASK) !== 0) || image.derivedTransientPixels?.has(index);
    if (w > 0 && Number.isFinite(value) && !flagged) {
      sum += w * value; weight += w;
      if (variance) {
        const v = image.variance[index];
        varianceSum += Number.isFinite(v) && v > 0 ? w * w * v : NaN;
      }
    }
  }
  if (variance && weight > 0) variance[outputIndex] = varianceSum / (weight * weight);
  return weight > 0 ? sum / weight : Number.NaN;
}

function lanczosWeights(position, start) {
  const sinc = x => x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  return Array.from({ length: 6 }, (_, i) => {
    const distance = position - start - i;
    return Math.abs(distance) < 3 ? sinc(distance) * sinc(distance / 3) : 0;
  });
}

// Require the entire stencil. Renormalizing a truncated signed kernel can
// amplify noise at detector boundaries or next to masked stellar pixels.
function lanczos3(image, x, y, settings, variance, outputIndex) {
  const x0 = Math.floor(x) - 2, y0 = Math.floor(y) - 2;
  if (x0 < 0 || y0 < 0 || x0 + 5 >= image.width || y0 + 5 >= image.height) return NaN;
  const wx = lanczosWeights(x, x0), wy = lanczosWeights(y, y0);
  let sum = 0, weight = 0, varianceSum = 0;
  for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 6; dx++) {
    const index = (y0 + dy) * image.width + x0 + dx;
    const value = image.values[index];
    if (!Number.isFinite(value) || (settings.hideBadPixels && (image.flags?.[index] & BAD_PIXEL_MASK))
      || image.derivedTransientPixels?.has(index)) return NaN;
    const w = wx[dx] * wy[dy];
    sum += w * value;
    weight += w;
    if (variance && w !== 0) {
      const v = image.variance[index];
      varianceSum += Number.isFinite(v) && v > 0 ? w * w * v : NaN;
    }
  }
  if (variance) variance[outputIndex] = varianceSum / (weight * weight);
  return sum / weight;
}

export function projectSkyToPixel(image, ra, dec) {
  const h = image.header, matrix = image.matrix;
  const deg = Math.PI / 180, ra0 = Number(h.CRVAL1) * deg, dec0 = Number(h.CRVAL2) * deg;
  const dra = ((ra * deg - ra0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const decRad = dec * deg, denom = Math.sin(dec0) * Math.sin(decRad) + Math.cos(dec0) * Math.cos(decRad) * Math.cos(dra);
  if (denom <= 0) return null;
  const xi = Math.cos(decRad) * Math.sin(dra) / denom / deg;
  const eta = (Math.cos(dec0) * Math.sin(decRad) - Math.sin(dec0) * Math.cos(decRad) * Math.cos(dra)) / denom / deg;
  const dx = (matrix.d * xi - matrix.b * eta) / matrix.determinant;
  const dy = (-matrix.c * xi + matrix.a * eta) / matrix.determinant;
  let x = dx, y = dy;
  const sip = (prefix, order, u, v) => {
    let value = 0;
    for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) value += Number(h[`${prefix}_${i}_${j}`] || 0) * u ** i * v ** j;
    return value;
  };
  if (String(h.CTYPE1).endsWith('-SIP')) {
    for (let i = 0; i < 3; i++) { x = dx - sip('A', Number(h.A_ORDER) || 0, x, y); y = dy - sip('B', Number(h.B_ORDER) || 0, x, y); }
  }
  return [Number(h.CRPIX1) - 1 + x, Number(h.CRPIX2) - 1 + y];
}


export const PIXEL_ARCSEC = 6.15;
export function gridSize(fovArcmin) { return Math.max(1, Math.round(fovArcmin * 60 / PIXEL_ARCSEC)); }

let lastSkyGrid;
export function skyGrid(target, fovArcmin) {
  const key = `${target.raDeg}|${target.decDeg}|${fovArcmin}`;
  if (lastSkyGrid?.key === key) return lastSkyGrid.grid;
  const width = gridSize(fovArcmin), coordinates = new Float64Array(width * width * 2);
  const deg = Math.PI / 180, ra0 = target.raDeg * deg, dec0 = target.decDeg * deg;
  const scale = PIXEL_ARCSEC / 3600 * deg, half = (width - 1) / 2;
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const xi = (half - x) * scale, eta = (half - y) * scale;
    const denom = Math.cos(dec0) - eta * Math.sin(dec0), at = (y * width + x) * 2;
    coordinates[at] = (ra0 + Math.atan2(xi, denom)) / deg;
    coordinates[at + 1] = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(denom, xi)) / deg;
  }
  const grid = { width, coordinates };
  lastSkyGrid = { key, grid };
  return grid;
}

// Identical source footprint for ranged originals and server-generated cutouts.
// The margin supports bilinear interpolation and the inspection neighbourhood.
export function sourceBounds(image, grid) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  image.matrix ||= matrixFor(image.header);
  for (let k = 0; k < grid.coordinates.length; k += 2) {
    const p = projectSkyToPixel(image, grid.coordinates[k], grid.coordinates[k + 1]);
    if (!p || !p.every(Number.isFinite)) continue;
    xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]);
    ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]);
  }
  if (xmax < 0 || ymax < 0 || xmin > image.width - 1 || ymin > image.height - 1 || !Number.isFinite(xmin)) throw new Error('No detector coverage for this field.');
  return {
    x0: Math.max(0, Math.floor(xmin) - 3), x1: Math.min(image.width - 1, Math.ceil(xmax) + 3),
    y0: Math.max(0, Math.floor(ymin) - 3), y1: Math.min(image.height - 1, Math.ceil(ymax) + 3)
  };
}

export function cropImage(image, bounds) {
  const { x0, x1, y0, y1 } = bounds, width = x1 - x0 + 1, height = y1 - y0 + 1;
  const values = new Float32Array(width * height), flags = image.flags ? new Uint32Array(width * height) : null;
  const variance = image.variance ? new Float32Array(values.length) : undefined;
  for (let y = 0; y < height; y++) {
    const start = (y + y0) * image.width + x0;
    values.set(image.values.subarray(start, start + width), y * width);
    if (flags) flags.set(image.flags.subarray(start, start + width), y * width);
    if (variance) variance.set(image.variance.subarray(start, start + width), y * width);
  }
  const header = { ...image.header, NAXIS1: width, NAXIS2: height, CRPIX1: Number(image.header.CRPIX1) - x0, CRPIX2: Number(image.header.CRPIX2) - y0 };
  return { values, flags, variance, width, height, header, matrix: matrixFor(header), sourceX: (image.sourceX || 0) + x0, sourceY: (image.sourceY || 0) + y0 };
}

export function projectImage(image, target, settings, grid = skyGrid(target, settings.fovArcmin)) {
  image.matrix ||= matrixFor(image.header);
  const good = [];
  for (let i = 0; i < image.values.length; i++) {
    if (Number.isFinite(image.values[i]) && !(settings.hideBadPixels && image.flags && (image.flags[i] & BAD_PIXEL_MASK)) && !image.derivedTransientPixels?.has(i)) good.push(image.values[i]);
  }
  if (!good.length) throw new Error('No valid pixels remain after applying the quality mask.');
  const background = estimateBackground(good).level;
  const values = new Float32Array(grid.width ** 2), flags = new Uint32Array(values.length), covered = new Uint8Array(values.length);
  values.fill(NaN);
  const variance = image.variance ? new Float32Array(values.length).fill(NaN) : undefined;
  const lanczosUsed = settings.resampling === 'lanczos3' ? new Uint8Array(values.length) : undefined;
  let coveredPixels = 0;
  for (let i = 0; i < values.length; i++) {
    const p = projectSkyToPixel(image, grid.coordinates[2 * i], grid.coordinates[2 * i + 1]);
    if (!p) continue;
    const [x, y] = p;
    if (x >= 0 && y >= 0 && x < image.width && y < image.height) { covered[i] = 1; coveredPixels++; }
    let sample = lanczosUsed ? lanczos3(image, x, y, settings, variance, i) : NaN;
    if (Number.isFinite(sample)) lanczosUsed[i] = 1;
    else sample = bilinear(image, x, y, settings, variance, i);
    if (Number.isFinite(sample)) values[i] = sample - background;
    const ix = Math.round(x), iy = Math.round(y);
    if (ix >= 0 && iy >= 0 && ix < image.width && iy < image.height) flags[i] = image.flags?.[iy * image.width + ix] || 0;
  }
  return { values, flags, variance, covered, background, coverage: coveredPixels / values.length, width: grid.width,
    ...(lanczosUsed ? { lanczosUsed } : {}) };
}

export function prepareImage(image, target, settings) {
  const grid = skyGrid(target, settings.fovArcmin);
  image = cropImage(image, sourceBounds(image, grid));
  image.projection = projectImage(image, target, settings, grid);
  image.projectionKey = projectionKey(target, settings);
  return image;
}
export function projectionKey(target, settings) {
  const key = [target.raDeg, target.decDeg, settings.fovArcmin, Boolean(settings.hideBadPixels)].join('|');
  return settings.resampling === 'lanczos3' ? key + '|lanczos3' : key;
}
