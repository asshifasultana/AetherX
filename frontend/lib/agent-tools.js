// Tool definitions for the SphereX AI guide. Pure: shared by the server proxy
// (which sends the schemas to the model) and the browser (which validates the
// model's arguments before touching the viewer), so both always agree.

import { checkSetting, settingRule, VIEW_MODES } from '../viewer-settings.js';
import { spotRadius, MIN_SPOT_RADIUS_ARCSEC, MAX_SPOT_RADIUS_ARCSEC } from './spots.js';

export const PRESET_IDS = ['barnard', 'epsilon', 'wise', 'aurigae', 'draconis'];
export const PLAYBACK_ACTIONS = ['play', 'pause', 'step_forward', 'step_back', 'go_to_frame', 'go_to_date', 'set_speed', 'first_frame', 'last_frame'];
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4];
export const COMPARE_REFERENCES = ['first', 'previous', 'deep-stack', 'frame'];
export const NOTE_MAX = 200;
export const QUEST_IDS = ['be-barnard', 'be-tombaugh', 'be-leverrier', 'hidden-planet'];
export const TOUR_IDS = ['highlights'];
export const MAX_SPOT = 9;
export const MAX_PANELS = 4;
// Blink animates, so it cannot be photographed as one panel.
export const PANEL_MODES = ['time-lapse', 'difference', 'motion-trail', 'deep-stack'];

const values = key => settingRule(key).values;
// Keep schemas compact because they are resent on every round.
// Ranges live in descriptions; the
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
  }, ['note']),
  // Pictures in the chat. The viewer shows one image at a time, so these are how
  // the visitor sees two or more views together; each picture links to its view.
  tool('take_snapshot', 'Put a picture of exactly what the viewer shows now (image, overlays, numbered spots) into the chat, with a link that reopens this view. Use it to keep a result the visitor should see after the view changes.', {
    caption: str(null, 'short title for the picture')
  }),
  tool('compare_side_by_side', 'Show 2-4 views next to each other in the chat (e.g. two dates, two bands, a frame and its difference). The viewer visits each panel, photographs it, then returns to where it was. Each panel gets a link that opens that view. Omitted fields keep the current setting.', {
    panels: {
      type: 'array', minItems: 2, maxItems: MAX_PANELS,
      items: {
        type: 'object',
        properties: {
          frame: int('1-based frame'),
          date: str(null, 'YYYY-MM-DD, nearest frame'),
          detector: int('band 1-6'),
          mode: str(PANEL_MODES),
          label: str(null, 'short panel title, e.g. "21 Aug 2025"')
        }
      }
    },
    caption: str(null, 'one line saying what to compare')
  }, ['panels']),
  // Investigation tools. A "spot" is a numbered marker (1-9) on the image.
  tool('find_changes', 'List compact brighter/fainter patches in the difference view on screen (use compare_frames view=difference or pick_epochs first). Marks the strongest as agent spots and reports moved pairs.', {
    limit: int('1-6, default 3'), mark: bool('default true')
  }),
  tool('mark_spot', 'Mark a numbered agent spot at raDeg/decDeg: a point, or a circular area when radius_arcsec is given (e.g. a nebula, a galaxy or a region to watch).', {
    raDeg: { type: 'number' }, decDeg: { type: 'number' }, label: str(),
    radius_arcsec: { type: 'number', description: `area radius ${MIN_SPOT_RADIUS_ARCSEC}-${MAX_SPOT_RADIUS_ARCSEC}; omit for a point (1 pixel = 6.15)` }
  }, ['raDeg', 'decDeg']),
  tool('resize_spot', 'Change a spot into an area of radius_arcsec, or back into a point with radius_arcsec 0. Use when the visitor asks to make a spot bigger or smaller.', {
    spot: int(), radius_arcsec: { type: 'number', description: `0 or ${MIN_SPOT_RADIUS_ARCSEC}-${MAX_SPOT_RADIUS_ARCSEC}` }
  }, ['spot', 'radius_arcsec']),
  tool('remove_spots', 'Remove spots from the image: the listed spots, all except keep, or all of them. Use when the visitor asks to clear, delete or keep only some spots.', {
    spots: { type: 'array', items: int(), description: 'spots to remove' }, keep: { type: 'array', items: int(), description: 'remove every other spot' }, all: bool()
  }),
  tool('measure_source', 'Aperture photometry of a spot in up to 12 loaded frames: flux and S/N per date, and whether brightness varies. Rules glitches and variable stars in or out.', {
    spot: int(), max_frames: int('3-12')
  }, ['spot']),
  tool('get_spectrum', 'Measure a spot across wavelengths (up to 24 frames) and return plain hints (methane dip near 3.3um, 4.4-5um rise). Uses SPHEREx colours.', {
    spot: int()
  }, ['spot']),
  tool('crossmatch', 'Check a spot against Gaia stars and JPL known asteroids/comets at a frame date. Updates the case file.', {
    spot: int(), date: str(null, 'YYYY-MM-DD, default frame on screen')
  }, ['spot']),
  tool('get_case', 'A spot case file: suspects ruled out/supported, evidence and the computed verdict. Never call something unexplained unless this verdict says so.', {
    spot: int()
  }, ['spot']),
  tool('pick_epochs', 'Show a difference between two frames about gap_days apart (default 180: the six-month gap where distant bodies shift most for SPHEREx).', {
    gap_days: int('1-400')
  }),
  tool('predict_parallax_pair', 'Where a body at distance_au seen at a spot would appear on another date (parallax only). Marks the predicted position.', {
    spot: int(), distance_au: { type: 'number', description: '30-2000' }, date: str(null, 'YYYY-MM-DD, default reference frame')
  }, ['spot', 'distance_au']),
  tool('precover', 'From the motion between two spots (from_spot then to_spot), predict positions in the other loaded frames and measure there to find the object again.', {
    from_spot: int(), to_spot: int()
  }, ['from_spot', 'to_spot']),
  tool('second_opinion', 'Ask a vision model whether the change at a spot looks real or like an artefact (supporting evidence only).', {
    spot: int()
  }, ['spot']),
  tool('start_quest', 'Start a discovery re-enactment game. Returns the story and goal to tell the visitor.', {
    id: str(QUEST_IDS)
  }, ['id']),
  tool('check_answer', 'Check the visitor spot against the running quest answer.', {
    spot: int()
  }, ['spot']),
  tool('planet_nine_region', 'Most probable sky cells where Planet Nine could still hide (Brown & Batygin 2021, after ZTF/DES/Pan-STARRS). go=true moves to cell number `top`.', {
    top: int('1-10'), go: bool()
  }),
  tool('patrol', 'Search several Planet Nine cells in turn: six-month difference, find changes, crossmatch. Slow.', {
    cells: int('1-12, default 3')
  }),
  tool('start_tour', 'Play the scripted one-minute tour.', {
    id: str(TOUR_IDS)
  }),
  tool('prepare_report', 'Build a report card for a spot (position, checks passed and open, link) the visitor can send to the team.', {
    spot: int()
  }, ['spot'])
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

function spotNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_SPOT ? number : null;
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
    case 'find_changes': {
      const limit = args.limit === undefined || args.limit === null ? 3 : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 6) errors.push('limit must be 1-6.');
      return done({ limit, mark: coerce(args.mark) !== false });
    }
    case 'mark_spot': {
      const ra = Number(args.raDeg), dec = Number(args.decDeg);
      if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) errors.push('raDeg/decDeg are out of range.');
      const radius = args.radius_arcsec === undefined || args.radius_arcsec === null ? null : Number(args.radius_arcsec);
      if (radius !== null && !(radius >= MIN_SPOT_RADIUS_ARCSEC && radius <= MAX_SPOT_RADIUS_ARCSEC)) errors.push(`radius_arcsec must be ${MIN_SPOT_RADIUS_ARCSEC}-${MAX_SPOT_RADIUS_ARCSEC}, or omitted for a point.`);
      return done({ raDeg: ((ra % 360) + 360) % 360, decDeg: dec, label: sanitizeNote(args.label, 40), ...(radius !== null ? { radiusArcsec: spotRadius(radius) } : {}) });
    }
    case 'resize_spot': {
      const spot = spotNumber(args.spot), radius = Number(args.radius_arcsec);
      if (!spot) errors.push(`spot must be 1-${MAX_SPOT}.`);
      if (!(radius === 0 || (radius >= MIN_SPOT_RADIUS_ARCSEC && radius <= MAX_SPOT_RADIUS_ARCSEC))) errors.push(`radius_arcsec must be 0 (point) or ${MIN_SPOT_RADIUS_ARCSEC}-${MAX_SPOT_RADIUS_ARCSEC}.`);
      return done({ spot, radiusArcsec: spotRadius(radius) });
    }
    case 'take_snapshot': {
      return done({ caption: sanitizeNote(args.caption, 80) });
    }
    case 'compare_side_by_side': {
      let panels = args.panels;
      if (typeof panels === 'string') { try { panels = JSON.parse(panels); } catch { panels = null; } }
      if (!Array.isArray(panels)) panels = [];
      if (panels.length < 2 || panels.length > MAX_PANELS) errors.push(`panels must list 2-${MAX_PANELS} views.`);
      const checked = panels.slice(0, MAX_PANELS).map((panel, index) => {
        const entry = {};
        if (!panel || typeof panel !== 'object') { errors.push(`panel ${index + 1} must be an object.`); return entry; }
        if (panel.frame !== undefined && panel.frame !== null) { entry.frame = positiveInt(panel.frame); if (!entry.frame) errors.push(`panel ${index + 1}: frame must be 1 or more.`); }
        if (panel.date !== undefined && panel.date !== null && panel.date !== '') { entry.date = validDate(panel.date); if (!entry.date) errors.push(`panel ${index + 1}: date must be YYYY-MM-DD.`); }
        if (panel.detector !== undefined && panel.detector !== null) { const band = Number(panel.detector); if (Number.isInteger(band) && band >= 1 && band <= 6) entry.detector = band; else errors.push(`panel ${index + 1}: detector must be 1-6.`); }
        if (panel.mode !== undefined && panel.mode !== null) { if (PANEL_MODES.includes(panel.mode)) entry.mode = panel.mode; else errors.push(`panel ${index + 1}: mode must be one of ${PANEL_MODES.join(', ')}.`); }
        const label = sanitizeNote(panel.label, 40);
        if (label) entry.label = label;
        return entry;
      });
      return done({ panels: checked, caption: sanitizeNote(args.caption, 120) });
    }
    case 'remove_spots': {
      const list = value => value === undefined || value === null ? null : (Array.isArray(value) ? value : [value]).map(spotNumber);
      const spots = list(args.spots), keep = list(args.keep), all = coerce(args.all) === true;
      if ([spots, keep, all || null].filter(Boolean).length !== 1) errors.push('Give exactly one of spots, keep or all.');
      if ([...(spots || []), ...(keep || [])].some(n => !n)) errors.push(`spots must be 1-${MAX_SPOT}.`);
      return done(all ? { all: true } : spots ? { spots: [...new Set(spots)] } : { keep: [...new Set(keep || [])] });
    }
    case 'measure_source': case 'get_spectrum': case 'crossmatch': case 'get_case': case 'second_opinion': case 'check_answer': case 'prepare_report': {
      const spot = spotNumber(args.spot);
      if (!spot) errors.push(`spot must be 1-${MAX_SPOT}.`);
      const result = { spot };
      if (name === 'measure_source' && args.max_frames !== undefined && args.max_frames !== null) {
        const max = Number(args.max_frames);
        if (!Number.isInteger(max) || max < 3 || max > 12) errors.push('max_frames must be 3-12.'); else result.max_frames = max;
      }
      if (name === 'crossmatch' && args.date !== undefined && args.date !== null) {
        result.date = validDate(args.date);
        if (!result.date) errors.push('date must be YYYY-MM-DD.');
      }
      return done(result);
    }
    case 'pick_epochs': {
      const gap = args.gap_days === undefined || args.gap_days === null ? 180 : Number(args.gap_days);
      if (!Number.isInteger(gap) || gap < 1 || gap > 400) errors.push('gap_days must be 1-400.');
      return done({ gap_days: gap });
    }
    case 'predict_parallax_pair': {
      const spot = spotNumber(args.spot), distance = Number(args.distance_au);
      if (!spot) errors.push(`spot must be 1-${MAX_SPOT}.`);
      if (!Number.isFinite(distance) || distance < 30 || distance > 2000) errors.push('distance_au must be 30-2000.');
      const result = { spot, distance_au: distance };
      if (args.date !== undefined && args.date !== null) { result.date = validDate(args.date); if (!result.date) errors.push('date must be YYYY-MM-DD.'); }
      return done(result);
    }
    case 'precover': {
      const from = spotNumber(args.from_spot), to = spotNumber(args.to_spot);
      if (!from || !to || from === to) errors.push('from_spot and to_spot must be two different spots 1-9.');
      return done({ from_spot: from, to_spot: to });
    }
    case 'start_quest': {
      if (!QUEST_IDS.includes(args.id)) errors.push(`id must be one of ${QUEST_IDS.join(', ')}.`);
      return done({ id: args.id });
    }
    case 'planet_nine_region': {
      const top = args.top === undefined || args.top === null ? 3 : Number(args.top);
      if (!Number.isInteger(top) || top < 1 || top > 10) errors.push('top must be 1-10.');
      return done({ top, go: coerce(args.go) === true });
    }
    case 'patrol': {
      const cells = args.cells === undefined || args.cells === null ? 3 : Number(args.cells);
      if (!Number.isInteger(cells) || cells < 1 || cells > 12) errors.push('cells must be 1-12.');
      return done({ cells });
    }
    case 'start_tour': {
      const id = args.id ?? 'highlights';
      if (!TOUR_IDS.includes(id)) errors.push(`id must be one of ${TOUR_IDS.join(', ')}.`);
      return done({ id });
    }
    default: return { ok: false, error: `Unhandled tool ${name}.` };
  }
}
