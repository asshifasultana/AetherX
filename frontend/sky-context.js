import { TRADITIONS, nearbyCards } from './sky-context-core.js';
import { initialViewState } from './share.js';
const panel=document.getElementById('cultural-context'), filter=document.getElementById('culture-filter');
const results=document.getElementById('culture-results'),status=document.getElementById('culture-status');
let field={raDeg:initialViewState.raDeg,decDeg:initialViewState.decDeg,fovArcmin:initialViewState.fovArcmin},dataset=null,pending=null;
let expanded=new Set();
function node(tag,text,className) { const el=document.createElement(tag);if(text)el.textContent=text;if(className)el.className=className;return el; }
for(const [key,label] of Object.entries(TRADITIONS)) {const option=node('option',label);option.value=key;filter.append(option);}
filter.value=initialViewState.culture;
function render() {
  if(!dataset)return;
  results.replaceChildren();
  const matches=nearbyCards(dataset.records,field,filter.value);
  status.textContent=matches.length ? `${matches.length} reviewed entries within this field or 15° nearby. Cultural context describes sky patterns, not lore attached to the selected infrared source.` : 'No reviewed entries near this position.';
  const gaps=dataset.manifest.coverage.filter(c=>c.published<c.target&&(filter.value==='all'||c.group===filter.value||c.group==='vedic-bengali'&&['vedic','bengali'].includes(filter.value)));
  const notice=document.getElementById('culture-coverage');
  notice.textContent=gaps.map(c=>`${c.group==='arabic-al-sufi'?TRADITIONS['arabic-al-sufi']:TRADITIONS[c.group]||c.group}: ${c.reason||'Additional reviewed cards needed'}.`).join(' ');
  for(const [label,inField] of [['In this field',true],['Nearby sky context',false]]) {
    const section=node('section');section.append(node('h3',label));let count=0;
    const group=node('div',null,'culture-cards');
    for(const [tradition,title] of Object.entries(TRADITIONS)) {
      const items=matches.filter(m=>m.inField===inField&&m.record.tradition===tradition);
      if(!items.length)continue;
      const key=`${tradition}|${inField}`;
      for(const match of items.slice(0,expanded.has(key)?Infinity:6)) {
        const r=match.record,card=node('article',null,'culture-card');
        card.append(node('p',title,'eyebrow'),node('h4',r.nameNative||r.names?.[0]?.native||r.id));
        card.querySelector('h4').dir='auto';
        if(r.translation)card.append(node('p',r.translation,'culture-translation'));
        card.append(node('p',r.summary),node('p',inField?'Intersects the displayed field':`${match.distanceDeg.toFixed(1)}° from the selected position`,'context-distance'));
        const links=node('p');for(const source of r.sources) {if(!/^https:\/\//.test(source.url))continue;const a=node('a','Source ↗');a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';links.append(a,document.createTextNode(' '));}card.append(links);
        const credits=node('details');credits.append(node('summary','Credits and source review'),node('p',r.credits),node('p',r.license),node('p',r.publication.review));card.append(credits);
        if(r.navigationAnchor) {const button=node('button','View this sky position','reset-settings');button.type='button';button.addEventListener('click',()=>window.dispatchEvent(new CustomEvent('sky:navigate-context',{detail:{...r.navigationAnchor,name:r.nameNative||r.translation}})));card.append(button);}
        group.append(card);count++;
      }
      if(items.length>6&&!expanded.has(key)) {const more=node('button',`Show more · ${title}`,'reset-settings');more.type='button';more.addEventListener('click',()=>{expanded.add(key);render();});group.append(more);}
    }
    if(count){section.append(group);results.append(section);}
  }
}
async function load() {
  if(!panel.open)return;
  if(dataset){render();return;}
  if(pending)return pending;
  status.textContent='Loading reviewed cultural entries…';
  pending=(async()=>{try {const response=await fetch('/cultural-sky.json');if(!response.ok)throw new Error();dataset=await response.json();render();document.getElementById('culture-retry').hidden=true;}
    catch {status.textContent='Cultural context is unavailable. Please retry.';document.getElementById('culture-retry').hidden=false;}
    finally {pending=null;}})();
  return pending;
}
panel.addEventListener('toggle',load);
document.getElementById('culture-retry').addEventListener('click',load);
filter.addEventListener('change',()=>{expanded.clear();window.dispatchEvent(new CustomEvent('sky:context-settings-changed',{detail:{culture:filter.value}}));render();});
window.addEventListener('sky:target-selected',event=>{field={...field,...event.detail};expanded.clear();if(panel.open)void load();});
window.addEventListener('sky:viewer-settings-changed',event=>{if(field.fovArcmin!==event.detail.fovArcmin){field.fovArcmin=event.detail.fovArcmin;expanded.clear();if(panel.open)void load();}});
window.addEventListener('sky:entry-mode-changed',event=>{panel.hidden=event.detail.mode==='moving';});
window.addEventListener('sky:search-entry',event=>{panel.hidden=event.detail.type==='moving';});
