// The shared-view hub. One place decides what a link means and when the address
// bar is rewritten, so the viewer, the timeline and the search form all agree.
//
// Reads the incoming URL once at import time, then follows the existing UI
// events. Writes go through history.replaceState so sharing never adds history
// entries the back button has to fight through.

import { decodeViewState, VIEW_SETTING_PARAMS } from './url-state.js';
import { readSearchEntry, encodeSearchView } from './search-route.js';

const hasLocation = typeof location !== 'undefined' && typeof location.search === 'string';
const decoded = decodeViewState(hasLocation ? location.search : '');
const initial = Object.freeze({ ...decoded.state });

/** The validated view state from the incoming URL. Read once, at startup. */
export const initialViewState = initial;
/** Human-readable problems found in the incoming URL, if any. */
export const initialViewIssues = Object.freeze([...decoded.issues]);

// A guide note is shown once on arrival; it is not carried into later links.
const live = { ...initial, note: '' };
let entry = hasLocation ? readSearchEntry(location.search) : null;
let lastWritten = encodeSearchView(live, entry);
let timer = null;
// The frame date a shared link asked for, consumed once by the timeline.
let pendingFrameDate = initial.frameDate;

function writeNow() {
  timer = null;
  if (!hasLocation || typeof history === 'undefined') return;
  const signature = encodeSearchView(live, entry);
  if (signature === lastWritten) return;
  lastWritten = signature;
  const query = signature;
  const url = location.pathname + (query ? `?${query}` : '') + location.hash;
  try { history.replaceState(history.state, '', url); } catch { /* A sandboxed frame may refuse. */ }
}

function scheduleWrite() {
  if (timer !== null) return;
  timer = setTimeout(writeNow, 180);
}

function update(patch) {
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in live)) continue;
    if (live[key] === value) continue;
    live[key] = value;
    changed = true;
  }
  if (changed) scheduleWrite();
}

function isoDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

if (typeof window !== 'undefined') {
  window.addEventListener('sky:context-settings-changed', event => {
    const patch={};
    if(typeof event.detail?.culture==='string')patch.culture=event.detail.culture;
    if(typeof event.detail?.gaia==='boolean')patch.gaia=event.detail.gaia;
    if (typeof event.detail?.wise === 'boolean') patch.wise = event.detail.wise;
    update(patch);
  });
  window.addEventListener('sky:search-entry', event => {
    entry = { ...event.detail, resolved: false };
    scheduleWrite();
  });
  window.addEventListener('sky:target-selected', event => {
    const detail = event.detail || {};
    if (!Number.isFinite(detail.raDeg) || !Number.isFinite(detail.decDeg)) return;
    if (entry) entry = { ...entry, resolved: true };
    update({
      raDeg: detail.raDeg,
      decDeg: detail.decDeg,
      // Only a curated target has an id; a manual or resolved position clears it.
      targetId: typeof detail.targetId === 'string' ? detail.targetId : null
    });
    scheduleWrite();
  });

  window.addEventListener('sky:viewer-settings-changed', event => {
    const detail = event.detail || {};
    const patch = {};
    if (Number.isFinite(detail.band)) patch.band = detail.band;
    if (Number.isFinite(detail.fovArcmin)) patch.fovArcmin = detail.fovArcmin;
    for (const [key] of VIEW_SETTING_PARAMS) if (detail[key] !== undefined) patch[key] = detail[key];
    if (Object.keys(patch).length) update(patch);
  });

  window.addEventListener('sky:search-filters-changed', event => {
    const detail = event.detail || {};
    update({
      startDate: typeof detail.startDate === 'string' ? detail.startDate : '',
      endDate: typeof detail.endDate === 'string' ? detail.endDate : ''
    });
  });

  window.addEventListener('sky:spots-changed', event => {
    const list = Array.isArray(event.detail?.spots) ? event.detail.spots : [];
    const [first, ...rest] = list;
    update({
      markRaDeg: first ? first.raDeg : null,
      markDecDeg: first ? first.decDeg : null,
      extraSpots: rest.map(spot => ({ raDeg: spot.raDeg, decDeg: spot.decDeg }))
    });
  });

  window.addEventListener('sky:source-marked', event => {
    const detail = event.detail || {};
    if (Number.isFinite(detail.raDeg) && Number.isFinite(detail.decDeg)) {
      update({ markRaDeg: detail.raDeg, markDecDeg: detail.decDeg });
    } else {
      update({ markRaDeg: null, markDecDeg: null });
    }
  });

  // Emitted only for a cutout the user opened, not for playback frames, so a
  // running time-lapse never rewrites the address bar on every frame.
  window.addEventListener('sky:frame-shown', event => {
    const date = isoDate(event.detail?.observation?.observedStartUtc);
    update({ frameDate: date });
  });

  // The pinned comparison frame travels as a date, since frame keys are local.
  window.addEventListener('sky:playback-state', event => {
    const date = typeof event.detail?.referenceDate === 'string' ? event.detail.referenceDate : '';
    update({ referenceDate: date });
  });

  // A shared frame date is spent once the timeline has used it.
  window.addEventListener('sky:frame-date-restored', () => { pendingFrameDate = ''; });
}

/** The frame date a shared link asked for, until the timeline consumes it. */
export function takePendingFrameDate() {
  return pendingFrameDate;
}

/** The current shareable state, for building a link by hand. */
export function currentViewState() {
  return { ...live };
}

/**
 * Absolute URL for the current view. `embed` forces the compact layout, which is
 * what an iframe should point at.
 */
export function shareUrl({ embed = isEmbedded, absolute = true, note = '' } = {}) {
  const state = { ...live, embed, note };
  const query = encodeSearchView(state, entry);
  if (!hasLocation) return query ? `?${query}` : '';
  const base = `${location.origin}/viewer.html`;
  const url = `${base}${query ? `?${query}` : ''}`;
  return absolute ? url : url.slice(location.origin.length);
}

/** HTML snippet for embedding the current view in another page. */
export function embedSnippet({ width = 720, height = 520 } = {}) {
  const src = shareUrl({ embed: true });
  return `<iframe src="${src}" width="${width}" height="${height}" style="border:0;max-width:100%" loading="lazy" title="SPHEREx sky viewer"></iframe>`;
}

/** True when the page was opened as an embed. */
export const isEmbedded = initial.embed || (typeof window !== 'undefined' && window.parent !== window
  && !(typeof document !== 'undefined' && document.documentElement?.classList.contains('is-tour-preview')));
