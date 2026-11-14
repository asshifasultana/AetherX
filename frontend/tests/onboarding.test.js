import test from 'node:test';
import assert from 'node:assert/strict';
import { readTourProgress, saveTourProgress } from '../onboarding.js';

test('onboarding completion persists across page visits', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(readTourProgress(storage), {});
  saveTourProgress(storage, { home: true });
  assert.deepEqual(readTourProgress(storage), { home: true });
  saveTourProgress(storage, { ...readTourProgress(storage), viewer: true });
  assert.deepEqual(readTourProgress(storage), { home: true, viewer: true });
});

test('blocked storage and malformed progress do not prevent browsing', () => {
  assert.deepEqual(readTourProgress({ getItem() { throw new Error('Blocked'); } }), {});
  assert.deepEqual(readTourProgress({ getItem: () => '{broken' }), {});
  assert.doesNotThrow(() => saveTourProgress({ setItem() { throw new Error('Blocked'); } }, { home: true }));
  assert.doesNotThrow(() => saveTourProgress(undefined, { home: true }));
});
