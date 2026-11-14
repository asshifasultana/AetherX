import { createNameResolver, ResolveError } from '../lib/name-resolver.js';
export function createResolveObjectHandler(resolve = createNameResolver()) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; res.end(JSON.stringify({ error: 'Use GET to resolve an object name.', code: 'METHOD_NOT_ALLOWED' })); return; }
    try { res.end(JSON.stringify(await resolve(new URL(req.url, 'http://localhost').searchParams))); }
    catch (error) {
      res.statusCode = error instanceof ResolveError ? error.status : 500;
      res.end(JSON.stringify({ error: error instanceof ResolveError ? error.message : 'Object lookup failed. Please retry.', code: error instanceof ResolveError ? error.code : 'INTERNAL_ERROR' }));
    }
  };
}
export default createResolveObjectHandler();
