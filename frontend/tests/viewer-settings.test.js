import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, LOOK_PRESETS, SETTINGS_SCHEMA, MODE_DESCRIPTIONS, VIEW_MODES, DISPLAY_KEYS, OBSERVATION_KEYS,
  normalizeSettings, applyLook, reconcileLook, resetKeys, loadStoredSettings, storeSettings, STORAGE_KEY
} from '../viewer-settings.js';
import { readFile } from 'node:fs/promises';

const memoryStorage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map }; };

test('defaults are self-consistent and every mode is described', () => {
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS });
  assert.equal(DEFAULT_SETTINGS.look, 'natural');
  for (const mode of VIEW_MODES) assert.ok(MODE_DESCRIPTIONS[mode], mode);
});

test('normalizeSettings clamps, steps and rejects invalid values', () => {
  const result = normalizeSettings({ band: 9, fovArcmin: 0, maxStackFrames: 81, viewMode: 'nonsense', invert: 'yes', smoothing: '2', maskCategories: ['detector', 'bogus'], scaleLow: 'abc', unknown: 1 });
  assert.equal(result.band, 6); assert.equal(result.fovArcmin, 1); assert.equal(result.maxStackFrames, 80);
  assert.equal(result.viewMode, 'time-lapse'); assert.equal(result.invert, false); assert.equal(result.smoothing, 2);
  assert.deepEqual(result.maskCategories, ['detector']); assert.equal(result.scaleLow, null);
  assert.equal('unknown' in result, false);
});

test('look presets apply as a group and a manual tone edit becomes Custom', () => {
  const faint = applyLook(DEFAULT_SETTINGS, 'faint');
  assert.equal(faint.look, 'faint'); assert.equal(faint.scaleMode, LOOK_PRESETS.faint.scaleMode);
  assert.equal(reconcileLook({ ...faint, contrast: 30 }).look, 'custom');
  assert.equal(reconcileLook({ ...faint, contrast: 30, ...LOOK_PRESETS.natural }).look, 'natural');
  assert.equal(normalizeSettings({ look: 'contrast' }).look, 'custom', 'a look label must match its tone settings');
});

test('per-panel resets only touch their own keys', () => {
  const changed = { ...DEFAULT_SETTINGS, colours: 'magma', viewMode: 'difference', exposuresPerDay: 0 };
  const display = resetKeys(changed, DISPLAY_KEYS);
  assert.equal(display.colours, 'grayscale'); assert.equal(display.viewMode, 'difference');
  const observation = resetKeys(changed, OBSERVATION_KEYS);
  assert.equal(observation.viewMode, 'time-lapse'); assert.equal(observation.exposuresPerDay, 6); assert.equal(observation.colours, 'magma');
  for (const key of [...DISPLAY_KEYS, ...OBSERVATION_KEYS]) assert.ok(key in DEFAULT_SETTINGS, key);
});

test('storage round-trips choices but never band, field of view or inspection', () => {
  const storage = memoryStorage();
  assert.equal(storeSettings({ ...DEFAULT_SETTINGS, colours: 'viridis', band: 5, fovArcmin: 3, inspectPixels: true }, storage), true);
  const restored = loadStoredSettings(storage);
  assert.equal(restored.colours, 'viridis');
  for (const key of ['band', 'fovArcmin', 'inspectPixels']) assert.equal(key in restored, false, key);
  storage.setItem(STORAGE_KEY, '{broken');
  assert.deepEqual(loadStoredSettings(storage), {});
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadStoredSettings(throwing), {}); assert.equal(storeSettings(DEFAULT_SETTINGS, throwing), false);
});

test('every schema control exists exactly once in the viewer markup', async () => {
  const html = await readFile(new URL('../viewer.html', import.meta.url), 'utf8');
  for (const control of SETTINGS_SCHEMA) {
    assert.equal(html.split(`id="${control.id}"`).length - 1, 1, control.id);
    assert.ok(control.key in DEFAULT_SETTINGS, control.key);
  }
});

test('a stored Natural look picks up the current preset; other looks keep their tone', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ look: 'natural', stretch: 'asinh', scaleMode: 'p99.5', contrast: 65, brightness: 50, colours: 'magma' }));
  const restored = normalizeSettings(loadStoredSettings(storage));
  assert.equal(restored.look, 'natural'); assert.equal(restored.scaleMode, LOOK_PRESETS.natural.scaleMode);
  assert.equal(restored.contrast, LOOK_PRESETS.natural.contrast); assert.equal(restored.colours, 'magma');
  storage.setItem(STORAGE_KEY, JSON.stringify({ look: 'custom', stretch: 'linear', scaleMode: 'p98', contrast: 70, brightness: 50 }));
  assert.equal(normalizeSettings(loadStoredSettings(storage)).contrast, 70);
  assert.equal(DEFAULT_SETTINGS.pixelView, 'pixelated'); assert.equal(DEFAULT_SETTINGS.fillMaskedCores, true);
});
