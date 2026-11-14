import { createQualityService } from '../lib/quality.js';
import { SearchError } from '../lib/observations.js';
const inspectQuality = createQualityService();
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; res.end(JSON.stringify({ error: 'Use GET to inspect quality.' })); return; }
  try { const url = new URL(req.url, 'http://localhost').searchParams.get('url'); res.end(JSON.stringify(await inspectQuality(url))); }
  catch (error) { res.statusCode = error instanceof SearchError ? error.status : 500; res.end(JSON.stringify({ error: error instanceof SearchError ? error.message : 'Could not inspect quality.' })); }
}
