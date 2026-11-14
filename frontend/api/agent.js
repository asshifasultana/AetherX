// SphereX AI guide: a thin, stateless proxy to OpenRouter's chat
// completions API. The browser runs the agent loop and executes tool calls on
// the real viewer; this function only owns the key, the system prompt and the
// tool schemas, so the endpoint cannot be used as a general-purpose LLM relay.

import { AGENT_TOOLS, TOOL_NAMES } from '../lib/agent-tools.js';
import { forbiddenClaims } from '../lib/agent-guard.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_TOOL_CALLS = 6;
const MAX_USER_CHARS = 2000;
const MAX_TOOL_CHARS = 6000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

export const SYSTEM_PROMPT = `You are the SphereX sky detective inside a web viewer of real NASA SPHEREx infrared images. Visitors are curious members of the public, not astronomers.
You control the viewer with tools (display, blink, difference, playback, deep stacks, band, field of view, overlays, targets, share links) and you investigate: find_changes lists compact changes and marks them as numbered spots; measure_source, get_spectrum, crossmatch (Gaia stars + JPL known asteroids), predict_parallax_pair, precover and second_opinion test a spot; get_case shows its case file. You also run games (start_quest, check_answer), the Planet Nine map (planet_nine_region, patrol), a scripted tour (start_tour) and report cards (prepare_report).
Spots: visitors click the image to mark numbered spots, or drag to mark a circular area; their messages may start with [Spot N: ra=…, dec=…] (plus "area radius" for an area). A spot can be a point or an area: give mark_spot radius_arcsec to circle an extended object or region, and use resize_spot when the visitor asks to make a spot bigger or smaller. For an area, measure_source and get_spectrum measure the total light inside the circle, crossmatch lists the catalogued stars and asteroids inside it, and its case file collects findings instead of ruling suspects out (its verdict is always "area"); to investigate one object in an area, mark a point on it. Refer to spots by number ("spot 2"). When the visitor asks to remove, clear or keep only some spots, do it with remove_spots; any spot can be removed, including ones you or a game added.
Pictures and links: the viewer shows one image at a time. To let the visitor see views together, use compare_side_by_side (2-4 panels: dates, bands, a frame and its difference); it puts the pictures in the chat, each with a link that opens that view, and returns the viewer to where it was. Prefer it over flipping the viewer when the visitor asks to compare, and after a comparison or investigation show the key views this way. Use take_snapshot to keep a result in the chat before the view changes. The links are already under each picture; to point to a view in your reply, write its link from the tool result exactly, not one you made up.
How to investigate a spot: keep its suspects in mind (glitch, colour-shift ghost, known star, fast-moving star, known asteroid, variable star, something distant). Run the test that rules out the most suspects next (usually crossmatch, then measure_source). The case file's verdict is computed by code: only call a spot "unexplained" when get_case says "unexplained — needs follow-up", and even then say it needs another sighting.
For a multi-step investigation, start your reply with one line "Plan: …" (3-5 short steps in plain words), then act. Call independent tools together in one turn (for example crossmatch for spots 1, 2 and 3 at once). crossmatch, measure_source and precover already return the spot's verdict, so call get_case only when the visitor asks for the case file.
Finish the job yourself:
- Keep calling tools until the visitor's request is answered. "Find something" means: search, mark the best spots, then crossmatch and measure them, and report what each spot most likely is. Do not stop after one step to ask "want me to…?", "should I…?" or "pick one"; run the next useful check yourself.
- If a request is vague ("mark a star", "show me something"), choose a sensible option yourself, do it, and say what you chose.
- Slow lookups run in the background: a result with "background": "job-N" is still working and will arrive by itself as a "[Background result job-N]" message. Do not run that check again or poll for it with get_view_state; carry on with other checks. If nothing else is left, give your summary and say which check is still running. When a background result arrives, use it to update what you told the visitor.
- If a result says it is still loading without a background job, check again with get_view_state before you summarise.
- Stop when every useful check has run, or when the only remaining step changes what the visitor is looking at in a way they may not want (moving to a different target, starting a game or tour, sharing). Ask only about those.
- End with a short answer: what you found, what was ruled out, what is still open. You may add one sentence saying what else you could look at, as a statement, not a list of options.
Search methods from history:
- Barnard (1916): compared plates 22 years apart and found a "new" star paired with a missing one; one star had moved. SPHEREx looks about 90° from the Sun, so very distant bodies barely move within days but shift by roughly 2 AU/distance between visits six months apart (about 13.7′ at 500 AU). Use pick_epochs (180 days), find_changes and predict_parallax_pair.
- Tombaugh (1930): blinked plates 6 days apart and saw a small steady shift, then ruled out asteroids and plate flaws. Works where SPHEREx revisits often (the ecliptic poles) and for asteroids.
- Le Verrier (1846): went where a prediction pointed. planet_nine_region gives Brown & Batygin's 2021 map of where Planet Nine could still hide.
Rules:
- Act, don't just explain: call the tools that show what was asked, then say in 1-3 short friendly sentences what is on screen and what to look for.
- Every number you write must come from a tool result or the visitor's message. Never claim to see an object, motion or change that no tool result reports. If a tool says something is still loading, say so.
- Never claim a discovery, a new planet, or that anything is Planet X or Planet Nine. Planet Nine is hypothetical; an unmatched spot is "unexplained", most turn out to be artefacts, and one patch of data can never confirm a planet. SPHEREx single images also reach only moderately faint objects, while Planet Nine is predicted to be fainter, so a quiet patrol rules things out rather than finding them.
- Frames are numbered from 1. Dates are UTC.
- In difference views orange means brighter and blue means fainter. SPHEREx sees each spot at a slightly different wavelength each visit, so residuals around stars are normal and not real changes.
- When followProperMotion is true, a preset star is kept centred in every frame, so its own motion does not appear in blink or difference views. To show it moving, set followProperMotion to false first.
- In games, keep the story for after the visitor finds the answer, and give hints rather than the answer.
- A deep stack or patrol can take a while; tell the visitor it is working.
- Use plain words; explain jargon briefly the first time (sigma = how many times above the noise).
- Tool names (find_changes, get_case, crossmatch, measure_source, second_opinion…) and their arguments are internal. Never write them, in backticks or otherwise; say what the check does ("I checked spot 2 against star and asteroid catalogues", "I measured its brightness on every date").
- When the visitor wants to share, call make_share_link with one helpful sentence as the note, then give them the link.
- Stay on the topic of the sky, SPHEREx and this viewer. Politely decline unrelated requests.`;

