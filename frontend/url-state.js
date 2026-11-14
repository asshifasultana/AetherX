// Shareable view state. Pure functions only: nothing here touches the DOM, the
// network or global objects, so the exact encoding rules can be unit tested in
// Node and reused by the embed view.
//
// The URL is the source of truth for a shared view. Every value is validated on
// the way in and normalised on the way out, so a hand-edited or truncated link
// still opens a usable view instead of throwing.

export const FOV_OPTIONS = Array.from({ length: 30 }, (_, index) => index + 1);
export const BAND_OPTIONS = [1, 2, 3, 4, 5, 6];
export const CULTURE_OPTIONS = ['all','arabic-al-sufi','hawaiian','kamilaroi','vedic','bengali','lakota'];
import { checkSetting, DEFAULT_SETTINGS } from './viewer-settings.js';

// View and display settings a link can carry, as [state key, URL parameter].
// They are validated with the same rules as the viewer controls.
export const VIEW_SETTING_PARAMS = Object.freeze([
  ['viewMode', 'mode'], ['referenceFrame', 'ref'], ['look', 'look'], ['brightness', 'bright'],
  ['contrast', 'contrast'], ['stretch', 'stretch'], ['scaleMode', 'scale'], ['colours', 'colours'],
  ['invert', 'invert'], ['maxStackFrames', 'stack'], ['blinkIntervalMs', 'blink'], ['differenceThreshold', 'thresh']
]);
export const NOTE_MAX_LENGTH = 200;
const cleanNote = text => [...String(text ?? '')].map(char => { const code = char.codePointAt(0); return code < 32 || code === 127 || code === 0x2028 || code === 0x2029 ? ' ' : char; }).join('').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_LENGTH);

// Precision of the shared position. Six decimal places is 0.0036 arcsec, far
// finer than a SPHEREx pixel (6.15 arcsec), so a shared link lands on the same
// patch of sky that the sender was looking at.
const POSITION_DECIMALS = 6;

