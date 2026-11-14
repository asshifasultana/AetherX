import { parseHeader, projectSkyToPixel } from './fits-engine.js';
import { MASKED_FLAG_BITS } from './pixel-quality.js';
import { injectProfile } from './comet-profile.js';
import { createRangeReader } from './range-fits.js';

const BAD = MASKED_FLAG_BITS.reduce((mask, bit) => mask | (1 << bit), 0);
const calibrations = new Map();

export async function loadCometEpsf(detector, read = createRangeReader()) {
  if (!Number.isInteger(detector) || detector < 1 || detector > 6) throw new Error('Invalid ePSF detector.');
  if (!calibrations.has(detector)) {
    const version = `cal-epsf-v${detector === 3 ? 2 : 1}-2026-191`;
    const url = `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/epsf/${version}/${detector}/epsf_D${detector}_spx_${version}.fits`;
    const result = (async () => {
      const bytes = await read(url, 0, 11519);
      const { header, dataOffset } = parseHeader(bytes, parseHeader(bytes, 0).dataOffset);
      const [width, height] = String(header.TDIM11).match(/\d+/g)?.map(Number) ?? [];
      if (header.EXTNAME !== 'EPSF' || header.TTYPE3 !== 'XCENTER' || header.TTYPE4 !== 'YCENTER' ||
          header.TTYPE11 !== 'EPSF' || header.TFORM11 !== `${width * height}D` ||
          header.NAXIS1 !== 40 + 8 * width * height || !(header.OVSMPX > 0 && header.OVSMPY > 0) ||
          !(header.NAXIS2 > 0 && header.NAXIS2 < 1000)) throw new Error('Unsupported ePSF table layout.');
      const table = await read(url, dataOffset, dataOffset + header.NAXIS1 * header.NAXIS2 - 1);
      const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
      const zones = Array.from({ length: header.NAXIS2 }, (_, i) => {
        const offset = i * header.NAXIS1;
        return { x: view.getFloat32(offset + 8), y: view.getFloat32(offset + 12), offset };
      });
      return (x, y) => {
        const zone = zones.reduce((best, next) => (next.x - x) ** 2 + (next.y - y) ** 2 <
          (best.x - x) ** 2 + (best.y - y) ** 2 ? next : best);
        return (dx, dy) => {
          const px = dx * header.OVSMPX + (width - 1) / 2, py = dy * header.OVSMPY + (height - 1) / 2;
          if (px < 0 || py < 0 || px >= width - 1 || py >= height - 1) return 0;
          const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
          const at = (u, v) => view.getFloat64(zone.offset + 40 + 8 * ((iy + v) * width + ix + u));
          return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
        };
      };
    })();
    calibrations.set(detector, result);
    result.catch(() => calibrations.delete(detector));
  }
  return calibrations.get(detector);
}

function stamp(epsf, x, y) {
  const x0 = Math.floor(x) - 4, y0 = Math.floor(y) - 4;
  const cells = [];
  let total = 0;
  for (let v = 0; v < 9; v++) for (let u = 0; u < 9; u++) {
    const value = epsf(x0 + u - x, y0 + v - y);
    if (value) {
      cells.push([x0 + u, y0 + v, value]);
      total += value;
    }
  }
  if (!(total > 0)) throw new Error('Invalid ePSF normalization.');
  return cells.map(([u, v, value]) => [u, v, value / total]);
}

function psfColumn(image, x, y, epsfAt) {
  const values = new Float64Array(image.values.length);
  for (const [u, v, value] of stamp(epsfAt(x + image.sourceX, y + image.sourceY), x, y)) {
    if (u >= 0 && v >= 0 && u < image.width && v < image.height) values[v * image.width + u] = value;
  }
  return values;
}

export function nativeTemplates(image, target, epsfAt, shape = { radius: 20, scale: 4 }) {
  const [x, y] = projectSkyToPixel(image, target.raDeg, target.decDeg);
  const core = psfColumn(image, x, y, epsfAt);
  const zero = { ...image, values: new Float32Array(image.values.length) };
  const profile = injectProfile(zero, target, { ...shape, amplitude: 1 }).values;
  const centerX = Math.round(x), centerY = Math.round(y);
  const kernel = stamp(epsfAt(x + image.sourceX, y + image.sourceY), centerX, centerY);
  const coma = Float64Array.from(profile, (_, i) => {
    const col = i % image.width, row = Math.floor(i / image.width);
    let sum = 0;
    for (const [u, v, weight] of kernel) {
      const px = col - u + centerX, py = row - v + centerY;
      if (px >= 0 && py >= 0 && px < image.width && py < image.height) sum += weight * profile[py * image.width + px];
    }
    return sum;
  });
  return { core, coma, x, y };
}

function valid(image, i) {
  return Number.isFinite(image.values[i]) && !(image.flags?.[i] & BAD) &&
    Number.isFinite(image.variance?.[i]) && image.variance[i] > 0;
}

