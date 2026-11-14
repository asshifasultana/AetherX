import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createAppServer } from '../frontend/server.mjs';
import { CONTEXT_PUBLIC_FILES } from '../frontend/context-assets.js';
const server=createAppServer();server.listen(0,'127.0.0.1');await once(server,'listening');
try {
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const file of CONTEXT_PUBLIC_FILES){
    const response=await fetch(base+'/'+file);assert.equal(response.status,200,file);
    const original=await readFile(new URL('../frontend/'+file,import.meta.url));
    const deployed=await readFile(new URL('../.vercel/output/static/'+file,import.meta.url));
    assert.deepEqual(deployed,original,file);await response.body?.cancel();
  }
  for(const path of ['/data/sky-cultures/normalized.json','/lib/gaia-catalog.js','/cultural-sources/kamilaroi/index.json','/cultural-sources/arabic_al-sufi/index.json'])assert.equal((await fetch(base+path)).status,404,path);
  const deployed=await import(new URL('../.vercel/output/functions/api/gaia-sources.func/api/gaia-sources.js',import.meta.url));
  const response={statusCode:200,setHeader(){},end(text){this.body=JSON.parse(text);}};
  await deployed.default({method:'GET',url:'/api/gaia-sources?ra=bad'},response);
  assert.equal(response.statusCode,400);assert.equal(response.body.code,'INVALID_INPUT');
  assert.equal((await fetch(base+'/api/gaia-sources?ra=bad')).status,400);
  const stars=await import(new URL('../.vercel/output/functions/api/star-details.func/api/star-details.js',import.meta.url));
  await stars.createStarDetailsHandler(null)({method:'GET',url:'/api/star-details?preset=epsilon'},response);
  assert.equal(response.body.profile.name,'Epsilon Indi B');
  const localStar=await fetch(base+'/api/star-details?preset=epsilon');
  assert.equal((await localStar.json()).profile.name,'Epsilon Indi B');
  assert.equal((await fetch(base+'/lib/star-profiles.js')).status,404);
  console.log(`Verified ${CONTEXT_PUBLIC_FILES.length} context assets, isolated Vercel Gaia and star profile imports, local API routing, and private-source exclusions.`);
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
