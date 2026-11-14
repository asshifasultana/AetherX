#!/usr/bin/env bash
# Verification for the shareable-link / embeddable-viewer work.
# Run from the repository root:  ./verify.sh
#
# Each check prints PASS or FAIL and the script exits non-zero if anything fails,
# so it is safe to wire into CI once you trust it.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 1. tests
head "1. Test suite"
if out=$(npm test 2>&1); then
  summary=$(printf '%s\n' "$out" | grep -E '^ℹ (tests|pass|fail)' | tr '\n' ' ')
  ok "npm test — ${summary:-completed}"
else
  bad "npm test failed"
  printf '%s\n' "$out" | tail -20
fi

# ------------------------------------------------------- 2. modules served
head "2. New frontend modules are served"
PORT=${PORT:-5173}
BASE="http://127.0.0.1:${PORT}"
if curl -sf -o /dev/null --max-time 5 "$BASE/" 2>/dev/null; then
  for f in url-state.js sky-projection.js share.js share-ui.js; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/$f")
    if [ "$code" = "200" ]; then ok "$f -> HTTP 200"; else bad "$f -> HTTP $code"; fi
  done
else
  printf '  \033[33mSKIP\033[0m  dev server not running on %s — start it with: npm run dev\n' "$BASE"
fi

# --------------------------------------------------- 3. pure logic behaviour
head "3. URL encoding and projection (no browser needed)"
if node --input-type=module -e '
const root = "file://" + process.cwd() + "/frontend/";
const { encodeViewState, decodeViewState, DEFAULT_VIEW_STATE } = await import(root + "url-state.js");
const { skyToCanvas, canvasToSky, canvasSizeFor } = await import(root + "sky-projection.js");
let failures = 0;
const check = (name, cond) => { console.log((cond ? "OK   " : "BAD  ") + name); if (!cond) failures++; };

const state = { ...DEFAULT_VIEW_STATE, raDeg: 133.79512916666666, decDeg: -7.245147222222222,
  fovArcmin: 10, band: 3, startDate: "2025-06-01", endDate: "2026-01-31",
  markRaDeg: 133.784248, markDecDeg: -7.240941 };

const query = encodeViewState(state);
check("link contains the band", query.includes("band=3"));
check("link contains the dates", query.includes("from=2025-06-01") && query.includes("to=2026-01-31"));
check("link contains the marked source", query.includes("mra=") && query.includes("mdec="));
check("default view produces no query", encodeViewState(DEFAULT_VIEW_STATE) === "");

const back = decodeViewState(query).state;
check("position survives a round trip", Math.abs(back.raDeg - 133.795129) < 1e-6 && Math.abs(back.decDeg + 7.245147) < 1e-6);
check("marked source survives a round trip", Math.abs(back.markRaDeg - 133.784248) < 1e-6);

const badDec = decodeViewState("ra=10&dec=101");
check("impossible declination falls back with a reason", badDec.state.decDeg === DEFAULT_VIEW_STATE.decDeg && badDec.issues.length === 1);
const badDate = decodeViewState("from=2026-02-31");
check("impossible date is rejected", badDate.state.startDate === "" && badDate.issues.length >= 1);
check("RA wraps instead of failing", decodeViewState("ra=370&dec=0").state.raDeg === 10);

const size = canvasSizeFor(16);
let worst = 0;
for (let x = 0; x < size; x += 7) for (let y = 0; y < size; y += 7) {
  const sky = canvasToSky({ x, y, size, centerRaDeg: 133.795129, centerDecDeg: -7.245147 });
  const px = skyToCanvas({ ...sky, size, centerRaDeg: 133.795129, centerDecDeg: -7.245147 });
  worst = Math.max(worst, Math.abs(px.x - x), Math.abs(px.y - y));
}
check("pixel->sky->pixel round trip stays within 1e-6 px (worst " + worst.toExponential(1) + ")", worst < 1e-6);

const mid = (size - 1) / 2;
const left = canvasToSky({ x: 0, y: mid, size, centerRaDeg: 133.795129, centerDecDeg: -7.245147 });
const right = canvasToSky({ x: size - 1, y: mid, size, centerRaDeg: 133.795129, centerDecDeg: -7.245147 });
console.log("INFO left RA " + left.raDeg.toFixed(4) + " vs right RA " + right.raDeg.toFixed(4) +
  " -> east is on the " + (right.raDeg < left.raDeg ? "RIGHT (see doc section 7.3)" : "left"));

process.exit(failures ? 1 : 0);
' 2>&1; then
  ok "encoder, validator and projection behave as documented"
else
  bad "pure-logic checks failed (see output above)"
fi

# --------------------------------------------------------------- 4. git
head "4. What changed in the working tree"
if [ -n "$(git status --porcelain)" ]; then
  printf '  Modified: %s\n' "$(git diff --name-only | tr '\n' ' ')"
  printf '  Added:    %s\n' "$(git ls-files --others --exclude-standard | tr '\n' ' ')"
  printf '  Nothing is committed. Review with: git diff     Undo with: git checkout . && git clean -fd\n'
  ok "changes are uncommitted and reviewable"
else
  printf '  Working tree is clean — the changes may already be committed.\n'
fi

# -------------------------------------------------------------- summary
head "Summary"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
