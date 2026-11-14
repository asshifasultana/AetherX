import { nuisanceTemplates, fitNativeSequence } from '../frontend/lib/comet-native-fit.js';
import { projectSkyToPixel } from '../frontend/lib/fits-engine.js';
import { MASKED_FLAG_BITS } from '../frontend/lib/pixel-quality.js';

const bad = MASKED_FLAG_BITS.reduce((mask, bit) => mask | (1 << bit), 0);
const radians = Math.PI / 180;
const finite = value => value === '' || value === undefined ? NaN : Number(value);
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2;
};

async function csv(url, parameters, allowEmpty = false) {
  const response = await fetch(url + '?' + new URLSearchParams(parameters), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status} ${url}`);
  const body = (await response.text()).trim();
  if (allowEmpty && !body) return [];
  const [header, ...rows] = body.split(/\r?\n/);
  if (!header?.includes(',')) throw new Error(`Unexpected catalog response: ${url}`);
  const names = header.split(',');
  return rows.map(row => Object.fromEntries(row.split(',').map((value, i) => [names[i], value])));
}

async function panStarrsCatalog(ra, dec, radius) {
  const url = 'https://catalogs.mast.stsci.edu/api/v0.1/panstarrs/dr2/mean.csv';
  const rows = new Map();
  const pagesize = 500;
  for (let page = 1; page <= 10; page++) {
    const batch = await csv(url, {
      ra, dec, radius, pagesize, page,
      columns: '[objID,raMean,decMean,iMeanPSFMag,nDetections]',
      'nDetections.gte': 3, 'iMeanPSFMag.gt': 0, 'iMeanPSFMag.lt': 18
    }, true);
    const previous = rows.size;
    for (const row of batch) rows.set(row.objID, row);
    if (batch.length < pagesize) return [...rows.values()];
    if (rows.size === previous) throw new Error('Pan-STARRS repeated a catalog page.');
  }
  throw new Error('Pan-STARRS catalog response reached its page limit.');
}

export async function fetchFieldCatalogs(target) {
  const { raDeg, decDeg } = target;
  const radius = 0.14;
  const [gaia, pan] = await Promise.all([
    csv('https://gea.esac.esa.int/tap-server/tap/sync', {
      REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv',
      QUERY: `SELECT TOP 2000 source_id,ra,dec,pmra,pmdec,phot_rp_mean_mag FROM gaiadr3.gaia_source
        WHERE 1=CONTAINS(POINT(ra,dec),CIRCLE(${raDeg},${decDeg},${radius}))
        AND phot_rp_mean_mag < 18 ORDER BY phot_rp_mean_mag`
    }),
    panStarrsCatalog(raDeg, decDeg, radius)
  ]);
  if (gaia.length === 2000) throw new Error('Gaia catalog response reached its row limit.');
  return {
    gaia: gaia.map(row => ({ raDeg: finite(row.ra), decDeg: finite(row.dec),
      pmra: finite(row.pmra), pmdec: finite(row.pmdec), mag: finite(row.phot_rp_mean_mag), catalog: 'Gaia' })),
    pan: pan.map(row => ({ raDeg: finite(row.raMean), decDeg: finite(row.decMean),
      mag: finite(row.iMeanPSFMag), catalog: 'Pan-STARRS' }))
  };
}

function separation(a, b) {
  return Math.hypot((a.raDeg - b.raDeg) * Math.cos(a.decDeg * radians), a.decDeg - b.decDeg) * 3600;
}

export function starsAt(catalogs, mjd) {
  const years = (mjd - 57388.5) / 365.25;
  const gaia = catalogs.gaia.map(star => ({
    ...star,
    raDeg: star.raDeg + (star.pmra || 0) * years / (3600000 * Math.cos(star.decDeg * radians)),
    decDeg: star.decDeg + (star.pmdec || 0) * years / 3600000
  }));
  const pan = catalogs.pan.filter(star => catalogs.gaia.every(other => separation(star, other) > 1.5) &&
    gaia.every(other => separation(star, other) > 1.5));
  return { gaia, merged: [...gaia, ...pan].sort((a, b) => a.mag - b.mag) };
}

function usable(image, i) {
  return Number.isFinite(image.values[i]) && Number.isFinite(image.variance[i]) && image.variance[i] > 0 &&
    !(image.flags?.[i] & bad) && !image.derivedTransientPixels?.has(i);
}

function localScore(image, psf, x, y, dx = 0, dy = 0) {
  let weight = 0, wp = 0, wy = 0, pp = 0, py = 0;
  for (let v = Math.round(y) - 3; v <= Math.round(y) + 3; v++) {
    for (let u = Math.round(x) - 3; u <= Math.round(x) + 3; u++) {
      const i = v * image.width + u;
      if (!usable(image, i)) continue;
      const w = 1 / image.variance[i], p = psf(u - x - dx, v - y - dy), value = image.values[i];
      weight += w;
      wp += w * p;
      wy += w * value;
      pp += w * p * p;
      py += w * p * value;
    }
  }
  const norm = pp - wp * wp / weight;
  return norm > 0 ? (py - wp * wy / weight) / Math.sqrt(norm) : -Infinity;
}

function inBounds(image, x, y) {
  return x >= 4 && x < image.width - 4 && y >= 4 && y < image.height - 4;
}

export function refineAlignment(image, target, stars, epsf) {
  const center = projectSkyToPixel(image, target.raDeg, target.decDeg);
  const shifts = [];
  for (const star of stars.filter(star => star.catalog === 'Gaia' && star.mag < 15 &&
    Number.isFinite(star.pmra) && Number.isFinite(star.pmdec))) {
    if (stars.some(other => other !== star && other.mag < star.mag + 2 && separation(other, star) < 18)) continue;
    const [x, y] = projectSkyToPixel(image, star.raDeg, star.decDeg) ?? [];
    if (!inBounds(image, x, y) || Math.hypot(x - center[0], y - center[1]) < 10) continue;
    const psf = epsf(x + image.sourceX, y + image.sourceY);
    let best = { score: -Infinity };
    for (let iy = -4; iy <= 4; iy++) for (let ix = -4; ix <= 4; ix++) {
      const dx = ix / 8, dy = iy / 8;
      const score = localScore(image, psf, x, y, dx, dy);
      if (score > best.score) best = { dx, dy, score };
    }
    if (best.score >= 15 && Math.abs(best.dx) < 0.5 && Math.abs(best.dy) < 0.5) shifts.push(best);
  }
  const dx = median(shifts.map(shift => shift.dx)), dy = median(shifts.map(shift => shift.dy));
  const scatter = median(shifts.map(shift => Math.hypot(shift.dx - dx, shift.dy - dy)));
  const applied = shifts.length >= 3 && scatter <= 0.18 && Math.hypot(dx, dy) >= 0.05;
  return {
    image: applied ? { ...image, header: { ...image.header,
      CRPIX1: Number(image.header.CRPIX1) + dx, CRPIX2: Number(image.header.CRPIX2) + dy } } : image,
    dx, dy, scatter, anchors: shifts.length, applied
  };
}

export function subtractCatalogStars(image, target, stars, epsf, field = target) {
  const center = target && projectSkyToPixel(image, target.raDeg, target.decDeg);
  const fieldCenter = field && projectSkyToPixel(image, field.raDeg, field.decDeg);
  const candidates = [];
  for (const star of stars) {
    const [x, y] = projectSkyToPixel(image, star.raDeg, star.decDeg) ?? [];
    // Preserve the same central sky sources in the science and reference images.
    if (!inBounds(image, x, y) || (fieldCenter && Math.hypot(x - fieldCenter[0], y - fieldCenter[1]) < 10) ||
      (center && Math.hypot(x - center[0], y - center[1]) < 10)) continue;
    const score = localScore(image, epsf(x + image.sourceX, y + image.sourceY), x, y);
    if (score >= 6) candidates.push({ star, x, y, score });
  }
  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (selected.length === 20) break;
    if (selected.every(star => Math.hypot(star.x - candidate.x, star.y - candidate.y) > 1.25)) selected.push(candidate);
  }
  if (!selected.length) return { image, gaia: 0, pan: 0 };
  const [constant, east, north, ...signal] = nuisanceTemplates(image, field ?? target ?? selected[0].star,
    epsf, selected.map(item => item.star));
  const fitImage = center ? { ...image, values: image.values.map((value, i) =>
    Math.hypot(i % image.width - center[0], Math.floor(i / image.width) - center[1]) < 8 ? NaN : value) } : image;
  const { coefficients } = fitNativeSequence([{ image: fitImage, signal, nuisance: [constant, east, north] }]);
  const values = image.values.map((value, i) => signal.reduce((remaining, psf, j) =>
    remaining - Math.max(0, coefficients[j]) * psf[i], value));
  return { image: { ...image, values }, gaia: selected.filter(item => item.star.catalog === 'Gaia').length,
    pan: selected.filter(item => item.star.catalog === 'Pan-STARRS').length };
}
