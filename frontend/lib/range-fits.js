import { parseHeader, matrixFor, sourceBounds, skyGrid, cropImage } from './fits-engine.js';
import { decodeRice32 } from './rice.js';

const BLOCK = 2880;
export const MAX_RANGE_BYTES = 24 * 1024 * 1024;
export function cloudUrl(url) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://irsa.ipac.caltech.edu' || parsed.search || parsed.hash || !/^\/ibe\/data\/spherex\/qr\d+\/level2\/[\w/.-]+\.fits$/.test(parsed.pathname) || parsed.pathname.includes('..')) throw new Error('Invalid science product URL.');
  return 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/' + parsed.pathname.slice('/ibe/data/spherex/'.length);
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

export function createRangeReader({ fetchImpl = fetch, wait = sleep, random = Math.random } = {}) {
  // Bound simultaneous range buffers, including science and FLAGS requests.
  let reserved = 0;
  const waiters = [];
  const capacity = 32 * 1024 * 1024;
  async function reserve(size, signal) {
    while (reserved + size > capacity) {
      await new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { const index = waiters.indexOf(done); if (index >= 0) waiters.splice(index, 1); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true }); waiters.push(done);
      });
      signal?.throwIfAborted();
    }
    reserved += size;
    return () => { reserved -= size; for (const wake of waiters.splice(0)) wake(); };
  }
  return async function read(url, start, end, signal) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > MAX_RANGE_BYTES) throw new Error('Unsupported FITS byte range.');
    const size = end - start + 1;
    signal?.throwIfAborted();
    const release = await reserve(size, signal);
    try {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error('S3 range request timed out.')), 20000);
      let response;
      try {
        response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
        if (response.status === 429 || response.status >= 500) {
          const raw = response.headers.get('retry-after');
          const retry = raw && (/^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now());
          await response.body?.cancel();
          if (attempt === 2) throw new Error(`S3 request failed (${response.status}).`);
          clearTimeout(timer);
          await wait(Math.min(30000, Math.max(0, retry || (400 * 2 ** attempt + random() * 200))), signal);
          continue;
        }
        if (response.status !== 206) { await response.body?.cancel(); throw Object.assign(new Error(`S3 did not return a partial FITS response (${response.status}).`), { permanent: true }); }
        const range = response.headers.get('content-range');
        const parsedRange = range?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
        if (range && (!parsedRange || Number(parsedRange[1]) !== start || Number(parsedRange[2]) !== end)) { await response.body?.cancel(); throw Object.assign(new Error('Mismatched FITS Content-Range.'), { permanent: true }); }
        const declared = response.headers.get('content-length');
        if (declared !== null && Number(declared) !== size) { await response.body?.cancel(); throw Object.assign(new Error('Mismatched FITS range length.'), { permanent: true }); }
        if (!response.body) throw new Error('Empty FITS range response.');
        const reader = response.body.getReader(), bytes = new Uint8Array(size);
        let offset = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            if (offset + value.length > size) throw Object.assign(new Error('FITS range exceeded its byte limit.'), { permanent: true });
            bytes.set(value, offset); offset += value.length;
          }
          if (offset !== size) throw new Error('Truncated FITS range.');
          return bytes;
        } finally { await reader.cancel().catch(() => {}); }
      } catch (error) {
        if (signal?.aborted || error.permanent || attempt === 2) throw error;
        clearTimeout(timer);
        await wait(400 * 2 ** attempt + random() * 200, signal);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    } finally { release(); }
  };
}

function dataLength(h) {
  const dimensions = Number(h.NAXIS || 0);
  let elements = dimensions ? 1 : 0;
  for (let i = 1; i <= dimensions; i++) elements *= Number(h[`NAXIS${i}`]);
  const length = (Math.abs(Number(h.BITPIX)) / 8 * elements + Number(h.PCOUNT || 0)) * Number(h.GCOUNT || 1);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid FITS HDU dimensions.');
  return Math.ceil(length / BLOCK) * BLOCK;
}

