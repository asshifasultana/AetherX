// SIMBAD: named objects with their type (otype, e.g. BD* brown dwarf, PM*
// high-proper-motion star) and J2000 positions with proper motions. The CDS
// TAP service first, the CfA mirror as a fallback, both queried in ADQL.

import { createConeCatalogHandler, GaiaError, parseCsvRows } from '../lib/gaia-catalog.js';

const ENDPOINTS = ['https://simbad.cds.unistra.fr/simbad/sim-tap/sync', 'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync'];
const COLUMNS = ['main_id', 'ra', 'dec', 'pmra', 'pmdec', 'otype'];
const FAST_MAS_YR = 100;

export function parseSimbad(text, limit = 1000) {
  const [header = [], ...body] = parseCsvRows(text);
  const names = header.map(name => name.toLowerCase());
  if (!COLUMNS.every(name => names.includes(name))) throw new GaiaError('SIMBAD returned an unexpected table.');
  const index = COLUMNS.map(name => names.indexOf(name));
  const number = value => value === '' || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const sources = body.slice(0, limit).map(row => {
    if (row.length !== names.length) throw new GaiaError('SIMBAD returned an incomplete row.');
    const [mainId, ra, dec, pmra, pmdec, otype] = index.map(i => row[i]);
    if (ra === '' || dec === '') return null; // a few entries have no position
    const raDeg = Number(ra), decDeg = Number(dec);
    if (!mainId || !Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360 || !Number.isFinite(decDeg) || Math.abs(decDeg) > 90) throw new GaiaError('SIMBAD returned invalid astrometry.');
    const id = mainId.replace(/\s+/g, ' ').trim();
    return { sourceId: id, mainId: id, raDeg, decDeg, refEpoch: 2000, pmra: number(pmra), pmdec: number(pmdec), otype: otype || null };
  });
  // Exoplanets share their host star's position; keep the star.
  return { sources: sources.filter(source => source && source.otype !== 'Pl'), truncated: body.length > limit };
}

const cone = (ra, dec, radius) => `CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra},${dec},${radius}))=1`;

export function createSimbadHandler({ fetchImpl = fetch, timeoutMs = 8000, fallbackTimeoutMs = 10000, now } = {}) {
  const attempts = query => ENDPOINTS.map((endpoint, i) => ({ endpoint, query, timeoutMs: i ? fallbackTimeoutMs : timeoutMs }));
  return createConeCatalogHandler({
    catalog: 'SIMBAD', fetchImpl, now,
    nearAttempts: ({ ra, dec, radius, limit }) => attempts(`SELECT TOP ${limit + 1} ${COLUMNS.join(',')} FROM basic WHERE ${cone(ra, dec, radius)}`),
    fastAttempts: ({ ra, dec, radius, limit }) => attempts(`SELECT TOP ${limit + 1} ${COLUMNS.join(',')} FROM basic WHERE ${cone(ra, dec, radius)} AND pmra*pmra+pmdec*pmdec>=${FAST_MAS_YR ** 2}`),
    parse: text => parseSimbad(text)
  });
}

export default createSimbadHandler();
