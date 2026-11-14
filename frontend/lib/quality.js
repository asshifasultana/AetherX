import { scienceUrl, SearchError } from './observations.js';

function readCardValue(card) {
  const equals = card.indexOf('='); if (equals < 0) return null;
  let body = card.slice(equals + 1), inString = false, slash = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "'") { if (inString && body[i + 1] === "'") i++; else inString = !inString; }
    if (body[i] === '/' && !inString) { slash = i; break; }
  }
  const raw = (slash >= 0 ? body.slice(0, slash) : body).trim();
  const comment = slash >= 0 ? body.slice(slash + 1).trim() : '';
  let value = raw;
  if (raw.startsWith("'")) value = raw.slice(1, raw.lastIndexOf("'")).replaceAll("''", "'").trim();
  else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[DE][+-]?\d+)?$/i.test(raw)) value = Number(raw.replace(/D/i, 'e'));
  else if (raw === 'T' || raw === 'F') value = raw === 'T';
  return { value, comment };
}
export function parseFitsQuality(bytes) {
  const text = new TextDecoder('ascii').decode(bytes); let offset = 0;
  for (let hdu = 0; hdu < 3 && offset < text.length; hdu++) {
    const entries = new Map(); let end = -1;
    if (!['SIMPLE', 'XTENSION'].includes(text.slice(offset, offset + 8).trim())) throw new SearchError('The archive did not return a FITS header.');
    for (let at = offset; at + 80 <= text.length; at += 80) {
      const card = text.slice(at, at + 80), keyword = card.slice(0, 8).trim();
      if (keyword === 'END') { end = at + 80; break; }
      const parsed = readCardValue(card);
      if (parsed) entries.set(keyword === 'HIERARCH' ? card.slice(8, card.indexOf('=')).trim() : keyword, parsed);
    }
    if (end < 0) throw new SearchError('The archive header is incomplete. Please retry.');
    if (entries.get('EXTNAME')?.value === 'IMAGE') {
      const counts = [...entries].filter(([key, field]) => /^L2 N_/.test(key) && typeof field.value === 'number').map(([keyword, field]) => ({ keyword, count: field.value, description: field.comment }));
      return {
        source: 'FITS IMAGE extension header', observedAt: entries.get('DATE-OBS')?.value || null,
        detector: entries.get('DETECTOR')?.value ?? null, observationId: entries.get('OBSID')?.value || null,
        fineAstrometry: entries.get('FINAST') ? { keyword: 'FINAST', ...entries.get('FINAST') } : null,
        imagePixels: Number(entries.get('NAXIS1')?.value || 0) * Number(entries.get('NAXIS2')?.value || 0) || null,
        flaggedPixelCounts: counts, targetPixelAssessment: 'not-assessed',
        note: 'Counts describe the entire detector image and may overlap. They do not indicate whether the selected target pixel is affected.'
      };
    }
    const naxis = Number(entries.get('NAXIS')?.value || 0); let pixels = naxis ? 1 : 0;
    for (let axis = 1; axis <= naxis; axis++) pixels *= Number(entries.get('NAXIS' + axis)?.value || 0);
    const size = Math.abs(Number(entries.get('BITPIX')?.value || 0)) / 8 * (pixels + Number(entries.get('PCOUNT')?.value || 0)) * Number(entries.get('GCOUNT')?.value || 1);
    offset += Math.ceil((end - offset) / 2880) * 2880 + Math.ceil(size / 2880) * 2880;
  }
  throw new SearchError('No IMAGE quality header was found in the requested header range.');
}
export function createQualityService({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function inspectQuality(url) {
    const verified = scienceUrl(url);
    if (!verified) throw new SearchError('Choose a valid SPHEREx science product from the search results.', 400);
    const cached = cache.get(verified);
    if (cached && cached.expires > now()) return cached.result;
    const requestUrl = 'https://nasa-irsa-spherex.s3.amazonaws.com/' + verified.split('/ibe/data/spherex/')[1];
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetchImpl(requestUrl, { headers: { Range: 'bytes=0-65535' }, signal: controller.signal });
      if (response.status !== 206) { await response.body?.cancel(); throw new SearchError('The archive could not provide a bounded FITS-header read. No full image was downloaded.'); }
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 65536) { await reader.cancel(); throw new SearchError('The archive returned more header data than requested.'); } chunks.push(value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const result = { ...parseFitsQuality(bytes), accessUrl: verified, retrievedAt: new Date().toISOString(), bytesRead: length };
      cache.set(verified, { result, expires: now() + 300000 }); while (cache.size > 100) cache.delete(cache.keys().next().value);
      return result;
    } catch (error) {
      if (error instanceof SearchError) throw error;
      throw new SearchError(controller.signal.aborted ? 'Quality-header request timed out. Please retry.' : 'Could not read the quality header. Please retry.', controller.signal.aborted ? 504 : 502);
    } finally { clearTimeout(timer); }
  };
}
