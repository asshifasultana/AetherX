import { mkdir, open, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { INDEX_DIRECTORY, createIndexStore, snapshotNameIsValid, UPDATE_SCHEDULE } from '../frontend/lib/index-store.js';
import { buildQuery, queryArchive, normalizeRow, validateSearch, scienceUrl, MAX_RESULTS, TAP_URL, COLLECTIONS } from '../frontend/lib/observations.js';
import { preferredProducts, COLLECTION_PATTERN } from '../frontend/observation-products.js';
import { presets } from '../frontend/presets.js';

// Ask TAP, the same service searches use, which collections exist. IRSA's SIA
// collection list lagged behind (it still offered QR2 and never listed DR1).
// DISTINCT scans the whole table, so IRSA takes over a minute to answer.
export async function discoverCollections({ fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TAP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/csv' },
      body: new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: 'SELECT DISTINCT collection FROM spherex.observation' }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error('IRSA collection discovery failed.');
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Unexpected collection discovery response.');
    const names = [...new Set(text.split(/\r?\n/).map(line => line.trim().replace(/^"|"$/g, '')).filter(name => COLLECTION_PATTERN.test(name)))].sort();
    if (!names.length) throw new Error('No public SPHEREx spectral-image collections were discovered.');
    return names;
  } finally { clearTimeout(timeout); }
}

