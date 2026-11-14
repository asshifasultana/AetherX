import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWiseHandler } from '../api/wise-sources.js';
import { decodeViewState, encodeViewState } from '../url-state.js';

async function invoke(handler, query, method = 'GET') {
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(status) { this.statusCode = status; return this; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handler({ method, url: '/api/wise-sources?' + query }, res);
  return res;
}

const query = 'ra=56.75&dec=24.1167&radius=.02';
const header = 'designation,ra,dec,w1mpro,w1sigmpro,w2mpro,w2sigmpro,ph_qual,cc_flags,separation';
const row = 'J034700.00+240700.0,56.75,24.1167,12.12,.03,13.1,,AUUU,0d00,.001';

test('AllWISE lookup validates inputs, preserves photometry flags and coalesces requests', async () => {
  let calls = 0;
  const handler = createWiseHandler({ fetchImpl: async (url, options) => {
    calls++;
    assert.match(url, /irsa\.ipac\.caltech\.edu\/TAP\/sync$/);
    assert.match(options.body.get('QUERY'), /TOP 1001.+allwise_p3as_psd.+ORDER BY separation,designation/);
    return new Response(header + '\n' + row);
  } });
  assert.equal((await invoke(handler, 'ra=invalid')).statusCode, 400);
  assert.equal((await invoke(handler, query, 'POST')).statusCode, 405);
  const [first, second] = await Promise.all([invoke(handler, query), invoke(handler, query)]);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, second.body);
  assert.deepEqual(first.body.sources[0].photometry, [
    { magnitude: 12.12, uncertainty: .03, quality: 'A', artifact: '0' },
    { magnitude: 13.1, uncertainty: null, quality: 'U', artifact: 'd' }
  ]);
  await invoke(handler, query);
  assert.equal(calls, 1);
});

test('AllWISE lookup distinguishes empty, capped, and unavailable responses', async () => {
  const run = fetchImpl => invoke(createWiseHandler({ fetchImpl }), query);
  assert.deepEqual((await run(async () => new Response(header))).body.sources, []);
  const capped = await run(async () => new Response([header, ...Array(1001).fill(row)].join('\n')));
  assert.equal(capped.body.truncated, true);
  assert.equal(capped.body.sources.length, 1000);
  assert.equal((await run(async () => new Response('Unavailable', { status: 503 }))).statusCode, 502);
});

test('shared links independently restore Gaia and AllWISE', () => {
  const encoded = encodeViewState({ gaia: true, wise: true });
  assert.equal(decodeViewState(encoded).state.gaia, true);
  assert.equal(decodeViewState(encoded).state.wise, true);
  assert.equal(decodeViewState('gaia=1').state.wise, false);
  assert.equal(decodeViewState('wise=1&wise=0').issues.length, 1);
});

test('AllWISE switches to the CDS mirror when IRSA is unavailable', async () => {
  const handler = createWiseHandler({ fetchImpl: async url => {
    if (url.includes('ipac.caltech.edu')) return new Response('Busy', { status: 503 });
    const mirror = new URL(url);
    assert.equal(mirror.hostname, 'vizier.idia.ac.za');
    assert.equal(mirror.searchParams.get('-source'), 'II/328/allwise');
    assert.equal(mirror.searchParams.get('-sort'), '_r,AllWISE');
    return new Response([
      '#Name: II/328/allwise',
      '_r\tAllWISE\tRAJ2000\tDEJ2000\tW1mag\te_W1mag\tW2mag\te_W2mag\tqph\tccf',
      'deg\t \tdeg\tdeg\tmag\tmag\tmag\tmag\t \t ',
      '----\t----\t----\t----\t----\t----\t----\t----\t----\t----',
      '0.002\tJ034700.00+240700.0\t56.75\t+24.1167\t12.12\t.03\t13.1\t \tAUUU\t0d00'
    ].join('\n'));
  } });
  const result = await invoke(handler, query);
  assert.equal(result.statusCode, 200);
  assert.match(result.body.endpoint, /vizier\.idia\.ac\.za/);
  assert.equal(result.body.sources[0].photometry[1].quality, 'U');
});
