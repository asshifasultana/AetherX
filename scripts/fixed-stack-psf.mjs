import { fitNativeSequence, nuisanceTemplates, psfColumn } from '../frontend/lib/comet-native-fit.js';
import { cropImage, projectSkyToPixel } from '../frontend/lib/fits-engine.js';
import { validDetectorPixel } from './fixed-stack-drizzle.mjs';

export function nativeSource(image, pointing, epsf) {
  const [x, y] = projectSkyToPixel(image, pointing.raDeg, pointing.decDeg) ?? [NaN, NaN];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, column: psfColumn(image, x, y, epsf) };
}

export function nativeMeasurement(image, pointing, epsf, injection) {
  const source = nativeSource(image, pointing, epsf);
  if (!source) return null;
  const { x, y } = source;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const stamp = cropImage(image, {
    x0: Math.max(0, Math.floor(x) - 8), x1: Math.min(image.width - 1, Math.floor(x) + 8),
    y0: Math.max(0, Math.floor(y) - 8), y1: Math.min(image.height - 1, Math.floor(y) + 8),
  });
  const { column } = nativeSource(stamp, pointing, epsf);
  let usablePsf = 0, good = 0;
  for (let i = 0; i < column.length; i++) {
    if (validDetectorPixel(stamp, i) && Number.isFinite(stamp.variance[i]) && stamp.variance[i] > 0) {
      usablePsf += column[i];
      good++;
    }
  }
  if (good < 40 || usablePsf < .05) return null;
  const model = { image: stamp, signal: [column], nuisance: nuisanceTemplates(stamp, pointing, epsf, []) };
  const fit = () => fitNativeSequence([model]).coefficients[0];
  const amplitude = fit();
  if (!injection) return { amplitude, usablePsf };
  stamp.values = stamp.values.map((value, i) => value + injection * column[i]);
  return { amplitude, recovery: (fit() - amplitude) / injection, usablePsf };
}
