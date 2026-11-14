import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS, TOOL_NAMES, validateToolCall, sanitizeNote } from '../lib/agent-tools.js';
import { VIEW_MODES } from '../viewer-settings.js';
import { presets } from '../presets.js';

const schema = name => AGENT_TOOLS.find(entry => entry.function.name === name).function.parameters.properties;

test('every tool has a well-formed function schema', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  for (const entry of AGENT_TOOLS) {
    assert.equal(entry.type, 'function');
    assert.match(entry.function.name, /^[a-z_]+$/);
    assert.ok(entry.function.description.length > 10);
    assert.equal(entry.function.parameters.type, 'object');
    for (const key of entry.function.parameters.required) assert.ok(key in entry.function.parameters.properties, `${entry.function.name}.${key}`);
  }
  // Schemas are resent every round, so keep their token cost low.
  assert.ok(JSON.stringify(AGENT_TOOLS).length < 4500);
});

test('enums mirror the viewer settings and presets', () => {
  assert.deepEqual(schema('set_view_mode').mode.enum, VIEW_MODES);
  assert.deepEqual([...schema('go_to_target').preset.enum].sort(), Object.keys(presets).sort());
  assert.ok(!schema('set_display').look.enum.includes('custom'));
});

test('arguments are parsed, validated and mapped to setting keys', () => {
  assert.deepEqual(validateToolCall('set_display', '{"brightness":72,"invert":"true"}'), { ok: true, name: 'set_display', args: { changes: { brightness: 72, invert: true } } });
  assert.deepEqual(validateToolCall('set_display', { brightness: 250 }).args.changes, { brightness: 100 });
  assert.equal(validateToolCall('set_display', {}).ok, false);
  assert.equal(validateToolCall('set_display', { colours: 'rainbow' }).ok, false);
  assert.deepEqual(validateToolCall('set_view_mode', { mode: 'blink', referenceFrame: 'first' }).args.changes, { viewMode: 'blink', referenceFrame: 'first' });
  assert.equal(validateToolCall('set_view_mode', { mode: 'warp' }).ok, false);
  assert.deepEqual(validateToolCall('set_view', { detector: 4 }).args.changes, { band: 4 });
  assert.deepEqual(validateToolCall('set_view', { arcmin: 99 }).args.changes, { fovArcmin: 30 });
  assert.deepEqual(validateToolCall('set_view', { gaia: true, compass: false }).args, { changes: { showCompass: false }, gaia: true });
  assert.equal(validateToolCall('set_view', {}).ok, false);
  assert.equal(validateToolCall('set_view', { detector: 9 }).args.changes.band, 6);
  assert.equal(validateToolCall('nope', {}).ok, false);
  assert.equal(validateToolCall('get_view_state', 'not json').ok, false);
  assert.deepEqual(validateToolCall('get_view_state', '').args, {});
});

test('playback and comparison arguments are checked', () => {
  assert.deepEqual(validateToolCall('playback', { action: 'go_to_frame', frame: 3 }).args, { action: 'go_to_frame', frame: 3 });
  assert.equal(validateToolCall('playback', { action: 'go_to_frame', frame: 0 }).ok, false);
  assert.equal(validateToolCall('playback', { action: 'go_to_date', date: 'March' }).ok, false);
  assert.equal(validateToolCall('playback', { action: 'set_speed', speed: 3 }).ok, false);
  assert.deepEqual(validateToolCall('playback', { action: 'set_speed', speed: 2 }).args, { action: 'set_speed', speed: 2 });
  assert.equal(validateToolCall('playback', { action: 'rewind' }).ok, false);
  assert.deepEqual(validateToolCall('compare_frames', { reference: 'first' }).args, { reference: 'first', view: 'difference' });
  assert.equal(validateToolCall('compare_frames', { reference: 'frame' }).ok, false);
  assert.deepEqual(validateToolCall('compare_frames', { reference: 'frame', reference_frame: 2, target_date: '2026-04-01', view: 'blink' }).args,
    { reference: 'frame', view: 'blink', reference_frame: 2, target_date: '2026-04-01' });
});

test('navigation and share notes are normalised', () => {
  assert.deepEqual(validateToolCall('go_to_target', { preset: 'wise' }).args, { preset: 'wise' });
  assert.equal(validateToolCall('go_to_target', { preset: 'mars' }).ok, false);
  assert.deepEqual(validateToolCall('go_to_target', { raDeg: -10, decDeg: 20 }).args, { raDeg: 350, decDeg: 20 });
  assert.equal(validateToolCall('go_to_target', { raDeg: 10, decDeg: 120 }).ok, false);
  assert.deepEqual(validateToolCall('go_to_target', { name: '  M31 ' }).args, { name: 'M31' });
  assert.equal(validateToolCall('go_to_target', {}).ok, false);
  const controls = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x2028) + 'c   d';
  assert.equal(sanitizeNote(controls), 'a b c d');
  assert.equal(validateToolCall('make_share_link', { note: 'x'.repeat(500) }).args.note.length, 200);
});
