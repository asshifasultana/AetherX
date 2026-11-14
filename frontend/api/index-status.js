import { createIndexStore, indexStatus } from '../lib/index-store.js';
const store = createIndexStore();
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); res.end(JSON.stringify({ error: 'Use GET to read index status.' })); return; }
  try { res.end(JSON.stringify(indexStatus(await store.manifest()))); }
  catch { res.statusCode = 503; res.end(JSON.stringify({ ...indexStatus(null), status: 'error', error: 'Index status is unavailable. Live archive searches remain available.' })); }
}
