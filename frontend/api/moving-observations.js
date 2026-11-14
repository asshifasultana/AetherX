import { SearchError, scienceUrl, mjdToIso } from '../lib/observations.js';
import { preferredProducts } from '../observation-products.js';
import { metadataResources } from '../lib/resources.js';

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

export function createMovingSearch({ fetchImpl = fetch, resources = metadataResources } = {}) {
  async function positions(object, times, signal) {
    const points = [];
    let identity;
    for (let i = 0; i < times.length; i += 60) {
      const batch = times.slice(i, i + 60);
      const id = /^(\d+):NID$/i.exec(object)?.[1];
      const command = id ? `DES=${id};` : /^\d+$/.test(object) ? object + ';' : object;
      const url = new URL('https://ssd.jpl.nasa.gov/api/horizons.api');
      url.searchParams.set('format', 'json');
      for (const [key, value] of Object.entries({
        COMMAND: command, CENTER: '500@' + observer, EPHEM_TYPE: 'OBSERVER', TLIST_TYPE: 'JD',
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

  return async (params, { signal: requestSignal } = {}) => {
    const object = designation(params.get('object'));
    const action = params.get('action');
    const signal = AbortSignal.any([AbortSignal.timeout(85000), ...(requestSignal ? [requestSignal] : [])]);
    const now = Date.now();
    const key = JSON.stringify(['moving', object, ...[...params].sort()]);
    const cached = resources.get(key, now);
    if (cached) return cached;
    const release = resources.gate.acquire();
    try {
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
      let trajectory = null, trajectoryError = null;
      if (exposures.length) {
        const times = [...new Set(exposures.flatMap(e => [e.startMjd, (e.startMjd + e.endMjd) / 2, e.endMjd]))].sort((a, b) => a - b);
        try {
          trajectory = await positions(object, times, signal);
          const at = new Map(times.map((t, i) => [t, trajectory.points[i]]));
          for (const e of exposures) e.positions = [e.startMjd, (e.startMjd + e.endMjd) / 2, e.endMjd].map(t => at.get(t));
        } catch (err) {
          requestSignal?.throwIfAborted();
          trajectoryError = err instanceof SearchError ? err.message : 'Could not obtain spacecraft-relative positions.';
        }
      }
      const result = { object, name: trajectory?.name || /^\\object_name\s*=\s*"([^"]+)"/m.exec(text)?.[1] || object,
        observer: trajectory?.observer, solution: trajectory?.solution, trajectoryError, exposures };
      if (!trajectoryError) resources.set(key, result, now + 300000, now);
      return result;
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
      if (!res.destroyed) res.end(JSON.stringify(result));
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
