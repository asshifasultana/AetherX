import { matrixFor } from './fits-engine.js';

// Decodes the binary payload written by api/crop.js (see encodeCrop there).
export function decodeCrop(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 9 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'SPXC' || bytes[4] !== 1) throw new Error('Unsupported cropped image payload.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(5, true);
  if (9 + length > bytes.length) throw new Error('Truncated cropped image payload.');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + length)));
  const size = meta.width * meta.height;
  if (!Number.isSafeInteger(size) || size < 1 || size > 16 * 1024 * 1024) throw new Error('Invalid cropped image dimensions.');
  let at = Math.ceil((9 + length) / 4) * 4;
  const plane = Type => {
    if (at + size * 4 > bytes.length) throw new Error('Truncated cropped image payload.');
    // Copy into an aligned, standalone buffer so the result stays transferable.
    const out = new Type(size), source = new DataView(bytes.buffer, bytes.byteOffset + at, size * 4);
    const float = Type === Float32Array;
    for (let i = 0; i < size; i++) out[i] = float ? source.getFloat32(i * 4, true) : source.getUint32(i * 4, true);
    at += size * 4;
    return out;
  };
  const values = plane(Float32Array), flags = meta.hasFlags ? plane(Uint32Array) : null, variance = meta.hasVariance ? plane(Float32Array) : undefined;
  if (at !== bytes.length) throw new Error('Unexpected data after cropped image payload.');
  return { values, flags, variance, width: meta.width, height: meta.height, header: meta.header, matrix: matrixFor(meta.header), sourceX: meta.sourceX, sourceY: meta.sourceY };
}

export const PROXY_MAX_FOV = 30, PROXY_TIMEOUT_MS = 30000;
const retryDelay = (ms, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
});
// The query that fully determines a crop. It addresses the proxy and is also the
// key under which scripts/bake-tour-view.mjs files a crop saved with the site.
export function cropQuery({ accessUrl, target, settings, revision }) {
  return new URLSearchParams({
    url: accessUrl, raDeg: String(((target.raDeg % 360) + 360) % 360), decDeg: String(target.decDeg), fovArcmin: String(settings.fovArcmin), revision: revision || '',
    flags: settings.hideBadPixels === false && settings.includeFlags !== true ? '0' : '1', variance: settings.includeVariance ? '1' : '0'
  }).toString();
}

// A crop saved with the site: the proxy's own gzipped payload as a static file.
// Returns null on any failure, so the caller asks the proxy as usual.
async function loadBaked(bakedUrl, signal, fetchImpl) {
  try {
    const response = await fetchImpl(bakedUrl, { signal });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    return decodeCrop(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  } catch (error) { if (signal?.aborted) throw signal.reason; return null; }
}

// Fetches the exposure already cropped next to the S3 bucket. Returns null when
// the proxy cannot serve this request, so the caller reads S3 directly instead.
export async function loadViaProxy({ proxyUrl, bakedUrl, accessUrl, target, settings, revision }, signal, fetchImpl = fetch) {
  if (!proxyUrl || !(settings.fovArcmin <= PROXY_MAX_FOV)) return null;
  if (bakedUrl) { const baked = await loadBaked(bakedUrl, signal, fetchImpl); if (baked) return baked; }
  const url = new URL(proxyUrl);
  url.search = cropQuery({ accessUrl, target, settings, revision });
  const timeout = AbortSignal.timeout(PROXY_TIMEOUT_MS), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  // A busy instance (503) usually frees a slot within a moment; retry briefly
  // before giving up on the proxy and reading S3 directly.
  for (let attempt = 0; ; attempt++) {
    try { response = await fetchImpl(url, { signal: combined }); }
    catch (error) { if (signal?.aborted) throw signal.reason; return null; }
    if (response.status !== 503 || attempt === 2) break;
    await response.body?.cancel().catch(() => {});
    try { await retryDelay(250 * (attempt + 1) + Math.random() * 250, combined); }
    catch { if (signal?.aborted) throw signal.reason; return null; }
  }
  if (response.status === 422) {
    // The field has no detector coverage; a direct S3 read would fail
    // identically, so surface the proxy's explanation. Other failures
    // (including validation mismatches) fall back to reading S3 directly.
    let message = `Cropped image request failed (${response.status}).`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
  try { return decodeCrop(await response.arrayBuffer()); }
  catch (error) { if (signal?.aborted) throw signal.reason; return null; }
}
