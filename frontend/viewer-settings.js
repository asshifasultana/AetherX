// Viewer settings model. Pure: no DOM access, so defaults, validation, look
// presets and storage rules can be unit tested in Node. app.js binds the
// controls generically from SETTINGS_SCHEMA.

export const VIEW_MODES = ['time-lapse', 'blink', 'difference', 'motion-trail', 'deep-stack'];
export const MODE_DESCRIPTIONS = Object.freeze({
  'time-lapse': 'Plays every observation in date order. Good for watching slow changes.',
  blink: 'Flips between this frame and a reference frame. Anything that moves or changes brightness jumps out.',
  difference: 'Subtracts a reference frame. Unchanged sky goes dark; brightening glows orange, fading glows blue, in units of the noise (σ). SPHEREx sees each spot at a slightly different wavelength per visit, so some star residuals are normal.',
  'motion-trail': 'Keeps the brightest value of each pixel across nearby frames, so moving objects leave a streak.',
  'deep-stack': 'Per-pixel combination of many observing days. Masked, missing and uncovered pixels do not count as zeros, revealing faint sources.'
});

export const MASK_CATEGORIES = Object.freeze([
  { id: 'transient', label: 'Cosmic rays & outliers' },
  { id: 'detector', label: 'Detector defects' },
  { id: 'correction', label: 'Persistence & corrections' },
  { id: 'artifact', label: 'Ghosts, halos & crosstalk' },
  { id: 'caution', label: 'Saturation & streaks' }
]);
const DEFAULT_MASK = ['transient', 'detector', 'correction', 'artifact'];

export const LOOK_PRESETS = Object.freeze({
  natural: Object.freeze({ stretch: 'asinh', scaleMode: 'p99.5', contrast: 65, brightness: 50 }),
  // ZScale + linear is the DS9/IRAF way to see sources near the noise floor.
  faint: Object.freeze({ stretch: 'linear', scaleMode: 'zscale', contrast: 55, brightness: 50 }),
  contrast: Object.freeze({ stretch: 'linear', scaleMode: 'p98', contrast: 85, brightness: 50 })
});
const LOOK_KEYS = ['stretch', 'scaleMode', 'contrast', 'brightness'];

export const DEFAULT_SETTINGS = Object.freeze({
  band: 2,
  viewMode: 'time-lapse',
  fovArcmin: 16,
  // Mode-specific
  maxStackFrames: 80,
  referenceFrame: 'previous',
  blinkIntervalMs: 600,
  differenceThreshold: 5,
  differenceFlatten: true,
  trailWindow: 3,
  // Processing
  combineExposures: true,
  hideBadPixels: true,
  rejectVisitGlitches: true,
  exposuresPerDay: 6,
  maskCategories: DEFAULT_MASK,
  resampling: 'bilinear',
  subtractBackground: true,
  stackStatistic: 'median',
  // Display
  look: 'natural',
  stretch: 'asinh',
  scaleMode: 'p99.5',
  scaleLow: null,
  scaleHigh: null,
  contrast: 65,
  brightness: 50,
  colours: 'grayscale',
  invert: false,
  consistentBrightness: true,
  smoothing: 0,
  // Overlays
  showCrosshair: false,
  showCompass: true,
  qualityOverlay: false,
  inspectPixels: false
});

