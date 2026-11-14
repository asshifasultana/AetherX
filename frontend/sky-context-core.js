// Pure spherical geometry shared by the offline importer and the context panel.
import { skyToCanvas, canvasToSky, canvasSizeFor } from './sky-projection.js';
export const TRADITIONS = Object.freeze({
  'arabic-al-sufi': 'Arabic · al-Sufi', hawaiian: 'Hawaiian starlines',
  kamilaroi: 'Kamilaroi / Euahlayi', vedic: 'Vedic', bengali: 'Bengali', lakota: 'Lakota'
});
const D = Math.PI / 180;
export const vector = ({ raDeg, decDeg }) => [Math.cos(decDeg * D) * Math.cos(raDeg * D), Math.cos(decDeg * D) * Math.sin(raDeg * D), Math.sin(decDeg * D)];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = a => Math.hypot(...a);
const unit = a => a.map(v => v / norm(a));
const angle = (a, b) => Math.atan2(norm(cross(a, b)), dot(a, b));
export const separationDeg = (a, b) => angle(vector(a), vector(b)) / D;
export function fromVector(v) {
  return { raDeg: (Math.atan2(v[1], v[0]) / D + 360) % 360, decDeg: Math.atan2(v[2], Math.hypot(v[0], v[1])) / D };
}
export function sphericalBounds(points) {
  if (!points.length) return null;
  const sum = points.map(vector).reduce((a, b) => a.map((v, i) => v + b[i]), [0, 0, 0]);
  const center = norm(sum) < 1e-9 ? points[0] : fromVector(sum);
  return { center, radiusDeg: Math.min(180, Math.max(...points.map(p => separationDeg(center, p))) + .000001) };
}
export function segmentDistanceDeg(p, start, end) {
  const a = vector(start), b = vector(end), q = vector(p), n = cross(a, b);
  let best = Math.min(angle(q, a), angle(q, b));
  if (norm(n) > 1e-12 && angle(a, b) < Math.PI - 1e-8) {
    const nh = unit(n), projected = q.map((v, i) => v - dot(q, nh) * nh[i]);
    if (norm(projected) > 1e-12) {
      const foot = unit(projected);
      for (const f of [foot, foot.map(v => -v)]) {
        if (Math.abs(angle(a, f) + angle(f, b) - angle(a, b)) < 1e-8) best = Math.min(best, angle(q, f));
      }
    }
  }
  return best / D;
}
function intersectsSquare(a, b, edge) {
  let lo = 0, hi = 1;
  for (const axis of ['x', 'y']) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-12) { if (a[axis] < -.5 || a[axis] > edge) return false; continue; }
    const t1 = (-.5 - a[axis]) / delta, t2 = (edge - a[axis]) / delta;
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
  }
  return lo <= hi;
}
function arcsIntersect(a,b,c,d) {
  const av=vector(a),bv=vector(b),cv=vector(c),dv=vector(d);
  const axis=cross(cross(av,bv),cross(cv,dv));
  if(norm(axis)<1e-14)return false;
  const intersection=unit(axis);
  const on=(v,start,end)=>Math.abs(angle(start,v)+angle(v,end)-angle(start,end))<1e-8;
  return [intersection,intersection.map(v=>-v)].some(v=>on(v,av,bv)&&on(v,cv,dv));
}
export function classifyFeature(feature, field) {
  const center = { raDeg: field.raDeg, decDeg: field.decDeg };
  const size = canvasSizeFor(field.fovArcmin), edge = size - .5;
  const project = p => skyToCanvas({ ...p, size, centerRaDeg: field.raDeg, centerDecDeg: field.decDeg });
  const corners=[[-.5,-.5],[edge,-.5],[edge,edge],[-.5,edge]].map(([x,y])=>canvasToSky({x,y,size,centerRaDeg:field.raDeg,centerDecDeg:field.decDeg}));
  const crossesBoundary=(a,b)=>corners.some((c,i)=>arcsIntersect(a,b,c,corners[(i+1)%4]));
  const inside = p => p && p.x >= -.5 && p.x <= edge && p.y >= -.5 && p.y <= edge;
  let distanceDeg = 180, inField = false;
  for (const p of feature.geometry?.points || []) {
    distanceDeg = Math.min(distanceDeg, separationDeg(center, p)); inField ||= Boolean(inside(project(p)));
  }
  for (const line of feature.geometry?.polylines || []) {
    for (let i = 0; i < line.length; i++) {
      distanceDeg = Math.min(distanceDeg, separationDeg(center, line[i])); inField ||= Boolean(inside(project(line[i])));
      if (!i) continue;
      distanceDeg = Math.min(distanceDeg, segmentDistanceDeg(center, line[i-1], line[i]));
      const a = project(line[i-1]), b = project(line[i]);
      // Within the front tangent hemisphere a great-circle arc projects to a line.
      if (a && b && separationDeg(line[i-1], line[i]) < 179) inField ||= intersectsSquare(a, b, edge);
      else if(separationDeg(line[i-1],line[i])<179)inField ||= crossesBoundary(line[i-1],line[i]);
    }
  }
  // Supplied polygon rings use great-circle edges. Winding includes a field
  // contained entirely within a region, even when no boundary intersects it.
  for (const ring of feature.geometry?.regions || []) {
    const q = vector(center); let winding = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = vector(ring[i]), b = vector(ring[(i+1)%ring.length]);
      const u = a.map((v,j)=>v-dot(a,q)*q[j]), v = b.map((x,j)=>x-dot(b,q)*q[j]);
      if (angle(q,a)<1e-12||angle(q,b)<1e-12) { inField=true;break; }
      if (norm(u) < 1e-12 || norm(v) < 1e-12) continue;
      winding += Math.atan2(dot(q,cross(u,v)),dot(u,v));
      distanceDeg = Math.min(distanceDeg,segmentDistanceDeg(center,ring[i],ring[(i+1)%ring.length]));
      const pa=project(ring[i]),pb=project(ring[(i+1)%ring.length]);
      if(pa&&pb) inField ||= intersectsSquare(pa,pb,edge);
      else inField ||= crossesBoundary(ring[i],ring[(i+1)%ring.length]);
    }
    // Select the local (minor) interior, not its antipodal complement.
    const sum=ring.map(vector).reduce((a,b)=>a.map((v,i)=>v+b[i]),[0,0,0]);
    if (Math.abs(winding) > Math.PI && dot(q,sum)>0) inField = true;
  }
  return { inField, distanceDeg: inField ? 0 : distanceDeg };
}
export function nearbyCards(records, field, tradition = 'all') {
  return records.filter(r => r.publication?.status === 'published' && (tradition === 'all' || r.tradition === tradition))
    .filter(r=>!r.bounds||r.bounds.radiusDeg>=90||separationDeg(field,r.bounds.center)<=r.bounds.radiusDeg+15+field.fovArcmin/60)
    .map(record => ({ record, ...classifyFeature(record, field) }))
    .filter(r => r.inField || r.distanceDeg <= 15)
    .sort((a, b) => Number(b.inField)-Number(a.inField) || a.distanceDeg-b.distanceDeg || a.record.id.localeCompare(b.record.id));
}
