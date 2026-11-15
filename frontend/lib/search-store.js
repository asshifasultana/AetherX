import { createHash } from 'node:crypto';

// Shared, durable cache of archive search results (metadata only, never images),
// stored in one Supabase table through its REST API. Every read failure is a cache
// miss and every write failure is ignored: the cache can never block a search.
export const FRESH_RECENT_MS = 36 * 3600000;   // daily refresh job + slack
export const FRESH_FIXED_MS = 7 * 86400000;    // date ranges that ended more than 30 days ago
export const STALE_MS = 7 * 86400000;          // extra age allowed only while upstream is down
export const RECENT_RANGE_MS = 30 * 86400000;
const TABLE = 'search_cache';
const HOUR = 3600000;

export const cacheRowKey = (kind, cacheKey) => createHash('sha256').update(kind + '\n' + JSON.stringify(cacheKey)).digest('hex');

// A range with no end date, or one ending within 30 days, can still gain new exposures.
export function isRecentRange(endDate, now = Date.now()) {
  if (!endDate) return true;
  const end = Date.parse(endDate + 'T00:00:00Z');
  return !Number.isFinite(end) || now - end < RECENT_RANGE_MS;
}
export const freshFor = (endDate, now = Date.now()) => isRecentRange(endDate, now) ? FRESH_RECENT_MS : FRESH_FIXED_MS;
// Classify a saved entry. 'fresh' is served normally; 'stale' only when upstream fails.
export function entryAge(saved, endDate, now = Date.now()) {
  if (!saved) return 'missing';
  const age = now - saved.checkedAt, fresh = freshFor(endDate, now);
  return age < fresh ? 'fresh' : age < fresh + STALE_MS ? 'stale' : 'expired';
}

export function createSearchStore({ url, key, fetchImpl = fetch, now = () => Date.now(), readTimeoutMs = 1500, writeTimeoutMs = 4000, jobTimeoutMs = 15000 }) {
  if (!url || !key) throw new TypeError('Supabase URL and key are required.');
  const base = String(url).replace(/\/+$/, '') + '/rest/v1/' + TABLE;
  // New secret keys go in `apikey` only; legacy service_role keys are JWTs and also need Authorization.
  const auth = { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}) };
  const iso = time => new Date(time).toISOString();
  async function call(query, { method = 'GET', body, prefer, timeoutMs }) {
    const headers = { ...auth, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(prefer ? { Prefer: prefer } : {}) };
    const response = await fetchImpl(base + query, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Supabase ${method} failed (HTTP ${response.status}).`); }
    return response;
  }
  const patch = (rowKey, fields, timeoutMs) => call(`?key=eq.${rowKey}`, { method: 'PATCH', body: fields, prefer: 'return=minimal', timeoutMs });
  return {
    async get(kind, cacheKey) {
      try {
        const rowKey = cacheRowKey(kind, cacheKey);
        const response = await call(`?key=eq.${rowKey}&select=result,saved_at,checked_at,last_used_at`, { timeoutMs: readTimeoutMs });
        const [row] = await response.json();
        const savedAt = Date.parse(row?.saved_at), checkedAt = Date.parse(row?.checked_at);
        if (!row?.result || typeof row.result !== 'object' || !Number.isFinite(savedAt) || !Number.isFinite(checkedAt)) return null;
        // Usage decides what the refresh job keeps; record it at most hourly, without waiting.
        if (!(now() - Date.parse(row.last_used_at) < HOUR)) patch(rowKey, { last_used_at: iso(now()) }, writeTimeoutMs).catch(() => {});
        return { result: row.result, savedAt, checkedAt };
      } catch { return null; }
    },
    // `used: false` (refresh job) leaves last_used_at alone so unused rows still age out.
    // `lastUsedAt` sets it explicitly, for a row the job moves to a new key.
    async put(kind, cacheKey, params, result, { used = true, lastUsedAt } = {}) {
      try {
        const at = iso(now());
        const lastUsed = lastUsedAt ? { last_used_at: iso(Date.parse(lastUsedAt)) } : used ? { last_used_at: at } : {};
        await call('?on_conflict=key', {
          method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', timeoutMs: writeTimeoutMs,
          body: { key: cacheRowKey(kind, cacheKey), kind, params, result, saved_at: at, checked_at: at, ...lastUsed }
        });
        return true;
      } catch { return false; }
    },
    // Refresh-job operations throw, so the job can report what failed.
    async listForRefresh({ usedSince, limit = 60 }) {
      const response = await call(`?select=key,kind,params,result,checked_at,last_used_at&last_used_at=gte.${encodeURIComponent(iso(usedSince))}&order=checked_at.asc&limit=${limit}`, { timeoutMs: jobTimeoutMs });
      return response.json();
    },
    markChecked: rowKey => patch(rowKey, { checked_at: iso(now()) }, jobTimeoutMs),
    remove: rowKey => call(`?key=eq.${rowKey}`, { method: 'DELETE', prefer: 'return=minimal', timeoutMs: jobTimeoutMs }),
    deleteUnused: before => call(`?last_used_at=lt.${encodeURIComponent(iso(before))}`, { method: 'DELETE', prefer: 'return=minimal', timeoutMs: jobTimeoutMs })
  };
}

// Disabled (null) unless both variables are set: local dev, tests and unconfigured deploys.
export function defaultSearchStore(env = process.env) {
  return env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? createSearchStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY }) : null;
}
