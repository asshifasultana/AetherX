// Known asteroids and comets near a sky position at a time, from NASA JPL's
// Small-Body Identification API (SBIdent). Used by the AI guide's crossmatch
// tool to rule a "moving dot" in or out as a catalogued small body.
//
// GET /api/known-objects?ra=<deg>&dec=<deg>&time=<ISO>&radius=<arcsec>
// Predictions are geocentric; SPHEREx's low orbit shifts nearby asteroids by
// at most a few arcseconds, inside the default 30″ match radius for all but
// the closest near-Earth objects.

const SBIDENT_URL = 'https://ssd-api.jpl.nasa.gov/sb_ident.api';
const CACHE_LIMIT = 300;
const CACHE_MS = 24 * 3600_000;
const cache = new Map();
const inFlight = new Map();
// SBIdent integrates every known orbit, which can take over a minute in
// crowded fields. A request waits this long; slower checks keep running (on a
// long-lived server) and fill the cache, and the caller is told to ask again.
const WAIT_MS = 20_000;
const UPSTREAM_TIMEOUT_MS = 150_000;

const pad = (value, width = 2) => String(value).padStart(width, '0');

export function raToSbident(raDeg) {
  let seconds = Math.round((((raDeg % 360) + 360) % 360) / 15 * 3600 * 100) / 100;
  if (seconds >= 86400) seconds -= 86400;
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds - h * 3600) / 60), s = seconds - h * 3600 - m * 60;
  return `${pad(h)}-${pad(m)}-${s.toFixed(2).padStart(5, '0')}`;
}

export function decToSbident(decDeg) {
  let seconds = Math.round(Math.abs(decDeg) * 3600 * 10) / 10;
  const d = Math.floor(seconds / 3600); seconds -= d * 3600;
  const m = Math.floor(seconds / 60), s = seconds - m * 60;
  return `${decDeg < 0 ? 'M' : ''}${pad(d)}-${pad(m)}-${s.toFixed(1).padStart(4, '0')}`;
}

