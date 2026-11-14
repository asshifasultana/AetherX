import { SearchError, scienceUrl, mjdToIso } from '../lib/observations.js';
import { preferredProducts } from '../observation-products.js';
import { metadataResources } from '../lib/resources.js';
import { defaultSearchStore, entryAge } from '../lib/search-store.js';
import { gzipSync } from 'node:zlib';
// Search results compress ~16x (Barnard's Star: 408 KB of JSON becomes 25 KB).
function sendJson(req, res, data) {
  const body = Buffer.from(JSON.stringify(data));
  const gzip = body.length > 1024 && /\bgzip\b/.test(String(req.headers?.['accept-encoding'] || ''));
  res.setHeader('Vary', 'Accept-Encoding');
  if (gzip) res.setHeader('Content-Encoding', 'gzip');
  res.end(gzip ? gzipSync(body, { level: 6 }) : body);
}

const observer = '-163182';
const day = 86400000;
const aliases = new Map([['3i/atlas', '3I'], ['c/2025 n1', '3I'], ['4 vesta', '20000004:NID']]);
const error = (message, status = 502, code = 'UPSTREAM_ERROR') => new SearchError(message, status, code);

function designation(value) {
  const name = (value || '').trim();
  if (!/^[\p{L}\p{N} ._()/+:\-]{1,80}$/u.test(name) || name.includes(';')) {
    throw error('Enter a comet or asteroid name or designation.', 400, 'INVALID_OBJECT');
  }
  return aliases.get(name.toLowerCase()) || name;
}

function utcDate(value) {
  const time = Date.parse(value + 'T00:00:00Z');
  if (!/^\d{4}-\d\d-\d\d$/.test(value || '') || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw error('Enter both dates as YYYY-MM-DD.', 400, 'INVALID_DATES');
  }
  return time;
}

export function parseMost(text) {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex(line => line.startsWith('|') && line.includes('observationid') && line.includes('mjd_start'));
  if (header < 0) {
    if (/no (?:matching |candidate )?(?:images|observations|matches|records) (?:were )?found/i.test(text)) return [];
    throw error('MOST did not return a complete observation table.', 502, 'INCOMPLETE_ARCHIVE');
  }
  const boundaries = [...lines[header].matchAll(/\|/g)].map(match => match.index);
  const fields = boundaries.slice(0, -1).map((start, i) => lines[header].slice(start + 1, boundaries[i + 1]).trim());
  if (!['uri', 'productid', 'mjd_end', 'exposure_time'].every(field => fields.includes(field))) {
    throw error('MOST returned an unsupported observation table.', 502, 'INCOMPLETE_ARCHIVE');
  }
  return lines.slice(header + 1).filter(line => line.trim() && !/^[|\\]/.test(line)).map(line => {
    const row = Object.fromEntries(fields.map((field, i) => [field, line.slice(boundaries[i] + 1, boundaries[i + 1]).trim()]));
    const accessUrl = scienceUrl(row.uri), detector = Number(/^D([1-6])$/.exec(row.productid)?.[1] || /D([1-6])_spx_/.exec(accessUrl || '')?.[1]);
    const startMjd = Number(row.mjd_start), endMjd = Number(row.mjd_end);
    if (!accessUrl || !detector || !row.observationid || !row.planeid || !Number.isFinite(startMjd) || !(endMjd > startMjd)) {
      throw error('MOST returned an incomplete or unsupported FITS record.', 502, 'INCOMPLETE_ARCHIVE');
    }
    return { observationId: row.observationid, productId: row.planeid, accessUrl, detector, startMjd, endMjd,
      observedStartUtc: mjdToIso(startMjd), observedEndUtc: mjdToIso(endMjd),
      exposureSeconds: Number(row.exposure_time) || (endMjd - startMjd) * 86400,
      release: /\/(qr\d+)\//i.exec(accessUrl)[1].toUpperCase(),
      processingVersion: /\/(l2b[^/]+)\//.exec(accessUrl)?.[1] ?? null };
  });
}

async function boundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw error('Upstream response has no body.');
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw error('Upstream result is too large. Narrow the search dates.', 502, 'INCOMPLETE_ARCHIVE');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function mostError(text, status) {
  const choices = [...text.matchAll(/^(.+?), Object Type=.*?NAIF ID=(\d+)/gm)]
    .map(([, label, id]) => ({ label, designation: id + ':NID' }));
  if (choices.length) {
    const err = error('Choose a specific Horizons designation.', 409, 'AMBIGUOUS_OBJECT');
    err.choices = choices;
    return err;
  }
  return /name lookup failed/i.test(text) ? error('Object not found. Try its numbered designation.', 404, 'OBJECT_NOT_FOUND')
    : error(`IRSA MOST search failed (HTTP ${status}).`);
}

export function parseHorizons(text, requested) {
  const target = /Target body name:\s*(.*?)\s+\{source:\s*([^}]+)\}/.exec(text);
  const table = /\$\$SOE\s*([\s\S]*?)\$\$EOE/.exec(text);
  if (!target || !table || !/Center body name:.*\(-163182\)/.test(text)) {
    throw error('A spacecraft-relative trajectory is unavailable for these epochs.', 502, 'NO_SPACECRAFT_EPHEMERIS');
  }
  const points = table[1].trim().split(/\r?\n/).map(line => {
    const [jd, , , ra, dec] = line.split(',');
    return { mjd: Number(jd) - 2400000.5, ra: Number(ra), dec: Number(dec) };
  });
  if (points.length !== requested.length || points.some((p, i) => Math.abs(p.mjd - requested[i]) > 1e-7 ||
      !Number.isFinite(p.mjd) || !(p.ra >= 0 && p.ra < 360 && p.dec >= -90 && p.dec <= 90))) {
    throw error('Horizons returned incomplete spacecraft positions.', 502, 'NO_SPACECRAFT_EPHEMERIS');
  }
  return { name: target[1], solution: target[2], observer, points: points.map((p, i) => ({ ...p, mjd: requested[i] })) };
}

