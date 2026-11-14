import { readFile, writeFile } from 'node:fs/promises';
import { PIXEL_ARCSEC } from '../frontend/lib/fits-engine.js';
import { stackMovingTarget } from '../frontend/lib/moving-stack.js';
import { crossSubtract, kernelAt } from './benchmark-psf-model.mjs';
import { size, diffuse, measure, recovery } from './benchmark-aperture.mjs';

const [filename, mode] = process.argv.slice(2);
if (!filename || (mode && mode !== '--check')) {
  throw new Error('Usage: node scripts/export-comet-benchmark.mjs benchmark-manifest.json [--check]');
}
const input = JSON.parse(await readFile(filename, 'utf8'));
const { cases, ephemeris } = input.manifest ?? input;
const entry = cases.find(({ name }) => name === 'August 2025 D1 continuum');
if (entry?.exposures.length !== 6) throw new Error('Expected the original six August D1 exposures.');

let outerRecovery;
const result = await stackMovingTarget({
  exposures: entry.exposures, ephemeris, kernelAt, subtract: crossSubtract, size, injections: [diffuse],
  onStage(stage, output, frames, injected) {
    if (stage === 'starSubtractedWeighted') outerRecovery = recovery(output.values, injected.values, diffuse, 9, 15);
  }
});
if (result.failures.length || result.frames.length !== 6) throw new Error(JSON.stringify(result.failures));
const stages = [result.tracked, result.weighted].map(({ values, counts }) => ({
  values: Array.from(values), counts: Array.from(counts), ...measure(values, 1)
}));
if (stages[0].apertureContrast.toFixed(2) !== '12.48' || stages[1].apertureContrast.toFixed(2) !== '41.63') {
  throw new Error(`The benchmark did not reproduce 12.48 and 41.63: ${stages.map(s => s.apertureContrast)}`);
}
const product = {
  size, pixelArcsec: PIXEL_ARCSEC, apertureRadiusPixels: 1,
  wavelengthRange: [Math.min(...result.frames.map(frame => frame.wavelength)),
    Math.max(...result.frames.map(frame => frame.wavelength))],
  outerRecovery,
  stages,
  exposures: result.frames.map(({ url, observedStartUtc, wavelength, cleaned }) => ({
    url, observedStartUtc, wavelength, centralReferenceCount: cleaned.referenceCounts?.[(size ** 2 - 1) / 2] ?? 0
  }))
};
const destination = new URL('../frontend/comet-benchmark.json', import.meta.url);
if (mode !== '--check') await writeFile(destination, JSON.stringify(product) + '\n');
console.log(JSON.stringify({ stages: stages.map(({ apertureContrast }) => apertureContrast), outerRecovery }));
