// Straight-line motion through positions measured on several dates: a weighted
// least-squares fit in the tangent plane. Backyard Worlds style vetting: a real
// mover sits on one line across many dates; alignment and colour residuals
// jump around. Pure and DOM-free.

const D = Math.PI / 180;
const YEAR_MS = 365.25 * 86_400_000;
export const AGREE_ARCSEC = 9; // about 1.5 SPHEREx pixels
const DEFAULT_SIGMA_ARCSEC = 2;

function solve(points) {
  let sw = 0, st = 0;
  for (const p of points) { sw += p.w; st += p.w * p.t; }
  const tm = st / sw;
  let stt = 0, se = 0, sn = 0, ste = 0, stn = 0;
  for (const p of points) {
    const dt = p.t - tm;
    stt += p.w * dt * dt; se += p.w * p.e; sn += p.w * p.n; ste += p.w * dt * p.e; stn += p.w * dt * p.n;
  }
  const ve = stt > 0 ? ste / stt : 0, vn = stt > 0 ? stn / stt : 0;
  return { tm, e0: se / sw, n0: sn / sw, ve, vn, stt };
}

/**
 * @param {Array<{time:number, raDeg:number, decDeg:number, sigmaArcsec?:number, snr?:number, date?:string}>} detections
 * @returns {null | {motionArcsecPerYear:number, directionDeg:number, significance:number, rmsArcsec:number,
 *   agreeing:number, of:number, consistent:boolean, spanYears:number, dates:Array<{date:string|null, residualArcsec:number, agrees:boolean}>,
 *   at:(time:number)=>{raDeg:number, decDeg:number}}}
 */
export function fitLinearMotion(detections, { agreeArcsec = AGREE_ARCSEC } = {}) {
  const list = (detections || []).filter(d => Number.isFinite(d?.time) && Number.isFinite(d.raDeg) && Number.isFinite(d.decDeg));
  if (list.length < 2) return null;
  const ra0 = list[0].raDeg, dec0 = list.reduce((sum, d) => sum + d.decDeg, 0) / list.length, cos = Math.cos(dec0 * D);
  const t0 = list[0].time;
  const points = list.map(d => {
    const sigma = d.sigmaArcsec > 0 ? d.sigmaArcsec : d.snr > 0 ? Math.max(0.5, 6.15 / d.snr) : DEFAULT_SIGMA_ARCSEC;
    return { d, t: (d.time - t0) / YEAR_MS, e: (((d.raDeg - ra0 + 540) % 360) - 180) * cos * 3600, n: (d.decDeg - dec0) * 3600, w: 1 / sigma ** 2 };
  });
  const residual = (fit, p) => Math.hypot(p.e - (fit.e0 + fit.ve * (p.t - fit.tm)), p.n - (fit.n0 + fit.vn * (p.t - fit.tm)));
  let fit = solve(points);
  // Drop dates far off the line and refit, as long as three dates remain.
  const keep = points.filter(p => residual(fit, p) < agreeArcsec);
  if (keep.length >= 3 && keep.length < points.length) fit = solve(keep);
  const residuals = points.map(p => residual(fit, p));
  const agreeing = residuals.filter(r => r < agreeArcsec).length;
  const used = points.filter((_, i) => residuals[i] < agreeArcsec);
  const fitted = used.length >= 2 ? used : points;
  const chi2 = fitted.reduce((sum, p) => sum + p.w * residual(fit, p) ** 2, 0);
  const dof = Math.max(1, 2 * fitted.length - 4);
  const stt = solve(fitted).stt;
  const motion = Math.hypot(fit.ve, fit.vn);
  const sigmaV = stt > 0 ? Math.sqrt(Math.max(1, chi2 / dof) / stt) : Infinity;
  const times = list.map(d => d.time);
  return {
    motionArcsecPerYear: Number(motion.toFixed(2)),
    directionDeg: Math.round(((Math.atan2(fit.ve, fit.vn) / D) + 360) % 360),
    significance: Number.isFinite(sigmaV) && sigmaV > 0 ? Number((motion / sigmaV).toFixed(1)) : 0,
    rmsArcsec: Number(Math.sqrt(residuals.filter(r => r < agreeArcsec).reduce((sum, r) => sum + r * r, 0) / Math.max(1, agreeing)).toFixed(1)),
    agreeing, of: points.length,
    consistent: agreeing >= 3 && agreeing / points.length >= 2 / 3,
    spanYears: Number(((Math.max(...times) - Math.min(...times)) / YEAR_MS).toFixed(2)),
    dates: points.map((p, i) => ({ date: p.d.date || null, residualArcsec: Number(residuals[i].toFixed(1)), agrees: residuals[i] < agreeArcsec })),
    at(time) {
      const t = (time - t0) / YEAR_MS;
      const e = fit.e0 + fit.ve * (t - fit.tm), n = fit.n0 + fit.vn * (t - fit.tm);
      return { raDeg: ((ra0 + e / 3600 / cos) % 360 + 360) % 360, decDeg: dec0 + n / 3600 };
    }
  };
}
