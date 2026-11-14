import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteGroup } from '../lib/route-group.js';

const record = name => async req => ({ name, url: req.url });
const group = createRouteGroup({ agent: record('agent'), cases: record('cases'), 'known-objects': record('known-objects') }, 'agent');

test('route group dispatches a rewritten request and strips the marker', async () => {
  assert.deepEqual(await group({ url: '/api/agent?__route=known-objects&ra=1&dec=2' }), { name: 'known-objects', url: '/api/known-objects?ra=1&dec=2' });
  assert.deepEqual(await group({ url: '/api/agent?__route=cases' }), { name: 'cases', url: '/api/cases' });
});

test('route group falls back to the path, then to the default handler', async () => {
  assert.deepEqual(await group({ url: '/api/cases?id=7' }), { name: 'cases', url: '/api/cases?id=7' });
  assert.deepEqual(await group({ url: '/api/agent' }), { name: 'agent', url: '/api/agent' });
  assert.equal((await group({ url: '/api/agent?__route=__proto__' })).name, 'agent');
});
