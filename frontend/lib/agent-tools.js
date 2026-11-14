// Tool definitions for the SphereX AI guide. Pure: shared by the Groq proxy
// (which sends the schemas to the model) and the browser (which validates the
// model's arguments before touching the viewer), so both always agree.

import { checkSetting, settingRule, VIEW_MODES } from '../viewer-settings.js';

export const PRESET_IDS = ['barnard', 'epsilon', 'wise', 'aurigae', 'draconis'];
export const PLAYBACK_ACTIONS = ['play', 'pause', 'step_forward', 'step_back', 'go_to_frame', 'go_to_date', 'set_speed', 'first_frame', 'last_frame'];
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4];
export const COMPARE_REFERENCES = ['first', 'previous', 'deep-stack', 'frame'];
export const NOTE_MAX = 200;

const values = key => settingRule(key).values;
// Compact schemas: they are resent on every round and Groq's free tier allows
// only a few thousand tokens a minute. Ranges live in descriptions; the
// browser clamps and validates every value anyway.
const str = (enumValues, description) => ({ type: 'string', ...(enumValues ? { enum: enumValues } : {}), ...(description ? { description } : {}) });
const int = description => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = description => ({ type: 'boolean', ...(description ? { description } : {}) });
const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
});

export const AGENT_TOOLS = Object.freeze([
  tool('get_view_state', 'What is on screen now: target, band, mode, display, frame, and latest image measurements.'),
  tool('set_display', 'Change only the given display settings. brightness 0-100 (50 neutral), contrast 10-100. look: natural, faint (faint detail), contrast.', {
    look: str(values('look').filter(look => look !== 'custom')),
    brightness: int(),
    contrast: int(),
    stretch: str(values('stretch')),
    scaleMode: str(values('scaleMode').filter(mode => mode !== 'manual')),
    colours: str(values('colours')),
    invert: bool(),
    smoothing: int('0 off, 1, 2 strong')
  }),
  tool('set_view_mode', 'time-lapse plays dates; blink flips vs a reference (motion); difference subtracts a reference (orange brighter, blue fainter); motion-trail; deep-stack combines days to reveal faint sources (slow).', {
    mode: str(VIEW_MODES),
    referenceFrame: str(values('referenceFrame')),
    blinkIntervalMs: int('200-2000'),
    differenceThreshold: int('sigma 2-20'),
    trailWindow: int('0-20, 0 all'),
    maxStackFrames: int('days 4-400'),
    followProperMotion: bool('false holds sky fixed so a preset star visibly moves')
  }, ['mode']),
  tool('compare_frames', 'Show target frame as difference or blink vs a reference; returns sigma and brighter/fainter pixel counts. Frames 1-based; target defaults to latest.', {
    reference: str(COMPARE_REFERENCES, 'frame = use reference_frame or reference_date'),
    reference_frame: int(),
    reference_date: str(null, 'YYYY-MM-DD'),
    target_frame: int(),
    target_date: str(null, 'YYYY-MM-DD'),
    view: str(['difference', 'blink'])
  }, ['reference']),
  tool('playback', 'Timeline control. Frames 1-based.', {
    action: str(PLAYBACK_ACTIONS),
    frame: int(),
    date: str(null, 'YYYY-MM-DD'),
    speed: { type: 'number', enum: PLAYBACK_SPEEDS }
  }, ['action']),
  tool('set_view', 'Detector band 1-6 (D1 0.75-1.09um ... D6 4.42-5.00um), field of view 1-30 arcmin, overlays.', {
    detector: int(),
    arcmin: int(),
    gaia: bool('Gaia star markers'),
    crosshair: bool(),
    compass: bool(),
    qualityOverlay: bool('pipeline quality flags')
  }),
  tool('go_to_target', 'Go to a preset, a catalog name (e.g. Vega, M31) or raDeg+decDeg, and load observations.', {
    preset: str(PRESET_IDS, "barnard=Barnard's Star, epsilon=Epsilon Indi B, wise=WISE 0855, aurigae=RW Aurigae, draconis=R Draconis"),
    name: str(),
    raDeg: { type: 'number' },
    decDeg: { type: 'number' }
  }),
  tool('make_share_link', 'Link that reopens this exact view, with a one-sentence note for viewers.', {
    note: str()
  }, ['note'])
]);

export const TOOL_NAMES = AGENT_TOOLS.map(entry => entry.function.name);

