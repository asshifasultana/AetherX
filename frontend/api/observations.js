import { SearchError } from '../lib/observations.js';
import { createIndexedSearch } from '../lib/index-store.js';
import { gzipSync } from 'node:zlib';
// Search results compress ~16x (Barnard's Star: 408 KB of JSON becomes 25 KB).
// Always gzip and never send Vary: Vercel's CDN keys Vary on the exact
// Accept-Encoding string, which would give each browser its own cache.
function sendJson(req, res, data) {
  const body = Buffer.from(JSON.stringify(data));
  const gzip = body.length > 1024;
  if (gzip) res.setHeader('Content-Encoding', 'gzip');
  res.end(gzip ? gzipSync(body, { level: 6 }) : body);
}

const searchObservations = createIndexedSearch();
export function createObservationsHandler(search = searchObservations) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; res.end(JSON.stringify({ error: 'Use GET to search observations.' })); return; }
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnect);
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const result = await search(params, { signal: controller.signal });
      if (!res.destroyed) {
        if (!result.source?.fallback && !result.source?.stale) res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=60');
        sendJson(req, res, result);
      }
    } catch (error) {
      if (res.destroyed) return;
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      res.statusCode = error instanceof SearchError || error.retryAfter ? error.status : 500;
      res.end(JSON.stringify({ error: error instanceof SearchError || error.retryAfter ? error.message : 'Observation search failed. Please retry.', ...(error instanceof SearchError && error.code ? { code: error.code } : {}) }));
    } finally { res.off('close', disconnect); }
  };
}
export default createObservationsHandler();
