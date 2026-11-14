import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW_STATE, FOV_OPTIONS, decodeViewState, encodeViewState,
  isDefaultViewState, viewStateSignature
} from '../url-state.js';

test('the default view encodes to an empty query string', () => {
  assert.equal(encodeViewState(DEFAULT_VIEW_STATE), '');
  assert.equal(encodeViewState({}), '');
  assert.equal(isDefaultViewState({}), true);
});

test('a position, field of view and band survive a round trip', () => {
  const state = { ...DEFAULT_VIEW_STATE, raDeg: 133.79512916666666, decDeg: -7.245147222222222, fovArcmin: 25, band: 3 };
  const query = encodeViewState(state);
  const { state: decoded, issues } = decodeViewState(query);
  assert.deepEqual(issues, []);
  assert.ok(Math.abs(decoded.raDeg - 133.795129) < 1e-6, `RA ${decoded.raDeg}`);
  assert.ok(Math.abs(decoded.decDeg - -7.245147) < 1e-6, `Dec ${decoded.decDeg}`);
  assert.equal(decoded.fovArcmin, 25);
  assert.equal(decoded.band, 3);
});

test('trailing zeros are trimmed so links stay short', () => {
  const query = encodeViewState({ ...DEFAULT_VIEW_STATE, raDeg: 269.4521, decDeg: 4.6934, band: 4 });
  assert.equal(query, 'band=4');
  assert.equal(decodeViewState(query).state.raDeg, 269.4521);
});

test('default values are omitted individually', () => {
  const query = encodeViewState({ ...DEFAULT_VIEW_STATE, fovArcmin: 5 });
  assert.equal(query, 'fov=5');
  assert.equal(decodeViewState('fov=5').state.raDeg, DEFAULT_VIEW_STATE.raDeg);
});

test('dates, frame date and target are preserved', () => {
  const state = {
    ...DEFAULT_VIEW_STATE, raDeg: 76.9567, decDeg: 30.4043,
    startDate: '2025-06-01', endDate: '2026-01-31', frameDate: '2025-09-14', targetId: 'aurigae'
  };
  const query = encodeViewState(state);
  const { state: decoded, issues } = decodeViewState(query);
  assert.deepEqual(issues, []);
  assert.equal(decoded.startDate, '2025-06-01');
  assert.equal(decoded.endDate, '2026-01-31');
  assert.equal(decoded.frameDate, '2025-09-14');
  assert.equal(decoded.targetId, 'aurigae');
  for (const key of ['from=2025-06-01', 'to=2026-01-31', 'at=2025-09-14', 'target=aurigae']) {
    assert.ok(query.includes(key), `expected ${key} in ${query}`);
  }
});

test('a marked source is preserved as its own coordinate pair', () => {
  const state = { ...DEFAULT_VIEW_STATE, markRaDeg: 133.79512916666666, markDecDeg: -7.245147222222222 };
  const query = encodeViewState(state);
  const { state: decoded, issues } = decodeViewState(query);
  assert.deepEqual(issues, []);
  assert.ok(Math.abs(decoded.markRaDeg - 133.795129) < 1e-6);
  assert.ok(Math.abs(decoded.markDecDeg - -7.245147) < 1e-6);
});

test('an incomplete mark is dropped rather than half-applied', () => {
  const { state, issues } = decodeViewState('mra=133.795129');
  assert.equal(state.markRaDeg, null);
  assert.equal(state.markDecDeg, null);
  assert.equal(issues.length, 1);
});

test('an embed link is flagged but not treated as a different sky position', () => {
  const { state } = decodeViewState('embed=1&band=5');
  assert.equal(state.embed, true);
  assert.equal(state.band, 5);
  assert.equal(decodeViewState('embed=true').state.embed, true);
  assert.equal(decodeViewState('embed=0').state.embed, false);
});

