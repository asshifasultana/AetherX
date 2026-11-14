import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatwiseHandler, parseCatwise, yearOfMjd } from '../api/catwise-sources.js';
import { createSimbadHandler, parseSimbad } from '../api/simbad-sources.js';
import { parseCsvRows, VIZIER_MIRROR } from '../lib/gaia-catalog.js';

async function invoke(handler, query, method = 'GET') {
  const res = {
    statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.statusCode = status; return this; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handler({ method, url: '/api/x?' + query }, res);
  return res;
}
const query = 'ra=133.795129&dec=-7.245147&radius=.025';

const catwiseHeader = 'source_name,ra,dec,pmra,pmdec,sigpmra,sigpmdec,meanobsmjd,w1mpro,w2mpro';
const wise0855 = 'J085508.34-071439.2,133.7847629,-7.2442457,-7.95040,0.81220,0.3259,0.3100,57170.0,17.966,13.820';
const quiet = 'J085509.47-071502.9,133.7894645,-7.2508264,0.00919,-0.00211,0.0089,0.0105,57230.36,14.989,13.752';
const noisy = 'J085507.74-071458.6,133.7822509,-7.2496127,0.4,0.3,0.3,0.3,57319.17,17.713,16.931';

test('CatWISE validates input, converts motions to mas/yr at the mean epoch, and caches both cones', async () => {
  let calls = 0;
  const handler = createCatwiseHandler({ fetchImpl: async (url, options) => {
    calls++;
    assert.match(url, /irsa\.ipac\.caltech\.edu\/TAP\/sync$/);
    const adql = options.body.get('QUERY');
    assert.match(adql, /FROM catwise_2020 WHERE 1=CONTAINS/);
    // The fast cone is 0.2° and keeps only significant motions of at least 0.1″/yr.
    if (/pmra\*pmra/.test(adql)) { assert.match(adql, /CIRCLE\('ICRS',133\.795129,-7\.245147,0\.2\)/); return new Response(`${catwiseHeader}\n${wise0855}`); }
    return new Response([catwiseHeader, wise0855, quiet, noisy].join('\n'));
  } });
  assert.equal((await invoke(handler, 'ra=bad&dec=0&radius=.02')).statusCode, 400);
  assert.equal((await invoke(handler, 'ra=1&dec=0&radius=1')).statusCode, 400, 'radius is capped');
  assert.equal((await invoke(handler, query, 'POST')).statusCode, 405);
  const [first, second] = await Promise.all([invoke(handler, query), invoke(handler, query)]);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(calls, 2, 'two cones, coalesced');
  assert.equal(first.body.fastChecked, true);
  assert.equal(first.body.sources.length, 3, 'merged by name');
  const dwarf = first.body.sources.find(source => source.sourceName === 'J085508.34-071439.2');
  assert.equal(dwarf.pmra, -7950.4);
  assert.equal(dwarf.pmdec, 812.2);
  assert.ok(Math.abs(dwarf.refEpoch - 2015.4) < 0.05);
  assert.equal(dwarf.w2, 13.82);
  const blurry = first.body.sources.find(source => source.sourceName === 'J085507.74-071458.6');
  assert.equal(blurry.pmra, null, 'a fast motion within the noise is dropped');
  assert.equal(blurry.motionUnreliable, true);
  await invoke(handler, query);
  assert.equal(calls, 2, 'cached');
  assert.ok(Math.abs(yearOfMjd(51544.5) - 2000) < 1e-9);
});

test('CatWISE falls back to the VizieR mirror for the near cone and reports the fast cone as unchecked', async () => {
  const handler = createCatwiseHandler({ fetchImpl: async url => {
    if (url.includes('ipac.caltech.edu')) return new Response('Busy', { status: 503 });
    assert.ok(url.startsWith(VIZIER_MIRROR));
    assert.match(url, /-source=II\/365\/catwise&-c=133\.795129%20-7\.245147&-c\.rd=0\.025/);
    assert.match(url, /-out\.all$/);
    return new Response([
      '#Name: II/365/catwise',
      '_r\tName\tRA_ICRS\tDE_ICRS\tMJD\tpmRA\te_pmRA\tpmDE\te_pmDE\tW1mproPM\tW2mproPM',
      'arcmin\t \tdeg\tdeg\td\tarcsec/yr\tarcsec/yr\tarcsec/yr\tarcsec/yr\tmag\tmag',
      '----\t----\t----\t----\t----\t----\t----\t----\t----\t----\t----',
      '0.6\tJ085508.34-071439.2 \t133.7847629\t-07.2442457\t57230.36\t  -7.95040\t0.3259\t 0.81220\t0.31\t17.966\t13.820'
    ].join('\n'));
  } });
  const result = await invoke(handler, query);
  assert.equal(result.statusCode, 200);
  assert.match(result.body.endpoint, /vizier\.idia\.ac\.za/);
  assert.equal(result.body.fastChecked, false);
  assert.equal(result.body.sources[0].sourceName, 'J085508.34-071439.2');
  assert.equal(result.body.sources[0].pmra, -7950.4);
  assert.equal((await invoke(createCatwiseHandler({ fetchImpl: async () => new Response('down', { status: 503 }) }), query)).statusCode, 502);
});

const simbadRows = [
  'main_id,ra,dec,pmra,pmdec,otype',
  '"WISEA J085510.74-071442.5",133.81890825,-7.247048000000001,-8123.7,673.2,"BD*"',
  '"NAME Barnard\'s Star b",269.452,4.6933,-801.551,10362.394,"Pl"',
  '"Cl, ""odd"" name",133.8,-7.25,,,"Cl*"',
  '"no position",,,,,"?"'
].join('\n');

test('SIMBAD parses quoted names, drops planets and positionless rows, and falls back to the CfA mirror', async () => {
  const parsed = parseSimbad(simbadRows);
  assert.deepEqual(parsed.sources.map(source => source.mainId), ['WISEA J085510.74-071442.5', 'Cl, "odd" name']);
  assert.equal(parsed.sources[0].otype, 'BD*');
  assert.equal(parsed.sources[0].refEpoch, 2000);
  assert.equal(parsed.sources[1].pmra, null);
  assert.deepEqual(parseCsvRows('a,"b,c"\r\n1,2\n'), [['a', 'b,c'], ['1', '2']]);

  const asked = [];
  const handler = createSimbadHandler({ fetchImpl: async (url, options) => {
    asked.push(url);
    if (url.includes('cds.unistra.fr')) return new Response('<!doctype html>maintenance', { status: 200 });
    assert.match(url, /simbad\.cfa\.harvard\.edu\/simbad\/sim-tap\/sync$/);
    assert.match(options.body.get('QUERY'), /FROM basic WHERE CONTAINS/);
    return new Response(simbadRows);
  } });
  const result = await invoke(handler, query);
  assert.equal(result.statusCode, 200);
  assert.match(result.body.endpoint, /cfa\.harvard\.edu/);
  assert.equal(result.body.fastChecked, true);
  assert.equal(result.body.sources[0].otype, 'BD*');
  assert.ok(asked.some(url => url.includes('cds.unistra.fr')), 'CDS is asked first; a page that is not a table falls through');
  const before = asked.length;
  await invoke(handler, query);
  assert.equal(asked.length, before, 'cached');
  assert.equal((await invoke(handler, 'ra=1&dec=0&radius=.02&url=https://evil.example')).statusCode, 400);
});

test('catalogue parsers reject tables with the wrong columns', () => {
  assert.throws(() => parseSimbad('id,ra\n1,2'), /unexpected/);
  assert.throws(() => parseCatwise('name,ra\n1,2', 'https://irsa.ipac.caltech.edu/TAP/sync'), /unexpected/);
});
