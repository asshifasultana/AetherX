import { fetchCatalogTable, gaiaQuery, GaiaError, parseVizierTable, VIZIER_MIRROR } from '../lib/gaia-catalog.js';
import { createSearchResources, createWorkGate } from '../lib/resources.js';
import { fieldRadiusDeg } from '../gaia-core.js';

const columns = ['designation', 'ra', 'dec', 'w1mpro', 'w1sigmpro', 'w2mpro', 'w2sigmpro', 'ph_qual', 'cc_flags'];
const mirrorColumns = ['AllWISE', 'RAJ2000', 'DEJ2000', 'W1mag', 'e_W1mag', 'W2mag', 'e_W2mag', 'qph', 'ccf'];
const mirrorTable = 'II/328/allwise';
const limit = 1000;

function parseSources(text) {
  const [header = '', ...rows] = text.trim().split(/\r?\n/);
  const cells = line => line.split(',').map(cell => cell.trim().replace(/^"(.*)"$/, '$1').trim());
  const names = cells(header).map(name => name.toLowerCase());
  if (!columns.every(name => names.includes(name)) || rows.length > limit + 1) {
    throw new GaiaError('IRSA returned an unexpected AllWISE catalog.');
  }
  const sources = rows.slice(0, limit).map(line => {
    const values = cells(line);
    const row = Object.fromEntries(names.map((name, i) => [name, values[i]]));
    const number = key => row[key] ? Number(row[key]) : null;
    const raDeg = number('ra'), decDeg = number('dec');
    if (values.length !== names.length || !row.designation || !Number.isFinite(raDeg) || raDeg < 0 ||
        raDeg >= 360 || !Number.isFinite(decDeg) || Math.abs(decDeg) > 90 ||
        !/^[ABCUXZ]{4}$/.test(row.ph_qual) || !/^[0DHOPdhop]{4}$/.test(row.cc_flags)) {
      throw new GaiaError('The archive returned invalid AllWISE source data.');
    }
    const photometry = ['w1', 'w2'].map((band, index) => {
      const magnitude = number(band + 'mpro'), uncertainty = number(band + 'sigmpro');
      return {
        magnitude: Number.isFinite(magnitude) ? magnitude : null,
        uncertainty: Number.isFinite(uncertainty) ? uncertainty : null,
        quality: row.ph_qual[index] || null,
        artifact: row.cc_flags[index] || null
      };
    });
    return { sourceId: row.designation, raDeg, decDeg, photometry };
  });
  return { catalog: 'AllWISE', sources, truncated: rows.length > limit };
}

export function createWiseHandler({ fetchImpl = fetch, timeoutMs = 5000, fallbackTimeoutMs = 8000 } = {}) {
  const resources = createSearchResources({ maxEntries: 8, maxBytes: 2 * 1024 * 1024, gate: createWorkGate() });
  async function lookup({ ra, dec, radius }) {
    const key = `${ra}|${dec}|${radius}`;
    const cached = resources.get(key, Date.now());
    if (cached) return cached;
    if (resources.pending.has(key)) return resources.pending.get(key);
    const release = resources.gate.acquire();
    const center = `POINT('ICRS',${ra},${dec})`;
    const point = "POINT('ICRS',ra,dec)";
    const circle = `CIRCLE('ICRS',${ra},${dec},${radius})`;
    const query = `SELECT TOP ${limit + 1} ${columns.join(',')},DISTANCE(${point},${center}) AS separation FROM allwise_p3as_psd WHERE 1=CONTAINS(${point},${circle}) ORDER BY separation,designation`;
    const mirrorParams = new URLSearchParams({
      '-source': mirrorTable, '-c': `${ra} ${dec >= 0 ? '+' : ''}${dec}`, '-c.rd': String(radius),
      '-out': mirrorColumns.join(','), '-out.add': '_r', '-sort': '_r,AllWISE', '-out.max': String(limit + 1)
    });
    const work = (async () => {
      const { text, endpoint } = await fetchCatalogTable(fetchImpl, [
        { endpoint: 'https://irsa.ipac.caltech.edu/TAP/sync', query, timeoutMs },
        { endpoint: VIZIER_MIRROR + '?' + mirrorParams, timeoutMs: fallbackTimeoutMs }
      ], 'WISE');
      const csv = endpoint === VIZIER_MIRROR
        ? [columns.join(','), ...parseVizierTable(text, mirrorTable, mirrorColumns).map(row => row.join(','))].join('\n')
        : text;
      const result = { ...parseSources(csv), endpoint };
      const now = Date.now();
      resources.set(key, result, now + 86400000, now);
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
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'Use GET.' }));
      return;
    }
    try {
      // The largest view can round up by half a display pixel.
      const params = gaiaQuery(new URL(req.url, 'http://localhost').searchParams, fieldRadiusDeg(30.1));
      res.end(JSON.stringify(await lookup(params)));
    } catch (error) {
      res.statusCode = error.status || 502;
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      const message = error instanceof GaiaError ? error.message : 'WISE lookup is temporarily unavailable.';
      res.end(JSON.stringify({ error: message }));
    }
  };
}

export default createWiseHandler();
