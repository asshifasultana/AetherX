// Dependency-free Chromium smoke test. All astronomy responses are synthetic
// fixtures; never used as scientific evidence. Requires a local Chrome/Brave.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../frontend/server.mjs';
import { createGaiaCatalog } from '../frontend/lib/gaia-catalog.js';
import { createGaiaHandler } from '../frontend/api/gaia-sources.js';
import { makeFits } from '../frontend/tests/fixtures/fits-builder.js';
const root=new URL('../.local/sky-context-smoke/',import.meta.url);await mkdir(root,{recursive:true});
const browserPath=process.env.SKY_CONTEXT_BROWSER||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe','/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
if(!browserPath)throw new Error('Set SKY_CONTEXT_BROWSER to a Chromium executable.');
const bytes=makeFits({ra:56.75,dec:24.1167});
const observations=[2,3].map(day=>({accessUrl:`https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/fixture${day}.fits`,detector:1,observationId:`obs-${day}`,productId:`fixture-${day}`,observedStartUtc:`2026-01-0${day}T00:00:00Z`,observedEndUtc:`2026-01-0${day}T00:01:40Z`,exposureSeconds:100,release:'QR3',wavelengthMinUm:.8,wavelengthMaxUm:1.0,quality:{archiveFlag:0,summary:'Synthetic fixture'}}));
let gaiaRequests=0,fitsRequests=0,culturalRequests=0;
const gaia=createGaiaHandler(createGaiaCatalog({fetchImpl:async()=>new Response('source_id,ra,dec,ref_epoch,pmra,pmdec,phot_g_mean_mag\n5350358584482202880,56.75,24.1167,2016,0,0,10\n')}));
const app=createAppServer().listeners('request')[0];
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/cultural-sky.json')culturalRequests++;
  if(url.pathname==='/api/observations'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({query:{raDeg:56.75,decDeg:24.1167,detector:'all'},source:{name:'Synthetic browser fixture',kind:'live',retrievedAt:new Date().toISOString()},observations,count:2,matchedProducts:2,duplicatesRemoved:0,truncated:false,nextCursor:null,warnings:[]}));return;}
  if(url.pathname==='/api/gaia-sources'){gaiaRequests++;await gaia(req,res);return;}
  if(url.pathname==='/api/cutout'){fitsRequests++;res.writeHead(200,{'Content-Type':'application/fits'}).end(bytes);return;}
  await app(req,res);
});
server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
const child=spawn(browserPath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${fileURLToPath(new URL(`profile-${process.pid}/`,root))}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let ws;
try {
  const endpoint=await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(new Error('Browser startup timed out')),15000);child.stderr.on('data',chunk=>{stderr+=chunk;const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('error',reject);});
  ws=new WebSocket(endpoint);await once(ws,'open');let id=0;const pending=new Map(),errors=[];
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(new Error(`CDP timeout: ${method}`));},20000);pending.set(next,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id:next,method,params,...sessionId?{sessionId}:{}}));});
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(new Error(m.error.message));else p?.resolve(m.result);return;}
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Fetch.requestPaused'){
      const request=m.params.request;const range=request.headers.Range||request.headers.range;
      const match=/bytes=(\d+)-(\d+)/.exec(range||'');const start=match?Number(match[1]):0,end=match?Math.min(bytes.length-1,Number(match[2])):bytes.length-1;fitsRequests++;
      void call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:206,responseHeaders:[{name:'Content-Type',value:'application/fits'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Expose-Headers',value:'Content-Range'},{name:'Content-Range',value:`bytes ${start}-${end}/${bytes.length}`}],body:bytes.subarray(start,end+1).toString('base64')},m.sessionId).catch(error=>errors.push(error.message));
    }
  });
  const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  const send=(method,params={})=>call(method,params,sessionId);
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||'Evaluation failed');return result.result.value;};
  const waitFor=async(expression)=>{for(let i=0;i<250;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error(`Browser condition timed out: ${expression}\n${JSON.stringify(await evaluate("({errors:[],gaia:document.querySelector('#gaia-status')?.textContent,cutout:document.querySelector('#cutout-status')?.textContent,search:document.querySelector('#search-error')?.textContent,grids:window.__gridEvents?.slice(-3)})"))}\nRuntime: ${errors.join('\n')}`);};
  await send('Runtime.enable');await send('Page.enable');
  await send('Fetch.enable',{patterns:[{urlPattern:'*nasa-irsa-spherex.s3*'}]});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"globalThis.Worker=undefined;window.__gridEvents=[];addEventListener('sky:display-grid-changed',e=>__gridEvents.push(e.detail));"});
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/viewer.html?ra=56.75&dec=24.1167&fov=1&band=1&gaia=1&culture=vedic`});
  await waitFor("document.querySelector('#gaia-source-list')?.children.length===1");
  await evaluate("document.querySelector('#cultural-context').open=true");
  await waitFor("document.querySelectorAll('.culture-card').length>0");
  assert.equal(await evaluate("document.querySelector('#culture-filter').value"),'vedic');
  assert.match(await evaluate("document.querySelector('#gaia-status').textContent"),/epoch 2026/);
  const before=fitsRequests;
  const sciencePixels=await evaluate("document.querySelector('#sky-canvas').toDataURL()");
  await evaluate("document.querySelector('#gaia-stars').click();document.querySelector('#gaia-stars').click()");
  await waitFor("document.querySelector('#gaia-source-list').children.length===1");
  assert.equal(fitsRequests,before,'Gaia toggles must not reload FITS');
  assert.equal(await evaluate("document.querySelector('#sky-canvas').toDataURL()"),sciencePixels,'Overlay state cannot change exported science pixels');
  await evaluate("document.querySelector('#gaia-stars').focus()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  assert.equal(await evaluate("document.querySelector('#gaia-stars').checked"),false,'Gaia supports keyboard activation');
  await evaluate("document.querySelector('#gaia-stars').click()");
  await waitFor("document.querySelector('#gaia-source-list').children.length===1");
  await send('Runtime.evaluate',{expression:"document.querySelector('.viewer-shell').requestFullscreen()",awaitPromise:true,userGesture:true});
  await waitFor("!!document.fullscreenElement");
  assert.ok(await evaluate("Math.abs(document.querySelector('#gaia-canvas').clientWidth-document.querySelector('#sky-canvas').clientWidth)<1"),'Fullscreen canvases stay aligned');
  await evaluate('document.exitFullscreen()');
  await evaluate("document.querySelector('#step-forward').click()");
  await waitFor("__gridEvents.some(g=>g?.startUtc.startsWith('2026-01-03'))");
  await evaluate("document.querySelector('#culture-filter').value='all';document.querySelector('#culture-filter').dispatchEvent(new Event('change'))");
  await waitFor("document.querySelector('#culture-coverage').textContent.includes('permission')");
  await evaluate("document.querySelector('#cultural-context').scrollIntoView({behavior:'instant',block:'start'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(new URL('desktop.png',root),Buffer.from(shot.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelector('#cultural-context').scrollIntoView({behavior:'instant',block:'start'});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),'Mobile layout must not overflow');
  const mobile=await send('Page.captureScreenshot',{format:'png'});await writeFile(new URL('mobile.png',root),Buffer.from(mobile.data,'base64'));
  await evaluate("document.querySelector('.culture-card button').click()");
  await waitFor("document.querySelector('#object-name').textContent!=='Shared sky position'");
  const loadedCultures=culturalRequests;
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/viewer.html?ra=56.75&dec=24.1167&fov=1&band=1&gaia=1&culture=lakota&embed=1`});
  await waitFor("document.readyState==='complete'&&document.querySelector('#gaia-source-list')?.children.length===1");
  assert.equal(await evaluate("document.querySelector('#cultural-context').open"),false,'Embedded context starts collapsed');
  assert.equal(await evaluate("document.querySelector('#culture-filter').value"),'lakota');
  assert.equal(culturalRequests,loadedCultures,'Collapsed context must not fetch the cultural dataset');
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/viewer.html?searchType=object&q=GJ+699&ra=269.4521&dec=4.6934`});
  await waitFor("document.querySelector('#object-name')?.textContent==='GJ 699'");
  await evaluate("document.querySelector('#cultural-context').open=true");
  await waitFor("document.querySelector('#star-profile-card')?.textContent.includes('Edward Emerson Barnard (identified its rapid motion)')");
  assert.ok(await evaluate("document.querySelector('#star-profile-card').textContent.includes('How it was discovered') && document.querySelector('#star-profile-card').textContent.includes('10 arcseconds per year')"));
  assert.equal(await evaluate("document.querySelector('#cultural-context > summary').textContent"),'Star Details');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,gaiaRequests,fitsRangeRequests:fitsRequests,screenshots:fileURLToPath(root)},null,2));
} finally {ws?.close();child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