// Sun-object angle (Horizons quantity 23) for each epoch, in degrees.
export function parseElongations(text, count) {
  const table = /\$\$SOE\s*([\s\S]*?)\$\$EOE/.exec(text);
  const values = table ? table[1].trim().split(/\r?\n/).map(line => Number(line.split(',')[3])) : [];
  if (values.length !== count || values.some(v => !(v >= 0 && v <= 180))) throw error('Horizons returned incomplete Sun angles.', 502, 'NO_SPACECRAFT_EPHEMERIS');
  return values;
}

// MOST clips the search to the archive's coverage; report where public data ends when it falls short.
export function mostDataThrough(text, requestedEnd) {
  const match = /^\\user_input_end_time\s*=\s*"(\d{4}) (\d\d) (\d\d)/m.exec(text);
  if (!match) return null;
  const time = Date.UTC(+match[1], +match[2] - 1, +match[3]);
  return time < requestedEnd ? new Date(time).toISOString().slice(0, 10) : null;
}

// The latest date a request covers: its end date, or its latest epoch for position lookups.
export function movingEndDate(params) {
  if (params.get('action') !== 'positions') return params.get('endDate') || '';
  const latest = Math.max(...params.getAll('mjd').map(Number).filter(Number.isFinite));
  return Number.isFinite(latest) ? new Date((latest - 40587) * day).toISOString().slice(0, 10) : '';
}

// Horizons reads a bare number as a major body and "N;" as a small body; "499:MB" keeps planets explicit.
export function horizonsCommand(object) {
  const smallBody = /^(\d+):NID$/i.exec(object)?.[1], majorBody = /^(\d+):MB$/i.exec(object)?.[1];
  return smallBody ? `DES=${smallBody};` : majorBody || (/^\d+$/.test(object) ? object + ';' : object);
}

// A bare planet name matches its barycenter and spacecraft in Horizons; MOST names the body it chose, e.g. "Mars (499)".
export function mostBody(text, object) {
  const name = /^\\object_name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  const id = /\((\d{1,3})\)\s*$/.exec(name || '')?.[1];
  return { name, target: id && !/:(?:NID|MB)$/i.test(object) ? id + ':MB' : object };
}

