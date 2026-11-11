// "Mark star": put one spot on the target star where it actually is on the
// date shown. A catalogue or preset position is J2000 (Barnard's Star is about
// 4.4′ north of it by 2025), so the position is moved to the frame date
// (lib/target-locate.js) and checked against the source in the image; a plain
// catalogue position with no known motion is snapped onto that source. The
// AI guide's mark_target tool uses this one path for a single mark.
//
// The toolbar button is "Track star", a toggle: while it is on, every frame
// shown re-marks the star, and the spot's dated track draws its path (first
// place, every later place, an arrow on each hop) up to where it is now.

import { locateTarget } from './lib/target-locate.js';
import { presetMotion } from './presets.js';
import { describeTrack, trackUpTo } from './lib/track-arrow.js';

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

// Catalogue stars near a target do not change between frames, so tracking
// asks once per target rather than on every frame.
const catalogueCache = new Map();
const cacheKey = position => `${position.raDeg.toFixed(6)},${position.decDeg.toFixed(6)}`;
function catalogueStars(position) {
  const key = cacheKey(position);
  if (!catalogueCache.has(key)) {
    const pending = fetchCatalogueStars(position);
    catalogueCache.set(key, pending);
    // A lookup that brought nothing back is not kept, so a later mark retries it.
    pending.then(stars => { if (!stars.length) catalogueCache.delete(key); });
  }
  return catalogueCache.get(key);
}
async function fetchCatalogueStars(position) {
  const query = new URLSearchParams({ ra: position.raDeg.toFixed(6), dec: position.decDeg.toFixed(6), radius: String(CATALOGUE_RADIUS_DEG) });
  const load = path => fetch(`${path}?${query}`, { signal: AbortSignal.timeout(12000) }).then(response => response.ok ? response.json() : null).catch(() => null);
  // Gaia covers most stars; SIMBAD adds named objects Gaia cannot see (cold brown dwarfs).
  const [gaia, simbad] = await Promise.all([load('/api/gaia-sources'), load('/api/simbad-sources')]);
  return [...(gaia?.sources || []), ...(simbad?.sources || [])];
}

const formatDay = time => new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const formatMove = arcmin => arcmin >= 1 ? `${arcmin.toFixed(1)}′` : `${Math.round(arcmin * 60)}″`;

/** Locate, snap and mark the target. Returns a plain result for the button and the guide. */
export async function markTarget({ origin = 'user', restart = false } = {}) {
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
  // Dated, so marking again on another frame keeps both places on the spot's
  // track and the viewer draws the path between them. restart starts the
  // track over here (Track star turned on).
  const date = new Date(frameTime).toISOString().slice(0, 10);
  const change = existing ? { move: [{ n: existing.n, ...position, date, restart }] } : { add: [{ ...position, origin, label: name, date }] };
  const answer = await ask('sky:agent-spots', change);
  const spot = existing ? answer?.moved?.[0] : answer?.added?.[0];
  if (!spot) return { ok: false, error: 'All 9 spots are in use; remove one first.' };
  const day = formatDay(frameTime), moved = located.movedArcmin >= 0.1;
  // Only where it had been by this frame's date, as the viewer draws it.
  const past = trackUpTo(spot.track, date);
  const shift = past.length >= 2 ? describeTrack(past) : null;
  const message = located.method === 'catalogue' && !snapped
    ? `No star found here; marked the catalogue position of ${name}.`
    : `Marked ${name} where it is on ${day}${moved && located.sinceYear ? ` (moved ${formatMove(located.movedArcmin)} since ${located.sinceYear})` : ''}${snapped ? '' : '; no clear source under it in this image'}.${shift && shift.arcsec > 0 ? ` The arrows show it moved ${shift.text} across the frames marked.` : ''}`;
  return {
    ok: true, spot: spot.n, name, date: new Date(frameTime).toISOString().slice(0, 10),
    raDeg: Number(position.raDeg.toFixed(5)), decDeg: Number(position.decDeg.toFixed(5)),
    method: located.method, ...(located.sourceId ? { sourceId: located.sourceId } : {}),
    ...(moved && located.sinceYear ? { movedArcmin: located.movedArcmin, since: located.sinceYear } : {}),
    snapped: Boolean(snapped), ...(snapped ? { snapOffsetArcsec: peak.offsetArcsec, peakSigma: peak.peakSigma } : {}),
    moved: Boolean(existing), frames: past.length || 1, ...(shift ? { trackText: shift.text } : {}),
    ...(shift && shift.arcsec > 0 ? { track: { arcsec: shift.arcsec, directionDeg: shift.directionDeg, from: shift.from, to: shift.to, ...(shift.days !== null ? { days: shift.days } : {}) } } : {}),
    message
  };
}