const parseRa = text => {
  const [h, m, s] = String(text).trim().split(/[\s:]+/).map(Number);
  return [h, m, s].every(Number.isFinite) ? (h + m / 60 + s / 3600) * 15 : null;
};
const parseDec = text => {
  const raw = String(text).trim(), sign = raw.startsWith('-') ? -1 : 1;
  const [d, m, s] = raw.replace(/^[+-]/, '').split(/[\s'"°]+/).filter(Boolean).map(Number);
  return [d, m, s].every(Number.isFinite) ? sign * (d + m / 60 + s / 3600) : null;
};

/** Objects from an SBIdent JSON body, with their separation from the centre. */
export function parseSbident(body) {
  const fields = body?.fields_second || body?.fields_first;
  const rows = body?.data_second_pass || body?.data_first_pass;
  if (!Array.isArray(fields) || !Array.isArray(rows)) return [];
  const names = fields.map(field => String(field).toLowerCase());
  const column = pattern => names.findIndex(name => pattern.test(name));
  const iName = column(/object/), iRa = column(/^astrometric ra/), iDec = column(/^astrometric dec/);
  const iNorm = column(/norm/), iMag = column(/magnitude/), iRaRate = column(/ra rate/), iDecRate = column(/dec rate/);
  if (iName < 0 || iRa < 0 || iDec < 0) return [];
  return rows.map(row => {
    const raDeg = parseRa(row[iRa]), decDeg = parseDec(row[iDec]);
    if (raDeg === null || decDeg === null) return null;
    const number = index => { const value = Number(row[index]); return index >= 0 && Number.isFinite(value) ? value : null; };
    const raRate = number(iRaRate), decRate = number(iDecRate);
    return {
      name: String(row[iName]).trim(),
      raDeg, decDeg,
      separationArcsec: number(iNorm),
      vMag: number(iMag),
      rateArcsecPerHour: raRate !== null && decRate !== null ? Number(Math.hypot(raRate, decRate).toFixed(2)) : null
    };
  }).filter(Boolean).sort((a, b) => (a.separationArcsec ?? Infinity) - (b.separationArcsec ?? Infinity));
}

function sendJson(res, status, data, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store');
  res.end(JSON.stringify(data));
}

export function validateKnownObjectsQuery(searchParams) {
  const ra = Number(searchParams.get('ra')), dec = Number(searchParams.get('dec'));
  const radius = searchParams.has('radius') ? Number(searchParams.get('radius')) : 60;
  const time = Date.parse(searchParams.get('time') || '');
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return { error: 'Give ra and dec in degrees.' };
  if (!Number.isFinite(radius) || radius < 5 || radius > 1800) return { error: 'radius must be 5–1800 arcseconds.' };
  if (!Number.isFinite(time) || time < Date.UTC(2020, 0, 1) || time > Date.now() + 86400_000 * 366) return { error: 'Give time as an ISO date between 2020 and next year.' };
  return { raDeg: ((ra % 360) + 360) % 360, decDeg: dec, radiusArcsec: radius, time: new Date(time) };
}

export function createKnownObjectsHandler({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), waitMs = WAIT_MS } = {}) {
  return async (req, res) => {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { error: 'Use GET.' }); return; }
    const { searchParams } = new URL(req.url, 'http://localhost');
    const query = validateKnownObjectsQuery(searchParams);
    if (query.error) { sendJson(res, 400, { error: query.error, code: 'BAD_REQUEST' }); return; }
    const stamp = query.time.toISOString().slice(0, 19);
    const key = `${query.raDeg.toFixed(4)}|${query.decDeg.toFixed(4)}|${query.radiusArcsec}|${stamp.slice(0, 16)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) { sendJson(res, 200, hit.data, 3600); return; }
    const halfWidthDeg = Math.max(0.02, query.radiusArcsec / 3600);
    const url = new URL(SBIDENT_URL);
    for (const [name, value] of Object.entries({
      'mpc-code': '500', 'obs-time': stamp.replace('T', '_'),
      'fov-ra-center': raToSbident(query.raDeg), 'fov-dec-center': decToSbident(query.decDeg),
      'fov-ra-hwidth': halfWidthDeg.toFixed(4), 'fov-dec-hwidth': halfWidthDeg.toFixed(4),
      'two-pass': 'true', 'suppress-first-pass': 'true'
    })) url.searchParams.set(name, value);
    let job = inFlight.get(key);
    if (!job) {
      job = (async () => {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), headers: { Accept: 'application/json' } });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body) throw new Error('upstream');
        const objects = parseSbident(body).filter(object => object.separationArcsec === null || object.separationArcsec <= query.radiusArcsec * 1.5);
        const data = {
          checked: true, source: 'NASA/JPL SBIdent (geocentric)', date: stamp.slice(0, 10), time: stamp + 'Z',
          raDeg: query.raDeg, decDeg: query.decDeg, radiusArcsec: query.radiusArcsec,
          count: objects.length, objects: objects.slice(0, 20)
        };
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now(), data });
        return data;
      })().finally(() => inFlight.delete(key));
      job.catch(() => {});
      inFlight.set(key, job);
    }
    let timer;
    const pending = new Promise(resolve => { timer = setTimeout(() => resolve(null), waitMs); });
    try {
      const data = await Promise.race([job, pending]);
      if (data) { sendJson(res, 200, data, 3600); return; }
      sendJson(res, 202, { checked: false, pending: true, error: 'JPL is still computing the known asteroids for this field; ask again in a minute.', code: 'PENDING' });
    } catch {
      sendJson(res, 502, { error: 'JPL did not answer the known-object check.', code: 'UPSTREAM_ERROR', checked: false });
    } finally { clearTimeout(timer); }
  };
}

export default createKnownObjectsHandler();
