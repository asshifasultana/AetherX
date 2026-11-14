// The compressed rows are from a real SPHEREx FLAGS tile; expected native
// int32 values were exported with Astropy and serve as the independent oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeRice32 } from '../lib/rice.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/spherex-rice-astropy.json', import.meta.url), 'utf8'));

for (const row of fixture.rows) {
  test(`RICE_1 decodes SPHEREx FLAGS row ${row.row} bit-for-bit against Astropy`, () => {
    const compressed = new Uint8Array(Buffer.from(row.compressed, 'base64'));
    const expected = new Int32Array(new Uint8Array(Buffer.from(row.expected, 'base64')).buffer);
    const actual = decodeRice32(compressed, new Int32Array(fixture.width), fixture.blocksize);
    assert.deepEqual(actual, expected);
  });
}

test('RICE_1 rejects a truncated compressed tile', () => {
  assert.throws(() => decodeRice32(Uint8Array.of(0, 0, 0, 0, 0), new Int32Array(100)), /Truncated/);
});
