import { julianEpoch } from './gaia-core.js';
export function displayGrid({ observation, image, center, width, arcsecPerPixel=6.15, deep=false }) {
  if(!observation||!image||deep||image.stackRecord?.deepStack)return null;
  const contributors=image.stackRecord?.contributors||observation.exposures||[observation];
  const intervals=contributors.filter(c=>c.status!=='failed').map(c=>{
    const start=Date.parse(c.observedStartUtc||'');
    const explicit=Date.parse(c.observedEndUtc||'');
    const duration=Number(c.exposureSeconds);
    const end=Number.isFinite(explicit)&&explicit>=start?explicit:Number.isFinite(duration)&&duration>=0?start+duration*1000:start;
    return [start,end];
  }).filter(pair=>pair.every(Number.isFinite));
  if(!intervals.length)return null;
  const start=Math.min(...intervals.map(x=>x[0])),end=Math.max(...intervals.map(x=>x[1]));
  return {centerRaDeg:center.raDeg,centerDecDeg:center.decDeg,width,height:width,arcsecPerPixel,
    startUtc:new Date(start).toISOString(),endUtc:new Date(end).toISOString(),epoch:julianEpoch((start+end)/2),daily:contributors.length>1};
}
