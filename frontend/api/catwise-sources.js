// CatWISE2020 (Marocco et al. 2021): WISE + NEOWISE positions and motions down
// to W1 ~ 17, which catches cold brown dwarfs Gaia cannot see. IRSA's TAP
// service first, the VizieR mirror (II/365/catwise) as a fallback. Proper
// motions are stored in arcsec/yr and returned in mas/yr; positions are at the
// source's mean observation epoch (about 2015.4).

import { createConeCatalogHandler, GaiaError, parseCsvRows, parseVizierTable, VIZIER_MIRROR } from '../lib/gaia-catalog.js';

const IRSA = 'https://irsa.ipac.caltech.edu/TAP/sync';
const TABLE = 'catwise_2020';
const COLUMNS = ['source_name', 'ra', 'dec', 'pmra', 'pmdec', 'sigpmra', 'sigpmdec', 'meanobsmjd', 'w1mpro', 'w2mpro'];
const MIRROR_TABLE = 'II/365/catwise';
const MIRROR_COLUMNS = ['Name', 'RA_ICRS', 'DE_ICRS', 'pmRA', 'pmDE', 'e_pmRA', 'e_pmDE', 'MJD', 'W1mproPM', 'W2mproPM'];
// WISE motions over ~10 years are noisy: a fast mover must be at least 100
// mas/yr and five times its own uncertainty.
const FAST_ARCSEC_YR = 0.1;
const FAST_SIGNIFICANCE = 5;

export const yearOfMjd = mjd => 2000 + (mjd - 51544.5) / 365.25;

function toSources(rows, limit) {
  const sources = [];
  for (const [name, ra, dec, pmra, pmdec, sigpmra, sigpmdec, mjd, w1, w2] of rows.slice(0, limit)) {
    const raDeg = Number(ra), decDeg = Number(dec), epoch = Number(mjd);
    if (!name || !Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360 || !Number.isFinite(decDeg) || Math.abs(decDeg) > 90) throw new GaiaError('CatWISE returned invalid astrometry.');
    const number = value => value === '' || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const pm = [number(pmra), number(pmdec)], sig = [number(sigpmra), number(sigpmdec)];
    sources.push({
      sourceId: name.trim(), sourceName: name.trim(), raDeg, decDeg,
      refEpoch: Number.isFinite(epoch) && epoch > 50000 ? Number(yearOfMjd(epoch).toFixed(3)) : 2015.4,
      pmra: pm[0] === null ? null : Number((pm[0] * 1000).toFixed(1)), pmdec: pm[1] === null ? null : Number((pm[1] * 1000).toFixed(1)),
      pmErrorMasYr: sig.every(value => value !== null) ? Number((Math.hypot(...sig) * 1000).toFixed(1)) : null,
      w1: number(w1), w2: number(w2)
    });
  }
  return sources;
}

// A fast motion within the noise is dropped (the star is kept, without a
// motion), so it cannot fake a star that moved through a spot.
const reliable = source => {
  const pm = Math.hypot(source.pmra || 0, source.pmdec || 0);
  if (pm < FAST_ARCSEC_YR * 1000 || !(source.pmErrorMasYr > 0) || pm >= FAST_SIGNIFICANCE * source.pmErrorMasYr) return source;
  return { ...source, pmra: null, pmdec: null, motionUnreliable: true };
};

export function parseCatwise(text, endpoint, limit = 1000) {
  let rows;
  if (endpoint === VIZIER_MIRROR) rows = parseVizierTable(text, MIRROR_TABLE, MIRROR_COLUMNS);
  else {
    const [header = [], ...body] = parseCsvRows(text);
    const names = header.map(name => name.toLowerCase());
    if (!COLUMNS.every(name => names.includes(name))) throw new GaiaError('IRSA returned an unexpected CatWISE catalog.');
    const index = COLUMNS.map(name => names.indexOf(name));
    rows = body.map(row => { if (row.length !== names.length) throw new GaiaError('IRSA returned an incomplete CatWISE row.'); return index.map(i => row[i]); });
  }
  return { sources: toSources(rows, limit).map(reliable), truncated: rows.length > limit };
}

const circle = (ra, dec, radius) => `1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${radius}))`;
// This mirror only answers CatWISE with every column (-out.all, bare) and a
// %20-encoded centre, and rejects column filters, so it serves the near cone only.
const mirror = (ra, dec, radius, limit) => `${VIZIER_MIRROR}?-source=${MIRROR_TABLE}&-c=${ra}%20${dec >= 0 ? '%2B' : ''}${dec}&-c.rd=${radius}&-out.max=${limit + 1}&-sort=_r&-out.all`;

export function createCatwiseHandler({ fetchImpl = fetch, timeoutMs = 6000, fallbackTimeoutMs = 8000, now } = {}) {
  return createConeCatalogHandler({
    catalog: 'CatWISE2020', fetchImpl, now,
    nearAttempts: ({ ra, dec, radius, limit }) => [
      { endpoint: IRSA, timeoutMs, query: `SELECT TOP ${limit + 1} ${COLUMNS.join(',')} FROM ${TABLE} WHERE ${circle(ra, dec, radius)}` },
      { endpoint: mirror(ra, dec, radius, limit), timeoutMs: fallbackTimeoutMs }
    ],
    fastAttempts: ({ ra, dec, radius, limit }) => [
      { endpoint: IRSA, timeoutMs, query: `SELECT TOP ${limit + 1} ${COLUMNS.join(',')} FROM ${TABLE} WHERE ${circle(ra, dec, radius)} AND pmra*pmra+pmdec*pmdec>=${FAST_ARCSEC_YR ** 2} AND pmra*pmra+pmdec*pmdec>=${FAST_SIGNIFICANCE ** 2}*(sigpmra*sigpmra+sigpmdec*sigpmdec)` },
    ],
    parse: (text, endpoint) => parseCatwise(text, endpoint)
  });
}

export default createCatwiseHandler();