export const DEFAULT_VIEW_STATE = Object.freeze({
  raDeg: 269.4521,
  decDeg: 4.6934,
  fovArcmin: 16,
  band: 2,
  startDate: '',
  endDate: '',
  frameDate: '',
  markRaDeg: null,
  markDecDeg: null,
  targetId: null,
  embed: false,
  culture: 'all',
  gaia: false,
  ...Object.fromEntries(VIEW_SETTING_PARAMS.map(([key]) => [key, DEFAULT_SETTINGS[key]])),
  referenceDate: '',
  note: ''
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseNumber(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function isRealDate(text) {
  if (!DATE_PATTERN.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(time)) return false;
  // Reject impossible dates such as 2026-02-31, which Date.parse happily rolls over.
  return new Date(time).toISOString().slice(0, 10) === text;
}

// Trim a coordinate to the shared precision without emitting trailing zeros, so
// `269.452100` becomes `269.4521` and links stay short.
function formatNumber(value) {
  return String(Number(value.toFixed(POSITION_DECIMALS)));
}

function normaliseRa(degrees) {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Build a query string (without the leading `?`) for the given view state.
 * Values equal to the defaults are omitted, so the default view produces an
 * empty string and a link that only carries what the sender actually changed.
 */
export function encodeViewState(state = {}) {
  const merged = { ...DEFAULT_VIEW_STATE, ...state };
  const params = new URLSearchParams();
  if (merged.raDeg !== DEFAULT_VIEW_STATE.raDeg) params.set('ra', formatNumber(normaliseRa(merged.raDeg)));
  if (merged.decDeg !== DEFAULT_VIEW_STATE.decDeg) params.set('dec', formatNumber(merged.decDeg));
  if (merged.fovArcmin !== DEFAULT_VIEW_STATE.fovArcmin) params.set('fov', String(merged.fovArcmin));
  if (merged.band !== DEFAULT_VIEW_STATE.band) params.set('band', String(merged.band));
  if (merged.startDate) params.set('from', merged.startDate);
  if (merged.endDate) params.set('to', merged.endDate);
  if (merged.frameDate) params.set('at', merged.frameDate);
  if (Number.isFinite(merged.markRaDeg) && Number.isFinite(merged.markDecDeg)) {
    params.set('mra', formatNumber(normaliseRa(merged.markRaDeg)));
    params.set('mdec', formatNumber(merged.markDecDeg));
  }
  if (merged.targetId) params.set('target', merged.targetId);
  if (merged.embed) params.set('embed', '1');
  if (CULTURE_OPTIONS.includes(merged.culture) && merged.culture !== 'all') params.set('culture',merged.culture);
  if (merged.gaia) params.set('gaia','1');
  for (const [key, param] of VIEW_SETTING_PARAMS) {
    const value = merged[key];
    if (value === DEFAULT_VIEW_STATE[key] || !checkSetting(key, value).ok) continue;
    params.set(param, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  if (merged.referenceFrame === 'pinned' && isRealDate(merged.referenceDate || '')) params.set('refat', merged.referenceDate);
  const note = cleanNote(merged.note);
  if (note) params.set('note', note);
  return params.toString();
}

/**
 * Decode a query string, a full URL or a `?…` fragment into a validated view
 * state. Malformed values fall back to the default for that field and are
 * reported in `issues` so the UI can explain what it ignored.
 */
function toSearchParams(input) {
  const text = String(input ?? '').trim();
  if (!text) return new URLSearchParams();
  // A full URL carries its own query string.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return new URL(text).searchParams;
  // Otherwise accept both "?ra=1&dec=2" and a bare "ra=1&dec=2". A bare string
  // must not be handed to URL() directly: it would be read as a path and the
  // whole query would silently disappear.
  const query = text.startsWith('?') ? text.slice(1) : text;
  return new URLSearchParams(query);
}

export function decodeViewState(input) {
  const issues = [];
  let params;
  try {
    params = toSearchParams(input);
  } catch {
    return { state: { ...DEFAULT_VIEW_STATE }, issues: ['The link could not be read. Showing the default view.'] };
  }
  const state = { ...DEFAULT_VIEW_STATE };

  const ra = params.has('ra') ? parseNumber(params.get('ra')) : null;
  const dec = params.has('dec') ? parseNumber(params.get('dec')) : null;
  if (params.has('ra') || params.has('dec')) {
    // Right ascension is cyclic, so any finite angle wraps into 0-360. Declination
    // is not, so a value outside the poles is a genuine error.
    const raValid = ra !== null;
    const decValid = dec !== null && dec >= -90 && dec <= 90;
    if (raValid && decValid) {
      state.raDeg = normaliseRa(ra);
      state.decDeg = dec;
    } else {
      if (!raValid) issues.push('The right ascension in this link is not valid, so the default target was used.');
      if (!decValid) issues.push('The declination in this link is not valid, so the default target was used.');
    }
  }

  if (params.has('fov')) {
    const fov = parseNumber(params.get('fov'));
    if (FOV_OPTIONS.includes(fov)) state.fovArcmin = fov;
    else issues.push(`This link asked for a ${params.get('fov')}′ field of view, which is not offered. Using ${DEFAULT_VIEW_STATE.fovArcmin}′.`);
  }

  if (params.has('band')) {
    const band = parseNumber(params.get('band'));
    if (BAND_OPTIONS.includes(band)) state.band = band;
    else issues.push(`This link asked for detector ${params.get('band')}, which does not exist. Using D${DEFAULT_VIEW_STATE.band}.`);
  }

  for (const [key, field, label] of [['from', 'startDate', 'from'], ['to', 'endDate', 'through']]) {
    if (!params.has(key)) continue;
    const text = (params.get(key) || '').trim();
    if (isRealDate(text)) state[field] = text;
    else issues.push(`The ${label} date in this link is not a valid calendar date, so it was ignored.`);
  }
  if (state.startDate && state.endDate && state.startDate > state.endDate) {
    issues.push('This link has a from date after its through date, so the date range was cleared.');
    state.startDate = '';
    state.endDate = '';
  }

  if (params.has('at')) {
    const text = (params.get('at') || '').trim();
    if (isRealDate(text)) state.frameDate = text;
    else issues.push('The frame date in this link is not a valid calendar date, so the earliest frame is shown.');
  }

  const markRa = params.has('mra') ? parseNumber(params.get('mra')) : null;
  const markDec = params.has('mdec') ? parseNumber(params.get('mdec')) : null;
  if (params.has('mra') && params.has('mdec') && markRa !== null && markDec !== null && markDec >= -90 && markDec <= 90) {
    state.markRaDeg = normaliseRa(markRa);
    state.markDecDeg = markDec;
  } else if (params.has('mra') || params.has('mdec')) {
    issues.push('The marked source in this link is incomplete or invalid, so no source is marked.');
  }

  if (params.has('target')) {
    const text = (params.get('target') || '').trim();
    if (/^[a-z0-9-]{1,32}$/i.test(text)) state.targetId = text;
  }

  state.embed = params.get('embed') === '1' || params.get('embed') === 'true';
  if(params.has('culture')) {
    if(params.getAll('culture').length===1&&CULTURE_OPTIONS.includes(params.get('culture')))state.culture=params.get('culture');
    else issues.push('The cultural tradition in this link is invalid. Showing all traditions.');
  }
  if(params.has('gaia')) {
    if(params.getAll('gaia').length===1&&['0','1'].includes(params.get('gaia')))state.gaia=params.get('gaia')==='1';
    else issues.push('The Gaia option in this link is invalid. Markers are off.');
  }
  for (const [key, param] of VIEW_SETTING_PARAMS) {
    if (!params.has(param)) continue;
    const raw = params.get(param);
    const value = typeof DEFAULT_SETTINGS[key] === 'boolean' ? (raw === '1' ? true : raw === '0' ? false : raw)
      : typeof DEFAULT_SETTINGS[key] === 'number' ? parseNumber(raw) : raw;
    const checked = checkSetting(key, value);
    // Integers are clamped by the settings rules; only an unusable value is reported.
    if (checked.ok && value !== null) state[key] = checked.value;
    else issues.push(`The ${param} setting in this link is not valid, so the default was used.`);
  }
  if (params.has('refat')) {
    const text = (params.get('refat') || '').trim();
    if (isRealDate(text)) state.referenceDate = text;
    else issues.push('The reference date in this link is not a valid calendar date, so it was ignored.');
  }
  if (params.has('note')) state.note = cleanNote(params.get('note'));
  return { state, issues };
}

/**
 * A stable signature for change detection, so the URL is only rewritten when a
 * shared field actually changes.
 */
export function viewStateSignature(state = {}) {
  const merged = { ...DEFAULT_VIEW_STATE, ...state };
  return [
    merged.raDeg, merged.decDeg, merged.fovArcmin, merged.band,
    merged.startDate, merged.endDate, merged.frameDate,
    merged.markRaDeg ?? '', merged.markDecDeg ?? '', merged.targetId ?? '', merged.embed ? 1 : 0, merged.culture, merged.gaia ? 1 : 0,
    ...VIEW_SETTING_PARAMS.map(([key]) => merged[key]), merged.referenceDate, cleanNote(merged.note)
  ].join('|');
}

/**
 * True when the state carries no shareable difference from the default view.
 * Used to keep the address bar clean until the user actually moves somewhere.
 */
export function isDefaultViewState(state = {}) {
  return encodeViewState(state) === '';
}

/**
 * The view and display settings a link carries, or null when it carries none.
 * When any is present, all of them apply, so the recipient sees exactly the
 * sender's view rather than a mix with their own remembered settings.
 */
export function linkViewSettings(state = {}) {
  const merged = { ...DEFAULT_VIEW_STATE, ...state };
  const carried = VIEW_SETTING_PARAMS.some(([key]) => merged[key] !== DEFAULT_VIEW_STATE[key]);
  return carried ? Object.fromEntries(VIEW_SETTING_PARAMS.map(([key]) => [key, merged[key]])) : null;
}