export function createMovingSearch({ fetchImpl = fetch, resources = metadataResources, store = defaultSearchStore() } = {}) {
  async function positions(object, times, signal) {
    const points = [];
    let identity;
    for (let i = 0; i < times.length; i += 60) {
      const batch = times.slice(i, i + 60);
      const url = new URL('https://ssd.jpl.nasa.gov/api/horizons.api');
      url.searchParams.set('format', 'json');
      for (const [key, value] of Object.entries({
        COMMAND: horizonsCommand(object), CENTER: '500@' + observer, EPHEM_TYPE: 'OBSERVER', TLIST_TYPE: 'JD',
        TLIST: batch.map(t => (t + 2400000.5).toFixed(9)).join(' '),
        QUANTITIES: '1', ANG_FORMAT: 'DEG', CSV_FORMAT: 'YES', CAL_FORMAT: 'JD', EXTRA_PREC: 'YES',
      })) url.searchParams.set(key, "'" + value + "'");
      const response = await fetchImpl(url, { signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw error('JPL Horizons is temporarily unavailable.', 502, 'NO_SPACECRAFT_EPHEMERIS');
      }
      const batchResult = parseHorizons(JSON.parse(await boundedText(response, 512 * 1024)).result || '', batch);
      if (identity && (identity.solution !== batchResult.solution || identity.name !== batchResult.name)) {
        throw error('The Horizons orbit solution changed during the request. Retry the search.', 502, 'NO_SPACECRAFT_EPHEMERIS');
      }
      identity = batchResult;
      points.push(...batchResult.points);
    }
    return { name: identity.name, solution: identity.solution, observer, points };
  }

  // Where the object sat relative to the Sun, as seen from SPHEREx: explains empty searches.
  async function sunAngles(object, times, signal) {
    const url = new URL('https://ssd.jpl.nasa.gov/api/horizons.api');
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries({
      COMMAND: horizonsCommand(object), CENTER: '500@' + observer,
      EPHEM_TYPE: 'OBSERVER', TLIST_TYPE: 'JD', TLIST: times.map(t => (t + 2400000.5).toFixed(9)).join(' '),
      QUANTITIES: '23', CSV_FORMAT: 'YES', CAL_FORMAT: 'JD',
    })) url.searchParams.set(key, "'" + value + "'");
    const response = await fetchImpl(url, { signal });
    if (!response.ok) { await response.body?.cancel(); throw error('JPL Horizons is temporarily unavailable.', 502, 'NO_SPACECRAFT_EPHEMERIS'); }
    const values = parseElongations(JSON.parse(await boundedText(response, 256 * 1024)).result || '', times.length);
    return { min: Math.min(...values), max: Math.max(...values) };
  }

  return async (params, { signal: requestSignal } = {}) => {
    const object = designation(params.get('object'));
    const action = params.get('action');
    const signal = AbortSignal.any([AbortSignal.timeout(85000), ...(requestSignal ? [requestSignal] : [])]);
    const now = Date.now();
    const key = JSON.stringify(['moving', object, ...[...params].sort()]);
    const cached = resources.get(key, now);
    if (cached) return cached;
    const stored = store ? await store.get('moving', key) : null;
    // Empty results saved before Sun angles were added explain nothing, so search again.
    const outdated = !action && stored?.result?.exposures?.length === 0 && !('dataThrough' in stored.result);
    const saved = outdated ? null : stored;
    const age = entryAge(saved, movingEndDate(params), now);
    const savedAt = saved ? new Date(saved.savedAt).toISOString() : null;
    if (age === 'fresh') {
      const result = { ...saved.result, cache: { shared: true, savedAt } };
      resources.set(key, result, now + 300000, now);
      return result;
    }
    const run = async () => {
      if (action === 'positions') {
        const times = [...new Set(params.getAll('mjd').map(Number))].sort((a, b) => a - b);
        if (!times.length || times.length > 24 || times.some(t => !(t >= 60745 && t <= now / day + 40588))) {
          throw error('Request 1–24 valid exposure epochs.', 400, 'INVALID_EPOCHS');
        }
        const result = await positions(object, times, signal);
        resources.set(key, result, now + 300000, now);
        return result;
      }
      if (action) throw error('Unknown moving-object request.', 400, 'INVALID_ACTION');
      const start = utcDate(params.get('startDate')), end = utcDate(params.get('endDate'));
      const detector = params.get('detector') || '';
      if (end < start || end - start >= 90 * day) throw error('Choose a date range of at most 90 days.', 400, 'INVALID_DATES');
      if (detector && !/^[1-6]$/.test(detector)) throw error('Choose detector D1 through D6.', 400, 'INVALID_DETECTOR');
      const url = new URL('https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most');
      const date = time => new Date(time).toISOString().slice(0, 10).replaceAll('-', ' ');
      url.search = new URLSearchParams({ catalog: 'spherex', input_type: 'name_input', obj_name: object,
        obs_begin: date(start), obs_end: date(end + day), output_mode: 'Brief' });
      const response = await fetchImpl(url, { signal });
      const text = await boundedText(response, 8 * 1024 * 1024);
      if (!response.ok || /Object Name Error:/i.test(text)) throw mostError(text, response.status);
      if (/truncat(?:ed|ion)|maximum (?:number of )?(?:rows|matches) exceeded/i.test(text)) {
        throw error('MOST returned an incomplete result. Narrow the date range.', 502, 'INCOMPLETE_ARCHIVE');
      }
      const exposures = preferredProducts(parseMost(text)).filter(e => (!detector || e.detector === Number(detector))
        && e.startMjd >= start / day + 40587 && e.startMjd < (end + day) / day + 40587);
      if (exposures.length > 240) throw error('More than 240 exposures matched. Narrow the dates or select one detector.', 422, 'TOO_MANY_EXPOSURES');
      const body = mostBody(text, object);
      let trajectory = null, trajectoryError = null;
      if (exposures.length) {
        const times = [...new Set(exposures.flatMap(e => [e.startMjd, (e.startMjd + e.endMjd) / 2, e.endMjd]))].sort((a, b) => a - b);
        try {
          trajectory = await positions(body.target, times, signal);
          const at = new Map(times.map((t, i) => [t, trajectory.points[i]]));
          for (const e of exposures) e.positions = [e.startMjd, (e.startMjd + e.endMjd) / 2, e.endMjd].map(t => at.get(t));
        } catch (err) {
          requestSignal?.throwIfAborted();
          trajectoryError = err instanceof SearchError ? err.message : 'Could not obtain spacecraft-relative positions.';
        }
      }
      // object is what later position requests send back, so it carries the resolved Horizons body.
      const result = { object: body.target, name: trajectory?.name || body.name || object,
        observer: trajectory?.observer, solution: trajectory?.solution, trajectoryError, exposures };
      if (!exposures.length) {
        result.dataThrough = mostDataThrough(text, end + day);
        const last = result.dataThrough ? Math.max(start, Date.parse(result.dataThrough + 'T00:00:00Z')) : end;
        try { result.sunAngle = await sunAngles(body.target, [start, (start + last) / 2, last].map(t => t / day + 40587), signal); }
        catch { requestSignal?.throwIfAborted(); }
      }
      if (!trajectoryError) resources.set(key, result, now + 300000, now);
      return result;
    };
    const release = resources.gate.acquire();
    try {
      const result = await run();
      // An empty result without a Sun angle means JPL failed; don't keep that for a day and a half.
      const unexplained = result.exposures?.length === 0 && !result.sunAngle;
      if (store && !result.trajectoryError && !unexplained) await store.put('moving', key, { query: new URLSearchParams([...params].sort()).toString(), object }, result);
      return result;
    } catch (err) {
      // Horizons or MOST outage: an older saved copy, clearly marked, beats an error.
      if (age === 'stale' && !requestSignal?.aborted && err instanceof SearchError && err.status === 502) return { ...saved.result, cache: { shared: true, stale: true, savedAt } };
      throw err;
    } finally { release(); }
  };
}

export function createMovingObservationsHandler(search = createMovingSearch()) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'Use GET.' })); return; }
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnect);
    try {
      const result = await search(new URL(req.url, 'http://localhost').searchParams, { signal: controller.signal });
      if (!res.destroyed) sendJson(req, res, result);
    } catch (err) {
      if (!res.destroyed) {
        if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
        res.statusCode = err.status || 502;
        res.end(JSON.stringify({ error: err.status ? err.message : 'Moving-object service unavailable.',
          code: err.code || 'UPSTREAM_ERROR', choices: err.choices }));
      }
    } finally { res.off('close', disconnect); }
  };
}

export default createMovingObservationsHandler();
