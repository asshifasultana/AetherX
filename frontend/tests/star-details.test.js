import assert from 'node:assert/strict';
import test from 'node:test';
import { createStarDetailsHandler } from '../api/star-details.js';
import { createStarProfileStore } from '../lib/star-profile-store.js';
import { starAlias } from '../lib/star-profiles.js';
import { collectStarRows, combineStarRows } from '../../scripts/wikimedia-star-catalog.mjs';

async function request(handler, query, method = 'GET') {
  const headers = new Map();
  const response = {
    statusCode: 200,
    setHeader: (name, value) => headers.set(name, value),
    end(body) { this.body = JSON.parse(body); }
  };
  await handler({ method, url: '/api/star-details?' + query }, response);
  return { ...response, headers };
}

test('looks up a normalized catalog alias in Supabase without exposing credentials', async () => {
  const profile = { name: 'Barnard’s Star', description: 'Imported description' };
  const store = createStarProfileStore({
    url: 'https://example.supabase.co/', key: 'sb_secret_example',
    async fetchImpl(url, { headers }) {
      const requestUrl = new URL(url);
      assert.equal(requestUrl.pathname, '/rest/v1/star_profiles');
      assert.equal(requestUrl.searchParams.get('lookup_keys'), 'cs.["name:gj 699"]');
      assert.equal(headers.apikey, 'sb_secret_example');
      assert.equal(headers.Authorization, undefined);
      return Response.json([{ profile }]);
    }
  });
  const result = await request(createStarDetailsHandler(store, () => null), 'name=+GJ++699+');
  assert.equal(result.body.profile.description, profile.description);
  assert.match(result.body.profile.discoverer, /Edward Emerson Barnard/);
  assert.match(result.body.profile.discoveryMethod, /photographs/);
  assert.equal(result.body.profile.discoverySources[0].url, 'https://doi.org/10.1086/104156');
  assert.match(result.headers.get('Cache-Control'), /max-age=300/);
});

test('uses reviewed fallback matches during outages and keeps components distinct', async () => {
  const handler = createStarDetailsHandler({ async get() { throw new Error('offline'); } }, () => null);
  const result = await request(handler, 'preset=epsilon');
  assert.match(result.body.profile.description, /Epsilon Indi Ba and Bb/);
  assert.equal((await request(handler, 'name=Epsilon+Indi+A')).body.profile, null);
  assert.equal((await request(handler, 'name=R+Dra')).body.profile.name, 'R Draconis');
  const sirius = (await request(handler, 'name=Sirius')).body.profile;
  assert.equal(sirius.discoverer, undefined);
  assert.equal(sirius.discoveryMethod, undefined);
  assert.equal((await request(handler, 'name=Sirius&name=Vega')).statusCode, 400);
  assert.equal((await request(handler, 'preset=barnard', 'POST')).statusCode, 405);
});

test('a bulk catalog follows Wikipedia continuation and imports catalog names and discovery facts', async t => {
  const continuations = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const params = new URL(url).searchParams;
    if (params.get('list') === 'embeddedin') {
      const cursor = params.get('eicontinue');
      continuations.push(cursor);
      return Response.json(cursor ? { query: { embeddedin: [{ pageid: 456, title: 'List of stars' }] } } : {
        continue: { eicontinue: 'next' }, query: { embeddedin: [{ pageid: 123, title: 'Example Star' }] }
      });
    }
    if (params.has('pageids')) {
      assert.equal(params.get('pageids'), '123');
      return Response.json({ query: { pages: [{
        pageid: 123, title: 'Example Star', extract: 'A stellar description.', lastrevid: 789, pageprops: { wikibase_item: 'Q123' }
      }] } });
    }
    if (params.get('ids') === 'Q123') {
      const statement = value => ({ mainsnak: { datavalue: { value } } });
      return Response.json({ entities: { Q123: { claims: {
        P3083: [statement('HD 123')], P61: [statement({ id: 'Q456' })],
        P575: [statement({ time: '+1916-00-00T00:00:00Z', precision: 9 })]
      } } } });
    }
    assert.equal(params.get('ids'), 'Q456');
    return Response.json({ entities: { Q456: { labels: { en: { value: 'Example Astronomer' } } } } });
  });
  const rows = await collectStarRows('SphereX test', () => {});
  assert.deepEqual(continuations, [null, 'next']);
  const example = rows.find(row => row.id === 'Q123');
  assert.ok(example.lookup_keys.includes('name:* hd 123'));
  assert.equal(example.profile.discoverer, 'Example Astronomer');
  assert.equal(example.profile.discoveryDate, '1916');
  assert.equal(example.profile.source.revision, 789);
  const response = await request(createStarDetailsHandler(null, key => example.lookup_keys.includes(key) ? example.profile : null), 'name=HD+123');
  assert.equal(response.body.profile.name, 'Example Star');
});

test('bulk aliases cannot shadow a reviewed component or resolve an ambiguous name', () => {
  const article = (id, title) => ({
    id, lookup_keys: ['name:' + title.toLowerCase(), 'name:shared', 'name:epsilon indi b'],
    profile: { source: { title } }
  });
  const rows = combineStarRows([article('Q100', 'Epsilon Indi'), article('Q101', 'Example Star')]);
  const matches = key => rows.filter(row => row.lookup_keys.includes(key)).map(row => row.id);
  assert.deepEqual(matches('name:epsilon indi b'), ['epsilon']);
  assert.deepEqual(matches('name:epsilon indi'), ['Q100']);
  assert.deepEqual(matches('name:shared'), []);
  assert.notEqual(starAlias('NU Orionis'), starAlias('Nu Orionis'));
});