window.addEventListener('sky:mark-target-requested', async event => {
  const result = await markTarget({ origin: event.detail?.origin || 'user' }).catch(error => ({ ok: false, error: error?.message || 'Could not mark the target.' }));
  event.detail?.respond?.(result);
});

// ---- Track star: the toolbar toggle ----------------------------------------
const button = $('mark-target-button'), status = $('mark-target-status'), viewer = document.querySelector('.viewer');
const buttonText = button?.querySelector('.mark-target-text');
const tracking = { on: false, busy: false, pending: false, name: '', savedFov: null };
let hideTimer = null, playback = null;
window.addEventListener('sky:playback-state', event => { playback = event.detail || playback; });

function say(text, { sticky = false } = {}) {
  if (!status) return;
  status.textContent = text; status.hidden = !text;
  clearTimeout(hideTimer);
  if (text && !sticky) hideTimer = setTimeout(() => { status.hidden = true; }, 9000);
}
function sync() {
  if (!button || !viewer) return;
  // While tracking the button stays usable, so it can always be turned off.
  button.disabled = !tracking.on && (!viewer.classList.contains('has-image') || tracking.busy);
  button.setAttribute('aria-pressed', String(tracking.on));
  if (buttonText) buttonText.textContent = tracking.on ? 'Tracking' : 'Track star';
  button.title = tracking.on ? 'Stop tracking; the path stays on the image' : 'Track the target star across frames: marks it on every frame shown and draws its path';
}
const currentFov = () => Number($('field-of-view')?.value) || null;
const setFov = fovArcmin => emit('sky:agent-settings-requested', { changes: { fovArcmin } });

function progress(result) {
  if (!result?.ok) return result?.error || 'Could not find the star on this frame.';
  const frames = result.frames || 1;
  return `Tracking ${result.name} · ${frames} frame${frames === 1 ? '' : 's'}${result.trackText ? ` · moved ${result.trackText}` : ''}. Play or step through the dates to follow it.`;
}

// Mark the frame on screen; frames that arrive meanwhile collapse into one more run.
async function markFrame({ restart = false } = {}) {
  if (tracking.busy) { tracking.pending = true; return null; }
  tracking.busy = true;
  let result;
  try { result = await markTarget({ origin: 'user', restart }); }
  catch (error) { result = { ok: false, error: error?.message || 'Could not mark the target.' }; }
  tracking.busy = false;
  if (result?.ok) tracking.name = result.name;
  if (tracking.on) say(progress(result), { sticky: true });
  if (tracking.pending && tracking.on) { tracking.pending = false; void markFrame(); }
  return result;
}

// The whole path across the loaded dates is often a few pixels, so zoom in
// until it spans about a quarter of the field (never zooming out).
async function zoomToFit() {
  const fov = currentFov(), first = Date.parse(playback?.firstDate || ''), last = Date.parse(playback?.lastDate || '');
  if (!fov || !target || !Number.isFinite(first) || !Number.isFinite(last)) return;
  const gaiaSources = presetMotion(target) ? [] : await catalogueStars(target);
  const a = locateTarget({ target, frameTime: first, gaiaSources }), b = locateTarget({ target, frameTime: last, gaiaSources });
  if (!a || !b || !tracking.on) return;
  const path = describeTrack([{ ...a, date: null }, { ...b, date: null }])?.arcsec || 0;
  const wanted = Math.max(1, Math.min(fov, Math.ceil(4 * path / 60)));
  if (path > 0 && wanted < fov) { tracking.savedFov = fov; setFov(wanted); }
}

async function startTracking() {
  tracking.on = true; tracking.pending = false; tracking.savedFov = null; sync();
  say('Finding the star on this date…', { sticky: true });
  const result = await markFrame({ restart: true });
  if (!result?.ok) { stopTracking({ message: result?.error || 'Could not mark the target.' }); return; }
  await zoomToFit();
}
function stopTracking({ message = 'Stopped tracking; the path stays on the image.' } = {}) {
  if (!tracking.on) return;
  tracking.on = false; tracking.pending = false;
  if (tracking.savedFov && currentFov() !== tracking.savedFov) setFov(tracking.savedFov);
  tracking.savedFov = null; sync();
  say(message);
}

// Each frame the viewer finishes drawing (previews never announce this).
window.addEventListener('sky:cutout-rendered', () => { if (tracking.on) void markFrame(); });
// A new target, or removing the tracked spot, ends tracking.
window.addEventListener('sky:target-selected', () => { catalogueCache.clear(); stopTracking({ message: '' }); });
window.addEventListener('sky:spots-changed', event => {
  if (tracking.on && tracking.name && !tracking.busy && !(event.detail?.spots || []).some(spot => spot.label === tracking.name)) stopTracking();
});

if (button && viewer) {
  new MutationObserver(sync).observe(viewer, { attributes: true, attributeFilter: ['class'] });
  sync();
  button.addEventListener('click', () => { if (tracking.on) stopTracking(); else void startTracking(); });
}
