// Saved AI-guide records in Supabase: patrol results, spot case files and
// "Think you've got one?" reports (table public.agent_records, see
// supabase/migrations/20261110000000_agent_records.sql).
//
// POST /api/cases {kind, payload}   saves one record (rate-limited)
// GET  /api/cases?kind=report       lists the 30 newest records of a kind
// GET  /api/cases?kind=vote&tally=1 PlanetX case votes counted per case
//      (latest vote per browser; view public.planetx_vote_tally)
// GET  /api/cases?kind=finding&caseId=… the 20 newest PlanetX case-file
//      submissions for one case, without the voter id
// Without SUPABASE_URL and SUPABASE_SERVICE_KEY the endpoint reports 503 and
// the guide falls back to share links (PlanetX keeps votes in the browser).
//
// PlanetX case ids are "p9-…" (public suspicion patches) or "t9-…" (any other
// 5° tile; the team promotes well-backed tiles to public case files).

const KINDS = ['patrol', 'case', 'report', 'vote', 'finding'];
const VOTE_VERDICTS = ['something', 'nothing'];
const CASE_ID = /^(p9|t9)-ra\d{3}\.\d-dec[+-]\d{2}\.\d$/;
const VOTER_ID = /^[a-z0-9-]{8,64}$/i;
// The AI guide's suspects (lib/case-file.js); a finding answers each one.
const SUSPECT_KEYS = ['glitch', 'colour_shift', 'known_star', 'proper_motion_star', 'known_asteroid', 'variable_star', 'distant_unknown'];
const ANSWERS = ['ruled_out', 'supported', 'unsure'];
const AI_STATUSES = ['ruled_out', 'supported', 'open'];
const FINDINGS_LIMIT = 20;

const statusMap = (value, allowed) => Object.fromEntries(SUSPECT_KEYS.filter(key => allowed.includes(value?.[key])).map(key => [key, value[key]]));

/**
 * A PlanetX case-file submission: the person's answer per suspect, their
 * verdict, the AI's read of the same spot if they looked, and where the spot
 * is. No free text is kept.
 */
export function cleanFinding(payload) {
  if (!payload || !CASE_ID.test(String(payload.caseId)) || !VOTE_VERDICTS.includes(payload.verdict) || !VOTER_ID.test(String(payload.voter))) return null;
  const answers = statusMap(payload.answers, ANSWERS);
  const ai = payload.ai && typeof payload.ai === 'object' && typeof payload.ai.label === 'string'
    ? { label: payload.ai.label.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60), suspects: statusMap(payload.ai.suspects, AI_STATUSES) }
    : null;
  const ra = Number(payload.spot?.raDeg), dec = Number(payload.spot?.decDeg), radius = Number(payload.spot?.radiusArcsec);
  const spot = Number.isFinite(ra) && ra >= 0 && ra < 360 && Number.isFinite(dec) && Math.abs(dec) <= 90
    ? { raDeg: Number(ra.toFixed(5)), decDeg: Number(dec.toFixed(5)), ...(Number.isFinite(radius) && radius > 0 && radius <= 3600 ? { radiusArcsec: Math.round(radius) } : {}) }
    : null;
  return { caseId: payload.caseId, verdict: payload.verdict, voter: String(payload.voter).toLowerCase(), answers, ai, spot, ...(spot ? { raDeg: spot.raDeg, decDeg: spot.decDeg } : {}) };
}

/** A PlanetX vote holds a case id, a verdict and an anonymous browser id; nothing else is kept. */
export function cleanVote(payload) {
  if (!payload || !CASE_ID.test(String(payload.caseId)) || !VOTE_VERDICTS.includes(payload.verdict) || !VOTER_ID.test(String(payload.voter))) return null;
  const ra = Number(payload.raDeg), dec = Number(payload.decDeg);
  return {
    caseId: payload.caseId, verdict: payload.verdict, voter: String(payload.voter).toLowerCase(),
    ...(Number.isFinite(ra) && ra >= 0 && ra < 360 ? { raDeg: ra } : {}),
    ...(Number.isFinite(dec) && Math.abs(dec) <= 90 ? { decDeg: dec } : {})
  };
}
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
        const params = new URL(req.url, 'http://localhost').searchParams;
        const kind = params.get('kind');
        if (!KINDS.includes(kind)) { fail(400, `kind must be one of ${KINDS.join(', ')}.`, 'BAD_REQUEST'); return; }
        if (kind === 'vote') {
          if (params.get('tally') !== '1') { fail(400, 'Votes are only read as totals: use ?kind=vote&tally=1.', 'BAD_REQUEST'); return; }
          const view = base.replace(/agent_records$/, 'planetx_vote_tally');
          const response = await fetchImpl(`${view}?select=case_id,something,nothing&limit=500`, { headers, signal: AbortSignal.timeout(5000) });
          if (!response.ok) { fail(502, 'Could not read vote totals.', 'STORE_ERROR'); return; }
          const tallies = {};
          for (const row of await response.json()) if (CASE_ID.test(String(row.case_id))) tallies[row.case_id] = { something: Number(row.something) || 0, nothing: Number(row.nothing) || 0 };
          res.end(JSON.stringify({ tallies }));
          return;
        }
        if (kind === 'finding') {
          const caseId = params.get('caseId');
          if (!CASE_ID.test(String(caseId))) { fail(400, 'Findings are read per case: use ?kind=finding&caseId=p9-….', 'BAD_REQUEST'); return; }
          const response = await fetchImpl(`${base}?kind=eq.finding&payload->>caseId=eq.${encodeURIComponent(caseId)}&select=payload,created_at&order=created_at.desc&limit=${FINDINGS_LIMIT}`, { headers, signal: AbortSignal.timeout(5000) });
          if (!response.ok) { fail(502, 'Could not read case findings.', 'STORE_ERROR'); return; }
          // The voter id stays private; only what was found is shared.
          const findings = (await response.json()).map(({ payload = {}, created_at: createdAt }) => ({
            verdict: payload.verdict, answers: payload.answers || {}, ai: payload.ai || null, spot: payload.spot || null, createdAt
          }));
          res.end(JSON.stringify({ findings }));
          return;
        }
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
      const payload = body.kind === 'vote' ? cleanVote(body.payload) : body.kind === 'finding' ? cleanFinding(body.payload) : cleanPayload(body.payload);
      if (!payload) { fail(400, `A ${body.kind} needs {caseId, verdict: "something" | "nothing", voter}.`, 'BAD_REQUEST'); return; }
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
