import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, MYSTERY_SPECTRA, spectrumSamples } from '../lib/mystery-spectra.js';
import { spectralHints } from '../lib/spectral-hints.js';

test('mystery spectra sample SPHEREx channels from 0.75 to 5 microns', () => {
  assert.equal(CHANNELS.length, 102);
  assert.equal(CHANNELS[0], 0.75);
  assert.equal(CHANNELS.at(-1), 5);
});

test('only the cold brown dwarf shows the methane dip', () => {
  const results = Object.fromEntries(MYSTERY_SPECTRA.map(({ id }) => [id, spectralHints(spectrumSamples(id))]));
  assert.equal(results['brown-dwarf'].methaneDip, true);
  assert.equal(results['brown-dwarf'].longWaveRise, true);
  assert.notEqual(results.star.methaneDip, true);
  assert.notEqual(results.galaxy.methaneDip, true);
  assert.match(results.star.hints.join(' '), /fades toward longer/);
});

test('mystery spectra are deterministic', () => {
  assert.deepEqual(spectrumSamples('galaxy'), spectrumSamples('galaxy'));
});