const DISPLAY_FIELDS = ['look', 'brightness', 'contrast', 'stretch', 'scaleMode', 'colours', 'invert', 'smoothing'];
const MODE_FIELDS = { mode: 'viewMode', referenceFrame: 'referenceFrame', blinkIntervalMs: 'blinkIntervalMs', differenceThreshold: 'differenceThreshold', differenceFlatten: 'differenceFlatten', trailWindow: 'trailWindow', maxStackFrames: 'maxStackFrames', followProperMotion: 'followProperMotion' };
const OVERLAY_FIELDS = { crosshair: 'showCrosshair', compass: 'showCompass', qualityOverlay: 'qualityOverlay' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strip control characters and trim to a safe one-line note. */
export function sanitizeNote(text, max = NOTE_MAX) {
  return [...String(text ?? '')].map(char => { const code = char.codePointAt(0); return code < 32 || code === 127 || code === 0x2028 || code === 0x2029 ? ' ' : char; }).join('').replace(/\s+/g, ' ').trim().slice(0, max);
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function settingsFrom(args, mapping, errors) {
  const changes = {};
  for (const [field, key] of Object.entries(mapping)) {
    if (args[field] === undefined || args[field] === null) continue;
    const checked = checkSetting(key, coerce(args[field]));
    if (checked.ok) changes[key] = checked.value; else errors.push(`${field}: ${checked.error}`);
  }
  return changes;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

function validDate(value) {
  return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) ? value : null;
}

/**
 * Parse and validate a model tool call. Returns { ok: true, name, args } with
 * normalised arguments, or { ok: false, error } explaining what to fix, which
 * is sent back to the model as the tool result.
 */
export function validateToolCall(name, rawArgs) {
  if (!TOOL_NAMES.includes(name)) return { ok: false, error: `Unknown tool ${name}.` };
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {}; } catch { return { ok: false, error: 'Arguments were not valid JSON.' }; }
  }
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'Arguments must be an object.' };
  const errors = [];
  const done = result => errors.length ? { ok: false, error: errors.join(' ') } : { ok: true, name, args: result };
  switch (name) {
    case 'get_view_state': return done({});
    case 'set_display': {
      const changes = settingsFrom(args, Object.fromEntries(DISPLAY_FIELDS.map(field => [field, field])), errors);
      if (changes.look === 'custom') delete changes.look;
      if (!errors.length && !Object.keys(changes).length) errors.push('Pass at least one display setting to change.');
      return done({ changes });
    }
    case 'set_view_mode': {
      if (args.mode === undefined) errors.push('mode is required.');
      return done({ changes: settingsFrom(args, MODE_FIELDS, errors) });
    }
    case 'compare_frames': {
      const reference = COMPARE_REFERENCES.includes(args.reference) ? args.reference : null;
      if (!reference) errors.push(`reference must be one of ${COMPARE_REFERENCES.join(', ')}.`);
      const result = { reference, view: args.view === 'blink' ? 'blink' : 'difference' };
      for (const [field, parse] of [['reference_frame', positiveInt], ['target_frame', positiveInt], ['reference_date', validDate], ['target_date', validDate]]) {
        if (args[field] === undefined || args[field] === null) continue;
        const parsed = parse(args[field]);
        if (parsed === null) errors.push(`${field} is not valid.`); else result[field] = parsed;
      }
      if (reference === 'frame' && !result.reference_frame && !result.reference_date) errors.push('reference "frame" needs reference_frame or reference_date.');
      return done(result);
    }
    case 'playback': {
      if (!PLAYBACK_ACTIONS.includes(args.action)) { errors.push(`action must be one of ${PLAYBACK_ACTIONS.join(', ')}.`); return done({}); }
      const result = { action: args.action };
      if (args.action === 'go_to_frame') { result.frame = positiveInt(args.frame); if (!result.frame) errors.push('go_to_frame needs a 1-based frame.'); }
      if (args.action === 'go_to_date') { result.date = validDate(args.date); if (!result.date) errors.push('go_to_date needs date YYYY-MM-DD.'); }
      if (args.action === 'set_speed') { result.speed = Number(args.speed); if (!PLAYBACK_SPEEDS.includes(result.speed)) errors.push(`speed must be one of ${PLAYBACK_SPEEDS.join(', ')}.`); }
      return done(result);
    }
    case 'set_view': {
      const changes = settingsFrom(args, { detector: 'band', arcmin: 'fovArcmin', ...OVERLAY_FIELDS }, errors);
      const gaia = coerce(args.gaia);
      if (gaia !== undefined && gaia !== null && typeof gaia !== 'boolean') errors.push('gaia must be true or false.');
      if (!errors.length && !Object.keys(changes).length && typeof gaia !== 'boolean') errors.push('Pass at least one setting to change.');
      return done({ changes, ...(typeof gaia === 'boolean' ? { gaia } : {}) });
    }
    case 'go_to_target': {
      if (args.preset !== undefined && args.preset !== null) {
        if (!PRESET_IDS.includes(args.preset)) errors.push(`preset must be one of ${PRESET_IDS.join(', ')}.`);
        return done({ preset: args.preset });
      }
      const ra = Number(args.raDeg), dec = Number(args.decDeg);
      if (args.raDeg !== undefined && args.decDeg !== undefined) {
        if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) errors.push('raDeg/decDeg are out of range.');
        return done({ raDeg: ((ra % 360) + 360) % 360, decDeg: dec, ...(typeof args.name === 'string' ? { name: sanitizeNote(args.name, 80) } : {}) });
      }
      const query = sanitizeNote(args.name, 80);
      if (!query) errors.push('Give a preset, a name, or raDeg and decDeg.');
      return done({ name: query });
    }
    case 'make_share_link': {
      return done({ note: sanitizeNote(args.note) });
    }
    default: return { ok: false, error: `Unhandled tool ${name}.` };
  }
}
