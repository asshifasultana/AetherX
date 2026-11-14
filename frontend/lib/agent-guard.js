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
  return { ok: !ungrounded.length && !forbidden.length, ungrounded, forbidden };
}

/** Remove the sentences that contain a problem; used when a rewrite also fails. */
export function stripProblems(reply, { ungrounded = [], forbidden = [] }) {
  const sentences = String(reply).split(/(?<=[.!?])\s+/);
  const bad = sentence => forbidden.some(phrase => sentence.includes(phrase)) ||
    numbersIn(sentence).some(token => ungrounded.includes(token));
  const kept = sentences.filter(sentence => !bad(sentence));
  return kept.join(' ').trim();
}

export function correctionPrompt({ ungrounded, forbidden }) {
  const parts = ['Your last reply broke the guide rules.'];
  if (ungrounded.length) parts.push(`These numbers do not appear in any tool result: ${ungrounded.join(', ')}. Use only measured numbers, or call a tool to measure first.`);
  if (forbidden.length) parts.push(`Never claim a discovery or that something is Planet X/Planet Nine (you wrote: "${forbidden.join('", "')}"). Say "unexplained" and what would confirm it.`);
  parts.push('Rewrite the reply now, briefly.');
  return parts.join(' ');
}
