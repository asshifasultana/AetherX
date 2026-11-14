// The difference image the viewer draws and the AI guide's find_changes reads:
// current − reference, large-scale sky removed, robust (MAD) noise, and a mask
// of pixels beyond ±threshold·σ. Pure and DOM-free, so the recovery grid
// (scripts/recovery-grid.mjs) runs exactly the code the viewer runs.

import { gaussianSmooth, subtractLargeScale } from './display-scale.js';
import { estimateBackground } from './background.js';

/**
 * @param {object} input
 * @param {ArrayLike<number>} input.current later frame on the shared grid
 * @param {ArrayLike<number>} input.reference earlier frame on the same grid
 * @param {number} input.width grid width (square grid)
 * @param {number} [input.threshold=5] significance cut in σ
 * @param {boolean} [input.flatten=true] remove local sky offsets (16-px blocks) instead of one constant
 * @param {number} [input.smoothing=0] Gaussian smoothing σ in pixels (0 = none)
 * @returns {null | {values: Float32Array, sigma: number, threshold: number, significant: Uint8Array, brighter: number, fainter: number}}
 *   null when the two frames share no finite pixel.
 */
export function differenceImage({ current, reference, width, threshold = 5, flatten = true, smoothing = 0 }) {
  const raw = new Float32Array(current.length);
  for (let i = 0; i < raw.length; i++) raw[i] = Number.isFinite(current[i]) && Number.isFinite(reference[i]) ? current[i] - reference[i] : NaN;
  if (!raw.some(Number.isFinite)) return null;
  // Remove sky-level offsets and gradients between the two epochs, either
  // locally (default) or as one constant, so only compact changes remain.
  let flattened;
  if (flatten) flattened = subtractLargeScale(raw, width, 16);
  else { const level = estimateBackground(raw).level; flattened = raw.map(value => value - level); }
  const values = smoothing ? gaussianSmooth(flattened, width, smoothing) : flattened;
  // Robust (MAD) noise of the difference image, so a few real changes do not
  // inflate the significance scale.
  const sigma = estimateBackground(values).noise;
  const significant = new Uint8Array(values.length);
  let brighter = 0, fainter = 0;
  if (sigma > 0) for (let i = 0; i < values.length; i++) {
    if (values[i] > threshold * sigma) { significant[i] = 1; brighter++; }
    else if (values[i] < -threshold * sigma) { significant[i] = 2; fainter++; }
  }
  return { values, sigma, threshold, significant, brighter, fainter };
}
