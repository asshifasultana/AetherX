// The wavelength SPHEREx saw at one sky position in each exposure, without
// downloading any pixels. Per exposure: the IMAGE header (for its WCS, about
// 35 KB) and the WCS-WAVE table at the end of the file (about 11.5 KB), both as
// S3 range reads. The wavelength at the position comes from the table at the
// pixel the WCS puts it on. Wavelength-ordered frames and line maps sort and
// filter exposures with it.

import { matrixFor, projectSkyToPixel } from './fits-engine.js';
import { createFitsRangeLoader } from './range-fits.js';
import { createWavelengthReader } from './wavelength.js';

const finite = value => Number.isFinite(value) && value > 0;

export function createTargetWavelengths({ readImageHeader = createFitsRangeLoader().imageHeader, wavelengthAt = createWavelengthReader(), concurrency = 8 } = {}) {
  const cache = new Map();

  function one(observation, position, signal) {
    const key = `${observation.accessUrl}|${position.raDeg.toFixed(6)}|${position.decDeg.toFixed(6)}`;
    if (!cache.has(key)) {
      const pending = (async () => {
        const header = await readImageHeader(observation.accessUrl, signal);
        const pixel = projectSkyToPixel({ header, matrix: matrixFor(header) }, position.raDeg, position.decDeg);
        const width = Number(header.NAXIS1), height = Number(header.NAXIS2);
        if (!pixel || pixel[0] < -0.5 || pixel[1] < -0.5 || pixel[0] > width - 0.5 || pixel[1] > height - 0.5) throw new Error('The position is outside this exposure.');
        const um = await wavelengthAt(observation.accessUrl, pixel[0], pixel[1]);
        if (!finite(um)) throw new Error('Wavelength calibration is unavailable here.');
        return um;
      })();
      cache.set(key, pending);
      pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    }
    return cache.get(key);
  }

  /**
   * Map of accessUrl → wavelength (μm) at the position for every observation
   * that could be resolved. `positionFor(observation)` lets a moving target's
   * position follow its proper motion. Failures are counted, not thrown.
   */
  async function lookup(observations, position, { signal = null, onProgress = null, positionFor = () => position } = {}) {
    const list = (observations || []).filter(item => item?.accessUrl);
    const result = new Map();
    let next = 0, done = 0, failed = 0;
    const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (next < list.length) {
        signal?.throwIfAborted();
        const observation = list[next++];
        try { result.set(observation.accessUrl, await one(observation, positionFor(observation), signal)); }
        catch (error) { if (signal?.aborted) throw error; failed++; }
        done++;
        onProgress?.({ done, failed, total: list.length });
      }
    });
    await Promise.all(workers);
    signal?.throwIfAborted();
    return Object.assign(result, { failed });
  }

  return { lookup, one };
}
