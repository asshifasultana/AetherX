import { preferredProducts } from '../observation-products.js';
import { createSearchResources } from './resources.js';
import { exposureCenter, presetMotion } from '../presets.js';
// IRSA TAP/CAOM metadata adapter. The reference project's tools/build_index.py
// informed the archive tables and processing-version selection; no code is copied.
export const TAP_URL = 'https://irsa.ipac.caltech.edu/TAP/sync';
export const COLLECTIONS = ['spherex_qr3', 'spherex_qr3_deep', 'spherex_qr2', 'spherex_qr2_deep'];
export const MAX_RESULTS = 2000;
export class SearchError extends Error {
  constructor(message, status = 502, code) { super(message); this.status = status; this.code = code; }
}

function numeric(value, name, min, max, exclusiveMax = false) {
  if (value === null || value === undefined || String(value).trim() === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value))) throw new SearchError(`Enter a valid ${name}.`, 400);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || (exclusiveMax ? number >= max : number > max)) throw new SearchError(`${name} must be between ${min} and ${exclusiveMax ? 'less than ' : ''}${max}.`, 400);
  return number;
}
function dateBound(value, name, end) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SearchError(`${name} must use YYYY-MM-DD.`, 400);
  const milliseconds = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) throw new SearchError(`${name} is not a valid date.`, 400);
  return milliseconds / 86400000 + 40587 + (end ? 1 : 0);
}
export function validateSearch(params) {
  const raDeg = numeric(params.get('raDeg'), 'RA (degrees)', 0, 360, true);
  const decDeg = numeric(params.get('decDeg'), 'Dec (degrees)', -90, 90);
  const detector = params.get('detector') && params.get('detector') !== 'all' ? numeric(params.get('detector'), 'detector', 1, 6) : null;
  if (detector !== null && !Number.isInteger(detector)) throw new SearchError('Detector must be D1 through D6.', 400);
  const release = params.get('release') || 'all';
  if (release !== 'all' && !/^qr[1-9]\d*$/.test(release)) throw new SearchError('Release must be all or a public QR release, such as qr3.', 400);
  const startDate = params.get('startDate') || '', endDate = params.get('endDate') || '';
  const startMjd = dateBound(startDate, 'Start date', false), endMjd = dateBound(endDate, 'End date', true);
  if (startMjd !== null && endMjd !== null && startMjd >= endMjd) throw new SearchError('End date must be on or after the start date.', 400);
  let afterUri = null;
  const cursor = params.get('cursor');
  if (cursor) {
    if (cursor.length > 1024 || !/^[\w-]+$/.test(cursor)) throw new SearchError('Invalid observation cursor. Start a new search.', 400);
    afterUri = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!scienceUrl(afterUri) || !afterUri.startsWith('ibe/data/')) throw new SearchError('Invalid observation cursor. Start a new search.', 400);
  }
  const motion = presetMotion({ raDeg, decDeg, targetId: params.get('targetId') });
  return { raDeg, decDeg, frame: 'icrs', detector, release, startDate, endDate, startMjd, endMjd, afterUri, ...(motion ? { targetId: params.get('targetId') } : {}) };
}

