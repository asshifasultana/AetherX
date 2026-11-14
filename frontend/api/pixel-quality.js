import { assessPixelQuality, detectSingleExposureGlitches, MASKED_FLAG_BITS, QUALITY_FLAGS, summarizeExposureSamples } from '../lib/pixel-quality.js';

const reply = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
};

export function createPixelQualityHandler() {
  return async function handler(req, res) {
    if (req.method === 'GET') {
      reply(res, 200, { maskedFlagBits: MASKED_FLAG_BITS, flags: QUALITY_FLAGS });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      reply(res, 405, { error: 'Use GET for the quality policy or POST to inspect one FITS pixel.' });
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 32768) { reply(res, 413, { error: 'Pixel inspection request is too large.' }); return; }
      }
      const input = JSON.parse(body || '{}');
      if (typeof input.covered !== 'boolean' || !Number.isInteger(input.flags) || input.flags < 0 || input.flags > 0xffffffff || typeof input.flagsAvailable !== 'boolean' || typeof input.maskEnabled !== 'boolean' || typeof input.detectGlitches !== 'boolean' || (input.value !== null && !Number.isFinite(input.value))) {
        reply(res, 400, { error: 'Pixel inspection requires coverage, 32-bit FITS flags, flag availability, a finite value or null, mask state and transient-check state.' });
        return;
      }
      if (!Array.isArray(input.samples) || input.samples.length > 256 || !Number.isInteger(input.activeSampleIndex) || input.activeSampleIndex < 0 || input.activeSampleIndex >= input.samples.length || input.samples.some(sample =>
        !sample || typeof sample.covered !== 'boolean' || !Number.isInteger(sample.flags) || sample.flags < 0 || sample.flags > 0xffffffff || typeof sample.flagsAvailable !== 'boolean' || (sample.value !== null && !Number.isFinite(sample.value)) || (sample.visitId !== undefined && (typeof sample.visitId !== 'string' || sample.visitId.length > 100)) || (sample.signal !== undefined && sample.signal !== null && !Number.isFinite(sample.signal)) || (sample.noise !== undefined && sample.noise !== null && (!Number.isFinite(sample.noise) || sample.noise < 0)))) {
        reply(res, 400, { error: 'Exposure counts require up to 256 valid pixel samples with coverage and FITS flags.' });
        return;
      }
      const glitchIndices = input.detectGlitches ? detectSingleExposureGlitches(input.samples) : [];
      const quality = assessPixelQuality(input);
      if (glitchIndices.includes(input.activeSampleIndex) && quality.state === 'valid') {
        quality.state = 'suspected_transient';
        quality.label = 'Possible one-exposure transient; excluded from valid contributions';
        quality.excluded = true;
      }
      reply(res, 200, { ...quality, glitchIndices, exposureCounts: summarizeExposureSamples(input.samples, input.maskEnabled, new Set(glitchIndices)) });
    } catch {
      reply(res, 400, { error: 'Could not read the pixel inspection request.' });
    }
  };
}

export default createPixelQualityHandler();
