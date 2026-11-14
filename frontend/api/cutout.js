import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CACHE_DIR = path.join(os.tmpdir(), 'spherex-cutouts-v1');
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const pending = new Map();
const respond = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data)); };
class CutoutError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export function validateCutout(params) {
  const url = params.get('url') || '';
  let parsed;
  try { parsed = new URL(url); } catch { throw new CutoutError('Choose a valid SPHEREx FITS product.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'irsa.ipac.caltech.edu' || !/^\/ibe\/data\/spherex\/qr\d+\/level2\/[\w/.-]+\.fits$/.test(parsed.pathname) || parsed.pathname.includes('..')) throw new CutoutError('Only public SPHEREx science FITS products from IRSA can be cut out.');
  const number = (name, min, max, inclusive = true) => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new CutoutError(`Enter a valid ${name}.`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || (inclusive ? value > max : value >= max)) throw new CutoutError(`${name} is outside the supported range.`);
    return value;
  };
  const revision = params.get('revision') || '';
  if (revision.length > 100 || /[\x00-\x1f\x7f]/.test(revision)) throw new CutoutError('The observation revision is invalid.');
  return { url: parsed.origin + parsed.pathname, raDeg: number('raDeg', 0, 360, false), decDeg: number('decDeg', -90, 90), fovArcmin: number('fovArcmin', 1, 300), revision };
}

function cacheKey(input) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
function isFits(bytes) {
  return bytes.length >= 80 && Buffer.from(bytes.subarray(0, 8)).toString('ascii') === 'SIMPLE  ';
}

async function getCutout(input, fetchImpl) {
  const key = cacheKey(input), file = path.join(CACHE_DIR, key + '.fits');
  try {
    const details = await stat(file);
    if (Date.now() - details.mtimeMs < MAX_AGE_MS) return { bytes: await readFile(file), cached: true };
    await rm(file, { force: true });
  } catch {}
  if (pending.has(key)) return { bytes: await pending.get(key), cached: true };
  const job = (async () => {
    const target = new URL(input.url);
    target.search = new URLSearchParams({ center: `${input.raDeg},${input.decDeg}`, size: `${input.fovArcmin}arcmin` }).toString();
    let response, networkError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetchImpl(target, { headers: { Accept: 'application/fits, application/octet-stream' }, signal: AbortSignal.timeout(90000) });
        if (response.status < 500 || attempt === 2) break;
        await response.body?.cancel();
      } catch (error) {
        networkError = error;
        if (attempt === 2) break;
      }
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (!response && networkError) {
      const message = networkError.name === 'TimeoutError'
        ? 'IRSA took too long to return this cutout. Try again or choose a smaller field of view.'
        : 'Could not connect to the IRSA archive. Check your internet connection and try again.';
      throw new CutoutError(message, 502);
    }
    if (!response.ok) throw new CutoutError(response.status === 404 ? 'IRSA could not find this image cutout.' : `IRSA cutout request failed (${response.status}).`, response.status === 404 ? 404 : 502);
    const reader = response.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('This cutout is larger than the 24 MB safety limit. Choose a smaller field of view.'); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    if (!isFits(bytes)) throw new Error('IRSA returned an invalid FITS cutout. Please retry or choose another observation.');
    await mkdir(CACHE_DIR, { recursive: true });
    const temp = path.join(CACHE_DIR, key + '.' + process.pid + '.tmp');
    try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, file); } catch (error) { await rm(temp, { force: true }); if (error.code !== 'EEXIST') throw error; }
    return bytes;
  })();
  pending.set(key, job);
  try { return { bytes: await job, cached: false }; } finally { pending.delete(key); }
}

export function createCutoutHandler(fetchImpl = fetch) {
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); respond(res, 405, { error: 'Use GET to retrieve an image cutout.' }); return; }
    try {
      const input = validateCutout(new URL(req.url, 'http://localhost').searchParams);
      const { bytes, cached } = await getCutout(input, fetchImpl);
      res.statusCode = 200; res.setHeader('Content-Type', 'application/fits'); res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('X-Cutout-Cache', cached ? 'HIT' : 'MISS'); res.setHeader('Cache-Control', 'private, max-age=3600'); res.end(bytes);
    } catch (error) { respond(res, error.status || 502, { error: error.message || 'Could not retrieve the cutout. Please retry.' }); }
  };
}
export default createCutoutHandler();