const enumOf = (...values) => ({ kind: 'enum', values });
const intRange = (min, max, step = 1) => ({ kind: 'int', min, max, step });
const RULES = {
  band: intRange(1, 6),
  viewMode: enumOf(...VIEW_MODES),
  fovArcmin: intRange(1, 30),
  maxStackFrames: intRange(4, 400, 4),
  referenceFrame: enumOf('previous', 'first', 'pinned', 'deep-stack'),
  blinkIntervalMs: intRange(200, 2000, 50),
  differenceThreshold: intRange(2, 20),
  differenceFlatten: { kind: 'bool' },
  trailWindow: intRange(0, 20),
  combineExposures: { kind: 'bool' },
  hideBadPixels: { kind: 'bool' },
  rejectVisitGlitches: { kind: 'bool' },
  exposuresPerDay: intRange(0, 64),
  maskCategories: { kind: 'set', values: MASK_CATEGORIES.map(category => category.id) },
  resampling: enumOf('bilinear', 'lanczos3'),
  subtractBackground: { kind: 'bool' },
  stackStatistic: enumOf('median', 'clipped-mean'),
  look: enumOf('natural', 'faint', 'contrast', 'custom'),
  stretch: enumOf('asinh', 'linear', 'sqrt', 'log', 'histeq'),
  scaleMode: enumOf('p99.5', 'p98', 'zscale', 'minmax', 'manual'),
  scaleLow: { kind: 'nullable-number' },
  scaleHigh: { kind: 'nullable-number' },
  contrast: intRange(10, 100),
  brightness: intRange(0, 100),
  colours: enumOf('grayscale', 'inferno', 'magma', 'viridis', 'cividis'),
  invert: { kind: 'bool' },
  consistentBrightness: { kind: 'bool' },
  smoothing: enumOf(0, 1, 2),
  showCrosshair: { kind: 'bool' },
  showCompass: { kind: 'bool' },
  qualityOverlay: { kind: 'bool' },
  inspectPixels: { kind: 'bool' }
};

function normalizeValue(rule, value, fallback) {
  switch (rule.kind) {
    case 'bool': return typeof value === 'boolean' ? value : fallback;
    case 'enum': {
      const match = rule.values.find(option => String(option) === String(value));
      return match === undefined ? fallback : match;
    }
    case 'int': {
      const number = Number(value);
      if (value === null || value === '' || !Number.isFinite(number)) return fallback;
      const stepped = Math.round((number - rule.min) / rule.step) * rule.step + rule.min;
      return Math.max(rule.min, Math.min(rule.max, stepped));
    }
    case 'set': {
      if (!Array.isArray(value)) return fallback;
      return rule.values.filter(option => value.includes(option));
    }
    case 'nullable-number': {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    default: return fallback;
  }
}

/** Validate every known key; unknown keys are dropped, bad values fall back. */
export function normalizeSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const result = {};
  for (const [key, rule] of Object.entries(RULES)) {
    const fallback = base[key] ?? DEFAULT_SETTINGS[key];
    result[key] = raw && Object.hasOwn(raw, key) ? normalizeValue(rule, raw[key], fallback) : fallback;
  }
  if (result.look !== 'custom' && !matchesLook(result, result.look)) result.look = 'custom';
  return result;
}

export function matchesLook(settings, look) {
  const preset = LOOK_PRESETS[look];
  return Boolean(preset) && LOOK_KEYS.every(key => settings[key] === preset[key]);
}

/** Apply a look preset; 'custom' keeps the current tone settings. */
export function applyLook(settings, look) {
  if (!LOOK_PRESETS[look]) return { ...settings, look: 'custom' };
  return { ...settings, ...LOOK_PRESETS[look], look };
}

/** After a manual tone edit, keep the look label honest. */
export function reconcileLook(settings) {
  const named = Object.keys(LOOK_PRESETS).find(look => matchesLook(settings, look));
  return { ...settings, look: named || 'custom' };
}

// Settings that belong to each panel's reset button.
export const DISPLAY_KEYS = ['look', 'stretch', 'scaleMode', 'scaleLow', 'scaleHigh', 'contrast', 'brightness', 'colours', 'invert', 'consistentBrightness', 'smoothing', 'showCrosshair', 'showCompass', 'qualityOverlay', 'inspectPixels'];
export const OBSERVATION_KEYS = ['viewMode', 'fovArcmin', 'maxStackFrames', 'referenceFrame', 'blinkIntervalMs', 'differenceThreshold', 'differenceFlatten', 'trailWindow', 'combineExposures', 'hideBadPixels', 'rejectVisitGlitches', 'exposuresPerDay', 'maskCategories', 'resampling', 'subtractBackground', 'stackStatistic'];

export function resetKeys(settings, keys) {
  const next = { ...settings };
  for (const key of keys) next[key] = DEFAULT_SETTINGS[key];
  return next;
}

