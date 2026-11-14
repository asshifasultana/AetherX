import { createSearchResources, createWorkGate } from './resources.js';
import { GAIA_MOTION_MARGIN_DEG, fieldRadiusDeg } from '../gaia-core.js';
export class GaiaError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') { super(message); Object.assign(this, { status, code }); }
}
const ENDPOINT = 'https://gea.esac.esa.int/tap-server/tap/sync';
export function gaiaQuery(params) {
  const values = {};
  for (const [key, min, max] of [['ra',0,360],['dec',-90,90],['radius',0,fieldRadiusDeg(30)]]) {
    const raw = params.get(key);
    if (params.getAll(key).length !== 1 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw || '')) throw new GaiaError(`Invalid ${key}.`,400,'INVALID_INPUT');
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || key === 'radius' && value === 0 || key === 'ra' && value === 360) throw new GaiaError(`Invalid ${key}.`,400,'INVALID_INPUT');
    values[key] = value;
  }
  if ([...params.keys()].some(key => !['ra','dec','radius'].includes(key))) throw new GaiaError('Unsupported query parameter.',400,'INVALID_INPUT');
  return values;
}
async function boundedText(response, signal) {
  if (!response.body) throw new GaiaError('Gaia returned no catalog.');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await reader.read();signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > 2 * 1024 * 1024) throw new GaiaError('Gaia response exceeded the catalog limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{}); }
}
export function parseGaiaCSV(text) {
  const rows=text.trim().split(/\r?\n/).map(line=>line.split(',').map(cell=>cell.trim().replace(/^"(.*)"$/,'$1')));
  const fields=rows.shift()||[];
  if(!['source_id','ra','dec','ref_epoch','pmra','pmdec','phot_g_mean_mag'].every(f=>fields.includes(f)))throw new GaiaError('Gaia catalog fields are incomplete.');
  return {metadata:fields.map(name=>({name})),data:rows.filter(row=>row.some(Boolean)).map(row=>{
    if(row.length!==fields.length)throw new GaiaError('Gaia catalog rows are incomplete.');
    return row.map((cell,i)=>fields[i]==='source_id'?cell:cell===''?null:Number(cell));
  })};
}
export function createGaiaCatalog({ fetchImpl = fetch, now = Date.now, timeoutMs = 8000,
  resources = createSearchResources({ maxEntries: 8, maxBytes: 2*1024*1024, gate: createWorkGate() }) } = {}) {
  return async params => {
    const { ra, dec, radius } = gaiaQuery(params), key = `${ra}|${dec}|${radius}`;
    const cached = resources.get(key,now()); if (cached) return cached;
    if (resources.pending.has(key)) return resources.pending.get(key);
    const release = resources.gate.acquire();
    const work = (async () => {
      const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),timeoutMs);
      try {
        // CSV retains all 64-bit source-ID digits without numeric JSON parsing
        // or reliance on archive-specific ADQL cast functions.
        const query = `SELECT TOP 1001 source_id,ra,dec,ref_epoch,pmra,pmdec,phot_g_mean_mag FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${radius + GAIA_MOTION_MARGIN_DEG})) AND phot_g_mean_mag<=18 ORDER BY phot_g_mean_mag,source_id`;
        const response = await fetchImpl(ENDPOINT, { method:'POST', body:new URLSearchParams({ REQUEST:'doQuery', LANG:'ADQL', FORMAT:'csv', QUERY:query }), signal:controller.signal });
        if (!response.ok) { await response.body?.cancel(); throw new GaiaError(`Gaia archive returned HTTP ${response.status}.`); }
        const result = parseGaiaCSV(await boundedText(response,controller.signal));
        if (!Array.isArray(result.metadata) || !Array.isArray(result.data) || result.data.length > 1001) throw new GaiaError('Gaia returned an unsupported catalog.');
        const fields = result.metadata.map(f=>f.name.toLowerCase());
        if (!['source_id','ra','dec','ref_epoch','pmra','pmdec','phot_g_mean_mag'].every(f=>fields.includes(f))) throw new GaiaError('Gaia catalog fields are incomplete.');
        const sources = result.data.slice(0,1000).map(row => {
          const r = Object.fromEntries(fields.map((f,i)=>[f,row[i]]));
          if (typeof r.source_id !== 'string' || !/^\d+$/.test(r.source_id) || ![r.ra,r.dec,r.ref_epoch,r.phot_g_mean_mag].every(Number.isFinite) || r.ra < 0 || r.ra >= 360 || Math.abs(r.dec)>90 || r.ref_epoch !== 2016 || r.phot_g_mean_mag>18 || ![r.pmra,r.pmdec].every(x=>x===null || Number.isFinite(x))) throw new GaiaError('Gaia returned invalid astrometry.');
          return { sourceId:r.source_id,raDeg:r.ra,decDeg:r.dec,refEpoch:r.ref_epoch,pmra:r.pmra,pmdec:r.pmdec,gMag:r.phot_g_mean_mag };
        });
        const output = { catalog:'Gaia DR3', frame:'icrs', retrievedAt:new Date(now()).toISOString(), truncated:result.data.length>1000,
          field:{raDeg:ra,decDeg:dec,radiusDeg:radius}, motionMarginDeg:GAIA_MOTION_MARGIN_DEG,
          attribution:'ESA/Gaia/DPAC, Gaia DR3 (2023)', sourceUrl:'https://www.cosmos.esa.int/web/gaia/dr3', sources };
        resources.set(key,output,now()+86400000,now()); return output;
      } catch (error) {
        if (controller.signal.aborted || error.name === 'TimeoutError') throw new GaiaError('Gaia lookup timed out. Please retry.',504,'TIMEOUT');
        if (error instanceof GaiaError) throw error;
        throw new GaiaError('Gaia archive is unavailable. Please retry.');
      } finally { clearTimeout(timer); release(); }
    })();
    resources.pending.set(key,work);
    try { return await work; } finally { resources.pending.delete(key); }
  };
}
