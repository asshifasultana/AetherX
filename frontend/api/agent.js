// SphereX AI guide: a thin, stateless proxy to OpenRouter's chat
// completions API. The browser runs the agent loop and executes tool calls on
// the real viewer; this function only owns the key, the system prompt and the
// tool schemas, so the endpoint cannot be used as a general-purpose LLM relay.

import { AGENT_TOOLS, TOOL_NAMES } from '../lib/agent-tools.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const MAX_BODY_BYTES = 48 * 1024;
const MAX_MESSAGES = 40;
const MAX_TOOL_CALLS = 4;
const MAX_USER_CHARS = 2000;
const MAX_TOOL_CHARS = 6000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

export const SYSTEM_PROMPT = `You are the SphereX sky guide inside a web viewer of real NASA SPHEREx infrared images. Visitors are curious members of the public, not astronomers.
You control the viewer with tools: change brightness and contrast, blink frames, compare frames (difference), play or step the time-lapse, build deep stacks, switch detector band, change field of view, toggle overlays, move to a new target, and make share links.
Rules:
- Act, don't just explain: when the visitor asks to see something, call the tools that show it, then say in 1-3 short friendly sentences what is on screen and what to look for.
- Ground every statement about the image in tool results (get_view_state, compare_frames, deep-stack records). Never claim to see an object, motion or change that no tool result reports. If a tool says something is still loading, say so.
- Frames are numbered from 1. Dates are UTC.
- In difference views orange means brighter and blue means fainter. SPHEREx observes each spot at a slightly different wavelength on each visit, so some residuals around stars are normal and not real changes.
- When followProperMotion is true, a preset star is kept centred in every frame, so its own motion does not appear in blink or difference views. To show it moving, set followProperMotion to false first. Do not attribute an orange/blue pair to the target's motion unless followProperMotion is false.
- A deep stack can take a while to build; tell the visitor it is building.
- Use plain words; explain jargon (sigma = how many times above the noise) briefly the first time.
- When the visitor wants to share, or after building a notable view if they ask for a link, call make_share_link with one helpful sentence as the note, then give them the link.
- Stay on the topic of the sky, SPHEREx and this viewer. Politely decline unrelated requests.`;

const hits = new Map();
function rateLimited(key, now = Date.now()) {
  if (hits.size > 5000) for (const [entry, list] of hits) if (!list.length || now - list.at(-1) > RATE_WINDOW_MS) hits.delete(entry);
  const recent = (hits.get(key) || []).filter(time => now - time < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > RATE_LIMIT;
}

class AgentError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

/** Seconds OpenRouter asks us to wait via Retry-After. */
export function retryAfterSeconds(headers) {
  const direct = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(direct) && direct > 0) return direct;
  return null;
}

const DEFAULT_RATE_COOLDOWN_MS = 20_000;
const KEY_FAULT_COOLDOWN_MS = 60 * 60_000;
const MAX_INLINE_WAIT_S = 6;

/** Keys from OPENROUTER_API_KEYS (comma, semicolon or whitespace separated) plus OPENROUTER_API_KEY. */
export function parseApiKeys(env = {}) {
  const raw = [env.OPENROUTER_API_KEYS, env.OPENROUTER_API_KEY].filter(Boolean).join(',');
  return [...new Set(raw.split(/[\s,;]+/).map(key => key.trim()).filter(Boolean))];
}

const nextUtcMidnight = at => { const date = new Date(at); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1); };