export function createFitsRangeLoader({ read = createRangeReader() } = {}) {
  const headers = new Map();
  let headerBytes = 0;
  async function headerAt(url, offset, signal, spans) {
    for (const span of spans) {
      if (span.start <= offset && span.start + span.bytes.length >= offset + BLOCK) {
        try {
          const parsed = parseHeader(span.bytes.subarray(offset - span.start), 0);
          return { header: parsed.header, dataOffset: offset + parsed.dataOffset };
        } catch (error) { if (!error.message.includes('Incomplete')) throw error; }
      }
    }
    let bytes = new Uint8Array();
    for (let n = 0; n < 24; n++) {
      const next = await read(url, offset + bytes.length, offset + bytes.length + BLOCK * (n === 0 ? 12 : 1) - 1, signal);
      const merged = new Uint8Array(bytes.length + next.length); merged.set(bytes); merged.set(next, bytes.length); bytes = merged;
      try { const parsed = parseHeader(bytes, 0); spans.push({ start: offset, bytes }); return { header: parsed.header, dataOffset: offset + parsed.dataOffset }; }
      catch (error) { if (!error.message.includes('Incomplete')) throw error; }
    }
    throw new Error('FITS header exceeds the supported size.');
  }
  async function metadata(url, signal, identity, includeVariance) {
    if (headers.has(identity)) return headers.get(identity);
    const spans = [];
    let offset = 0, image, flags, variance;
    for (let hdu = 0; hdu < 16; hdu++) {
      const info = await headerAt(url, offset, signal, spans);
      if (info.header.EXTNAME === 'IMAGE') image = info;
      if (info.header.EXTNAME === 'FLAGS') flags = info;
      if (info.header.EXTNAME === 'VARIANCE') variance = info;
      if (image && flags && (!includeVariance || variance)) break;
      offset = info.dataOffset + dataLength(info.header);
    }
    if (!image || !flags) throw new Error('Required IMAGE or FLAGS extension is unavailable.');
    const bytes = spans.reduce((total, span) => total + span.bytes.byteLength, 0);
    const result = { image, flags, variance, spans, bytes };
    while (headers.size && (headers.size >= 64 || headerBytes + bytes > 8 * 1024 * 1024)) {
      const oldest = headers.keys().next().value;
      headerBytes -= headers.get(oldest).bytes; headers.delete(oldest);
    }
    if (bytes <= 8 * 1024 * 1024) { headers.set(identity, result); headerBytes += bytes; }
    return result;
  }
  return async function load(accessUrl, target, settings, signal, revision = '') {
    const url = cloudUrl(accessUrl);
    // Revision is part of metadata identity; S3 requests retain their canonical URL.
    const identity = `${url}|${revision}|${Boolean(settings.includeVariance)}`;
    const info = await metadata(url, signal, identity, settings.includeVariance);
    const cachedRead = async (start, end) => {
      const span = info.spans.find(s => s.start <= start && s.start + s.bytes.length > end);
      return span ? span.bytes.subarray(start - span.start, end - span.start + 1) : read(url, start, end, signal);
    };
    const h = info.image.header, width = Number(h.NAXIS1), height = Number(h.NAXIS2);
    const bitpix = Number(h.BITPIX), stride = Math.abs(bitpix) / 8;
    if (h.NAXIS !== 2 || ![-32, -64].includes(bitpix) || !Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height > 16 * 1024 * 1024) throw new Error('Unsupported science image layout.');
    const image = { header: h, width, height, matrix: matrixFor(h) };
    const bounds = sourceBounds(image, skyGrid(target, settings.fovArcmin));
    const { y0, y1 } = bounds, rows = y1 - y0 + 1;
    const scienceStart = info.image.dataOffset + y0 * width * stride;
    const f = info.flags.header;
    const [science, flags, variance] = await Promise.all([
      read(url, scienceStart, scienceStart + rows * width * stride - 1, signal),
      (async () => {
        if (f.XTENSION === 'IMAGE' && f.BITPIX === 32 && f.NAXIS1 === width && f.NAXIS2 === height) {
          const start = info.flags.dataOffset + y0 * width * 4;
          const bytes = await read(url, start, start + rows * width * 4 - 1, signal), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          return Uint32Array.from({ length: rows * width }, (_, i) => view.getUint32(i * 4, false));
        }
        if (f.ZCMPTYPE !== 'RICE_1' || f.ZBITPIX !== 32 || f.ZTILE1 !== width || f.ZTILE2 !== 1 || f.ZNAXIS1 !== width || f.ZNAXIS2 !== height || !/1P[Bb](?:\(\d+\))?/.test(String(f.TFORM1)) || Number(f.NAXIS1) < 8) throw new Error('Unsupported compressed FLAGS layout.');
        const tableStart = info.flags.dataOffset + y0 * f.NAXIS1;
        const descriptors = await cachedRead(tableStart, tableStart + rows * f.NAXIS1 - 1);
        const table = new DataView(descriptors.buffer, descriptors.byteOffset, descriptors.byteLength);
        const heapStart = info.flags.dataOffset + Number(f.THEAP ?? f.NAXIS1 * f.NAXIS2);
        const heapEnd = info.flags.dataOffset + f.NAXIS1 * f.NAXIS2 + f.PCOUNT;
        let lo = Infinity, hi = -Infinity;
        for (let r = 0; r < rows; r++) {
          const length = table.getInt32(r * f.NAXIS1, false), offset = table.getInt32(r * f.NAXIS1 + 4, false);
          if (length < 5 || offset < 0 || heapStart + offset + length > heapEnd) throw new Error('FLAGS descriptor lies outside its heap.');
          lo = Math.min(lo, offset); hi = Math.max(hi, offset + length);
        }
        const heap = await read(url, heapStart + lo, heapStart + hi - 1, signal);
        const result = new Uint32Array(rows * width);
        const block = f.ZNAME1 === 'BLOCKSIZE' ? Number(f.ZVAL1) : 32;
        for (let r = 0; r < rows; r++) {
          const length = table.getInt32(r * f.NAXIS1, false), start = table.getInt32(r * f.NAXIS1 + 4, false) - lo;
          result.set(decodeRice32(heap.subarray(start, start + length), new Int32Array(width), block), r * width);
        }
        return result;
      })(),
      (async () => {
        if (!settings.includeVariance) return undefined;
        const v = info.variance?.header;
        if (v?.BITPIX !== -32 || v.NAXIS1 !== width || v.NAXIS2 !== height) throw new Error('Unsupported VARIANCE layout.');
        const start = info.variance.dataOffset + y0 * width * 4;
        const bytes = await read(url, start, start + rows * width * 4 - 1, signal);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Float32Array.from({ length: rows * width }, (_, i) => view.getFloat32(i * 4) * Number(v.BSCALE ?? 1) + Number(v.BZERO ?? 0));
      })()
    ]);
    const view = new DataView(science.buffer, science.byteOffset, science.byteLength), values = new Float32Array(rows * width);
    for (let i = 0; i < values.length; i++) values[i] = (bitpix === -32 ? view.getFloat32(i * stride, false) : view.getFloat64(i * stride, false)) * Number(h.BSCALE ?? 1) + Number(h.BZERO ?? 0);
    const shifted = { ...h, CRPIX2: Number(h.CRPIX2) - y0, NAXIS2: rows };
    return cropImage({ values, flags, variance, width, height: rows, header: shifted, sourceY: y0 }, { ...bounds, y0: 0, y1: rows - 1 });
  };
}
