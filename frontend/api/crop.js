// Cropping proxy: reads the public SPHEREx S3 mirror from next to the bucket
// (deploy in iad1 / us-east-1), keeps only the pixels around the target and
// returns them as a compact binary payload. The browser otherwise downloads
// whole 2040-pixel detector rows, ~10x the bytes it uses. Nothing is stored.
import { gzipSync } from 'node:zlib';
import { createFitsRangeLoader, cloudUrl } from '../lib/range-fits.js';
import { createWorkGate } from '../lib/resources.js';

export const CROP_MAGIC = 'SPXC', CROP_VERSION = 1, MAX_CROP_FOV = 30;
const respond = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data)); };
class CropError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export function validateCrop(params) {
  const url = params.get('url') || '';
  try { cloudUrl(url); } catch { throw new CropError('Only public SPHEREx science FITS products from IRSA can be cropped.'); }
  const number = (name, min, max, inclusive = true) => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw new CropError(`Enter a valid ${name}.`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || (inclusive ? value > max : value >= max)) throw new CropError(`${name} is outside the supported range.`);
    return value;
  };
  const flag = name => {
    const raw = params.get(name);
    if (raw !== null && raw !== '0' && raw !== '1') throw new CropError(`Invalid ${name} option.`);
    return raw === '1';
  };
  const revision = params.get('revision') || '';
  if (revision.length > 100 || /[\x00-\x1f\x7f]/.test(revision)) throw new CropError('The observation revision is invalid.');
  return { url, raDeg: number('raDeg', 0, 360, false), decDeg: number('decDeg', -90, 90), fovArcmin: number('fovArcmin', 1, MAX_CROP_FOV), revision, flags: flag('flags'), variance: flag('variance') };
}

// Layout: "SPXC" u8 version, u32le JSON length, JSON metadata, zero padding to a
// multiple of 4, then little-endian Float32 values, Uint32 flags, Float32 variance.
export function encodeCrop(image) {
  const meta = Buffer.from(JSON.stringify({ width: image.width, height: image.height, header: image.header, sourceX: image.sourceX, sourceY: image.sourceY, hasFlags: Boolean(image.flags), hasVariance: Boolean(image.variance) }));
  const offset = Math.ceil((9 + meta.length) / 4) * 4;
  const planes = [image.values, image.flags, image.variance].filter(Boolean);
  const out = Buffer.alloc(offset + planes.reduce((n, p) => n + p.byteLength, 0));
  out.write(CROP_MAGIC, 0, 'ascii'); out.writeUInt8(CROP_VERSION, 4); out.writeUInt32LE(meta.length, 5); meta.copy(out, 9);
  let at = offset;
  for (const plane of planes) {
    const bytes = new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength);
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) out.set(bytes, at);
    else for (let i = 0; i < bytes.length; i += 4) { out[at + i] = bytes[i + 3]; out[at + i + 1] = bytes[i + 2]; out[at + i + 2] = bytes[i + 1]; out[at + i + 3] = bytes[i]; }
    at += plane.byteLength;
  }
  return out;
}

export function createCropHandler({ load = createFitsRangeLoader(), gate = createWorkGate({ slots: 16 }), timeoutMs = 25000 } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); respond(res, 405, { error: 'Use GET to retrieve a cropped image.' }); return; }
    let release, timer;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(new Error('Client disconnected.')); };
    res.once('close', disconnect);
    try {
      const input = validateCrop(new URL(req.url, 'http://localhost').searchParams);
      release = gate.acquire();
      timer = setTimeout(() => controller.abort(new CropError('The SPHEREx archive took too long to return this exposure.', 504)), timeoutMs);
      const settings = { fovArcmin: input.fovArcmin, hideBadPixels: input.flags, includeFlags: input.flags, includeVariance: input.variance };
      let image;
      try { image = await load(input.url, { raDeg: input.raDeg, decDeg: input.decDeg }, settings, controller.signal, input.revision); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        // Geometry failures are properties of the request, not of the archive.
        throw new CropError(error.message || 'Could not read this exposure.', /coverage/i.test(error.message) ? 422 : 502);
      }
      const body = encodeCrop(image);
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      const payload = gzip ? gzipSync(body, { level: 2 }) : body;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Vary', 'Accept-Encoding');
      if (gzip) res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(payload.length));
      res.end(payload);
    } catch (error) {
      if (res.destroyed) return;
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      respond(res, error.status || 502, { error: error.message || 'Could not crop this exposure. Please retry.' });
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
      release?.();
    }
  };
}

export default createCropHandler();