export function buildQuery(search, { collections: available = COLLECTIONS } = {}) {
  const collections = available.filter(c => search.release === 'all' || c === 'spherex_' + search.release || c === 'spherex_' + search.release + '_deep');
  if (!collections.length || collections.some(c => !/^spherex_qr\d+(_deep)?$/.test(c))) throw new SearchError('The selected archive release is not available.', 400);
  const conditions = [
    `ob.collection IN (${collections.map(c => `'${c}'`).join(',')})`,
    "a.producttype='science'",
    `1=CONTAINS(POINT('ICRS',${search.raDeg},${search.decDeg}),p.poly)`
  ];
  if (search.detector) conditions.push(`p.energy_bandpassname IN ('D${search.detector}','SPHEREx-D${search.detector}')`);
  if (search.startMjd !== null) conditions.push(`p.time_bounds_upper>=${search.startMjd}`);
  if (search.endMjd !== null) conditions.push(`p.time_bounds_lower<${search.endMjd}`);
  if (search.windowStartMjd !== undefined) conditions.push(`p.time_bounds_lower>=${search.windowStartMjd}`);
  if (search.afterUri) conditions.push(`a.uri>'${search.afterUri}'`);
  return `SELECT TOP ${MAX_RESULTS + 1}
    ob.observationid AS obs_id,ob.collection AS obs_collection,
    p.energy_bandpassname,p.time_bounds_lower AS t_min,p.time_bounds_upper AS t_max,
    p.time_exposure AS t_exptime,p.energy_bounds_lower AS em_min,p.energy_bounds_upper AS em_max,
    p.obs_publisher_did,p.calibrationlevel AS calib_level,p.datarelease AS obs_release_date,
    p.quality_flag,p.provenance_version,p.provenance_lastexecuted,p.lastmodified,
    a.uri,a.artifactid,a.contentlength,a.lastmodified AS artifact_modified
    FROM spherex.plane AS p
    JOIN spherex.observation AS ob ON p.obsid=ob.obsid
    JOIN spherex.artifact AS a ON p.planeid=a.planeid
    WHERE ${conditions.join(' AND ')} ORDER BY a.uri ASC`;
}

// IRSA TAP accepts one constant footprint position per query. Divide the
// mission into stable windows so pagination and date filtering use the same
// search centers. FITS projection uses the exact exposure midpoint.
export function observationQueries(search, { collections, now }) {
  if (!search.targetId) return [buildQuery(search, { collections })];
  const missionStart = 60746; // 2025-03-12 UTC
  const archiveEnd = Math.floor(now / 86400000 + 40587) + 1;
  const queries = [];
  for (let start = missionStart; start < archiveEnd; start += 180) {
    const end = start + 180;
    if (search.endMjd !== null && search.endMjd <= start) break;
    // Include the preceding window when an exposure may cross the date boundary.
    if (search.startMjd !== null && search.startMjd >= end + 1) continue;
    const pointing = exposureCenter(search, { startMjd: (start + end) / 2 });
    queries.push(buildQuery({
      ...search, ...pointing, windowStartMjd: start,
      endMjd: Math.min(search.endMjd ?? end, end),
    }, { collections }));
  }
  return queries;
}

