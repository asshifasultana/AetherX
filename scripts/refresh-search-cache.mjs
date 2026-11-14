// Daily upkeep of the shared Supabase search cache (frontend/lib/search-store.js).
// Re-runs only what can have changed: searches covering recent dates (new SPHEREx
// data) and comet searches whose JPL orbit solution was revised. Everything else
// is left alone; rows unused for 7 days are deleted. Each run also keeps a free
// Supabase project from pausing for inactivity.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearchService } from '../frontend/lib/observations.js';
import { createSearchResources } from '../frontend/lib/resources.js';
import { createMovingSearch, movingEndDate } from '../frontend/api/moving-observations.js';
import { defaultSearchStore, isRecentRange } from '../frontend/lib/search-store.js';

const DAY = 86400000;
const SOLUTION_EPOCH = 60800; // Any valid mission epoch: only the orbit solution ID is read.

export async function refreshSearchCache({
  store, now = Date.now(), limit = 60, log = console.log,
  observationsFactory = options => createSearchService(options),
  movingFactory = options => createMovingSearch(options)
}) {
  const counts = { checked: 0, refreshed: 0, unchanged: 0, skipped: 0, failed: 0 };
  // Writes from the job keep last_used_at as is, so unused rows still age out.
  const writer = {
    get: async () => null,
    async put(kind, key, params, result) { if (!await store.put(kind, key, params, result, { used: false })) throw new Error('Could not save the refreshed result to Supabase.'); }
  };
  const lookup = movingFactory({ store: null, resources: createSearchResources() });
  const solutions = new Map();
  const currentSolution = async object => {
    if (!solutions.has(object)) solutions.set(object, lookup(new URLSearchParams({ object, action: 'positions', mjd: String(SOLUTION_EPOCH) })).then(r => r.solution));
    return solutions.get(object);
  };
  const rows = await store.listForRefresh({ usedSince: now - 7 * DAY, limit });
  for (const row of rows) {
    counts.checked++;
    try {
      const query = new URLSearchParams(row.params?.query || '');
      if (query.has('cursor')) { counts.skipped++; continue; }
      let rerun;
      if (row.kind === 'observations') {
        // Old fixed ranges are not re-run; they expire and refill on the next search.
        if (!isRecentRange(query.get('endDate'), now)) { counts.skipped++; continue; }
        rerun = () => observationsFactory({ collections: row.params.collections, store: writer, resources: createSearchResources() })(query);
      } else if (row.kind === 'moving') {
        rerun = () => movingFactory({ store: writer, resources: createSearchResources() })(query);
        if (!isRecentRange(movingEndDate(query), now)) {
          const stored = row.result?.solution;
          // result.object is the resolved Horizons body (e.g. 599:MB); a bare planet name is ambiguous there.
          if (!stored || await currentSolution(row.result?.object || row.params.object || query.get('object')) === stored) {
            await store.markChecked(row.key); counts.unchanged++; continue;
          }
        }
      } else { counts.skipped++; continue; }
      const result = await rerun();
      if (result?.trajectoryError) throw new Error(result.trajectoryError);
      counts.refreshed++;
    } catch (error) {
      counts.failed++;
      log(`Could not refresh ${row.kind} search ${row.key?.slice(0, 12)}: ${error.message}`);
    }
  }
  await store.deleteUnused(now - 7 * DAY);
  log(`Search cache: ${counts.checked} checked, ${counts.refreshed} refreshed, ${counts.unchanged} unchanged, ${counts.skipped} skipped, ${counts.failed} failed.`);
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = defaultSearchStore();
  if (!store) console.log('::warning::SUPABASE_URL and SUPABASE_SERVICE_KEY are not set; the shared search cache was not refreshed.');
  else await refreshSearchCache({ store });
}
