import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeCulture, objectIdentifier, REVISION } from '../../scripts/ingest-sky-cultures.mjs';
import { classifyFeature, nearbyCards, sphericalBounds, segmentDistanceDeg } from '../sky-context-core.js';
import { decodeViewState, encodeViewState } from '../url-state.js';
const p=(raDeg,decDeg=0)=>({raDeg,decDeg,frame:'icrs',epoch:2000});
const f=(geometry)=>({id:'test',geometry,tradition:'hawaiian',publication:{status:'published'}});
test('ingestion preserves typed identifiers, associations and gaps without bridging missing stars',()=>{
  const long='5350358584482202880';
  assert.deepEqual(objectIdentifier(long),{catalog:'Gaia DR3',id:long});
  assert.equal(objectIdentifier('DSO:M7').catalog,'DSO');
  assert.equal(objectIdentifier(Number(long)),null);
  const data={id:'fixture',constellations:[{id:'figure',common_name:{english:'Figure'},references:[3],lines:[[1,2,999,3,4],[long,'DSO:M7'],[[-1,20],[-2,21]]]}],asterisms:[{id:'asterism',lines:[[1,2]]}],common_names:{'HIP 1':[{native:'Native',references:[4]}]}};
  const anchors={'HIP 1':p(0),'HIP 2':p(1),'HIP 3':p(2),'HIP 4':p(3),[`Gaia ${long}`]:p(5),'M7':p(6)};
  const result=normalizeCulture(data,'## Authors\nA\n## License\nCC BY-SA 4.0\n##### Figure\nFigure description.',anchors,{id:'fixture',tradition:'hawaiian',adaptationAllowed:true});
  assert.equal(result.records.length,3);assert.equal(result.unresolved.length,1);
  const figure=result.records[0];assert.equal(figure.geometry.polylines.length,4);
  assert.deepEqual(figure.geometry.polylines[0].map(p=>p.raDeg),[0,1]);
  assert.deepEqual(figure.geometry.polylines[1].map(p=>p.raDeg),[2,3]);
  assert.equal(figure.geometry.polylines[2][0].identifier.id,long);
  assert.equal(figure.geometry.polylines[3][0].raDeg,345);
  assert.match(figure.descriptions.section,/Figure description/);assert.deepEqual(figure.references,[3]);
  assert.equal(result.records[1].kind,'asterism');assert.deepEqual(result.records[2].references,[4]);
});
test('viewport geometry crosses RA zero and detects segments whose labels are outside',()=>{
  const record=f({points:[],polylines:[[p(359),p(2)]]});
  const field={raDeg:0,decDeg:0,fovArcmin:10};
  record.bounds=sphericalBounds(record.geometry.polylines.flat());
  assert.equal(classifyFeature(record,field).inField,true);
  assert.equal(nearbyCards([record],field).length,1);
  assert.ok(record.bounds.center.raDeg>.1);
  assert.ok(segmentDistanceDeg(p(0),p(359),p(1))<1e-9);
  assert.equal(classifyFeature(f({polylines:[[p(260),p(20)]]}),field).inField,true,'A segment with one endpoint behind the tangent plane still intersects the viewport');
});
test('polar geometry and empty/unpublished/far-away entries behave independently of archive coverage',()=>{
  const polar=f({points:[p(5,89.99)]});
  assert.equal(classifyFeature(polar,{raDeg:0,decDeg:89.99,fovArcmin:10}).inField,true);
  const field={raDeg:0,decDeg:0,fovArcmin:16};
  assert.equal(nearbyCards([f({points:[p(20)]})],field).length,0);
  assert.equal(nearbyCards([{...f({points:[p(0)]}),publication:{status:'unpublished'}}],field).length,0);
  const nearby=nearbyCards([f({points:[p(10)]})],field);assert.equal(nearby[0].inField,false);assert.equal(Math.round(nearby[0].distanceDeg),10);
});
test('explicit region interiors and boundaries are matched without inventing regions from lines',()=>{
  const region=f({regions:[[p(359,-1),p(1,-1),p(1,1),p(359,1)]]});
  assert.equal(classifyFeature(region,{raDeg:0,decDeg:0,fovArcmin:10}).inField,true);
  assert.equal(classifyFeature(region,{raDeg:180,decDeg:0,fovArcmin:10}).inField,false);
});
test('cultural and Gaia link state validates, round-trips, and reports malformed options',()=>{
  const decoded=decodeViewState(encodeViewState({culture:'bengali',gaia:true}));
  assert.equal(decoded.state.culture,'bengali');assert.equal(decoded.state.gaia,true);assert.equal(decoded.issues.length,0);
  for(const q of ['culture=chinese','culture=vedic&culture=lakota','gaia=yes','gaia=1&gaia=0'])assert.equal(decodeViewState(q).issues.length,1);
});
test('published catalog retains source evidence and explicitly reports restricted groups as incomplete',async()=>{
  const data=JSON.parse(await readFile(new URL('../cultural-sky.json',import.meta.url)));
  assert.equal(data.manifest.revision,REVISION);assert.equal(data.records.length,10);
  for(const r of data.records){assert.equal(r.publication.status,'published');assert.ok(r.publication.review);assert.ok(r.sources[0].url.startsWith('https:'));assert.ok(r.license);assert.ok(r.navigationAnchor);}
  for(const tradition of ['bengali','vedic','lakota','hawaiian'])assert.ok(data.records.some(r=>r.tradition===tradition));
  assert.equal(data.manifest.complete,false);
  assert.equal(data.records.some(r=>['kamilaroi','arabic-al-sufi','chinese'].includes(r.tradition)),false);
});
