// "Mark star": put one spot on the target star where it actually is on the
// date shown. A catalogue or preset position is J2000 (Barnard's Star is about
// 4.4′ north of it by 2025), so the position is moved to the frame date
// (lib/target-locate.js) and checked against the source in the image; a plain
// catalogue position with no known motion is snapped onto that source. The
// button and the AI guide's mark_target tool both use this one path.

import { locateTarget } from './lib/target-locate.js';
import { presetMotion } from './presets.js';

const $ = id => document.getElementById(id);
const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
const CATALOGUE_RADIUS_DEG = 0.025; // 90″; the Gaia endpoint adds room for fast movers
const SNAP_RADIUS_PX = 2;
const SNAP_KEEP_ARCSEC = 9; // about 1.5 SPHEREx pixels

let target = null, frameDate = '';
window.addEventListener('sky:target-selected', event => { target = { ...event.detail }; });
window.addEventListener('sky:playback-state', event => { if (event.detail?.frameDate) frameDate = event.detail.frameDate; });

function ask(type, detail = {}, timeout = 4000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeout);
    emit(type, { ...detail, respond: value => { clearTimeout(timer); resolve(value); } });
  });
}

async function catalogueStars(position) {
  const query = new URLSearchParams({ ra: position.raDeg.toFixed(6), dec: position.decDeg.toFixed(6), radius: String(CATALOGUE_RADIUS_DEG) });
  const load = path => fetch(`${path}?${query}`, { signal: AbortSignal.timeout(12000) }).then(response => response.ok ? response.json() : null).catch(() => null);
  // Gaia covers most stars; SIMBAD adds named objects Gaia cannot see (cold brown dwarfs).
  const [gaia, simbad] = await Promise.all([load('/api/gaia-sources'), load('/api/simbad-sources')]);
  return [...(gaia?.sources || []), ...(simbad?.sources || [])];
}

const formatDay = time => new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const formatMove = arcmin => arcmin >= 1 ? `${arcmin.toFixed(1)}′` : `${Math.round(arcmin * 60)}″`;

/** Locate, snap and mark the target. Returns a plain result for the button and the guide. */
export async function markTarget({ origin = 'user' } = {}) {
  if (!target || !Number.isFinite(target.raDeg)) return { ok: false, error: 'No target is selected.' };
  if (!document.querySelector('.viewer')?.classList.contains('has-image')) return { ok: false, error: 'No image is on screen yet.' };
  const name = ($('object-name')?.textContent || target.name || 'Target').trim().slice(0, 40);
  // The timeline re-announces the frame on screen (synchronously) when asked.
  emit('sky:agent-state-requested');
  const parsed = Date.parse(frameDate), frameTime = Number.isFinite(parsed) ? parsed : Date.now();
  const stars = presetMotion(target) ? [] : await catalogueStars(target);
  const located = locateTarget({ target, frameTime, gaiaSources: stars });
  if (!located) return { ok: false, error: 'The target position is not valid.' };
  const peak = await ask('sky:peak-requested', { raDeg: located.raDeg, decDeg: located.decDeg, radiusPx: SNAP_RADIUS_PX });
  const found = peak && !peak.noSource && Number.isFinite(peak.raDeg);
  // A position from proper motion or a catalogue star is more precise than a
  // centroid on 6″ pixels. It is kept when the image agrees with it to about a
  // pixel; a source further away is a neighbour (a faint target such as WISE
  // 0855 can be invisible in this band), so the mark stays put. Only a plain
  // catalogue position is moved onto the source.
  const precise = located.method !== 'catalogue';
  const snapped = found && (!precise || peak.offsetArcsec <= SNAP_KEEP_ARCSEC);
  const position = found && !precise ? { raDeg: peak.raDeg, decDeg: peak.decDeg } : { raDeg: located.raDeg, decDeg: located.decDeg };
  const existing = ((await ask('sky:spots-requested')) || []).find(spot => spot.label === name);
  const change = existing ? { move: [{ n: existing.n, ...position }] } : { add: [{ ...position, origin, label: name }] };
  const answer = await ask('sky:agent-spots', change);
  const spot = existing ? answer?.moved?.[0] : answer?.added?.[0];
  if (!spot) return { ok: false, error: 'All 9 spots are in use; remove one first.' };
  const day = formatDay(frameTime), moved = located.movedArcmin >= 0.1;
  const message = located.method === 'catalogue' && !snapped
    ? `No star found here; marked the catalogue position of ${name}.`
    : `Marked ${name} where it is on ${day}${moved && located.sinceYear ? ` (moved ${formatMove(located.movedArcmin)} since ${located.sinceYear})` : ''}${snapped ? '' : '; no clear source under it in this image'}.`;
  return {
    ok: true, spot: spot.n, name, date: new Date(frameTime).toISOString().slice(0, 10),
    raDeg: Number(position.raDeg.toFixed(5)), decDeg: Number(position.decDeg.toFixed(5)),
    method: located.method, ...(located.sourceId ? { sourceId: located.sourceId } : {}),
    ...(moved && located.sinceYear ? { movedArcmin: located.movedArcmin, since: located.sinceYear } : {}),
    snapped: Boolean(snapped), ...(snapped ? { snapOffsetArcsec: peak.offsetArcsec, peakSigma: peak.peakSigma } : {}),
    moved: Boolean(existing), message
  };
}

window.addEventListener('sky:mark-target-requested', async event => {
  const result = await markTarget({ origin: event.detail?.origin || 'user' }).catch(error => ({ ok: false, error: error?.message || 'Could not mark the target.' }));
  event.detail?.respond?.(result);
});

// The toolbar button: disabled until an image is shown.
const button = $('mark-target-button'), status = $('mark-target-status'), viewer = document.querySelector('.viewer');
let hideTimer = null;
function say(text) {
  if (!status) return;
  status.textContent = text; status.hidden = !text;
  clearTimeout(hideTimer);
  if (text) hideTimer = setTimeout(() => { status.hidden = true; }, 9000);
}
if (button && viewer) {
  const sync = () => { button.disabled = !viewer.classList.contains('has-image') || button.dataset.busy === 'true'; };
  new MutationObserver(sync).observe(viewer, { attributes: true, attributeFilter: ['class'] });
  sync();
  button.addEventListener('click', async () => {
    button.dataset.busy = 'true'; sync(); say('Finding the star on this date…');
    const result = await new Promise(resolve => emit('sky:mark-target-requested', { origin: 'user', respond: resolve }));
    button.dataset.busy = 'false'; sync();
    say(result?.ok ? result.message : result?.error || 'Could not mark the target.');
  });
}
