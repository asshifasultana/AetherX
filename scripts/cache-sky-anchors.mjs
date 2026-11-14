// Explicit maintenance command; never runs during the app/deployment build.
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../data/sky-cultures/', import.meta.url);
const ids = new Set();
for (const culture of ['arabic_al-sufi', 'hawaiian_starlines', 'kamilaroi', 'indian']) {
  const data = JSON.parse(await readFile(new URL(`stellarium/${culture}/index.json`, root)));
  for (const f of [...data.constellations || [], ...data.asterisms || []]) {
    for (const line of f.lines || []) for (const id of line) if (Number.isInteger(id) && id > 0) ids.add(id);
    for (const id of f.hull_extension || []) if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  for (const key of Object.keys(data.common_names || {})) if (/^HIP\s+\d+$/.test(key)) ids.add(Number(key.slice(3)));
}
const anchors = {};
const tsvIndex = process.argv.indexOf('--hip-tsv');
if (tsvIndex >= 0) {
  const text = await readFile(process.argv[tsvIndex+1],'utf8');
  for (const line of text.split(/\r?\n/)) {
    const [hip,ra,dec] = line.split('\t').map(v=>v.trim());
    if (!/^\d+$/.test(hip || '') || !ra || !dec || !ids.has(Number(hip))) continue;
    const raDeg=Number(ra),decDeg=Number(dec);
    if (Number.isFinite(raDeg)&&Number.isFinite(decDeg)) anchors[`HIP ${Number(hip)}`]={raDeg,decDeg,frame:'icrs',epoch:1991.25};
  }
} else {
const hipIds = [...ids].sort((a,b)=>a-b);
for (let offset = 0; offset < hipIds.length; offset += 250) {
  const query = `SELECT HIP, RAICRS, DEICRS FROM "I/239/hip_main" WHERE HIP IN (${hipIds.slice(offset,offset+250).join(',')})`;
  const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'json', QUERY: query });
  const response = await fetch('https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync', { method: 'POST', body, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`VizieR ${response.status}`);
  const result = await response.json();
  for (const [hip, raDeg, decDeg] of result.data) if (Number.isFinite(raDeg) && Number.isFinite(decDeg)) anchors[`HIP ${hip}`] = { raDeg, decDeg, frame: 'icrs', epoch: 1991.25 };
}
}
const cache = { schemaVersion: 1, retrievedAt: new Date().toISOString(), source: 'https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=I/239/hip_main',
  retrievalMethod:tsvIndex>=0?'Offline import of VizieR ASU TSV (Harvard mirror)':'VizieR TAP',
  rightsUrl:'https://cds.unistra.fr/vizier-org/licences_vizier.html',attribution: 'ESA, The Hipparcos and Tycho Catalogues (1997), CDS/VizieR I/239', anchors };
await writeFile(new URL('anchors.json', root), JSON.stringify(cache,null,2)+'\n');
console.log(`Cached ${Object.keys(anchors).length}/${ids.size} Hipparcos anchors. Gaia and DSO additions may be supplied in extra-anchors.json.`);