/** When a rate-limited key may be used again, from OpenRouter's X-RateLimit-Reset (epoch ms or s). */
export function rateLimitResetAt(headers, data) {
  const value = Number(headers?.get?.('x-ratelimit-reset') ?? data?.error?.metadata?.headers?.['X-RateLimit-Reset']);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * Round-robin pool of OpenRouter keys. Each request starts at the next key in
 * turn; a key that hits its per-minute or per-day limit (or is rejected) is
 * benched until it should work again, and the request moves on to the next key.
 * State lives in memory, so it survives warm serverless invocations only.
 */
export class KeyPool {
  constructor(keys) {
    this.entries = keys.map(key => ({ key, until: 0, status: null }));
    this.cursor = 0;
  }
  get size() { return this.entries.length; }
  /** Usable keys at time `at`, in round-robin order; advances the cursor. */
  take(at) {
    const n = this.entries.length;
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % n;
    const ordered = [];
    for (let i = 0; i < n; i++) ordered.push(this.entries[(start + i) % n]);
    return ordered.filter(entry => entry.until <= at);
  }
  bench(entry, until, status) { entry.until = Math.max(entry.until, until); entry.status = status; }
  /** Benched entries, soonest first. */
  benched(at) { return this.entries.filter(entry => entry.until > at).sort((a, b) => a.until - b.until); }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Some reasoning models put their thinking inline; visitors should not see it.
const stripThinking = text => typeof text === 'string' ? text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim() || null : null;

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new AgentError(413, 'TOO_LARGE', 'The conversation is too long. Start a new chat.');
    return JSON.parse(text);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AgentError(413, 'TOO_LARGE', 'The conversation is too long. Start a new chat.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

/** Keep only well-formed user / assistant / tool turns; drop anything else. */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new AgentError(400, 'BAD_REQUEST', 'Send at least one message.');
  const kept = [];
  for (const message of messages.slice(-MAX_MESSAGES)) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      const content = text(message.content, MAX_USER_CHARS).trim();
      if (content) kept.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls
        .filter(call => call && typeof call.id === 'string' && TOOL_NAMES.includes(call.function?.name))
        .slice(0, MAX_TOOL_CALLS)
        .map(call => ({ id: call.id.slice(0, 64), type: 'function', function: { name: call.function.name, arguments: text(call.function.arguments, 2000) || '{}' } })) : [];
      const content = text(message.content, MAX_TOOL_CHARS);
      if (calls.length) kept.push({ role: 'assistant', content: content || null, tool_calls: calls });
      else if (content) kept.push({ role: 'assistant', content });
    } else if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string') continue;
      kept.push({ role: 'tool', tool_call_id: message.tool_call_id.slice(0, 64), content: text(message.content, MAX_TOOL_CHARS) || '{}' });
    }
  }
  // A tool result must follow the assistant turn that asked for it; trimming the
  // history can orphan some, which the API rejects.
  const asked = new Set();
  const ordered = kept.filter(message => {
    if (message.role === 'assistant') for (const call of message.tool_calls || []) asked.add(call.id);
    return message.role !== 'tool' || asked.has(message.tool_call_id);
  });
  while (ordered.length && ordered[0].role !== 'user') ordered.shift();
  if (!ordered.length) throw new AgentError(400, 'BAD_REQUEST', 'Send at least one message.');
  return ordered;
}

function openRouterError(status, retryAfter = null) {
  if (status === 401 || status === 403) return new AgentError(502, 'AGENT_AUTH', 'The guide is not configured correctly (API key rejected).');
  if (status === 402) return new AgentError(502, 'AGENT_CREDITS', 'The guide has run out of OpenRouter credits.');
  if (status === 429) return new AgentError(429, 'AGENT_BUSY', 'The guide is temporarily rate limited. Please wait a few seconds and try again.', { retryAfter: Math.ceil(retryAfter ?? 10) });
  if (status === 413) return new AgentError(413, 'TOO_LARGE', 'The conversation is too long. Start a new chat.');
  return new AgentError(502, 'AGENT_UPSTREAM', 'The guide could not get an answer from OpenRouter. Please retry.');
}

