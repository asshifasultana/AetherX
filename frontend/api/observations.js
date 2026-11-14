import { SearchError } from '../lib/observations.js';
import { createIndexedSearch } from '../lib/index-store.js';

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
        if (!result.source?.fallback) res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=60');
        res.end(JSON.stringify(result));
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
