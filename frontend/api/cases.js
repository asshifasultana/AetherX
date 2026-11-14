// Saved AI-guide records in Supabase: patrol results, spot case files and
// "Think you've got one?" reports (table public.agent_records, see
// supabase/migrations/20261110000000_agent_records.sql).
//
// POST /api/cases {kind, payload}   saves one record (rate-limited)
// GET  /api/cases?kind=report       lists the 30 newest records of a kind
// Without SUPABASE_URL and SUPABASE_SERVICE_KEY the endpoint reports 503 and
// the guide falls back to share links.

const KINDS = ['patrol', 'case', 'report'];
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = 12;
const hits = new Map();

function rateLimited(key, now = Date.now()) {
  const recent = (hits.get(key) || []).filter(time => now - time < 60_000);
  recent.push(now); hits.set(key, recent);
  if (hits.size > 2000) hits.clear();
  return recent.length > RATE_LIMIT;
}

/** Keep only plain JSON (strings, numbers, booleans, arrays, objects), bounded in size. */
export function cleanPayload(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map(item => cleanPayload(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [String(key).slice(0, 40), cleanPayload(item, depth + 1)]));
  return null;
}

export function createCasesHandler({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status, error, code) => { res.statusCode = status; res.end(JSON.stringify({ error, code })); };
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) { fail(503, 'Saving is not set up on this server; use the share link instead.', 'STORE_UNCONFIGURED'); return; }
    const key = env.SUPABASE_SERVICE_KEY;
    const base = String(env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/agent_records';
    const headers = { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}), Accept: 'application/json' };
    try {
      if (req.method === 'GET') {
        const kind = new URL(req.url, 'http://localhost').searchParams.get('kind');
        if (!KINDS.includes(kind)) { fail(400, `kind must be one of ${KINDS.join(', ')}.`, 'BAD_REQUEST'); return; }
        const response = await fetchImpl(`${base}?kind=eq.${kind}&select=id,kind,payload,ra_deg,dec_deg,status,created_at&order=created_at.desc&limit=30`, { headers, signal: AbortSignal.timeout(5000) });
        if (!response.ok) { fail(502, 'Could not read saved records.', 'STORE_ERROR'); return; }
        res.end(JSON.stringify({ records: await response.json() }));
        return;
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); fail(405, 'Use GET or POST.', 'METHOD_NOT_ALLOWED'); return; }
      const client = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'local';
      if (rateLimited(client)) { fail(429, 'Too many saves in a minute.', 'RATE_LIMITED'); return; }
      let body;
      try {
        if (req.body && typeof req.body === 'object') body = req.body;
        else {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new Error('large'); chunks.push(chunk); }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        }
      } catch { fail(400, 'Send {kind, payload} as JSON (at most 16 KB).', 'BAD_REQUEST'); return; }
      if (!KINDS.includes(body?.kind) || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) { fail(400, 'Send {kind, payload}.', 'BAD_REQUEST'); return; }
      const payload = cleanPayload(body.payload);
      const ra = Number(payload.raDeg), dec = Number(payload.decDeg);
      const row = { kind: body.kind, payload, ra_deg: Number.isFinite(ra) ? ra : null, dec_deg: Number.isFinite(dec) && Math.abs(dec) <= 90 ? dec : null };
      const response = await fetchImpl(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(row), signal: AbortSignal.timeout(5000) });
      if (!response.ok) { fail(502, 'Could not save the record.', 'STORE_ERROR'); return; }
      const [saved] = await response.json();
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, id: saved?.id ?? null }));
    } catch { fail(502, 'The record store did not answer.', 'STORE_ERROR'); }
  };
}

export default createCasesHandler();
