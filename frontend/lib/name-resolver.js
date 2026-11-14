import { parseCoordinate } from '../coordinates.js';
export const SESAME_URL = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV';
export const SIMBAD_MIRROR_URL = 'https://simbad.cfa.harvard.edu/simbad/sim-id';
export class ResolveError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
export function validateName(params) {
  const names = params.getAll('name');
  const raw = names[0] || '';
  if (names.length !== 1 || !raw.trim() || raw.length > 200 || /[\p{Cc}\p{Cf}&;]/u.test(raw)) {
    throw new ResolveError('Enter one object name, up to 200 characters.', 400, 'INVALID_NAME');
  }
  return raw.trim();
}
export function parseSesame(text) {
  if (text.length > 1000000 || !/^#\s/m.test(text) || /<\s*(?:!doctype|html)/i.test(text)) throw new ResolveError('The resolver returned an invalid response. Please retry.', 502, 'UPSTREAM_ERROR');
  const sections = text.split(/^#=/m).slice(1);
  const section = sections.find(part => /^%J\s/m.test(part));
  if (!section) {
    const reportsSuccess = /^#=[SNV]=[^\n]*:\s*[1-9]\d*\s*$/m.test(text);
    if (!reportsSuccess && (/^#=[SNV]=[^\n]*:\s*0\s*$/m.test(text) || /^#!.*(?:nothing found|not found|no match)/im.test(text))) throw new ResolveError('No object found. Check the spelling or try a catalog identifier.', 404, 'NOT_FOUND');
    throw new ResolveError('The resolver returned an invalid response. Please retry.', 502, 'UPSTREAM_ERROR');
  }
  const source = section.match(/^([SNV])=([^\n]+?):\s*\d+/);
  const match = section.match(/^%J\s+(\S+)\s+(\S+)(?:\s|$)/m);
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const raDeg = Number(match?.[1]), decDeg = Number(match?.[2]);
  if (!source || !match || !numeric.test(match[1]) || !numeric.test(match[2]) || !Number.isFinite(raDeg) || !Number.isFinite(decDeg) || raDeg < 0 || raDeg >= 360 || decDeg < -90 || decDeg > 90) throw new ResolveError('The resolver returned invalid coordinates. Please retry.', 502, 'UPSTREAM_ERROR');
  return { resolvedName: section.match(/^%I\.0\s+(.+)$/m)?.[1].trim() || null, raDeg, decDeg, frame: 'icrs', source: { name: 'CDS Sesame', resolver: { S: 'SIMBAD', N: 'NED', V: 'VizieR' }[source[1]], url: 'https://cds.unistra.fr/cgi-bin/Sesame' } };
}
export function parseSimbad(text) {
  const invalid = () => new ResolveError('The SIMBAD mirror returned an invalid response. Please retry.', 502, 'UPSTREAM_ERROR');
  if (text.length > 1000000 || /<\s*(?:!doctype|html)/i.test(text)) throw invalid();
  if (/^!!\s+[^\n]+:\s*(?:No known catalog could be found|Identifier not found in the database|No astronomical object found)/m.test(text)) throw new ResolveError('No object found. Check the spelling or try a catalog identifier.', 404, 'NOT_FOUND');
  const name = text.match(/^Object\s+(.+?)\s+---/m)?.[1];
  const coordinates = text.match(/^Coordinates\(ICRS[^\n]*?\):\s*(\d+\s+\d+\s+\d+(?:\.\d+)?)\s+([+-]\d+\s+\d+\s+\d+(?:\.\d+)?)(?:\s|$)/m);
  if (!/^C\.D\.S\.\s+-\s+SIMBAD/m.test(text) || !name || !coordinates) throw invalid();
  try {
    return { resolvedName: name.trim(), raDeg: parseCoordinate(coordinates[1], 'ra', 'sexagesimal'), decDeg: parseCoordinate(coordinates[2], 'dec', 'sexagesimal'), frame: 'icrs', source: { name: 'SIMBAD Harvard mirror', resolver: 'SIMBAD', url: 'https://simbad.cfa.harvard.edu/simbad/' } };
  } catch { throw invalid(); }
}
export function createNameResolver({ fetchImpl = fetch, now = Date.now, timeoutMs = 10000, primaryTimeoutMs = 2000, ttlMs = 86400000, maxEntries = 200 } = {}) {
  const cache = new Map();
  return async params => {
    const submittedName = validateName(params), key = submittedName.toLowerCase();
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttlMs) return { ...cached.data, submittedName };
    cache.delete(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const request = async (url, parse, signal) => {
        const response = await fetchImpl(url, { signal, redirect: 'error', headers: { Accept: 'text/plain' } });
        if (!response.ok) throw new ResolveError('Object lookup is temporarily unavailable. Retry or use presets or coordinates.', 502, 'UPSTREAM_ERROR');
        return parse(await response.text());
      };
      let result;
      const primaryController = new AbortController();
      const primaryTimer = setTimeout(() => primaryController.abort(), primaryTimeoutMs);
      try {
        result = await request(SESAME_URL + '?' + encodeURIComponent(submittedName), parseSesame, AbortSignal.any([controller.signal, primaryController.signal]));
      } catch (primaryError) {
        clearTimeout(primaryTimer);
        // An authoritative Sesame miss has already checked its catalog chain.
        if (primaryError instanceof ResolveError && primaryError.status === 404) throw primaryError;
        if (controller.signal.aborted) throw primaryError;
        try {
          result = await request(SIMBAD_MIRROR_URL + '?' + new URLSearchParams({ Ident: submittedName, 'output.format': 'ASCII' }), parseSimbad, controller.signal);
        } catch (mirrorError) {
          // SIMBAD alone cannot establish a miss across Sesame's NED/VizieR catalogs.
          if (mirrorError instanceof ResolveError && mirrorError.status === 404) throw new ResolveError('SIMBAD found no match, and the other catalog resolver is unavailable. Retry or try a catalog identifier.', 502, 'UPSTREAM_ERROR');
          throw mirrorError;
        }
      } finally { clearTimeout(primaryTimer); }
      const data = { ...result, retrievedAt: new Date(now()).toISOString() };
      cache.set(key, { at: now(), data });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return { ...data, submittedName };
    } catch (error) {
      if (controller.signal.aborted) throw new ResolveError('Object lookup timed out. Retry or use presets or coordinates.', 504, 'TIMEOUT');
      if (error instanceof ResolveError) throw error;
      throw new ResolveError('Object lookup is temporarily unavailable. Retry or use presets or coordinates.', 502, 'UPSTREAM_ERROR');
    } finally { clearTimeout(timer); }
  };
}