// Band and field of view come from the page URL, so a shared link always wins;
// pixel inspection is a transient tool and is never restored.
const NOT_STORED = new Set(['band', 'fovArcmin', 'inspectPixels']);
export const STORAGE_KEY = 'spherex-viewer-settings-v1';

export function loadStoredSettings(storage = globalThis.localStorage) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return {};
    const kept = {};
    for (const key of Object.keys(RULES)) if (!NOT_STORED.has(key) && Object.hasOwn(parsed, key)) kept[key] = parsed[key];
    return kept;
  } catch { return {}; }
}

export function storeSettings(settings, storage = globalThis.localStorage) {
  try {
    const kept = {};
    for (const key of Object.keys(RULES)) if (!NOT_STORED.has(key)) kept[key] = settings[key];
    storage?.setItem(STORAGE_KEY, JSON.stringify(kept));
    return true;
  } catch { return false; }
}

// One entry per bound control. `type` drives how app.js reads and writes it.
export const SETTINGS_SCHEMA = Object.freeze([
  { id: 'detector-array', key: 'band', type: 'select', number: true },
  { id: 'view-mode', key: 'viewMode', type: 'select' },
  { id: 'field-of-view', key: 'fovArcmin', type: 'range', commit: 'change', format: value => `${value}′`, valuetext: value => `${value} arcminutes` },
  { id: 'max-stack-frames', key: 'maxStackFrames', type: 'range', commit: 'change', format: value => `${value} frames` },
  { id: 'reference-frame', key: 'referenceFrame', type: 'select' },
  { id: 'blink-interval', key: 'blinkIntervalMs', type: 'range', format: value => `${(value / 1000).toFixed(2)} s` },
  { id: 'difference-threshold', key: 'differenceThreshold', type: 'range', format: value => `${value}σ` },
  { id: 'difference-flatten', key: 'differenceFlatten', type: 'checkbox' },
  { id: 'trail-window', key: 'trailWindow', type: 'range', commit: 'change', format: value => value ? `±${value} frames` : 'All frames' },
  { id: 'combine-exposures', key: 'combineExposures', type: 'checkbox' },
  { id: 'hide-bad-pixels', key: 'hideBadPixels', type: 'checkbox' },
  { id: 'reject-visit-glitches', key: 'rejectVisitGlitches', type: 'checkbox' },
  { id: 'exposures-per-day', key: 'exposuresPerDay', type: 'range', commit: 'change', format: value => value ? `${value}` : 'All' },
  { id: 'mask-categories', key: 'maskCategories', type: 'multi' },
  { id: 'resampling', key: 'resampling', type: 'select' },
  { id: 'subtract-background', key: 'subtractBackground', type: 'checkbox' },
  { id: 'stack-statistic', key: 'stackStatistic', type: 'select' },
  { id: 'stretch', key: 'stretch', type: 'select', tone: true },
  { id: 'scale-mode', key: 'scaleMode', type: 'select', tone: true },
  { id: 'scale-low', key: 'scaleLow', type: 'number' },
  { id: 'scale-high', key: 'scaleHigh', type: 'number' },
  { id: 'contrast', key: 'contrast', type: 'range', tone: true, format: value => `${value}%` },
  { id: 'brightness', key: 'brightness', type: 'range', tone: true, format: value => `${value - 50 > 0 ? '+' : ''}${value - 50}` },
  { id: 'colours', key: 'colours', type: 'select' },
  { id: 'invert', key: 'invert', type: 'checkbox' },
  { id: 'consistent-brightness', key: 'consistentBrightness', type: 'checkbox' },
  { id: 'smoothing', key: 'smoothing', type: 'select', number: true },
  { id: 'show-crosshair', key: 'showCrosshair', type: 'checkbox' },
  { id: 'show-compass', key: 'showCompass', type: 'checkbox' },
  { id: 'quality-overlay', key: 'qualityOverlay', type: 'checkbox' },
  { id: 'inspect-pixels', key: 'inspectPixels', type: 'checkbox' }
]);
