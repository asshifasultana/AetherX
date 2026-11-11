import { createSearchResources, createWorkGate } from './resources.js';
import { GAIA_MOTION_MARGIN_DEG, fieldRadiusDeg } from '../gaia-core.js';
export class GaiaError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') { super(message); Object.assign(this, { status, code }); }
}
const ENDPOINT = 'https://gea.esac.esa.int/tap-server/tap/sync';
export const VIZIER_MIRROR = 'https://vizier.idia.ac.za/viz-bin/asu-tsv';
const gaiaColumns = ['source_id','ra','dec','ref_epoch','pmra','pmdec','phot_g_mean_mag'];
const mirrorColumns = ['Source','RA_ICRS','DE_ICRS','pmRA','pmDE','Gmag'];
export function gaiaQuery(params, maxRadius = fieldRadiusDeg(30)) {
  const values = {};
  for (const [key, min, max] of [['ra',0,360],['dec',-90,90],['radius',0,maxRadius]]) {
    const raw = params.get(key);
    if (params.getAll(key).length !== 1 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw || '')) throw new GaiaError(`Invalid ${key}.`,400,'INVALID_INPUT');
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || key === 'radius' && value === 0 || key === 'ra' && value === 360) throw new GaiaError(`Invalid ${key}.`,400,'INVALID_INPUT');
    values[key] = value;
  }
  if ([...params.keys()].some(key => !['ra','dec','radius'].includes(key))) throw new GaiaError('Unsupported query parameter.',400,'INVALID_INPUT');
  return values;
}
async function boundedText(response, signal, catalog) {
  if (!response.body) throw new GaiaError(`${catalog} returned no catalog.`);
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await reader.read();signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > 2 * 1024 * 1024) throw new GaiaError(`${catalog} response exceeded the catalog limit.`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{}); }
}
export function parseGaiaCSV(text) {
  const rows=text.trim().split(/\r?\n/).map(line=>line.split(',').map(cell=>cell.trim().replace(/^"(.*)"$/,'$1').trim()));
  const fields=rows.shift()||[];
  if(!['source_id','ra','dec','ref_epoch','pmra','pmdec','phot_g_mean_mag'].every(f=>fields.includes(f)))throw new GaiaError('Gaia catalog fields are incomplete.');
  return {metadata:fields.map(name=>({name})),data:rows.filter(row=>row.some(Boolean)).map(row=>{
    if(row.length!==fields.length)throw new GaiaError('Gaia catalog rows are incomplete.');
    return row.map((cell,i)=>fields[i]==='source_id'?cell:cell===''?null:Number(cell));
  })};
}
export function parseVizierTable(text, table, columns) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  const [header, , separator, ...rows] = lines;
  const catalogMatches = text.split(/\r?\n/).some(line => line.trim() === '#Name: ' + table);
  if (!catalogMatches || /^#(?:INFO\s+)?(?:-error|error|QUERY_STATUS\s*=\s*ERROR)\b/im.test(text)) {
    throw new GaiaError('VizieR returned an unexpected catalog.');
  }
  if (!header && columns.every(name => text.includes('#Column\t' + name + '\t'))) return [];
  const fields = header?.split('\t') ?? [];
  const indices = columns.map(name => fields.indexOf(name));
  if (indices.includes(-1) || !separator || !/^[-\t]+$/.test(separator)) {
    throw new GaiaError('VizieR returned an incomplete catalog.');
  }
  return rows.map(line => {
    const values = line.split('\t');
    if (values.length !== fields.length) throw new GaiaError('VizieR returned an incomplete catalog row.');
    return indices.map(index => values[index].trim());
  });
}
export async function fetchCatalogTable(fetchImpl, attempts, catalog) {
  let failure;
  for (const { endpoint, query, timeoutMs } of attempts) {
    if (!timeoutMs) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = { signal: controller.signal };
      if (query) {
        options.method = 'POST';
        options.headers = { Accept: 'text/csv' };
        options.body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query });
      }
      const response = await fetchImpl(endpoint, options);
      if (!response.ok) {
        await response.body?.cancel();
        throw new GaiaError(`${catalog} archive returned HTTP ${response.status}.`);
      }
      return { text: await boundedText(response, controller.signal, catalog), endpoint: endpoint.split('?')[0] };
    } catch (error) {
      failure = controller.signal.aborted || error.name === 'TimeoutError'
        ? new GaiaError(`${catalog} lookup timed out. Please retry.`, 504, 'TIMEOUT')
        : error instanceof GaiaError ? error : new GaiaError(`${catalog} archive is unavailable. Please retry.`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw failure;
}
export function createGaiaCatalog({ fetchImpl = fetch, now = Date.now, timeoutMs = 5000, fallbackTimeoutMs = 8000,
  resources = createSearchResources({ maxEntries: 8, maxBytes: 2*1024*1024, gate: createWorkGate() }) } = {}) {
  return async params => {
    const { ra, dec, radius } = gaiaQuery(params), key = `${ra}|${dec}|${radius}`;
    const cached = resources.get(key,now()); if (cached) return cached;
    if (resources.pending.has(key)) return resources.pending.get(key);
    const release = resources.gate.acquire();
    const work = (async () => {
      try {
        // CSV retains all 64-bit source-ID digits without numeric JSON parsing
        // or reliance on archive-specific ADQL cast functions.
        const paddedRadius = radius + GAIA_MOTION_MARGIN_DEG;
        const query = `SELECT TOP 1001 ${gaiaColumns.join(',')} FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${paddedRadius})) AND phot_g_mean_mag<=18 ORDER BY phot_g_mean_mag,source_id`;
        const mirrorTable = 'I/355/gaiadr3';
        const mirrorParams = new URLSearchParams({
          '-source': mirrorTable, '-c': `${ra} ${dec >= 0 ? '+' : ''}${dec}`, '-c.rd': String(paddedRadius),
          '-out': mirrorColumns.join(','), '-sort': 'Gmag,Source', Gmag: '<=18', '-out.max': '1001'
        });
        const { text, endpoint } = await fetchCatalogTable(fetchImpl, [
          { endpoint: ENDPOINT, query, timeoutMs },
          { endpoint: VIZIER_MIRROR + '?' + mirrorParams, timeoutMs: fallbackTimeoutMs }
        ], 'Gaia');
        // The mirror publishes RA_ICRS/DE_ICRS at J2016.0.
        const csv = endpoint === VIZIER_MIRROR ? [
          gaiaColumns.join(','),
          ...parseVizierTable(text, mirrorTable, mirrorColumns).map(([id, ra, dec, pmra, pmdec, g]) =>
            [id, ra, dec, '2016', pmra, pmdec, g].join(','))
        ].join('\n') : text;
        const result = parseGaiaCSV(csv);
        if (!Array.isArray(result.metadata) || !Array.isArray(result.data) || result.data.length > 1001) throw new GaiaError('Gaia returned an unsupported catalog.');
        const fields = result.metadata.map(f=>f.name.toLowerCase());
        if (!['source_id','ra','dec','ref_epoch','pmra','pmdec','phot_g_mean_mag'].every(f=>fields.includes(f))) throw new GaiaError('Gaia catalog fields are incomplete.');
        const sources = result.data.slice(0,1000).map(row => {
          const r = Object.fromEntries(fields.map((f,i)=>[f,row[i]]));
          if (typeof r.source_id !== 'string' || !/^\d+$/.test(r.source_id) || ![r.ra,r.dec,r.ref_epoch,r.phot_g_mean_mag].every(Number.isFinite) || r.ra < 0 || r.ra >= 360 || Math.abs(r.dec)>90 || r.ref_epoch !== 2016 || r.phot_g_mean_mag>18 || ![r.pmra,r.pmdec].every(x=>x===null || Number.isFinite(x))) throw new GaiaError('Gaia returned invalid astrometry.');
          return { sourceId:r.source_id,raDeg:r.ra,decDeg:r.dec,refEpoch:r.ref_epoch,pmra:r.pmra,pmdec:r.pmdec,gMag:r.phot_g_mean_mag };
        });
        const output = { catalog:'Gaia DR3', endpoint, frame:'icrs', retrievedAt:new Date(now()).toISOString(), truncated:result.data.length>1000,
          field:{raDeg:ra,decDeg:dec,radiusDeg:radius}, motionMarginDeg:GAIA_MOTION_MARGIN_DEG,
          attribution:'ESA/Gaia/DPAC, Gaia DR3 (2023)', sourceUrl:'https://www.cosmos.esa.int/web/gaia/dr3', sources };
        resources.set(key,output,now()+86400000,now()); return output;
      } finally { release(); }
    })();
    resources.pending.set(key,work);
    try { return await work; } finally { resources.pending.delete(key); }
  };
}
/** Rows of a CSV table (RFC 4180 quoting) as arrays of trimmed strings; the first row is the header. */
export function parseCsvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell.trim()); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
/** Try each catalogue endpoint in turn until one answers with a table that parses. */
export async function firstParsed(fetchImpl, attempts, catalog, parse) {
  let failure = new GaiaError(`${catalog} archive is unavailable. Please retry.`);
  for (const attempt of attempts) {
    if (!attempt.timeoutMs) continue;
    try {
      const { text, endpoint } = await fetchCatalogTable(fetchImpl, [attempt], catalog);
      let parsed = await parse(text, endpoint);
      // Some mirrors need several requests for one question; their rows are merged.
      for (const extra of attempt.also || []) {
        const more = await fetchCatalogTable(fetchImpl, [extra], catalog), next = await parse(more.text, more.endpoint);
        parsed = { ...parsed, sources: [...parsed.sources, ...next.sources], truncated: Boolean(parsed.truncated || next.truncated) };
      }
      return { ...parsed, endpoint };
    } catch (error) { failure = error instanceof GaiaError ? error : new GaiaError(`${catalog} returned an unexpected catalog.`); }
  }
  throw failure;
}
/**
 * A star catalogue endpoint that answers two cones at once: everything within
 * `radius` (default 90″) and only fast movers within fastRadiusDeg, because a
 * star that sat here years ago can be arcminutes away by now. Sources from
 * both cones are merged by sourceId. A failed fast cone still returns the
 * near cone, with fastChecked false.
 */
