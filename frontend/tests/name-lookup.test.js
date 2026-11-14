import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createNameResolver, parseSesame, parseSimbad, validateName, SESAME_URL, SIMBAD_MIRROR_URL } from '../lib/name-resolver.js';
import { createResolveObjectHandler } from '../api/resolve-object.js';
import { createAppServer } from '../server.mjs';
import { createServer } from 'node:http';
import { objectNames, suggestNames } from '../object-names.js';
import { createLookupController } from '../object-lookup.js';

const fixture = '# Sirius #Q123\n#=S=Simbad (CDS, via client/server): 1\n%J 101.287155333 -16.716115861 (8)\n%I.0 * alf CMa\n%I Sirius\n';
const missing = '# nonexistent #Q123\n#=S=Simbad: 0\n#=N=NED: 0\n#=V=VizieR: 0\n#! Nothing found\n';
// Shape and values verified against the live Harvard SIMBAD response for M31.
const mirrorFixture = 'C.D.S.  -  SIMBAD4 rel 1.8\n\nObject M 31  ---  AGN  ---  OID=@1575544\nCoordinates(ICRS,ep=J2000,eq=2000): 00 42 44.330  +41 16 07.50 (IR  ) C [~ ~ ] 2006AJ....131.1163S\nCoordinates(FK4,ep=B1950,eq=1950): 00 40 00.095 +40 59 41.73\n';
const params = name => new URLSearchParams({ name });
const data = { ...parseSesame(fixture), submittedName: 'Sirius', retrievedAt: '2026-11-04T00:00:00.000Z' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('Sesame parsing preserves precision, main identifier, source and absent identifiers', () => {
  assert.equal(data.raDeg, 101.287155333); assert.equal(data.decDeg, -16.716115861);
  assert.equal(data.resolvedName, '* alf CMa'); assert.equal(data.source.resolver, 'SIMBAD');
  assert.equal(parseSesame(fixture.replace('%I.0 * alf CMa\n', '')).resolvedName, null);
  assert.equal(parseSesame(fixture.replace('#=S=Simbad', '#=N=NED')).source.resolver, 'NED');
  assert.equal(parseSesame(fixture.replace('#=S=Simbad', '#=V=VizieR')).source.resolver, 'VizieR');
});
test('unresolved is distinct from malformed, incomplete and out-of-range responses', () => {
  assert.throws(() => parseSesame(missing), { status: 404, code: 'NOT_FOUND' });
  assert.throws(() => parseSesame('# source\n#=S=Simbad: 1\n#=N=NED: 0\n'), { status: 502 });
  for (const text of ['', '<html>Service unavailable</html>', '# Sirius\n', fixture.replace('%J ', '%J.E '), fixture.replace('101.287155333', '360'), fixture.replace('-16.716115861', '-91'), fixture.replace('101.287155333', 'NaN'), fixture.replace('101.287155333', 'Infinity')]) assert.throws(() => parseSesame(text), { status: 502 });
});
test('distance hints come from parallax and redshift lines when present', () => {
  assert.equal(data.parallaxMas, undefined); assert.equal(data.redshift, undefined);
  const sesame = parseSesame(fixture.replace('%I.0', '%X 379.21 [1.58] A 2007A&A...474..653V\n%V v -5.50 [0.4] A 2006AstL...32..759G\n%I.0'));
  assert.equal(sesame.parallaxMas, 379.21); assert.equal(sesame.parallaxErrorMas, 1.58);
  assert.ok(Math.abs(sesame.redshift + 5.5 / 299792.458) < 1e-12);
  assert.equal(parseSesame(fixture.replace('%I.0', '%V z 0.0158 [0.0001] C ref\n%I.0')).redshift, 0.0158);
  // Lines from SIMBAD's ASCII output (values verified against the live Harvard mirror).
  const simbad = parseSimbad(mirrorFixture + 'Parallax: 546.9759 [0.0401] A 2020yCat.1350....0G\nRedshift: -0.000367 [0.000000] A 2018MNRAS.475.1960F\n');
  assert.equal(simbad.parallaxMas, 546.9759); assert.equal(simbad.parallaxErrorMas, 0.0401); assert.equal(simbad.redshift, -0.000367);
  const absent = parseSimbad(mirrorFixture + 'Parallax: ~ [~] ~ ~\nRedshift: ~ [~ ~ ] ~ ~\n');
  assert.ok(!('parallaxMas' in absent) && !('redshift' in absent));
});
test('single-name validation rejects controls, batches and duplicate parameters', () => {
  for (const name of ['', ' ', 'a'.repeat(201), 'M31\nM42', 'M31\u0000', 'M31\u0085', 'M31\u200b', 'M31&M42', 'M31;M42']) assert.throws(() => validateName(params(name)), { status: 400 });
  assert.throws(() => validateName(new URLSearchParams('name=M31&name=M42')), { status: 400 });
  assert.equal(validateName(params('  Barnard’s Star  ')), 'Barnard’s Star');
});
test('name encoding cannot inject query values and aliases reach the resolver verbatim', async () => {
  let requested;
  const resolve = createNameResolver({ fetchImpl: async url => { requested = url; return new Response(fixture); } });
  const result = await resolve(params('2MASS J00013599+7214118'));
  assert.equal(requested, SESAME_URL + '?2MASS%20J00013599%2B7214118');
  assert.equal(result.submittedName, '2MASS J00013599+7214118');
  assert.equal(result.resolvedName, '* alf CMa');
});
test('successful cache expires, retains provenance, is bounded and preserves submitted casing', async () => {
  let clock = 0, calls = 0;
  const resolve = createNameResolver({ now: () => clock, ttlMs: 100, maxEntries: 2, fetchImpl: async () => { calls++; return new Response(fixture); } });
  const first = await resolve(params('Sirius')); clock = 50;
  const cached = await resolve(params('sirius'));
  assert.equal(calls, 1); assert.equal(cached.submittedName, 'sirius'); assert.equal(cached.retrievedAt, first.retrievedAt);
  clock = 100; await resolve(params('Sirius')); assert.equal(calls, 2);
  await resolve(params('M31')); await resolve(params('M42')); await resolve(params('Sirius')); assert.equal(calls, 5);
});
test('HTTP/network failures and not-found responses are not cached', async () => {
  for (const [response, expectedCalls] of [[() => new Response('down', { status: 503 }), 4], [() => { throw new Error('network'); }, 4], [() => new Response(missing), 2]]) {
    let calls = 0;
    const resolve = createNameResolver({ fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(resolve(params('Sirius'))); await assert.rejects(resolve(params('Sirius'))); assert.equal(calls, expectedCalls);
  }
});
test('Harvard parser selects ICRS, preserves returned precision, and rejects invalid replies', () => {
  const result = parseSimbad(mirrorFixture);
  assert.equal(result.resolvedName, 'M 31'); assert.equal(result.source.name, 'SIMBAD Harvard mirror');
  assert.ok(Math.abs(result.raDeg - 10.684708333333333) < 1e-12);
  assert.ok(Math.abs(result.decDeg - 41.26875) < 1e-12);
  assert.equal(parseSimbad(mirrorFixture.replace('+41 16 07.50', '-00 30 00.00')).decDeg, -0.5);
  for (const text of ['', '<html>error</html>', mirrorFixture.replace('00 42 44.330', '24 00 00'), mirrorFixture.replace('+41 16 07.50', '+91 00 00'), mirrorFixture.replace('ICRS', 'FK5'), mirrorFixture.replace('00 42 44.330', '00 60 00')]) assert.throws(() => parseSimbad(text), { status: 502 });
  assert.throws(() => parseSimbad("!! 'Siruis': No known catalog could be found\n query string: Siruis\n"), { status: 404 });
});
test('a slow primary falls back within the overall deadline and caches the mirror result', async () => {
  const requested = []; let primaryAborted = false;
  const resolve = createNameResolver({ primaryTimeoutMs: 5, timeoutMs: 1000, fetchImpl: async (url, { signal }) => {
    requested.push(url);
    if (url.startsWith(SESAME_URL)) return new Promise((resolve, reject) => signal.addEventListener('abort', () => { primaryAborted = true; reject(new Error('aborted')); }, { once: true }));
    return new Response(mirrorFixture);
  } });
  const result = await resolve(params('M31'));
  assert.equal(primaryAborted, true); assert.equal(result.resolvedName, 'M 31'); assert.equal(result.source.name, 'SIMBAD Harvard mirror');
  assert.equal(requested[1], SIMBAD_MIRROR_URL + '?Ident=M31&output.format=ASCII');
  await resolve(params('M31')); assert.equal(requested.length, 2);
});
test('primary HTTP, network and malformed-response failures try the mirror', async () => {
  for (const primary of [() => new Response('down', { status: 503 }), () => { throw new Error('network'); }, () => new Response('<html>bad</html>')]) {
    const resolve = createNameResolver({ fetchImpl: async url => url.startsWith(SESAME_URL) ? primary() : new Response(mirrorFixture) });
    assert.equal((await resolve(params('M31'))).resolvedName, 'M 31');
  }
});
test('fallback encoding preserves plus signs and cannot inject SIMBAD parameters', async () => {
  let fallback;
  const resolve = createNameResolver({ fetchImpl: async url => {
    if (url.startsWith(SESAME_URL)) throw new Error('unreachable');
    fallback = new URL(url); return new Response(mirrorFixture);
  } });
  await resolve(params('2MASS J00013599+7214118'));
  assert.deepEqual([...fallback.searchParams], [['Ident', '2MASS J00013599+7214118'], ['output.format', 'ASCII']]);
});
test('Sesame not-found is authoritative; mirror-only misses are service errors and uncached', async () => {
  let calls = 0;
  const missingPrimary = createNameResolver({ fetchImpl: async () => { calls++; return new Response(missing); } });
  await assert.rejects(missingPrimary(params('unknown')), { status: 404 }); assert.equal(calls, 1);
  calls = 0;
  const missingMirror = createNameResolver({ fetchImpl: async url => { calls++; if (url.startsWith(SESAME_URL)) throw new Error('unreachable'); return new Response("!! 'unknown': No known catalog could be found\n"); } });
  await assert.rejects(missingMirror(params('unknown')), { status: 502 });
  await assert.rejects(missingMirror(params('unknown')), { status: 502 }); assert.equal(calls, 4);
});
test('fallback shares the overall timeout rather than receiving another ten seconds', async () => {
  const resolve = createNameResolver({ timeoutMs: 15, fetchImpl: async (url, { signal }) => {
    if (url.startsWith(SESAME_URL)) throw new Error('unreachable');
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await assert.rejects(resolve(params('M31')), { status: 504 });
});
test('upstream timeout returns 504 and can be retried', async () => {
  let calls = 0;
  const resolve = createNameResolver({ timeoutMs: 5, fetchImpl: async (url, { signal }) => {
    if (++calls > 1) return new Response(fixture);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await assert.rejects(resolve(params('Sirius')), { status: 504, code: 'TIMEOUT' });
  assert.equal((await resolve(params('Sirius'))).raDeg, data.raDeg);
});
test('suggestions normalize punctuation, rank closest first and deduplicate', () => {
  assert.equal(objectNames.length, 20);
  assert.equal(suggestNames('Siriu')[0].name, 'Sirius');
  assert.equal(suggestNames('Siruis')[0].name, 'Sirius');
  assert.equal(suggestNames('BARNARD’S STAr')[0].name, 'Barnard’s Star');
  assert.equal(suggestNames('NGC-0224')[0].name, 'Andromeda Galaxy');
  assert.deepEqual(suggestNames('M3'), []); assert.deepEqual(suggestNames('unrecognizedobject'), []);
  assert.deepEqual(suggestNames('Sirxxs'), []);
  assert.equal(suggestNames('Andromeda Galx')[0].name, 'Andromeda Galaxy');
  const names = ['abcd', 'abce', 'abcf', 'abcg'].map(name => ({ name, query: name, aliases: [name] }));
  assert.equal(suggestNames('abcd', [...names, names[0]]).length, 3);
  assert.equal(suggestNames('abcd', names)[0].name, 'abcd');
});
test('lookup resolution selects nothing until confirmation; confirmation is single-use', async () => {
  const selected = [], states = [];
  const lookup = createLookupController({ fetchImpl: async () => json(data), render: state => states.push(state), select: result => selected.push(result) });
  await lookup.resolve('Sirius'); assert.equal(selected.length, 0); assert.equal(states.at(-1).state, 'ready');
  lookup.confirm(); lookup.confirm(); assert.deepEqual(selected, [data]);
});
test('edits, tab changes and other target selections invalidate pending and in-flight lookups', async () => {
  let finish;
  const states = [], selected = [];
  const lookup = createLookupController({ fetchImpl: () => new Promise(resolve => { finish = resolve; }), render: state => states.push(state), select: result => selected.push(result) });
  const request = lookup.resolve('Sirius'); lookup.invalidate(); finish(json(data)); await request;
  assert.equal(states.at(-1).state, 'idle'); lookup.confirm(); assert.equal(selected.length, 0);
});
test('out-of-order lookups cannot replace a newer confirmation', async () => {
  const pending = [], selected = [];
  const lookup = createLookupController({ fetchImpl: () => new Promise(resolve => pending.push(resolve)), render: () => {}, select: result => selected.push(result) });
  const first = lookup.resolve('old'), second = lookup.resolve('new');
  pending[1](json({ ...data, submittedName: 'new' })); await second;
  pending[0](json(data)); await first; lookup.confirm(); assert.equal(selected[0].submittedName, 'new');
});
test('editing after success removes confirmation; malformed success cannot be selected', async () => {
  let state;
  const lookup = createLookupController({ fetchImpl: async () => json(data), render: value => { state = value; }, select: () => assert.fail('must not select') });
  await lookup.resolve('Sirius'); assert.equal(state.state, 'ready'); lookup.invalidate(); lookup.confirm(); assert.equal(state.state, 'idle');
  const malformed = createLookupController({ fetchImpl: async () => json({ ...data, raDeg: 400 }), render: value => { state = value; }, select: () => assert.fail('must not select') });
  await malformed.resolve('Sirius'); malformed.confirm(); assert.equal(state.state, 'error');
});
test('only genuine unresolved responses offer suggestions; failures keep selection unchanged', async () => {
  for (const [status, code] of [[404, 'NOT_FOUND'], [502, 'UPSTREAM_ERROR'], [504, 'TIMEOUT']]) {
    let state;
    const lookup = createLookupController({ fetchImpl: async () => json({ error: 'test', code }, status), render: value => { state = value; }, select: () => assert.fail('must not select') });
    await lookup.resolve('Siriu'); lookup.confirm(); assert.equal(state.state, 'error'); assert.equal(state.suggestions.length > 0, status === 404);
  }
});
test('API and local server expose lookup, validation and method restrictions', async t => {
  const server = createServer(createResolveObjectHandler(createNameResolver({ fetchImpl: async () => new Response(fixture) })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/resolve-object`;
  assert.equal((await (await fetch(url + '?name=Sirius')).json()).resolvedName, '* alf CMa');
  assert.equal((await fetch(url)).status, 400); assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  const local = createAppServer(); local.listen(0, '127.0.0.1'); await once(local, 'listening'); t.after(() => local.close());
  const base = `http://127.0.0.1:${local.address().port}`;
  assert.equal((await fetch(base + '/api/resolve-object')).status, 400);
  for (const asset of ['object-lookup.js', 'object-names.js']) assert.equal((await fetch(base + '/' + asset)).status, 200);
});