export function createAgentHandler({ fetchImpl = (...args) => fetch(...args), env = process.env, now = () => Date.now(), pause = sleep } = {}) {
  let pool = null;
  let poolSignature = '';
  const getPool = () => {
    const keys = parseApiKeys(env);
    const signature = keys.join('\n');
    if (!pool || signature !== poolSignature) { pool = new KeyPool(keys); poolSignature = signature; }
    return pool;
  };
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const fail = error => {
      res.statusCode = error instanceof AgentError ? error.status : 500;
      res.end(JSON.stringify({ error: error instanceof AgentError ? error.message : 'The guide failed unexpectedly. Please retry.', code: error instanceof AgentError ? error.code : 'INTERNAL_ERROR', ...(error instanceof AgentError ? error.extra : {}) }));
    };
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(new AgentError(405, 'METHOD_NOT_ALLOWED', 'Use POST to talk to the guide.')); return; }
    const keys = getPool();
    if (!keys.size) { fail(new AgentError(503, 'AGENT_UNCONFIGURED', 'The AI guide is not set up on this server yet (missing OPENROUTER_API_KEYS).')); return; }
    const client = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'local';
    if (rateLimited(client, now())) { fail(new AgentError(429, 'RATE_LIMITED', 'Too many questions in a minute. Please slow down a little.')); return; }
    try {
      let body;
      try { body = await readJson(req); } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError(400, 'BAD_REQUEST', 'The request was not valid JSON.'); }
      const messages = sanitizeMessages(body?.messages);
      const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
      const payload = {
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        tools: AGENT_TOOLS,
        tool_choice: 'auto',
        provider: { require_parameters: true },
        temperature: 0.3,
        max_tokens: 700,
        ...(model.startsWith('openai/gpt-oss') ? { reasoning: { effort: 'low' } } : {})
      };
      const requestBody = JSON.stringify(payload);
      const callWith = async entry => {
        const response = await fetchImpl(OPENROUTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.key}` },
          body: requestBody,
          signal: AbortSignal.timeout(20_000)
        });
        const data = await response.json().catch(() => null);
        const upstreamError = data?.error ?? data?.choices?.[0]?.error;
        if (response.ok && !upstreamError) return { data };
        const status = response.ok ? Number(upstreamError?.code) : response.status;
        const at = now();
        if (status === 429) {
          // Bench this key until its limit resets: per-day limits until the
          // reset time (or next UTC midnight), per-minute ones briefly.
          const retryAfter = retryAfterSeconds(response.headers);
          const daily = /per[- ]?day|daily/i.test(String(upstreamError?.message ?? ''));
          const until = rateLimitResetAt(response.headers, data)
            ?? (retryAfter !== null ? at + retryAfter * 1000 : daily ? nextUtcMidnight(at) : at + DEFAULT_RATE_COOLDOWN_MS);
          keys.bench(entry, until, 429);
          return { rotate: true };
        }
        if (status === 401 || status === 403 || status === 402) {
          // Rejected or out of credits: try the other keys, retry this one later.
          keys.bench(entry, at + KEY_FAULT_COOLDOWN_MS, status);
          return { rotate: true };
        }
        throw openRouterError(status);
      };

      let reply;
      // Try every usable key in round-robin order. If they are all benched and
      // one frees up within a few seconds, wait once; otherwise tell the browser.
      for (let round = 0, waitedMs = 0; round < 2 && !reply; round++) {
        for (const entry of keys.take(now() + waitedMs)) {
          const result = await callWith(entry);
          if (result.data) { reply = result.data; break; }
        }
        if (reply) break;
        const benched = keys.benched(now());
        const limited = benched.find(entry => entry.status === 429);
        if (!limited) throw openRouterError(benched[0]?.status ?? 502);
        const wait = Math.max(0, (limited.until - now()) / 1000);
        if (round === 0 && wait <= MAX_INLINE_WAIT_S) { waitedMs = Math.ceil(wait) * 1000 + 250; await pause(waitedMs); continue; }
        throw openRouterError(429, wait);
      }
      const message = reply?.choices?.[0]?.message;
      if (!message) throw new AgentError(502, 'AGENT_UPSTREAM', 'The guide returned an empty answer. Please retry.');
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls
        .filter(call => TOOL_NAMES.includes(call?.function?.name))
        .slice(0, MAX_TOOL_CALLS)
        .map(call => ({ id: String(call.id), type: 'function', function: { name: call.function.name, arguments: String(call.function.arguments ?? '{}') } })) : [];
      res.end(JSON.stringify({
        message: { role: 'assistant', content: stripThinking(message.content), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        model
      }));
    } catch (error) {
      if (error?.name === 'TimeoutError') { fail(new AgentError(504, 'AGENT_TIMEOUT', 'The guide took too long to answer. Please retry.')); return; }
      fail(error);
    }
  };
}

export default createAgentHandler();