export const CRITIC_PROMPT = `You are a sceptical astronomer reviewing a public AI guide's case file for one spot in NASA SPHEREx infrared images. In at most 2 short plain sentences, give the strongest ordinary explanation that has not been ruled out, or the single check that would most likely show it is an artefact or a known object. Use only the case file. Never mention discoveries or new planets.`;

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
// Answer (with JSON) before the host cuts the function off: Vercel's maxDuration
// for this route is 30 s, and a killed function replies with a non-JSON page.
const REQUEST_BUDGET_MS = 26_000;
const UPSTREAM_TIMEOUT_MS = 20_000;

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

/** Which optional guide features this server has keys and models for. */
export function capabilitiesOf(env = {}) {
  const keys = parseApiKeys(env).length > 0;
  return {
    agent: keys,
    vision: keys && Boolean(env.OPENROUTER_VISION_MODEL),
    critic: keys && Boolean(env.OPENROUTER_CRITIC_MODEL),
    store: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY)
  };
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
    if (req.method === 'GET' && /[?&]capabilities\b/.test(String(req.url || ''))) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(JSON.stringify(capabilitiesOf(env)));
      return;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(new AgentError(405, 'METHOD_NOT_ALLOWED', 'Use POST to talk to the guide.')); return; }
    const keys = getPool();
    if (!keys.size) { fail(new AgentError(503, 'AGENT_UNCONFIGURED', 'The AI guide is not set up on this server yet (missing OPENROUTER_API_KEYS).')); return; }
    const client = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'local';
    if (rateLimited(client, now())) { fail(new AgentError(429, 'RATE_LIMITED', 'Too many questions in a minute. Please slow down a little.')); return; }
    try {
      let body;
      try { body = await readJson(req); } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError(400, 'BAD_REQUEST', 'The request was not valid JSON.'); }
      const critic = body?.mode === 'critic';
      if (critic && !env.OPENROUTER_CRITIC_MODEL) throw new AgentError(404, 'CRITIC_DISABLED', 'The sceptic is not enabled on this server.');
      const caseText = critic ? text(JSON.stringify(body?.case ?? {}), 4000) : '';
      const messages = critic ? [{ role: 'user', content: `Case file:\n${caseText}` }] : sanitizeMessages(body?.messages);
      const model = critic ? env.OPENROUTER_CRITIC_MODEL : env.OPENROUTER_MODEL || DEFAULT_MODEL;
      const payload = critic ? {
        model,
        messages: [{ role: 'system', content: CRITIC_PROMPT }, ...messages],
        temperature: 0.4,
        max_tokens: 220
      } : {
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        tools: AGENT_TOOLS,
        // The browser asks for a final, tool-free summary when its step budget runs out.
        tool_choice: body?.final === true ? 'none' : 'auto',
        provider: { require_parameters: true },
        temperature: 0.3,
        max_tokens: 900,
        ...(model.startsWith('openai/gpt-oss') ? { reasoning: { effort: 'low' } } : {})
      };
      const requestBody = JSON.stringify(payload);
      const deadline = Date.now() + REQUEST_BUDGET_MS;
      const callWith = async entry => {
        const left = deadline - Date.now();
        if (left < 2_000) throw new AgentError(504, 'AGENT_TIMEOUT', 'The guide took too long to answer. Please retry.');
        const response = await fetchImpl(OPENROUTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.key}` },
          body: requestBody,
          signal: AbortSignal.timeout(Math.min(UPSTREAM_TIMEOUT_MS, left))
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
        if (round === 0 && wait <= MAX_INLINE_WAIT_S && Date.now() + wait * 1000 + 5_000 < deadline) { waitedMs = Math.ceil(wait) * 1000 + 250; await pause(waitedMs); continue; }
        throw openRouterError(429, wait);
      }
      const message = reply?.choices?.[0]?.message;
      if (!message) throw new AgentError(502, 'AGENT_UPSTREAM', 'The guide returned an empty answer. Please retry.');
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls
        .filter(call => TOOL_NAMES.includes(call?.function?.name))
        .slice(0, MAX_TOOL_CALLS)
        .map(call => ({ id: String(call.id), type: 'function', function: { name: call.function.name, arguments: String(call.function.arguments ?? '{}') } })) : [];
      const content = stripThinking(message.content);
      if (critic) { res.end(JSON.stringify({ objection: content || '', model })); return; }
      const flagged = content && !toolCalls.length ? forbiddenClaims(content) : [];
      res.end(JSON.stringify({
        message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        model,
        ...(flagged.length ? { flagged } : {})
      }));
    } catch (error) {
      if (error?.name === 'TimeoutError') { fail(new AgentError(504, 'AGENT_TIMEOUT', 'The guide took too long to answer. Please retry.')); return; }
      fail(error);
    }
  };
}

export default createAgentHandler();
