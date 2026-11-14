import { readFile } from 'node:fs/promises';
import { publicStarProfile, starAlias, starLookupKeys, starProfiles } from '../lib/star-profiles.js';
import { createStarProfileStore } from '../lib/star-profile-store.js';

const fallback = new Map(starProfiles.flatMap(profile =>
  starLookupKeys(profile).map(key => [key, publicStarProfile(profile)])
));

let localCatalog;
async function localProfile(key) {
  localCatalog ??= readFile('.local/star-profiles.json', 'utf8')
    .then(text => new Map(JSON.parse(text).rows.flatMap(row => row.lookup_keys.map(key => [key, row.profile]))))
    .catch(() => new Map());
  return (await localCatalog).get(key);
}

export function createStarDetailsHandler(store = createStarProfileStore(), lookupLocal = localProfile) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      res.end(JSON.stringify({ error: 'Use GET to look up star details.' }));
      return;
    }
    const params = new URL(req.url, 'http://localhost').searchParams;
    const preset = params.get('preset');
    const name = params.get('name');
    const singleInput = params.getAll('preset').length + params.getAll('name').length === 1;
    const key = preset && singleInput && /^[a-z0-9-]{1,48}$/.test(preset)
      ? 'preset:' + preset
      : singleInput && name && name.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(name) && starAlias(name) && 'name:' + starAlias(name);
    if (!key) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Provide one preset or catalog name.' }));
      return;
    }
    let profile;
    try { profile = await store?.get(key); } catch { /* The bundled catalog is available during an outage. */ }
    profile ??= await lookupLocal(key);
    const bundled = fallback.get(key);
    // Older imports may lack fields added in a later release.
    const result = profile ? { ...bundled, ...profile } : bundled;
    res.setHeader('Cache-Control', profile ? 'public, max-age=300, s-maxage=300' : 'public, max-age=30, s-maxage=30');
    res.end(JSON.stringify({ profile: result ?? null }));
  };
}

export default createStarDetailsHandler();
