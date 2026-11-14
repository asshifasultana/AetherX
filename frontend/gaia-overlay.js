import { initialViewState } from './share.js';
import { skyToCanvas } from './sky-projection.js';
import { propagateGaia, fieldRadiusDeg, markerSuspension, createCatalogLoader } from './gaia-core.js';
const toggle=document.getElementById('gaia-stars'),canvas=document.getElementById('gaia-canvas'),status=document.getElementById('gaia-status');
const list=document.getElementById('gaia-source-list'),retry=document.getElementById('gaia-retry'),loader=createCatalogLoader();
let field={raDeg:initialViewState.raDeg,decDeg:initialViewState.decDeg,fovArcmin:initialViewState.fovArcmin};
let enabled=initialViewState.gaia,grid=null,catalog=null,queryKey='',mode='time-lapse',entryMode='object',loading=false,error='';
let loadGeneration=0;
toggle.checked=enabled;
const approximation=document.getElementById('gaia-approximation');
function clear() {canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);list.replaceChildren();}
function render() {
  clear();retry.hidden=true;approximation.hidden=!enabled;
  if(!enabled){status.textContent='';return;}
  const suspended=markerSuspension({mode,entryMode,grid});
  if(suspended){status.textContent=suspended;return;}
  if(error){status.textContent=error;retry.hidden=false;return;}
  if(loading||!catalog){status.textContent='Loading Gaia DR3 stars…';return;}
  const image=document.getElementById('sky-canvas');
  const width=image.clientWidth,height=image.clientHeight,dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));
  const context=canvas.getContext('2d');context.setTransform(dpr,0,0,dpr,0,0);
  context.strokeStyle='#65e5ed';context.lineWidth=1.25;
  const items=[];
  for(const source of catalog.sources) {
    const position=propagateGaia(source,grid.epoch);
    const p=skyToCanvas({...position,size:grid.width,centerRaDeg:grid.centerRaDeg,centerDecDeg:grid.centerDecDeg,arcsecPerPixel:grid.arcsecPerPixel});
    if(!p||p.x<-.5||p.y<-.5||p.x>grid.width-.5||p.y>grid.height-.5)continue;
    context.beginPath();context.arc((p.x+.5)*width/grid.width,(p.y+.5)*height/grid.height,4,0,Math.PI*2);context.stroke();
    const item=document.createElement('li');item.textContent=`${source.sourceId} · G ${source.gMag.toFixed(2)} · ${position.raDeg.toFixed(6)}°, ${position.decDeg.toFixed(6)}° · epoch ${position.epoch.toFixed(4)} · ${position.propagated?'proper motion applied':'reference position; proper motion unavailable'}`;items.push(item);
  }
  list.replaceChildren(...items);
  status.textContent=`${items.length} Gaia DR3 stars in field${catalog.truncated?' · Brightest 1,000 sources in padded search':''} · G ≤ 18 · epoch ${grid.epoch.toFixed(4)}${grid.daily?' · daily midpoint approximation':''}. Retrieved ${catalog.retrievedAt}. ESA/Gaia/DPAC.`;
}
async function load({force=false}={}) {
  if(!enabled||entryMode==='moving')return;
  // The fixed query center and backend motion margin cover supported dates;
  // propagation and projection use each actual displayed tracked center.
  const center=field;
  const params=new URLSearchParams({ra:String(center.raDeg),dec:String(center.decDeg),radius:String(fieldRadiusDeg(field.fovArcmin))});
  const key=params.toString();if(key===queryKey&&!force&&(catalog||loading))return;
  const generation=++loadGeneration;
  queryKey=key;catalog=null;error='';loading=true;render();
  try {const result=await loader.load('/api/gaia-sources?'+key);if(!result)return;catalog=result;}
  catch(e){error=e.message;}
  finally {if(generation===loadGeneration&&key===queryKey){loading=false;render();}}
}
toggle.addEventListener('change',()=>{enabled=toggle.checked;window.dispatchEvent(new CustomEvent('sky:context-settings-changed',{detail:{gaia:enabled}}));if(!enabled){loader.cancel();loading=false;queryKey='';}else void load();render();});
retry.addEventListener('click',()=>void load({force:true}));
window.addEventListener('sky:target-selected',event=>{loader.cancel();field={...field,...event.detail};queryKey='';catalog=null;grid=null;loading=false;error='';render();void load();});
window.addEventListener('sky:viewer-settings-changed',event=>{mode=event.detail.viewMode;const changed=field.fovArcmin!==event.detail.fovArcmin;field.fovArcmin=event.detail.fovArcmin;if(changed){grid=null;void load();}render();});
window.addEventListener('sky:display-grid-changed',event=>{grid=event.detail;render();});
window.addEventListener('sky:entry-mode-changed',event=>{entryMode=event.detail.mode;if(entryMode==='moving'){loader.cancel();queryKey='';loading=false;}else void load();render();});
window.addEventListener('sky:search-entry',event=>{entryMode=event.detail.type;if(entryMode==='moving'){loader.cancel();queryKey='';loading=false;}else void load();render();});
new ResizeObserver(render).observe(document.getElementById('sky-canvas'));
render();