export function nuisanceTemplates(image, target, epsfAt, stars, exclusionRadius = 7) {
  const [x, y] = projectSkyToPixel(image, target.raDeg, target.decDeg);
  const length = image.values.length;
  const basis = [new Float64Array(length).fill(1),
    Float64Array.from({ length }, (_, i) => (i % image.width - x) / image.width),
    Float64Array.from({ length }, (_, i) => (Math.floor(i / image.width) - y) / image.height)];
  const positions = stars ? stars.map(star => projectSkyToPixel(image, star.raDeg, star.decDeg)).filter(Boolean) : [];
  if (!stars) {
    const peaks = [];
    for (let py = 1; py < image.height - 1; py++) for (let px = 1; px < image.width - 1; px++) {
      const i = py * image.width + px;
      if (Math.hypot(px - x, py - y) < exclusionRadius || !valid(image, i)) continue;
      const neighbors = [i - 1, i + 1, i - image.width, i + image.width];
      if (neighbors.every(j => valid(image, j) && image.values[j] < image.values[i])) {
        const contrast = (image.values[i] - neighbors.reduce((sum, j) => sum + image.values[j], 0) / 4) / Math.sqrt(image.variance[i]);
        if (contrast >= 4) peaks.push({ px, py, contrast });
      }
    }
    peaks.sort((a, b) => b.contrast - a.contrast);
    for (const peak of peaks) {
      if (positions.length >= 12) break;
      if (positions.every(([px, py]) => Math.hypot(px - peak.px, py - peak.py) > 3)) positions.push([peak.px, peak.py]);
    }
  }
  for (const [px, py] of positions) {
    if (px >= 1 && py >= 1 && px < image.width - 1 && py < image.height - 1) basis.push(psfColumn(image, px, py, epsfAt));
  }
  return basis;
}

function solve(matrix, rhs) {
  const n = rhs.length;
  const scale = matrix.map((row, i) => Math.sqrt(row[i]));
  if (scale.some(v => !(v > 0))) throw new Error('Insufficient coverage to constrain the fit.');
  const rows = matrix.map((row, i) => [...row.map((v, j) => v / (scale[i] * scale[j])),
    rhs[i] / scale[i], ...Array.from({ length: n }, (_, j) => Number(i === j))]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(rows[j][i]) > Math.abs(rows[pivot][i])) pivot = j;
    [rows[i], rows[pivot]] = [rows[pivot], rows[i]];
    const divisor = rows[i][i];
    if (Math.abs(divisor) < 1e-8) throw new Error('Degenerate source or spectral model.');
    for (let k = i; k < rows[i].length; k++) rows[i][k] /= divisor;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const multiple = rows[j][i];
      for (let k = i; k < rows[j].length; k++) rows[j][k] -= multiple * rows[i][k];
    }
  }
  return { coefficients: rows.map((row, i) => row[n] / scale[i]),
    covariance: rows.map((row, i) => scale.map((s, j) => row[n + 1 + j] / (scale[i] * s))) };
}

function normalEquations(frame, robust) {
  const columns = [...frame.signal, ...frame.nuisance], n = columns.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  const rhs = new Float64Array(n);
  for (let i = 0; i < frame.image.values.length; i++) {
    if (!valid(frame.image, i)) continue;
    const value = frame.image.values[i], sigma = Math.sqrt(frame.image.variance[i]);
    let weight = 1 / (sigma * sigma);
    if (robust) {
      const predicted = columns.reduce((sum, column, j) => sum + column[i] * robust[j], 0);
      weight *= Math.min(1, 4 * sigma / Math.abs(value - predicted));
    }
    for (let j = 0; j < n; j++) {
      const term = columns[j][i] * weight;
      rhs[j] += term * value;
      for (let k = 0; k <= j; k++) matrix[j][k] += term * columns[k][i];
    }
  }
  for (let j = 0; j < n; j++) for (let k = 0; k < j; k++) matrix[k][j] = matrix[j][k];
  return { matrix, rhs };
}

export function fitNativeSequence(frames) {
  if (!frames.length || !frames[0].signal.length) throw new Error('The native fit requires exposures and signal templates.');
  const n = frames[0].signal.length;
  let estimate, local;
  for (let iteration = 0; iteration < 4; iteration++) {
    const matrix = Array.from({ length: n }, () => new Float64Array(n)), rhs = new Float64Array(n);
    const equations = frames.map((frame, i) => {
      const { matrix: full, rhs: measured } = normalEquations(frame, local?.[i]);
      const nuisance = full.slice(n).map(row => row.slice(n));
      const coupled = full.slice(0, n).map(row => row.slice(n));
      const background = solve(nuisance, measured.slice(n)).coefficients;
      const effects = coupled.map(column => solve(nuisance, column).coefficients);
      const dot = (a, b) => a.reduce((sum, v, j) => sum + v * b[j], 0);
      for (let j = 0; j < n; j++) {
        rhs[j] += measured[j] - dot(coupled[j], background);
        for (let k = 0; k < n; k++) matrix[j][k] += full[j][k] - dot(coupled[j], effects[k]);
      }
      return { background, effects };
    });
    estimate = solve(matrix, rhs);
    local = equations.map(({ background, effects }) => [...estimate.coefficients, ...background.map((value, j) =>
      effects.reduce((sum, effect, k) => sum - effect[j] * estimate.coefficients[k], value))]);
  }
  return estimate;
}

