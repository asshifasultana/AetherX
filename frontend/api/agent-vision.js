// Vision second opinion for the AI guide: shows a vision-capable model three
// small stamps around one change (new frame, reference frame, difference) and
// asks whether it looks like a real source or an artefact. The idea follows
// Stoppa et al. (2025), who classified transient cutouts with a multimodal
// model from a few examples. Asked twice; disagreement is reported as unsure.
// Off unless OPENROUTER_VISION_MODEL is set.

import { parseApiKeys } from './agent.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_BODY_BYTES = 200 * 1024;
const MAX_STAMP_CHARS = 60_000;
const LABELS = ['real', 'artifact', 'unsure'];
const RATE_LIMIT = 10;
const hits = new Map();
let cursor = 0;

const PROMPT = `You review small cutouts from NASA SPHEREx infrared images (6.15 arcsec pixels, so stars are only 1-2 pixels wide).
Image 1 is the new frame, image 2 the reference frame from another date, image 3 their difference (orange = brighter now, blue = fainter now, grey = no change). The change is at the centre.
Decide whether the centre change looks like a real astronomical source that appeared, vanished or moved ("real"), or an artefact ("artifact": single hot pixel, cosmic ray, edge, a ring or dipole residual around a bright star caused by the wavelength shift between visits, smooth background). If you cannot tell, say "unsure".
Return JSON only: {"label": "real"|"artifact"|"unsure", "reason": "<= 20 words, plain English", "interest": 0-1}.`;

function rateLimited(key, now = Date.now()) {
  const recent = (hits.get(key) || []).filter(time => now - time < 60_000);
  recent.push(now); hits.set(key, recent);
  if (hits.size > 2000) hits.clear();
  return recent.length > RATE_LIMIT;
}

export function parseVerdict(text) {
  const raw = typeof text === 'string' ? text : '';
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    const label = LABELS.includes(value.label) ? value.label : null;
    if (!label) return null;
    const interest = Math.max(0, Math.min(1, Number(value.interest) || 0));
    return { label, reason: String(value.reason || '').replace(/\s+/g, ' ').slice(0, 160), interest: Number(interest.toFixed(2)) };
  } catch { return null; }
}

const validStamp = value => typeof value === 'string' && value.startsWith('data:image/png;base64,') && value.length <= MAX_STAMP_CHARS;

export function createVisionHandler({ fetchImpl = (...args) => fetch(...args), env = process.env } = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status, error, code) => { res.statusCode = status; res.end(JSON.stringify({ error, code })); };
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(405, 'Use POST.', 'METHOD_NOT_ALLOWED'); return; }
    const keys = parseApiKeys(env), model = env.OPENROUTER_VISION_MODEL;
    if (!keys.length || !model) { fail(404, 'The vision second opinion is not enabled on this server.', 'VISION_DISABLED'); return; }
    const client = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'local';
    if (rateLimited(client)) { fail(429, 'Too many second opinions in a minute.', 'RATE_LIMITED'); return; }
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new Error('large'); chunks.push(chunk); }
      body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch { fail(400, 'Send the three image stamps as JSON.', 'BAD_REQUEST'); return; }
    const stamps = body?.stamps || {};
    const images = [stamps.current, stamps.reference, stamps.difference];
    if (!validStamp(stamps.difference) || !images.every(image => image === null || image === undefined || validStamp(image))) { fail(400, 'Stamps must be small PNG data URLs.', 'BAD_REQUEST'); return; }
    const content = [{ type: 'text', text: PROMPT }, ...images.filter(Boolean).map(url => ({ type: 'image_url', image_url: { url } }))];
    const ask = async () => {
      const key = keys[cursor++ % keys.length];
      const response = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.4, max_tokens: 200 }),
        signal: AbortSignal.timeout(20_000)
      });
      const data = await response.json().catch(() => null);
      return response.ok ? parseVerdict(data?.choices?.[0]?.message?.content) : null;
    };
    try {
      const answers = (await Promise.all([ask(), ask()])).filter(Boolean);
      if (!answers.length) { fail(502, 'The vision model did not give a usable answer.', 'VISION_UPSTREAM'); return; }
      const agreed = answers.length === 2 && answers[0].label === answers[1].label;
      const label = answers.length === 2 && !agreed ? 'unsure' : answers[0].label;
      res.end(JSON.stringify({ label, reason: answers[0].reason, interest: answers[0].interest, agreed, answers: answers.length, model }));
    } catch (error) {
      fail(error?.name === 'TimeoutError' ? 504 : 502, 'The vision model did not answer in time.', 'VISION_UPSTREAM');
    }
  };
}

export default createVisionHandler();
