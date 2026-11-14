import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovingSearch } from '../api/moving-observations.js';
import { createSearchResources } from '../lib/resources.js';
import { createMovingView } from '../lib/moving-view.js';
import { matrixFor } from '../lib/fits-engine.js';

const fields = ['observationid', 'planeid', 'productid', 'mjd_start', 'mjd_end', 'exposure_time', 'uri'];
const start = 60898, end = start + 120 / 86400;
const uri = 'ibe/data/spherex/qr2/level2/2025W33/l2b-v20-2025-265/1/exampleD1_spx_test.fits';
const widths = [24, 12, 12, 24, 24, 18, 128];
const row = (values, edge) => edge + values.map((v, i) => String(v).padEnd(widths[i])).join(edge) + edge;
const table = rows => [row(fields, '|'), row(fields.map(() => 'char'), '|'), ...rows.map(values => row(values, ' '))].join('\n');
const params = (extra = {}) => new URLSearchParams({ object: '3I/ATLAS', startDate: '2025-08-11', endDate: '2025-08-11', ...extra });

function horizons(points, center = 'SPHEREx (spacecraft) (-163182)') {
  return `Target body name: ATLAS (C/2025 N1) {source: JPL#55}
Center body name: ${center}
$$SOE
${points.map((jd, i) => `${jd}, , , ${[359.999, 0, .001][i % 3]}, 1,`).join('\n')}
$$EOE`;
}

test('MOST candidates are deduplicated and get spacecraft positions at each exposure epoch', async () => {
  const search = createMovingSearch({ resources: createSearchResources(), fetchImpl: async url => {
    if (url.hostname.startsWith('irsa')) {
      assert.equal(url.searchParams.get('obj_name'), '3I');
      assert.equal(url.searchParams.get('obs_end'), '2025 08 12');
      return new Response(table([
        ['observation-1', 'old', 'D1', start, end, 120, uri],
        ['observation-1', 'new', 'D1', start, end, 120, uri.replace('/qr2/', '/qr3/')],
      ]));
    }
    assert.equal(url.searchParams.get('CENTER'), "'500@-163182'");
    return Response.json({ result: horizons(url.searchParams.get('TLIST').slice(1, -1).split(' ')) });
  } });
  const result = await search(params());
  assert.equal(result.exposures.length, 1);
  assert.equal(result.exposures[0].productId, 'new');
  assert.equal(result.exposures[0].positions[1].ra, 0);
  assert.equal(result.observer, '-163182');
});

