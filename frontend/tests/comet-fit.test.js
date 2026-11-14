import test from 'node:test';
import assert from 'node:assert/strict';
import { fitNativeSequence } from '../lib/comet-native-fit.js';
import { responseCurve, makeLineResponse } from '../lib/comet-spectral-fit.js';
import { stackMovingTarget } from '../lib/moving-stack.js';
import { readFits, matrixFor } from '../lib/fits-engine.js';
import { makeFits } from './fixtures/fits-builder.js';

test('native fitting combines signal across exposures while excluding flagged detector pixels', () => {
  const profile = [0, 1, 2, 3, 4];
  const frames = [3, 8].map(background => ({
    image: { values: [background, background + 2, 999, background + 6, background + 8],
      flags: [0, 0, 1 << 19, 0, 0], variance: [1, 1, 1, 1, 1] },
    signal: [profile], nuisance: [[1, 1, 1, 1, 1]]
  }));
  const result = fitNativeSequence(frames);
  assert.ok(Math.abs(result.coefficients[0] - 2) < 1e-10);
  assert.ok(result.covariance[0][0] > 0);
});

test('response-weighted fitting distinguishes a line from its continuum on the same native grid', () => {
  const curve = responseCurve([[4.20, 0], [4.24, 0.7], [4.26, 1], [4.28, 0.7], [4.32, 0]]);
  const response = makeLineResponse([curve]);
  assert.ok(response(4.26, 0.04) > response(4.32, 0.04));
  const profile = [0, 1, 2, 3, 4];
  const frames = [4.23, 4.26, 4.30].map((center, j) => {
    const line = profile.map((value, i) => value * response(center + i * 0.0005, 0.04));
    return { image: { values: profile.map((value, i) => j + 2 * value + 3 * line[i]),
      variance: [1, 1, 1, 1, 1] },
      signal: [profile, line], nuisance: [[1, 1, 1, 1, 1]] };
  });
  const [continuum, line] = fitNativeSequence(frames).coefficients;
  assert.ok(Math.abs(continuum - 2) < 1e-9);
  assert.ok(Math.abs(line - 3) < 1e-9);
});

test('end-to-end injection measures coma leakage into reused reference frames', async () => {
  const bytes = makeFits({ width: 80, height: 80, ra: 100, dec: 0 });
  const raw = readFits(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const image = { ...raw, matrix: matrixFor(raw.header), sourceX: 0, sourceY: 0,
    values: new Float32Array(raw.values.length).fill(10), variance: new Float32Array(raw.values.length).fill(1),
    flags: new Uint32Array(raw.values.length) };
  const ephemeris = [0, 1, 2].map(i => ({ mjd: 60000 + i, ra: 100 + (i - 1) * 8 * 6.15 / 3600, dec: 0 }));
  const exposures = ephemeris.map(({ mjd }) => ({ url: String(mjd), mjd, detector: 1 }));
  const recover = async referenceRadius => {
    let flux;
    await stackMovingTarget({ exposures, ephemeris, referenceRadius, load: async () => image, wavelengthAt: async () => 1,
      injections: [{ amplitude: 1, radius: 16, scale: 6 }],
      onStage(stage, base, frames, injected) {
        if (stage !== 'starSubtractedMedian') return;
        flux = injected.values.reduce((sum, value, i) => {
          const r = Math.hypot(i % 49 - 24, Math.floor(i / 49) - 24);
          return sum + (r >= 9 && r <= 15 ? value - base.values[i] : 0);
        }, 0);
      }
    });
    return flux;
  };
  const [narrow, wide] = await Promise.all([recover(6), recover(18)]);
  assert.ok(wide > narrow + 1, `expected wider reference mask to preserve injected flux (${wide} vs ${narrow})`);
});
