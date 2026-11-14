export function createStarProfileStore({
  url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY, fetchImpl = fetch
} = {}) {
  if (!url || !key) return null;
  const endpoint = url.replace(/\/+$/, '') + '/rest/v1/star_profiles';
  const headers = { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}) };

  return {
    async get(lookupKey) {
      const query = new URLSearchParams({
        lookup_keys: 'cs.' + JSON.stringify([lookupKey]), select: 'profile', limit: '2'
      });
      const response = await fetchImpl(endpoint + '?' + query, {
        headers, signal: AbortSignal.timeout(1200)
      });
      if (!response.ok) throw new Error(`Star profile read failed (HTTP ${response.status}).`);
      const rows = await response.json();
      return rows.length === 1 ? rows[0].profile : null;
    },
    async upsert(rows, { seedOnly = false } = {}) {
      const resolution = seedOnly ? 'ignore-duplicates' : 'merge-duplicates';
      const response = await fetchImpl(endpoint + '?on_conflict=id', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: `resolution=${resolution},return=minimal` },
        body: JSON.stringify(rows), signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`Star profile import failed (HTTP ${response.status}).`);
    }
  };
}