test('out-of-range and non-numeric values fall back with an explanation', () => {
  // A declination past the pole is a real error, and an unusable position is
  // rejected as a pair rather than half-applied.
  const pastPole = decodeViewState('ra=10&dec=101');
  assert.equal(pastPole.state.decDeg, DEFAULT_VIEW_STATE.decDeg);
  assert.equal(pastPole.state.raDeg, DEFAULT_VIEW_STATE.raDeg);
  assert.equal(pastPole.issues.length, 1);

  const garbage = decodeViewState('ra=west&dec=north&band=99&fov=42');
  assert.equal(garbage.state.raDeg, DEFAULT_VIEW_STATE.raDeg);
  assert.equal(garbage.state.decDeg, DEFAULT_VIEW_STATE.decDeg);
  assert.equal(garbage.state.band, DEFAULT_VIEW_STATE.band);
  assert.equal(garbage.state.fovArcmin, DEFAULT_VIEW_STATE.fovArcmin);
  assert.ok(garbage.issues.length >= 2);
});

test('only offered field-of-view and band values are accepted', () => {
  for (const fov of FOV_OPTIONS) assert.equal(decodeViewState(`fov=${fov}`).state.fovArcmin, fov);
  assert.equal(decodeViewState('fov=7').state.fovArcmin, 7);
  assert.equal(decodeViewState('fov=1').state.fovArcmin, 1);
  assert.equal(decodeViewState('fov=30').state.fovArcmin, 30);
  for (const invalid of [0, 31, -1]) assert.equal(decodeViewState('fov=' + invalid).state.fovArcmin, DEFAULT_VIEW_STATE.fovArcmin);
  assert.equal(decodeViewState('fov=16.5').state.fovArcmin, DEFAULT_VIEW_STATE.fovArcmin);
  assert.equal(decodeViewState('band=7').state.band, DEFAULT_VIEW_STATE.band);
  assert.equal(decodeViewState('band=0').state.band, DEFAULT_VIEW_STATE.band);
});

test('impossible calendar dates are rejected', () => {
  const rolled = decodeViewState('from=2026-02-31');
  assert.equal(rolled.state.startDate, '');
  assert.equal(rolled.issues.length, 1);
  assert.equal(decodeViewState('from=2026-02-28').state.startDate, '2026-02-28');
});

test('a reversed date range is cleared rather than inverted', () => {
  const { state, issues } = decodeViewState('from=2026-05-01&to=2025-05-01');
  assert.equal(state.startDate, '');
  assert.equal(state.endDate, '');
  assert.equal(issues.length, 1);
});

test('a full URL or a bare query string decode identically', () => {
  const expected = decodeViewState('ra=10&dec=-20&band=4').state;
  for (const input of [
    '?ra=10&dec=-20&band=4',
    'https://example.org/?ra=10&dec=-20&band=4',
    'http://localhost:5173/atlas?ra=10&dec=-20&band=4'
  ]) {
    assert.deepEqual(decodeViewState(input).state, expected, input);
  }
});

test('right ascension wraps into range instead of failing', () => {
  assert.equal(decodeViewState('ra=370&dec=0').state.raDeg, 10);
  assert.equal(decodeViewState('ra=-10&dec=0').state.raDeg, 350);
});

test('an unknown target id is ignored without breaking the position', () => {
  const { state } = decodeViewState('ra=10&dec=5&target=not%20a%20target');
  assert.equal(state.targetId, null);
  assert.equal(state.raDeg, 10);
});

test('the signature changes only when a shared field changes', () => {
  const base = { ...DEFAULT_VIEW_STATE, raDeg: 10, decDeg: 5 };
  assert.equal(viewStateSignature(base), viewStateSignature({ ...base, contrast: 90, stretch: 'log' }));
  assert.notEqual(viewStateSignature(base), viewStateSignature({ ...base, band: 6 }));
  assert.notEqual(viewStateSignature(base), viewStateSignature({ ...base, markRaDeg: 10, markDecDeg: 5 }));
  assert.notEqual(viewStateSignature(base), viewStateSignature({ ...base, frameDate: '2025-07-01' }));
});
