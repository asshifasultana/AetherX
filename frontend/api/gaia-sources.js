import { createGaiaCatalog, GaiaError } from '../lib/gaia-catalog.js';
export function createGaiaHandler(catalog = createGaiaCatalog()) {
  return async (req,res) => {
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    if (req.method !== 'GET') { res.writeHead(405,{Allow:'GET'}).end(JSON.stringify({error:'Use GET.',code:'METHOD_NOT_ALLOWED'})); return; }
    try { res.end(JSON.stringify(await catalog(new URL(req.url,'http://localhost').searchParams))); }
    catch (error) {
      const known = error instanceof GaiaError || error.status === 503;
      res.statusCode = known ? error.status : 500;
      if (error.retryAfter) res.setHeader('Retry-After',String(error.retryAfter));
      res.end(JSON.stringify({error:known ? error.message : 'Gaia lookup failed.',code:error.code || (error.status === 503 ? 'BUSY' : 'INTERNAL_ERROR')}));
    }
  };
}
export default createGaiaHandler();