test('empty, ambiguous, incomplete and unavailable observer responses remain distinct', async () => {
  const create = fetchImpl => createMovingSearch({ fetchImpl, resources: createSearchResources() });
  const empty = create(async () => new Response(table([])));
  assert.deepEqual((await empty(params())).exposures, []);
  await assert.rejects(empty(params({ endDate: '2026-01-01' })), { code: 'INVALID_DATES' });
  const ambiguous = create(async () => new Response('Object Name Error:\n4 Vesta, Object Type=Asteroid, NAIF ID=20000004', { status: 400 }));
  await assert.rejects(ambiguous(params()), err => err.code === 'AMBIGUOUS_OBJECT' && err.choices[0].designation === '20000004:NID');
  const incomplete = create(async () => new Response('truncated result'));
  await assert.rejects(incomplete(params()), { code: 'INCOMPLETE_ARCHIVE' });
  const outage = create(async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(outage(params()), { code: 'UPSTREAM_ERROR' });
  const missing = create(async url => url.hostname.startsWith('irsa')
    ? new Response(table([['observation-1', 'id', 'D1', start, end, 120, uri]]))
    : Response.json({ result: horizons(['2460898.5'], 'Earth (399)') }));
  const result = await missing(params());
  assert.equal(result.exposures.length, 1);
  assert.match(result.trajectoryError, /spacecraft-relative/);
});

const iso = mjd => new Date((mjd - 40587) * 86400000).toISOString();
const identity = { object: '3I', name: 'ATLAS', observer: '-163182', solution: 'JPL#55' };
function exposure(i, epoch) {
  const end = epoch + 120 / 86400;
  return { productId: 'id' + i, observationId: 'obs' + i, detector: 1, accessUrl: 'image' + i,
    observedStartUtc: iso(epoch), observedEndUtc: iso(end), exposureSeconds: 120, startMjd: epoch, endMjd: end,
    positions: [{ mjd: epoch, ra: 359.999, dec: 1 }, { mjd: (epoch + end) / 2, ra: 0, dec: 1 }, { mjd: end, ra: .001, dec: 1 }] };
}

test('tracked worker core verifies FITS timing and coverage, then refuses enhancement without two references', async () => {
  let epochRequests = 0;
  const view = createMovingView({
    load: async (url, pointing) => {
      const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: url === 'image2' ? 25 : pointing.raDeg,
        CRVAL2: pointing.decDeg, CRPIX1: 25, CRPIX2: 25, CD1_1: -.00170833333, CD2_2: .00170833333, CD1_2: 0, CD2_1: 0,
        ...(url === 'image1' ? { 'DATE-BEG': iso(start + 1 + 1 / 86400), 'DATE-END': iso(start + 1 + 121 / 86400) } : {}) };
      const values = new Float32Array(49 ** 2).fill(2), variance = values.slice(), flags = new Uint32Array(values.length);
      flags[24 * 49 + 24] = 1 << 9;
      return { header, width: 49, height: 49, values, variance, flags, sourceX: 0, sourceY: 0, matrix: matrixFor(header) };
    },
    wavelengthAt: async () => .8,
    fetchImpl: async url => {
      const parsed = new URL(url, 'https://local.test');
      if (!parsed.searchParams.has('action')) return Response.json({ observations: [] });
      epochRequests++;
      return Response.json({ ...identity, points: parsed.searchParams.getAll('mjd').map(mjd => ({ mjd: Number(mjd), ra: 0, dec: 1 })) });
    },
    psf: async () => [[0, 0, 1]],
  });
  const input = [exposure(0, start), exposure(1, start + 1), exposure(2, start + 2)];
  const previews = [];
  const scan = await view.scan(identity, input, progress => previews.push(progress));
  assert.equal(epochRequests, 1);
  assert.equal(scan.days.length, 2);
  assert.equal(previews[0].preview.date, iso(start).slice(0, 10));
  assert.equal(scan.failures[0].productId, 'id2');
  assert.equal(scan.frames[0].centerValid, false);
  assert.ok(scan.frames[0].smearArcsec > 0);
  await assert.rejects(view.stack({ min: 1, max: 2 }), /No usable exposures/);
  const result = await view.stack({ min: .79, max: .81, enhanced: true }, () => {});
  assert.equal(result.frames.length, 2);
  assert.match(result.enhanced.unavailable, /two usable/);
});

test('enhancement uses two wavelength-matched independent references and blanks pixels without support', async () => {
  const science = exposure(0, start);
  const references = [1, 2, 3].map(i => exposure(i, start - i));
  const view = createMovingView({
    load: async (url, pointing) => {
      const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: pointing.raDeg, CRVAL2: pointing.decDeg,
        CRPIX1: 25, CRPIX2: 25, CD1_1: -.00170833333, CD2_2: .00170833333, CD1_2: 0, CD2_1: 0 };
      const values = new Float32Array(49 ** 2).fill(2), variance = values.slice();
      const flags = new Uint32Array(values.length);
      if (url === science.accessUrl) values[24 * 49 + 24] += 3;
      if (url === references[0].accessUrl) flags[0] = 1 << 9;
      return { header, width: 49, height: 49, values, variance, flags, sourceX: 0, sourceY: 0, matrix: matrixFor(header) };
    },
    wavelengthAt: async url => url === references[2].accessUrl ? 1 : .8,
    fetchImpl: async url => {
      const parsed = new URL(url, 'https://local.test');
      if (!parsed.searchParams.has('action')) return Response.json({ observations: references });
      return Response.json({ ...identity, points: parsed.searchParams.getAll('mjd').map(mjd => ({ mjd: Number(mjd), ra: 1, dec: 1 })) });
    },
    psf: async () => [[0, 0, 1]],
  });
  await view.scan(identity, [science]);
  const { enhanced, tracked } = await view.stack({ min: .79, max: .81, enhanced: true }, () => {});
  assert.equal(enhanced.referenceReport[0].sources.length, 2);
  assert.ok(enhanced.referenceReport[0].sources.every(ref => ref.strategy === 'independent'));
  assert.ok(Number.isFinite(enhanced.values[24 * 49 + 24]));
  assert.ok(enhanced.referenceCoverage < 1);
  assert.ok(enhanced.injectionRecovery[0].core.fraction > .8);
  assert.ok(Number.isFinite(tracked.values[24 * 49 + 24]));
});