// RFC 4180 quoted fields, embedded line breaks, empty cells, BOM and CRLF.
export function parseCsv(text) {
  const rows = []; let row = [], i = 0;
  text = text.replace(/^\uFEFF/, '');
  while (i < text.length) {
    let cell;
    if (text[i] === '"') {
      const start = ++i;
      while (i < text.length) {
        if (text[i] !== '"') { i++; continue; }
        if (text[i + 1] === '"') { i += 2; continue; }
        break;
      }
      if (i === text.length) throw new SearchError('IRSA returned an incomplete table. Please retry.');
      cell = text.slice(start, i++).replace(/""/g, '"');
      if (i < text.length && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') throw new SearchError('IRSA returned malformed CSV. Please retry.');
    } else {
      const start = i;
      while (i < text.length && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
        if (text[i] === '"') throw new SearchError('IRSA returned malformed CSV. Please retry.');
        i++;
      }
      // Slice complete fields instead of allocating a string node for every character.
      cell = text.slice(start, i);
    }
    row.push(cell);
    if (i === text.length) break;
    const delimiter = text[i++];
    if (delimiter === ',') { if (i === text.length) row.push(''); }
    else {
      if (delimiter === '\r' && text[i] === '\n') i++;
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    }
  }
  if (row.some(value => value !== '')) rows.push(row);
  const headers = rows.shift();
  if (!headers?.includes('obs_id')) throw new SearchError('IRSA did not return the expected observation table. Please retry.');
  return rows.map(values => {
    if (values.length !== headers.length) throw new SearchError('IRSA returned an incomplete observation row. Please retry.');
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });
}
const asNumber = value => value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export const mjdToIso = value => {
  const number = asNumber(value); if (number === null) return null;
  const milliseconds = (number - 40587) * 86400000;
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) < 8.64e15 ? new Date(milliseconds).toISOString() : null;
};
export function scienceUrl(uri) {
  if (!uri) return null;
  const path = uri.replace(/^https:\/\/irsa\.ipac\.caltech\.edu\//, '').replace(/^\//, '');
  if (!/^ibe\/data\/spherex\/qr\d+\/level2\/[\w/.-]+\.fits$/.test(path) || path.includes('..')) return null;
  return 'https://irsa.ipac.caltech.edu/' + path;
}
export function normalizeRow(row) {
  const detectorMatch = /(?:^|-)D([1-6])$/.exec(row.energy_bandpassname || '');
  const url = scienceUrl(row.uri);
  const version = /\/(l2b(?:_retry)?-v\d+-\d{4}-\d{3})\//.exec(url || '')?.[1] || null;
  const flag = row.quality_flag?.trim() || null;
  return {
    observationId: row.obs_id, productId: row.artifactid || row.obs_publisher_did,
    publisherId: row.obs_publisher_did, detector: detectorMatch ? Number(detectorMatch[1]) : null,
    observedStartUtc: mjdToIso(row.t_min), observedEndUtc: mjdToIso(row.t_max),
    startMjd: asNumber(row.t_min), endMjd: asNumber(row.t_max), exposureSeconds: asNumber(row.t_exptime),
    wavelengthMinUm: asNumber(row.em_min) === null ? null : Number(row.em_min) * 1e6,
    wavelengthMaxUm: asNumber(row.em_max) === null ? null : Number(row.em_max) * 1e6,
    wavelengthScope: 'image', collection: row.obs_collection,
    release: /spherex_(qr\d+)/.exec(row.obs_collection || '')?.[1].toUpperCase() || null,
    processingVersion: version, pipelineVersion: row.provenance_version || null,
    processedAt: row.provenance_lastexecuted || null, releasedAt: row.obs_release_date || null,
    metadataModifiedAt: row.lastmodified || null, productModifiedAt: row.artifact_modified || null,
    sizeBytes: asNumber(row.contentlength), accessUrl: url,
    quality: {
      archiveFlag: flag, status: flag ? 'reported' : 'not-reported',
      calibrationLevel: asNumber(row.calib_level), source: 'spherex.plane.quality_flag',
      pixelAssessment: 'not-assessed',
      description: flag ? `Archive quality flag: ${flag}. Pixel quality at the target is not assessed.` : 'No archive-level quality flag reported. This does not establish that target pixels are unflagged.'
    }
  };
}
export function deduplicate(rows) {
  try { return preferredProducts(rows.map(normalizeRow)); }
  catch { throw new SearchError('IRSA returned an observation without a valid identifier or detector.'); }
}

export async function queryArchive(query, { fetchImpl = fetch, timeoutMs = 90000, signal } = {}) {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(TAP_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/csv' }, body: new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', QUERY: query, FORMAT: 'csv', MAXREC: String(MAX_RESULTS + 1) }), signal: requestSignal });
      } catch (error) { if (attempt === 0 && !requestSignal.aborted) continue; throw error; }
      if (!response.ok) {
        await response.body?.cancel();
        if (attempt === 0 && [429, 502, 503, 504].includes(response.status)) continue;
        throw new SearchError('IRSA is temporarily unavailable. Please retry.', 502, response.status === 503 ? 'IRSA_UNAVAILABLE' : undefined);
      }
      let text = ''; const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0;
      while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 12_000_000) { await reader.cancel(); throw new SearchError('The archive response is too large. Narrow your date or detector filters.'); } text += decoder.decode(value, { stream: true }); }
      text += decoder.decode();
      if (/^\s*</.test(text)) {
        // TAP may return HTTP 200 with QUERY_STATUS=ERROR. Never treat it as zero results.
        throw new SearchError('IRSA could not complete the metadata query. Please retry or narrow the search.');
      }
      return parseCsv(text);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof SearchError) throw error;
    if (controller.signal.aborted) throw new SearchError('IRSA search timed out. Please retry or narrow the date range.', 504);
    throw new SearchError('Could not reach IRSA. Please check your connection and retry.');
  } finally { clearTimeout(timer); }
}

