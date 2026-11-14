import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { cutoutGate } from '../lib/resources.js';
import os from 'node:os';
import path from 'node:path';

export const MAX_CUTOUT_BYTES = 24 * 1024 * 1024;
let legacyCleanup;
export function clearLegacyCutoutCache() {
  if (!legacyCleanup) {
    const parent = path.resolve(os.tmpdir());
    const directory = path.resolve(parent, 'spherex-cutouts-v1');
    if (path.dirname(directory) !== parent || path.basename(directory) !== 'spherex-cutouts-v1') throw new Error('Unsafe legacy cache path.');
    // rm removes a symlink itself; it does not follow it to a different directory.
    legacyCleanup = rm(directory, { recursive: true, force: true }).catch(error => { legacyCleanup = null; throw error; });
  }
  return legacyCleanup;
}
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
  if (params.has('aligned') && params.get('aligned') !== '1') throw new CutoutError('Invalid aligned cutout option.');
  return { url: parsed.origin + parsed.pathname, raDeg: number('raDeg', 0, 360, false), decDeg: number('decDeg', -90, 90), fovArcmin: number('fovArcmin', 1, 300), revision, aligned: params.get('aligned') === '1' };
}

const tooLarge = () => new CutoutError('This cutout exceeds the 24 MiB limit. Choose a smaller field of view.', 413);

export function createCutoutHandler(fetchImpl = fetch, { gate = cutoutGate, cleanup = clearLegacyCutoutCache, timeoutMs = 90000 } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); respond(res, 405, { error: 'Use GET to retrieve an image cutout.' }); return; }
    let release, reader, timer;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(new Error('Client disconnected.')); };
    const cancel = () => {
      reader?.cancel(controller.signal.reason).catch(() => {});
      if (res.headersSent && !res.writableFinished) res.destroy();
    };
    res.once('close', disconnect);
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      const input = validateCutout(new URL(req.url, 'http://localhost').searchParams);
      release = gate.acquire();
      timer = setTimeout(() => controller.abort(new CutoutError('IRSA took too long to return this cutout. Try again or choose a smaller field of view.', 504)), timeoutMs);
      await cleanup();
      const target = new URL(input.url);
      // A detector-aligned cutout needs room for the rotated sky square and
      // interpolation/inspection neighbours. The browser crops both transports
      // to one deterministic footprint before estimating the background.
      const cutoutSize = input.aligned ? Math.min(300, input.fovArcmin * Math.SQRT2 + 1) : input.fovArcmin;
      target.search = new URLSearchParams({ center: `${input.raDeg},${input.decDeg}`, size: `${cutoutSize}arcmin` }).toString();
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        controller.signal.throwIfAborted();
        try {
          response = await fetchImpl(target, { headers: { Accept: 'application/fits, application/octet-stream' }, signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted || attempt === 2) throw error;
          await delay(400 * (attempt + 1), undefined, { signal: controller.signal });
          continue;
        }
        if (response.status < 500 || attempt === 2) break;
        await response.body?.cancel();
        response = null;
        await delay(400 * (attempt + 1), undefined, { signal: controller.signal });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CutoutError(response.status === 404 ? 'IRSA could not find this image cutout.' : `IRSA cutout request failed (${response.status}).`, response.status === 404 ? 404 : 502);
      }
      if (Number(response.headers.get('content-length')) > MAX_CUTOUT_BYTES) { await response.body?.cancel(); throw tooLarge(); }
      if (!response.body) throw new CutoutError('IRSA returned an empty cutout.', 502);
      reader = response.body.getReader();
      let size = 0;
      const read = async () => {
        controller.signal.throwIfAborted();
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (!chunk.done && (size += chunk.value.byteLength) > MAX_CUTOUT_BYTES) { await reader.cancel(); throw tooLarge(); }
        return chunk;
      };
      // Buffer just the first FITS card before committing a successful response.
      const prefix = Buffer.alloc(80); let filled = 0, remainder;
      while (filled < prefix.length) {
        const { value, done } = await read();
        if (done) throw new CutoutError('IRSA returned an incomplete FITS cutout.', 502);
        const length = Math.min(value.length, prefix.length - filled);
        prefix.set(value.subarray(0, length), filled); filled += length;
        remainder = value.subarray(length);
      }
      if (prefix.toString('ascii', 0, 8) !== 'SIMPLE  ') throw new CutoutError('IRSA returned an invalid FITS cutout. Please retry or choose another observation.', 502);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/fits');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      await pipeline(Readable.from((async function* () {
        yield prefix;
        if (remainder.length) yield remainder;
        while (true) { const { value, done } = await read(); if (done) break; yield value; }
      })(), { objectMode: false, highWaterMark: 64 * 1024 }), res);
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (failure.retryAfter) res.setHeader('Retry-After', String(failure.retryAfter));
      respond(res, failure.status || 502, { error: failure.message || 'Could not retrieve the cutout. Please retry.' });
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
      controller.signal.removeEventListener('abort', cancel);
      controller.abort();
      try { await reader?.cancel(); } catch {}
      release?.();
    }
  };
}
export default createCutoutHandler();
