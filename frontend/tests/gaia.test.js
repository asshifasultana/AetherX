import test from 'node:test';
import assert from 'node:assert/strict';
import { createGaiaCatalog, gaiaQuery, parseGaiaCSV } from '../lib/gaia-catalog.js';
import { createGaiaHandler } from '../api/gaia-sources.js';
import { propagateGaia, julianEpoch, createCatalogLoader, markerSuspension, fieldRadiusDeg, GAIA_MOTION_MARGIN_DEG } from '../gaia-core.js';
import { displayGrid } from '../display-grid.js';
const header='source_id,ra,dec,ref_epoch,pmra,pmdec,phot_g_mean_mag\n';
const row='5350358584482202880,269.45,4.69,2016,-801.551,10362.394,9.5\n';
const params=()=>new URLSearchParams({ra:'269.45',dec:'4.69',radius:'.2'});
test('Gaia query validates inputs, includes field corners and a documented epoch margin',()=>{
  assert.equal(gaiaQuery(params()).ra,269.45);
  for(const q of ['ra=1&dec=91&radius=.2','ra=360&dec=0&radius=.2','ra=1&dec=0&radius=0','ra=1&dec=0&radius=1','ra=1&ra=2&dec=0&radius=.2','ra=1&dec=0&radius=.2&url=https://evil.example','ra=1%3BDROP&dec=0&radius=.2'])assert.throws(()=>gaiaQuery(new URLSearchParams(q)),{status:400});
  assert.ok(fieldRadiusDeg(30)>.25);assert.ok(GAIA_MOTION_MARGIN_DEG>.1);
  assert.equal(parseGaiaCSV(header+row).data[0][0],'5350358584482202880');
});
test('Gaia tangent proper motion uses mu_alpha*cos(delta), wraps RA, and tolerates missing motion and poles',()=>{
  // Analytic eastward tangent displacement: atan(mu*dt)/cos(dec) to first order.
  const s={raDeg:359.999,decDeg:60,refEpoch:2016,pmra:1000,pmdec:0};
  const p=propagateGaia(s,2026);
  assert.ok(Math.abs(p.raDeg-0.0045555555)<1e-8);assert.equal(p.propagated,true);
  const missing=propagateGaia({...s,pmra:null},2026);assert.equal(missing.raDeg,s.raDeg);assert.equal(missing.propagated,false);assert.equal(missing.epoch,2016);
  assert.ok(Number.isFinite(propagateGaia({...s,decDeg:90},2026).raDeg));
  const barnard=propagateGaia({raDeg:269.45,decDeg:4.69,refEpoch:2016,pmra:-801.551,pmdec:10362.394},2026);
  assert.ok(Math.abs(barnard.decDeg-(4.69+103623.94/3600000))<1e-7);
  assert.equal(julianEpoch('2000-01-01T12:00:00Z'),2000);
});
test('Gaia caches successes and empties, deduplicates work, and rejects distinct concurrent searches',async()=>{
  let calls=0,release;
  const service=createGaiaCatalog({fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://gea.esac.esa.int/tap-server/tap/sync');assert.equal(options.body.get('FORMAT'),'csv');assert.match(options.body.get('QUERY'),/TOP 1001/);await new Promise(resolve=>release=resolve);return new Response(header+row);}});
  const a=service(params()),b=service(params());
  await assert.rejects(service(new URLSearchParams({ra:'1',dec:'2',radius:'.2'})),{status:503});
  release();const [one,two]=await Promise.all([a,b]);assert.deepEqual(one,two);assert.equal(calls,1);
  assert.equal((await service(params())).sources[0].sourceId,'5350358584482202880');assert.equal(calls,1);
  let emptyCalls=0;const empty=createGaiaCatalog({fetchImpl:async()=>{emptyCalls++;return new Response(header);}});
  assert.deepEqual((await empty(params())).sources,[]);await empty(params());assert.equal(emptyCalls,1);
});
test('Gaia reports truncation, rejects bad astrometry and bounds response size',async()=>{
  const service=createGaiaCatalog({fetchImpl:async()=>new Response(header+row.repeat(1001))});
  const result=await service(params());assert.equal(result.truncated,true);assert.equal(result.sources.length,1000);
  for(const body of ['bad response',header+row.replace(',2016,',',2000,'),header+row.replace('9.5','NaN'),header+row+'x'.repeat(2*1024*1024)]) {
    await assert.rejects(createGaiaCatalog({fetchImpl:async()=>new Response(body)})(params()),{status:502});
  }
});
test('Gaia deadlines abort upstream fetches and failures are not cached',async()=>{
  let calls=0;const service=createGaiaCatalog({timeoutMs:5,fetchImpl:async(_,options)=>{
    calls++;if(calls>1)return new Response(header);
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('abort','AbortError'))));
  }});
  await assert.rejects(service(params()),{status:504});assert.equal((await service(params())).sources.length,0);assert.equal(calls,2);
});
test('catalog loader suppresses late results after target changes, even when transport ignores abort',async()=>{
  const releases=[];const loader=createCatalogLoader(()=>new Promise(resolve=>releases.push(resolve)));
  const a=loader.load('first'),b=loader.load('second');
  releases[1](new Response(JSON.stringify({sources:['second']})));assert.deepEqual(await b,{sources:['second']});
  releases[0](new Response(JSON.stringify({sources:['first']})));assert.equal(await a,null);
});
test('Gaia deadline cancels a stalled response body and releases its request slot',async()=>{
  let cancelled=false,calls=0;
  const service=createGaiaCatalog({timeoutMs:10,fetchImpl:async()=>{
    if(calls++)return new Response(header);
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(header));},cancel(){cancelled=true;}}));
  }});
  await assert.rejects(service(params()),{status:504});assert.equal(cancelled,true);
  assert.deepEqual((await service(params())).sources,[]);
});
test('display grid describes the actual center and single/daily midpoint, and excludes deep stacks',()=>{
  const observation={observedStartUtc:'2026-01-01T00:00:00Z',exposureSeconds:100};
  const center={raDeg:269.5,decDeg:4.7};
  const single=displayGrid({observation,image:{},center,width:100});
  assert.equal(single.centerRaDeg,269.5);assert.equal(single.endUtc,'2026-01-01T00:01:40.000Z');
  const image={stackRecord:{contributors:[observation,{observedStartUtc:'2026-01-01T02:00:00Z',exposureSeconds:100}]}};
  const daily=displayGrid({observation,image,center,width:100});
  assert.equal(daily.daily,true);assert.equal(daily.epoch,julianEpoch('2026-01-01T01:00:50Z'));
  assert.equal(displayGrid({observation,image,center,width:100,deep:true}),null);
  assert.match(markerSuspension({mode:'difference',grid:single}),/suspended/);
  assert.equal(markerSuspension({mode:'blink',grid:single}),'');
});
test('Gaia HTTP handler returns JSON validation, method and upstream errors',async()=>{
  const invoke=async(method,url,handler=createGaiaHandler())=>{
    const response={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},writeHead(status,headers){this.statusCode=status;Object.assign(this.headers,headers);return this;},end(body){this.body=JSON.parse(body);}};
    await handler({method,url},response);return response;
  };
  assert.equal((await invoke('POST','/api/gaia-sources')).statusCode,405);
  assert.equal((await invoke('GET','/api/gaia-sources?ra=bad')).statusCode,400);
  const upstream=createGaiaHandler(createGaiaCatalog({fetchImpl:async()=>new Response('busy',{status:503})}));
  assert.equal((await invoke('GET','/api/gaia-sources?'+params(),upstream)).statusCode,502);
});
