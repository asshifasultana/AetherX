import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelpController } from '../workspace-ui.js';

function clock() {
  let time = 0, key = 0; const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++key; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) { time += ms; for (const [id, item] of [...timers]) if (item.at <= time) { timers.delete(id); item.callback(); } }
  };
}

test('checkbox help waits one second; leaving or switching items cancels delayed help', () => {
  const timer = clock(), seen = [];
  const help = createHelpController({ show: item => seen.push(item), hide() {}, schedule: timer.setTimeout, cancel: timer.clearTimeout });
  help.hover('combine'); timer.advance(999); assert.equal(seen.length, 0);
  timer.advance(1); assert.deepEqual(seen, ['combine']);
  help.dismiss(); assert.equal(help.visible, false);
  help.hover('mask'); timer.advance(500); help.dismiss(); timer.advance(500); assert.equal(seen.length, 1);
  help.hover('old'); help.hover('new'); timer.advance(1000); assert.deepEqual(seen, ['combine', 'new']);
});

test('keyboard and help-button focus reveal help immediately and dismiss outstanding hover timers', () => {
  const timer = clock(), seen = []; let hides = 0;
  const help = createHelpController({ show: item => seen.push(item), hide: () => hides++, schedule: timer.setTimeout, cancel: timer.clearTimeout });
  help.hover('old'); help.focus('focused'); assert.equal(help.visible, true); assert.deepEqual(seen, ['focused']);
  timer.advance(1000); assert.deepEqual(seen, ['focused']);
  help.dismiss(); assert.equal(help.visible, false); assert.equal(hides, 1);
});