// The scheduled job can wait longer than a visitor: IRSA sometimes needs over two
// minutes for one target, which the 90-second interactive limit would reject.
const INDEX_QUERY_TIMEOUT_MS = 300000;
export async function fetchTargetProducts(target, collections, { query = text => queryArchive(text, { timeoutMs: INDEX_QUERY_TIMEOUT_MS }), onProgress = () => {} } = {}) {
  const search = validateSearch(new URLSearchParams({ raDeg: target.raDeg, decDeg: target.decDeg }));
  const products = new Map(), cursors = new Set(); let pages = 0;
  while (true) {
    const rows = await query(buildQuery(search, { collections }));
    if (rows.length > MAX_RESULTS + 1) throw new Error('The archive exceeded the requested page size.');
    const batch = rows.slice(0, MAX_RESULTS);
    for (const row of batch) {
      const product = normalizeRow(row);
      if (!product.observationId || !product.detector || !product.accessUrl || !product.observedStartUtc || !product.processingVersion) throw new Error('IRSA returned an incomplete product; the previous index will be retained.');
      const key = `${product.release}/${product.productId}`;
      const previous = products.get(key);
      // A physical file may be listed in wide/deep collections. Keep one record,
      // preferring the wide membership when both represent the same artifact.
      if (!previous || (previous.collection.endsWith('_deep') && !product.collection.endsWith('_deep'))) products.set(key, product);
    }
    pages++; onProgress({ pages, products: products.size });
    if (rows.length <= MAX_RESULTS) break;
    const cursor = batch.at(-1)?.uri;
    if (!scienceUrl(cursor) || !cursor.startsWith('ibe/data/') || cursors.has(cursor) || (search.afterUri && cursor <= search.afterUri)) throw new Error('IRSA pagination did not advance; the previous index will be retained.');
    if (pages >= 100) throw new Error('Archive page safety limit reached; refusing to publish a partial index.');
    cursors.add(cursor); search.afterUri = cursor;
  }
  return [...products.values()].sort((a, b) => a.accessUrl < b.accessUrl ? -1 : a.accessUrl > b.accessUrl ? 1 : 0);
}
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function compareProducts(previous, next) {
  const key = o => `${o.observationId}/D${o.detector}`;
  const before = new Map(preferredProducts(previous).map(o => [key(o), canonical(o)]));
  const after = new Map(preferredProducts(next).map(o => [key(o), canonical(o)]));
  let added = 0, revised = 0, removed = 0, unchanged = 0;
  for (const [id, value] of after) { if (!before.has(id)) added++; else if (before.get(id) !== value) revised++; else unchanged++; }
  for (const id of before.keys()) if (!after.has(id)) removed++;
  return { added, revised, removed, unchanged };
}
async function atomicJson(file, object) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(object, null, 2) + '\n', { flag: 'wx' });
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function updateIndex({ directory = INDEX_DIRECTORY, targets = presets, now = () => Date.now(), discover = discoverCollections, fetchProducts = fetchTargetProducts, allowEmpty = false, log = () => {} } = {}) {
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, '.update.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('An observation-index update is already running.'); throw error; }
  const store = createIndexStore({ directory });
  let previous = null;
  const attemptedAt = new Date(now()).toISOString();
  try {
    await lock.writeFile(String(process.pid));
    previous = await store.manifest();
    let collections;
    try { collections = await discover(); }
    catch (error) {
      // A slow listing should not cost the whole daily check: search the known releases.
      log(`Collection discovery failed (${error.message}); using ${COLLECTIONS.join(', ')}.`);
      collections = COLLECTIONS;
    }
    if (!collections.length || collections.some(c => !COLLECTION_PATTERN.test(c))) throw new Error('Invalid archive collections.');
    const completed = [], changes = { added: 0, revised: 0, removed: 0, unchanged: 0 };
    // Low concurrency deliberately avoids overwhelming IRSA. No file is published
    // until every target has completed every page successfully.
    for (const [id, target] of Object.entries(targets)) {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid target ID.');
      log(`Checking ${target.name}…`);
      const products = await fetchProducts(target, collections);
      preferredProducts(products); // Validate identities before any publication.
      const priorEntry = previous?.targets.find(t => t.id === id);
      const prior = priorEntry ? await store.snapshot(priorEntry) : null;
      if (!allowEmpty && prior?.products.length && !products.length) throw new Error(`${target.name} unexpectedly returned zero products. The last good index was retained. Recheck IRSA before using --allow-empty.`);
      const delta = compareProducts(prior?.products || [], products);
      for (const key of Object.keys(changes)) changes[key] += delta[key];
      const snapshot = { schemaVersion: 1, complete: true, target: { id, raDeg: target.raDeg, decDeg: target.decDeg }, products };
      const text = JSON.stringify(snapshot) + '\n', hash = createHash('sha256').update(text).digest('hex');
      const entry = { id, name: target.name, raDeg: target.raDeg, decDeg: target.decDeg, snapshot: `snapshots/${id}-${hash}.json`, hash, count: preferredProducts(products).length, productCount: products.length, checkedAt: new Date(now()).toISOString(), changes: delta };
      completed.push({ entry, text });
      log(`${target.name}: ${entry.count} unique detector images; ${delta.added} new, ${delta.revised} revised, ${delta.removed} removed.`);
    }
    const targetEntries = completed.map(item => item.entry);
    const changed = canonical(collections) !== canonical(previous?.collections || []) || targetEntries.length !== previous?.targets.length || targetEntries.some(t => previous?.targets.find(p => p.id === t.id)?.hash !== t.hash);
    const finishedAt = new Date(now()).toISOString();
    const manifest = { schemaVersion: 1, scope: 'preset-targets', status: 'ready', schedule: UPDATE_SCHEDULE, lastAttemptAt: attemptedAt, lastSuccessfulCheckAt: finishedAt, lastChangedAt: changed ? finishedAt : previous.lastChangedAt, collections, totalObservations: targetEntries.reduce((sum, t) => sum + t.count, 0), changes, targets: targetEntries, previousSnapshots: (previous?.targets || []).map(t => t.snapshot), error: null };
    await mkdir(path.join(directory, 'snapshots'), { recursive: true });
    for (const item of completed) {
      // Content-addressed files are immutable: don't truncate a file that a
      // search may be reading while an unchanged index is being checked.
      try { await writeFile(path.join(directory, item.entry.snapshot), item.text, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await readFile(path.join(directory, item.entry.snapshot), 'utf8');
        if (createHash('sha256').update(existing).digest('hex') !== item.entry.hash) throw new Error('An existing snapshot failed its integrity check. The last good index was retained.');
      }
    }
    await atomicJson(path.join(directory, 'index.json'), manifest);
    // Keep current + previous complete snapshots for readers holding the old manifest.
    const retained = new Set([...targetEntries.map(t => t.snapshot), ...manifest.previousSnapshots]);
    for (const name of await readdir(path.join(directory, 'snapshots'))) {
      const relative = 'snapshots/' + name;
      if (snapshotNameIsValid(relative) && !retained.has(relative)) await unlink(path.join(directory, relative));
    }
    return manifest;
  } catch (error) {
    const failed = { ...(previous || { schemaVersion: 1, collections: [], targets: [], totalObservations: 0, lastSuccessfulCheckAt: null, lastChangedAt: null }), status: 'error', lastAttemptAt: attemptedAt, error: String(error.message).slice(0, 500) };
    await atomicJson(path.join(directory, 'index.json'), failed);
    throw error;
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
