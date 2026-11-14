import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovingSearch, parseElongations, mostDataThrough, mostBody, horizonsCommand } from '../api/moving-observations.js';
import { createSearchResources } from '../lib/resources.js';

const header = '|observationid|planeid|productid|mjd_start|mjd_end|exposure_time|uri|';
const most = end => `\\user_input_end_time = "${end} 12:00:00"\n\\object_name = "Mars (499)"\n${header}\n|char|char|char|double|double|double|char|\n`;
const horizons = angles => JSON.stringify({ result: `...\n$$SOE\n${angles.map(a => ` 2461000.5, , , ${a},/T,`).join('\n')}\n$$EOE\n` });

test('Sun angles and archive coverage parse from Horizons and MOST text', () => {
  assert.deepEqual(parseElongations(JSON.parse(horizons([63.1, 70, 75.6])).result, 3), [63.1, 70, 75.6]);
  assert.throws(() => parseElongations('$$SOE\n a, , , 63,/T,\n$$EOE', 2), /incomplete Sun angles/);
  assert.equal(mostDataThrough(most('2026 10 16'), Date.UTC(2026, 10, 13)), '2026-10-16');
  assert.equal(mostDataThrough(most('2026 11 13'), Date.UTC(2026, 10, 13)), null);
});

test('planet names resolve to the body MOST chose, never the barycenter', () => {
  assert.deepEqual(mostBody(most('2026 10 16'), 'Mars'), { name: 'Mars (499)', target: '499:MB' });
  assert.equal(mostBody('\\object_name = "1 Ceres (A801 AA)"\n', '1 Ceres').target, '1 Ceres');
  assert.equal(mostBody(most('2026 10 16'), '20000004:NID').target, '20000004:NID');
  assert.equal(horizonsCommand('499:MB'), '499'); assert.equal(horizonsCommand('20000004:NID'), 'DES=20000004;');
  assert.equal(horizonsCommand('433'), '433;'); assert.equal(horizonsCommand('3I'), '3I');
});

test('empty moving searches report where the object was and where public data ends', async () => {
  const urls = [];
  const search = createMovingSearch({ store: null, resources: createSearchResources(), fetchImpl: async url => {
    urls.push(String(url));
    return new Response(String(url).includes('MOST') ? most('2026 10 16') : horizons([63, 70, 75.6]));
  } });
  const result = await search(new URLSearchParams({ object: 'Mars', startDate: '2026-09-01', endDate: '2026-11-12' }));
  assert.equal(result.exposures.length, 0);
  assert.equal(result.dataThrough, '2026-10-16');
  assert.deepEqual(result.sunAngle, { min: 63, max: 75.6 });
  const tlist = new URL(urls[1]).searchParams.get('TLIST');
  const jd = time => (time / 86400000 + 40587 + 2400000.5).toFixed(9);
  assert.deepEqual(tlist.replaceAll("'", '').split(' ').at(-1), jd(Date.UTC(2026, 9, 16)), 'Sun angles stop where public data ends');
  assert.equal(new URL(urls[1]).searchParams.get('QUANTITIES'), "'23'");
  assert.equal(new URL(urls[1]).searchParams.get('COMMAND'), "'499'");
  assert.equal(result.object, '499:MB');
});

test('a Horizons failure leaves the empty result without Sun angles', async () => {
  const search = createMovingSearch({ store: null, resources: createSearchResources(), fetchImpl: async url =>
    String(url).includes('MOST') ? new Response(most('2026 11 13')) : new Response('down', { status: 503 }) });
  const result = await search(new URLSearchParams({ object: 'Mars', startDate: '2026-10-13', endDate: '2026-11-12' }));
  assert.equal(result.exposures.length, 0); assert.equal(result.sunAngle, undefined); assert.equal(result.dataThrough, null);
});
