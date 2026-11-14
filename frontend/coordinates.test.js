import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinate, formatSexagesimal } from './coordinates.js';
test('WISE example converts correctly', () => {
  assert.ok(Math.abs(parseCoordinate('08:55:10.831','ra','sexagesimal')-133.7951291667)<1e-8);
  assert.ok(Math.abs(parseCoordinate('−07:14:42.53','dec','sexagesimal')+7.2451472222)<1e-8);
});
test('negative zero degree signs survive conversion', () => {
  assert.equal(parseCoordinate('-00:30:00','dec','sexagesimal'),-.5);
  assert.equal(formatSexagesimal(-.5,'dec'),'-00:30:00.000');
});
test('valid boundaries and invalid inputs', () => {
  assert.equal(parseCoordinate('0','ra'),0);assert.equal(parseCoordinate('-90','dec'),-90);
  assert.equal(parseCoordinate('+90:00:00','dec','sexagesimal'),90);
  for(const v of ['', ' ', 'NaN','Infinity','1abc','0x10','360','-1']) assert.throws(()=>parseCoordinate(v,'ra'));
  for(const v of ['24:00:00','08:60:00','08:00:60','-01:00:00']) assert.throws(()=>parseCoordinate(v,'ra','sexagesimal'));
  assert.throws(()=>parseCoordinate('-90:00:01','dec','sexagesimal'));
});
