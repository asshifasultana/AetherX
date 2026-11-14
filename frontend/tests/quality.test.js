import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFitsQuality, createQualityService } from '../lib/quality.js';
const card = text => text.padEnd(80, ' ');
const header = lines => { let text = [...lines, 'END'].map(card).join(''); return text.padEnd(Math.ceil(text.length / 2880) * 2880, ' '); };
const fixture = new TextEncoder().encode(header(['SIMPLE  = T', 'BITPIX  = 8', 'NAXIS   = 0']) + header(["XTENSION= 'IMAGE   '", "EXTNAME = 'IMAGE   '", 'NAXIS1  = 2040', 'NAXIS2  = 2040', 'DETECTOR= 3', "OBSID   = '2025W19_1B_0116_1'", "DATE-OBS= '2025-05-05T16:48:02.459'", 'FINAST  = 0 / good fine-astrometric solution', 'HIERARCH L2 N_HOT = 1 / number of pixels flagged hot', 'HIERARCH L2 N_OUTLIER = 79045 / number of flagged outlier pixels']));
const url = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W19_1B/l2b-v20-2025-241/3/level2_2025W19_1B_0116_1D3_spx_l2b-v20-2025-241.fits';
test('FITS quality parser reads header flags and preserves their scope', () => {
  const result = parseFitsQuality(fixture);
  assert.equal(result.fineAstrometry.value, 0); assert.equal(result.fineAstrometry.comment, 'good fine-astrometric solution');
  assert.equal(result.detector, 3); assert.equal(result.imagePixels, 4161600);
  assert.equal(result.flaggedPixelCounts.find(item => item.keyword === 'L2 N_HOT').count, 1);
  assert.equal(result.targetPixelAssessment, 'not-assessed'); assert.match(result.note, /may overlap/);
});
test('missing FITS headers and non-FITS responses are failures', () => {
  assert.throws(() => parseFitsQuality(new TextEncoder().encode('<html>not FITS</html>')));
  assert.throws(() => parseFitsQuality(fixture.slice(0, 200)));
});
test('quality service uses bounded S3 range requests and caches only successes', async () => {
  let calls = 0, clock = 1000;
  const service = createQualityService({ now: () => clock, fetchImpl: async (requestedUrl, options) => {
    calls++; assert.match(requestedUrl, /^https:\/\/nasa-irsa-spherex.s3.amazonaws.com\/qr2\/level2\//);
    assert.equal(options.headers.Range, 'bytes=0-65535'); return new Response(fixture, { status: 206 });
  } });
  const result = await service(url); assert.equal(result.bytesRead, fixture.length);
  await service(url); assert.equal(calls, 1);
  await assert.rejects(service('https://evil.example/image.fits'), { status: 400 }); assert.equal(calls, 1);
  clock += 300001; await service(url); assert.equal(calls, 2);
});
test('full image responses and oversized ranges are rejected', async () => {
  await assert.rejects(createQualityService({ fetchImpl: async () => new Response(fixture) })(url), /No full image/);
  await assert.rejects(createQualityService({ fetchImpl: async () => new Response(new Uint8Array(65537), { status: 206 }) })(url), /more header data/);
});