export function createConeCatalogHandler({ catalog, nearAttempts, fastAttempts, parse, fetchImpl = fetch, now = Date.now,
  fastRadiusDeg = 0.2, maxRadiusDeg = 0.25, limit = 1000, gate = createWorkGate({ slots: 3 }) }) {
  const resources = createSearchResources({ maxEntries: 16, maxBytes: 2 * 1024 * 1024, gate });
  async function lookup({ ra, dec, radius }) {
    const key = `${ra}|${dec}|${radius}`;
    const cached = resources.get(key, now());
    if (cached) return cached;
    if (resources.pending.has(key)) return resources.pending.get(key);
    const release = resources.gate.acquire();
    const fastRadius = Math.max(fastRadiusDeg, radius);
    const work = (async () => {
      const [near, fast] = await Promise.allSettled([
        firstParsed(fetchImpl, nearAttempts({ ra, dec, radius, limit }), catalog, parse),
        firstParsed(fetchImpl, fastAttempts({ ra, dec, radius: fastRadius, limit }), catalog, parse)
      ]);
      if (near.status === 'rejected') throw near.reason;
      const merged = new Map();
      for (const source of [...near.value.sources, ...(fast.status === 'fulfilled' ? fast.value.sources : [])]) merged.set(source.sourceId, source);
      const result = {
        catalog, endpoint: near.value.endpoint, retrievedAt: new Date(now()).toISOString(),
        field: { raDeg: ra, decDeg: dec, radiusDeg: radius, fastRadiusDeg: fastRadius },
        truncated: Boolean(near.value.truncated), fastChecked: fast.status === 'fulfilled',
        sources: [...merged.values()]
      };
      resources.set(key, result, now() + 86400000, now());
      return result;
    })();
    resources.pending.set(key, work);
    try { return await work; }
    finally { resources.pending.delete(key); release(); }
  }
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'Use GET.', code: 'METHOD_NOT_ALLOWED' })); return; }
    try {
      res.end(JSON.stringify(await lookup(gaiaQuery(new URL(req.url, 'http://localhost').searchParams, maxRadiusDeg))));
    } catch (error) {
      const known = error instanceof GaiaError || error.status === 503;
      res.statusCode = known ? error.status : 500;
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      res.end(JSON.stringify({ error: known ? error.message : `${catalog} lookup failed.`, code: error.code || (error.status === 503 ? 'BUSY' : 'INTERNAL_ERROR') }));
    }
  };
}
