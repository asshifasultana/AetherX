import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preferredProducts } from '../observation-products.js';
import { COLLECTIONS, MAX_RESULTS, TAP_URL, SearchError, createSearchService, validateSearch } from './observations.js';
import { metadataResources } from './resources.js';

export const INDEX_DIRECTORY = fileURLToPath(new URL('../data/', import.meta.url));
export const INDEX_MAX_AGE_MS = 48 * 3600000;
export const UPDATE_SCHEDULE = { cron: '27 4 * * *', timeZone: 'UTC', description: 'Daily, around 10:27 AM Asia/Dhaka (04:27 UTC)' };
export const snapshotNameIsValid = name => /^snapshots\/[a-z0-9-]+-[a-f0-9]{64}\.json$/.test(name);
export function createIndexStore({ directory = INDEX_DIRECTORY } = {}) {
  const cached = new Map();
  async function manifest() {
    let data;
    try { data = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (data.schemaVersion !== 1 || !Array.isArray(data.targets) || !Array.isArray(data.collections) || data.collections.some(c => !/^spherex_qr\d+(_deep)?$/.test(c))) throw new Error('Invalid observation index manifest.');
    for (const target of data.targets) if (!snapshotNameIsValid(target.snapshot) || !/^[a-f0-9]{64}$/.test(target.hash) || !Number.isFinite(target.raDeg) || !Number.isFinite(target.decDeg)) throw new Error('Invalid indexed target.');
    return data;
  }
  async function snapshot(target) {
    if (cached.has(target.hash)) return cached.get(target.hash);
    if (!snapshotNameIsValid(target.snapshot)) throw new Error('Invalid snapshot path.');
    const text = await readFile(path.join(directory, target.snapshot), 'utf8');
    if (createHash('sha256').update(text).digest('hex') !== target.hash) throw new Error('Observation index checksum mismatch.');
    const data = JSON.parse(text);
    if (data.schemaVersion !== 1 || data.complete !== true || !Array.isArray(data.products) || data.target.id !== target.id || data.target.raDeg !== target.raDeg || data.target.decDeg !== target.decDeg || data.products.length !== target.productCount) throw new Error('Incomplete observation snapshot.');
    cached.set(target.hash, data); while (cached.size > 10) cached.delete(cached.keys().next().value);
    return data;
  }
  return { manifest, snapshot };
}
export function indexStatus(manifest, now = Date.now()) {
  const checked = manifest?.lastSuccessfulCheckAt || null;
  return {
    available: Boolean(manifest?.targets?.length), status: manifest?.status || 'uninitialized',
    scope: 'outage fallback for five preset positions; all positions use cached live IRSA search first', schedule: UPDATE_SCHEDULE,
    lastAttemptAt: manifest?.lastAttemptAt || null, lastSuccessfulCheckAt: checked,
    lastChangedAt: manifest?.lastChangedAt || null, stale: !checked || now - Date.parse(checked) > INDEX_MAX_AGE_MS,
    collections: manifest?.collections || [], totalObservations: manifest?.totalObservations || 0,
    changes: manifest?.changes || null, error: manifest?.error || null,
    targets: (manifest?.targets || []).map(({ id, name, count, productCount, checkedAt, hash }) => ({ id, name, count, productCount, checkedAt, hash }))
  };
}
export function indexedResponse(snapshot, entry, manifest, search, { stale = false } = {}) {
  const filtered = snapshot.products.filter(o => (!search.detector || o.detector === search.detector) && (search.release === 'all' || o.release?.toLowerCase() === search.release) && (search.startMjd === null || o.endMjd >= search.startMjd) && (search.endMjd === null || o.startMjd < search.endMjd));
  const preferred = preferredProducts(filtered);
  const uri = item => item.accessUrl?.replace('https://irsa.ipac.caltech.edu/', '') || '';
  const ordered = preferred.filter(o => !search.afterUri || uri(o) > search.afterUri).sort((a, b) => uri(a) < uri(b) ? -1 : uri(a) > uri(b) ? 1 : 0);
  const selected = ordered.slice(0, MAX_RESULTS), more = ordered.length > MAX_RESULTS;
  const duplicatesRemoved = search.afterUri ? 0 : filtered.length - preferred.length;
  return {
    query: search, source: { name: 'NASA/IPAC IRSA', service: TAP_URL, kind: 'scheduled-index', fallback: true, retrievedAt: entry.checkedAt, indexLastCheckedAt: manifest.lastSuccessfulCheckAt, indexHash: entry.hash, collections: manifest.collections, targetId: entry.id, stale },
    observations: preferredProducts(selected), count: selected.length, matchedProducts: selected.length + duplicatesRemoved,
    duplicatesRemoved, truncated: more, cached: false, nextCursor: more ? Buffer.from(uri(selected.at(-1))).toString('base64url') : null,
    warnings: [
      'Wavelength bounds describe each image, not the exact wavelength at the target pixel.',
      'Archive quality flags are reported as provided. FITS pixel flags at the target are not assessed.',
      search.targetId
        ? 'The fallback index was built at the stored position and may miss observations along the star’s path. Cutouts still use proper motion.'
        : 'Fixed ICRS position search: proper motion is not propagated to observation dates.',
      'Live IRSA search was unavailable. Showing the last successful preset index; newer observations or revisions may be missing.',
      ...(stale ? ['Showing the last successful preset index; newer observations or revisions may be missing.'] : []),
      ...(manifest.status === 'error' ? ['The latest scheduled check failed. These results come from the last successful index.'] : []),
      ...(more ? ['More indexed products are available. Use Load more observations to complete the list.'] : [])
    ]
  };
}
export function createIndexedSearch({ store = createIndexStore(), now = () => Date.now(), liveFactory = collections => createSearchService({ collections, resources: metadataResources }) } = {}) {
  const liveServices = new Map();
  return async (params, options = {}) => {
    const search = validateSearch(params);
    const expectedVersion = params.get('indexVersion');
    if (expectedVersion && !/^[a-f0-9]{64}$/.test(expectedVersion)) throw new SearchError('Invalid index version.', 400);
    let manifest = null, snapshot = null, entry = null;
    try {
      manifest = await store.manifest();
      entry = manifest?.targets.find(t => Math.abs(t.raDeg - search.raDeg) < 1e-10 && Math.abs(t.decDeg - search.decDeg) < 1e-10);
    } catch { /* Never let a missing or damaged local index block a live search. */ snapshot = null; }
    if (manifest?.collections.length && search.release !== 'all' && !manifest.collections.some(c => c === 'spherex_' + search.release || c === 'spherex_' + search.release + '_deep')) throw new SearchError('The selected archive release is not available.', 400);
    if (expectedVersion) {
      try { if (entry?.hash === expectedVersion) snapshot = await store.snapshot(entry); } catch {}
      if (!snapshot) throw new SearchError('The observation index changed while you were browsing. Start a new search to load the updated results.', 409);
      return indexedResponse(snapshot, entry, manifest, search, { stale: now() - Date.parse(entry.checkedAt) > INDEX_MAX_AGE_MS });
    }
    const collections = manifest?.collections?.length ? manifest.collections : COLLECTIONS;
    const key = collections.join(',');
    if (!liveServices.has(key)) { liveServices.set(key, liveFactory(collections)); while (liveServices.size > 3) liveServices.delete(liveServices.keys().next().value); }
    try { return await liveServices.get(key)(params, options); }
    catch (error) {
      if (options.signal?.aborted || search.afterUri || !entry || ![502, 504].includes(error.status)) throw error;
      try { snapshot = await store.snapshot(entry); } catch { throw error; }
      return indexedResponse(snapshot, entry, manifest, search, { stale: now() - Date.parse(entry.checkedAt) > INDEX_MAX_AGE_MS });
    }
  };
}
