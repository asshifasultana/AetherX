import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sphericalBounds } from '../frontend/sky-context-core.js';
export const REVISION = '3c4a720f313ada6124b86fef24131fa65900133f';
export const CULTURES = { 'arabic_al-sufi':'arabic-al-sufi', hawaiian_starlines:'hawaiian', kamilaroi:'kamilaroi', indian:'vedic' };
export function objectIdentifier(value) {
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return { catalog:'coordinate',id:value.join(','),raDeg:((value[0]*15)%360+360)%360,decDeg:value[1] };
  if (Number.isSafeInteger(value) && value>0) return { catalog:'HIP',id:String(value) };
  if (typeof value !== 'string') return null;
  if (/^HIP\s*\d+$/.test(value)) return {catalog:'HIP',id:value.replace(/^HIP\s*/,'')};
  if (/^(?:Gaia\s*)?\d{10,}$/.test(value)) return {catalog:'Gaia DR3',id:value.replace(/^Gaia\s*/,'')};
  if (/^(DSO:|M\s*\d|NGC\s*\d|Mel\s*\d)/.test(value)) return {catalog:'DSO',id:value.replace(/^DSO:/,'').replaceAll(' ','')};
  return {catalog:'other',id:value};
}
export function descriptionSections(markdown) {
  const sections={}; let heading='Introduction';
  for(const line of markdown.split(/\r?\n/)) {
    const match=/^#{2,6}\s+(.+)$/.exec(line);
    if(match) { heading=match[1].replace(/<\/?notr>/g,''); sections[heading] ||= ''; }
    else sections[heading]=(sections[heading]||'')+line+'\n';
  }
  return sections;
}
export function normalizeCulture(data, markdown, anchors, source) {
  const unresolved=[],records=[],sections=descriptionSections(markdown);
  const resolve = (value, owner) => {
    const identifier=objectIdentifier(value); if(!identifier) { unresolved.push({owner,value,reason:'Unsupported anchor'}); return null; }
    const key=identifier.catalog==='HIP' ? `HIP ${identifier.id}` : identifier.catalog==='Gaia DR3' ? `Gaia ${identifier.id}` : identifier.id;
    const position=identifier.catalog==='coordinate' ? {raDeg:identifier.raDeg,decDeg:identifier.decDeg,frame:'icrs',epoch:2000} : anchors[key];
    if(!position || ![position.raDeg,position.decDeg].every(Number.isFinite) || Math.abs(position.decDeg)>90) {unresolved.push({owner,identifier,reason:'No cached coordinate'});return null;}
    return {...position,identifier};
  };
  const add = (f, kind, names, anchorValues=[]) => {
    const geometry={points:[],polylines:[],regions:[]},identifiers=[];
    for(const value of anchorValues) { const p=resolve(value,f.id); if(p) { geometry.points.push(p);identifiers.push(p.identifier); } }
    for(const line of f.lines||[]) {
      let segment=[];
      const flush=()=>{if(segment.length)geometry.polylines.push(segment);segment=[];};
      for(const value of line) {const p=resolve(value,f.id); if(!p)flush();else {segment.push(p);identifiers.push(p.identifier);}}
      flush();
    }
    // Only explicit normalized ICRS degree rings are accepted as regions;
    // Stellarium edges/lunar systems are preserved below, never invented from lines.
    for(const ring of f.regions||[]) if(ring.every(p=>Number.isFinite(p.raDeg)&&Number.isFinite(p.decDeg)))geometry.regions.push(ring);
    const points=[...geometry.points,...geometry.polylines.flat(),...geometry.regions.flat()];
    const english=names[0]?.english;
    records.push({id:f.id,tradition:source.tradition,kind,names,identifiers,geometry,
      labelPosition:sphericalBounds(points)?.center||null,bounds:sphericalBounds(points),
      descriptions:{inline:f.description||null,section:english&&sections[english]||null},references:f.references||[],
      sourceMetadata:f,sourceId:source.id,publication:{status:'unpublished',reason:source.adaptationAllowed?'Awaiting editorial selection':'Source does not grant adaptation permission'}});
  };
  for(const [kind,list] of [['constellation',data.constellations||[]],['asterism',data.asterisms||[]]])for(const f of list)add(f,kind,[f.common_name||{}]);
  for(const [key,names] of Object.entries(data.common_names||{}))add({id:`${data.id}:${key}`,references:names.flatMap(n=>n.references||[])},'named-object',names,[key]);
  return {records,unresolved,sections,sourceMetadata:{region:data.region,classification:data.classification,lunarSystem:data.lunar_system||null,zodiac:data.zodiac||null,edges:data.edges||null,edgesEpoch:data.edges_epoch||null}};
}
export async function ingest() {
  const root=new URL('../data/sky-cultures/',import.meta.url),output=new URL('../frontend/',import.meta.url);
  const cache=JSON.parse(await readFile(new URL('anchors.json',root))), extra=JSON.parse(await readFile(new URL('extra-anchors.json',root)));
  const anchors={...cache.anchors,...extra.anchors},all=[],sources=[],unresolved=[],metadata={};
  for(const [culture,tradition] of Object.entries(CULTURES)) {
    const json=await readFile(new URL(`stellarium/${culture}/index.json`,root),'utf8');
    const text=await readFile(new URL(`stellarium/${culture}/description.md`,root),'utf8');
    const sections=descriptionSections(text),license=sections.License?.trim()||'Unknown';
    const source={id:culture,tradition,revision:REVISION,retrievedAt:'2026-11-07',url:`https://github.com/Stellarium/stellarium/tree/${REVISION}/skycultures/${culture}`,
      author:sections.Authors?.trim()||'See original source',community:tradition==='kamilaroi'?'Kamilaroi and Euahlayi':tradition,
      license,adaptationAllowed:license==='CC BY-SA 4.0',attribution:sections.Authors?.trim()||'Stellarium contributors',
      modifications:'Normalized identifiers and geometry; selected narrative cards are separately edited.',
      sha256:{index:createHash('sha256').update(json).digest('hex'),description:createHash('sha256').update(text).digest('hex')}};
    const normalized=normalizeCulture(JSON.parse(json),text,anchors,source);
    all.push(...normalized.records);unresolved.push(...normalized.unresolved);metadata[culture]=normalized.sourceMetadata;sources.push(source);
    if(source.adaptationAllowed) {
      await mkdir(new URL(`cultural-sources/${culture}/`,output),{recursive:true});
      for(const name of ['index.json','description.md'])await copyFile(new URL(`stellarium/${culture}/${name}`,root),new URL(`cultural-sources/${culture}/${name}`,output));
    }
  }
  const curated=JSON.parse(await readFile(new URL('curated.json',root)));
  for(const card of curated.cards) {
    const parent=card.recordId ? all.find(r=>r.id===card.recordId) : null;
    if(card.recordId&&!parent)throw new Error(`Unknown curated record ${card.recordId}`);
    const source=parent&&sources.find(s=>s.id===parent.sourceId);
    const publication={...card.publication};
    if(source&&!source.adaptationAllowed)Object.assign(publication,{status:'unpublished',reason:'Source does not grant adaptation permission'});
    const geometry=parent?.geometry||{points:(card.anchorIds||[]).map(id=>{if(!anchors[id])throw new Error(`Missing ${id}`);return anchors[id];}),polylines:[],regions:[]};
    const points=[...geometry.points,...geometry.polylines.flat(),...geometry.regions.flat()];
    const record={...parent,...card,publication,geometry,bounds:sphericalBounds(points),navigationAnchor:points[0]||null,
      sources:card.sources||[source],credits:card.credits||source?.attribution,license:card.license||source?.license};
    if(publication.status==='published'&&(!record.sources?.length||!record.credits||!record.license||!publication.review||!record.summary))throw new Error(`Missing publication evidence for ${card.id}`);
    all.push(record);
  }
  const published=all.filter(r=>r.publication.status==='published');
  const groups={'arabic-al-sufi':['arabic-al-sufi'],hawaiian:['hawaiian'],kamilaroi:['kamilaroi'],'vedic-bengali':['vedic','bengali'],lakota:['lakota']};
  const coverage=Object.entries(groups).map(([group,traditions])=>({group,published:published.filter(r=>traditions.includes(r.tradition)).length,target:3,
    reason:group==='arabic-al-sufi'?'Adaptation permission pending (CC BY-ND 4.0)':group==='kamilaroi'?'Adaptation permission pending (CC BY-NC-ND 4.0)':null}));
  const manifest={schemaVersion:1,revision:REVISION,sources,coordinateSources:[cache.source,extra.source],coverage,
    complete:coverage.every(c=>c.published>=c.target)&&published.some(r=>r.tradition==='vedic')&&published.some(r=>r.tradition==='bengali')};
  await writeFile(new URL('normalized.json',root),JSON.stringify({schemaVersion:1,records:all,metadata},null,2)+'\n');
  await writeFile(new URL('ingestion-report.json',root),JSON.stringify({unresolved,coverage,unpublished:all.filter(r=>r.publication.status!=='published').map(r=>({id:r.id,reason:r.publication.reason}))},null,2)+'\n');
  await writeFile(new URL('cultural-sky.json',output),JSON.stringify({schemaVersion:1,records:published,manifest},null,2)+'\n');
  await writeFile(new URL('cultural-sources.json',output),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify({published:published.length,unresolved:unresolved.length,coverage,contentComplete:manifest.complete},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await ingest();
