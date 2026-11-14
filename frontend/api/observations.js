import { SearchError } from '../lib/observations.js';
import { createIndexedSearch } from '../lib/index-store.js';

const searchObservations = createIndexedSearch();
export function createObservationsHandler(search = searchObservations) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; res.end(JSON.stringify({ error: 'Use GET to search observations.' })); return; }
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      res.end(JSON.stringify(await search(params)));
    } catch (error) {
      res.statusCode = error instanceof SearchError ? error.status : 500;
      res.end(JSON.stringify({ error: error instanceof SearchError ? error.message : 'Observation search failed. Please retry.' }));
    }
  };
}
export default createObservationsHandler();
