// Checks the AI guide's replies before visitors see them: no discovery claims,
// and every number must come from a tool result, the visitor's own words, or
// the short list of historical facts the guide is allowed to tell. Pure.

// Claims about OUR data that the guide must never make. History ("Barnard
// discovered it in 1916") is fine; "we discovered a new planet" is not.
const FORBIDDEN = [
  /\b(we|i|you)(?:'ve| have| just| may have| might have)*\s+(?:just\s+)?(discovered|found)\s+(?:a\s+)?new\b/i,
  /\b(this|it|that|spot\s*\d+)\s+(?:is|could be|might be|may be|is probably|is likely)\s+(?:a\s+|the\s+)?(new planet|planet x|planet nine|planet 9)\b/i,
  /\b(a|the)\s+new\s+(planet|world)\s+(has been\s+)?(discovered|found|detected)\b/i,
  /\b(first ever|never (?:been )?seen before)\b/i,
  /\b(confirmed|confirms)\s+(?:the\s+)?(existence of\s+)?(planet x|planet nine|planet 9)\b/i
];

/** Numbers the system prompt and quests may state without a tool result. */
export const FACT_NUMBERS = Object.freeze([
  1916, 1894, 1888, 1907, 1930, 1846, 1781, 2016, 2021, 2013, 2014, 2025, 2026,
  10.3, 22, 23, 29, 18, 13, 90, 102, 6.15, 0.75, 5, 500, 380, 100, 30, 6, 2, 14, 13.7, 24, 25, 4
]);

const NUMBER = /(?<![\w.])[-−]?\d+(?:[.,]\d+)?(?![\w])/g;

// Visitors should never see the guide's internal tool names. Each maps to the
// plain words used when a leaked name has to be replaced mechanically.
const TOOL_PHRASES = Object.freeze({
  get_view_state: 'a look at the screen', set_display: 'a display change', set_view_mode: 'a view change',
  compare_frames: 'a frame comparison', playback: 'the time-lapse', set_view: 'a view change',
  go_to_target: 'a move to the target', make_share_link: 'a share link', find_changes: 'a search for changes',
  mark_spot: 'a new spot', measure_source: 'a brightness measurement on every date',
  get_spectrum: 'a colour (spectrum) measurement', crossmatch: 'a check against star and asteroid catalogues',
  get_case: 'the case file', pick_epochs: 'a comparison of dates six months apart',
  predict_parallax_pair: 'a parallax prediction', precover: 'a search of older photos',
  second_opinion: 'a second opinion', start_quest: 'a game', check_answer: 'an answer check',
  planet_nine_region: 'the Planet Nine map', patrol: 'a patrol', start_tour: 'the tour',
  prepare_report: 'a report card'
});
// snake_case names are never plain English; single words only count when
// written as code (`crossmatch`) or as a call (crossmatch(…)).
const TOOL_MENTION = new RegExp(
  '`\\s*(' + Object.keys(TOOL_PHRASES).join('|') + ')\\b[^`\\n]*`' +
  '|\\b(' + Object.keys(TOOL_PHRASES).filter(name => name.includes('_')).join('|') + ')\\b(?:\\s*\\([^)\\n]*\\)|(?:\\s+(?:spot\\s*)?\\d+)?)' +
  '|\\b(' + Object.keys(TOOL_PHRASES).filter(name => !name.includes('_')).join('|') + ')\\s*\\([^)\\n]*\\)',
  'gi'
);

/** Internal tool names written in a reply, e.g. "`get_case 3`" → ["get_case"]. */
export function leakedToolNames(text) {
  return [...new Set([...String(text).matchAll(TOOL_MENTION)].map(match => (match[1] || match[2] || match[3]).toLowerCase()))];
}

/** Replace leaked tool names with plain words (fallback when a rewrite also leaks). */
export function plainToolNames(text) {
  return String(text).replace(TOOL_MENTION, (whole, a, b, c) => {
    const name = (a || b || c).toLowerCase();
    const spot = whole.match(/(?:spot\s*|\s)(\d+)\b/i)?.[1];
    return TOOL_PHRASES[name] + (spot ? ` for spot ${spot}` : '');
  });
}

// A reply that hands the next step back to the visitor instead of doing it.
const ASKS_PERMISSION = /\b(?:want me to|would you like me to|do you want me to|should i|shall i|(?:pick|choose) one|which would you prefer|next steps?\s*(?:\(|:))/i;

/** True when the reply stops to ask permission for more investigation. */
export function asksPermission(text) {
  return ASKS_PERMISSION.test(String(text));
}

export function forbiddenClaims(text) {
  return FORBIDDEN.map(pattern => String(text).match(pattern)?.[0]).filter(Boolean);
}

function numbersIn(text) {
  return [...String(text).matchAll(NUMBER)].map(match => match[0].replace('−', '-').replace(',', '.'));
}

function grounded(token, pool) {
  const value = Number(token);
  if (!Number.isFinite(value)) return true;
  if (Number.isInteger(value) && Math.abs(value) <= 12) return true; // counts, frame and spot numbers
  const decimals = (token.split('.')[1] || '').length;
  const tolerance = Math.max(0.5 * 10 ** -decimals, Math.abs(value) * 0.01);
  return pool.some(candidate => Math.abs(Math.abs(candidate) - Math.abs(value)) <= tolerance);
}

/**
 * @param {string} reply the model's text
 * @param {string[]} sources tool results (JSON strings), the user message, spot chips
 */
export function checkReply(reply, sources = []) {
  const pool = [...FACT_NUMBERS, ...sources.flatMap(numbersIn).map(Number).filter(Number.isFinite)];
  const ungrounded = [...new Set(numbersIn(reply).filter(token => !grounded(token, pool)))];
  const forbidden = forbiddenClaims(reply);
  const leaked = leakedToolNames(reply);
  return { ok: !ungrounded.length && !forbidden.length && !leaked.length, ungrounded, forbidden, leaked };
}

/** Remove the sentences that contain a problem; used when a rewrite also fails. */
export function stripProblems(reply, { ungrounded = [], forbidden = [] }) {
  const sentences = String(reply).split(/(?<=[.!?])\s+/);
  const bad = sentence => forbidden.some(phrase => sentence.includes(phrase)) ||
    numbersIn(sentence).some(token => ungrounded.includes(token));
  const kept = sentences.filter(sentence => !bad(sentence));
  return plainToolNames(kept.join(' ').trim());
}

export function correctionPrompt({ ungrounded = [], forbidden = [], leaked = [] }, { askedPermission = false } = {}) {
  const broke = ungrounded.length || forbidden.length || leaked.length;
  const parts = [broke ? 'Your last reply broke the guide rules.' : 'Before you reply:'];
  if (ungrounded.length) parts.push(`These numbers do not appear in any tool result: ${ungrounded.join(', ')}. Use only measured numbers, or call a tool to measure first.`);
  if (forbidden.length) parts.push(`Never claim a discovery or that something is Planet X/Planet Nine (you wrote: "${forbidden.join('", "')}"). Say "unexplained" and what would confirm it.`);
  if (leaked.length) parts.push(`Visitors must never see tool names (you wrote: ${leaked.join(', ')}). Describe what you did or could do in plain words, e.g. "I checked spot 2 against star catalogues".`);
  if (askedPermission) parts.push('Do not ask the visitor for permission to continue the investigation they asked for. If useful checks are still open, run them now. Only ask when the choice truly belongs to the visitor (going somewhere else, starting a game, sharing).');
  parts.push(askedPermission ? 'Then reply briefly.' : 'Rewrite the reply now, briefly.');
  return parts.join(' ');
}