export function createSearchService({ fetchImpl = fetch, now = () => Date.now(), timeoutMs = 90000, collections = COLLECTIONS, resources = createSearchResources() } = {}) {
  const { pending } = resources;
  return async function searchObservations(params, { signal } = {}) {
    signal?.throwIfAborted();
    const search = validateSearch(params), key = JSON.stringify([collections, search]);
    const cached = resources.get(key, now());
    if (cached) return { ...cached, cached: true };
    if (pending.has(key)) return joinRequest(pending.get(key), signal);
    const release = resources.gate.acquire();
    const record = { controller: new AbortController(), waiters: 0 };
    const request = (async () => {
      const rows = [];
      const queries = observationQueries(search, { collections, now: now() });
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([record.controller.signal, deadline]);
      try {
        // Limit TAP concurrency per search; each batch retains query order.
        for (let i = 0; i < queries.length; i += 2) {
          const batches = await Promise.allSettled(queries.slice(i, i + 2).map(query => queryArchive(query, { fetchImpl, timeoutMs, signal })));
          const failed = batches.find(batch => batch.status === 'rejected');
          if (failed) throw failed.reason;
          for (const batch of batches) rows.push(...batch.value);
        }
      } catch (error) {
        if (deadline.aborted && !record.controller.signal.aborted) throw new SearchError('IRSA search timed out. Please retry or narrow the date range.', 504);
        throw error;
      }
      if (queries.length > 1) rows.sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
      record.controller.signal.throwIfAborted();
      const truncated = rows.length > MAX_RESULTS;
      const observations = deduplicate(rows.slice(0, MAX_RESULTS));
      const result = {
        query: search, source: { name: 'NASA/IPAC IRSA', service: TAP_URL, kind: 'live', collections: collections.filter(c => search.release === 'all' || c === 'spherex_' + search.release || c === 'spherex_' + search.release + '_deep'), retrievedAt: new Date(now()).toISOString() },
        observations, count: observations.length, matchedProducts: Math.min(rows.length, MAX_RESULTS),
        duplicatesRemoved: Math.min(rows.length, MAX_RESULTS) - observations.length, truncated, cached: false,
        nextCursor: truncated ? Buffer.from(rows[MAX_RESULTS - 1].uri).toString('base64url') : null,
        warnings: [
          'Wavelength bounds describe each image, not the exact wavelength at the target pixel.',
          'Archive quality flags are reported as provided. FITS pixel flags at the target are not assessed.',
          search.targetId ? 'Archive footprints are searched at predicted positions in 180-day windows. Cutouts use the predicted position at each exposure midpoint.' : 'Fixed ICRS position search: proper motion is not propagated to observation dates.',
          ...(truncated ? [`More archive products are available. Use Load more observations or narrow your filters; the loaded list is incomplete.`] : [])
        ]
      };
      resources.set(key, result, now() + 900000, now());
      return result;
    })();
    record.promise = request.finally(() => { pending.delete(key); release(); });
    pending.set(key, record);
    return joinRequest(record, signal);
  };
}

async function joinRequest(record, signal) {
  record.waiters++;
  let onAbort;
  try {
    signal?.throwIfAborted();
    if (!signal) return await record.promise;
    return await Promise.race([record.promise, new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (--record.waiters === 0) record.controller.abort();
  }
}
