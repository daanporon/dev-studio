#!/usr/bin/env bash
# ds-feedback.sh — the note is appended to the log, and the output says plainly that
# it does not reach the operator (a blocker goes to the Lead, never here).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export DS_FEEDBACK_LOG="$TMP/feedback"
F="$ROOT/bin/role/ds-feedback.sh"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
rc(){ set +e; "$@" >/dev/null 2>&1; local r=$?; set -e; echo "$r"; }

# usage: no note refused, nothing written.
eq "no args refused" "$(rc "$F")" "2"
[ -e "$DS_FEEDBACK_LOG" ] && r=written || r=none; eq "refusal writes nothing" "$r" "none"

# the note is appended, one line, dated.
out="$("$F" "builder on zz: retry backoff is in-context, lost on restart")"
eq "note exits 0" "$?" "0"
eq "one line appended" "$(grep -c '^- ' "$DS_FEEDBACK_LOG")" "1"
case "$(head -1 "$DS_FEEDBACK_LOG")" in
  "- 20"??"-"??"-"??"T"*" — builder on zz: retry backoff"*) r=ok ;; *) r=no ;; esac
eq "entry format: - DATE — note" "$r" "ok"

# the output warns it reaches no one, and redirects blockers to the Lead.
has "output says it does not reach the operator" "$out" "does not reach the operator"
has "output names the next dev-studio session" "$out" "next dev-studio session"
has "output redirects blockers to the Lead" "$out" "tell your Lead"

# a second note appends beside the first; the default log path is unchanged.
"$F" "thinker on zz: second note" >/dev/null
eq "second note appends" "$(grep -c '^- ' "$DS_FEEDBACK_LOG")" "2"
eq "default log path unchanged" "$(grep -c 'process.env.DS_FEEDBACK_LOG || join(sr, "dev-studio-feedback")' "$(dirname "$F")/../commands/ds-feedback-ts.ts")" "1"

echo "ds-feedback: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
