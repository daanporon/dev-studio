#!/usr/bin/env bash
# ds-feedback.sh — the note is one feedback_notes row in loop.db (ds-feedback-github-issues U1), the
# output says plainly that it does not reach the operator (a blocker goes to the Lead, never here), and
# with loop.db unopenable the note is appended to the old file as before.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
TMP="$(mktemp -d)"; state_root_on_exit 'rm -rf "$TMP" "$DS_STATE_PARENT"'
export DS_FEEDBACK_LOG="$TMP/feedback"
unset DS_MEMBER DS_WT ORCA_TERMINAL_HANDLE CLAUDE_PROJECT_DIR
F="$ROOT/bin/role/ds-feedback.sh"
DS="$ROOT/bin/ds"
cd "$TMP"   # outside any role worktree

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
rc(){ set +e; "$@" >/dev/null 2>&1; local r=$?; set -e; echo "$r"; }
rows(){ "$DS" feedback list --json | grep -c '"key"' || true; }

# usage: no note refused, nothing written.
eq "no args refused" "$(rc "$F")" "2"
[ -e "$DS_STATE_ROOT/loop.db" ] && r=written || r=none; eq "refusal opens no loop.db" "$r" "none"

# the note is one row, state new, project - outside a member; the file is untouched.
out="$("$F" "builder on zz: retry backoff is in-context, lost on restart")"
eq "note exits 0" "$?" "0"
eq "one row" "$(rows)" "1"
j="$("$DS" feedback list --json)"
has "row state new" "$j" '"state": "new"'
has "row project - outside a member" "$j" '"project": "-"'
has "row text" "$j" '"text": "builder on zz: retry backoff is in-context, lost on restart"'
[ -e "$DS_FEEDBACK_LOG" ] && r=written || r=none; eq "file untouched while loop.db opens" "$r" "none"

# the output warns it reaches no one, and redirects blockers to the Lead.
has "output says it does not reach the operator" "$out" "does not reach the operator"
has "output names the next dev-studio session" "$out" "next dev-studio session"
has "output redirects blockers to the Lead" "$out" "tell your Lead"

# a second note is a second row.
"$F" "thinker on zz: second note" >/dev/null
eq "second note is a second row" "$(rows)" "2"

# loop.db unopenable (a folder in its place): the note is appended to the file, dated, and the command says so.
FB="$TMP/broken"; mkdir -p "$FB/loop.db"
err="$(DS_STATE_ROOT="$FB" "$F" "lead on zz: fallback note" 2>&1 >/dev/null)"
has "fallback says why" "$err" "loop.db could not be opened"
eq "one line appended" "$(grep -c '^- ' "$DS_FEEDBACK_LOG")" "1"
case "$(head -1 "$DS_FEEDBACK_LOG")" in
  "- 20"??"-"??"-"??"T"*" — lead on zz: fallback note") r=ok ;; *) r=no ;; esac
eq "entry format: - DATE — note" "$r" "ok"
eq "default log path unchanged" "$(grep -c 'process.env.DS_FEEDBACK_LOG || join(sr, "dev-studio-feedback")' "$(dirname "$F")/../commands/ds-feedback-ts.ts")" "1"

# ds feedback import reads the fallback's line in and renames the file.
"$DS" feedback import >/dev/null
eq "import adds the fallback note" "$(rows)" "3"
[ -e "$DS_FEEDBACK_LOG" ] && r=still || r=renamed; eq "import renames the file" "$r" "renamed"
eq "renamed copy kept" "$(find "$TMP" -maxdepth 1 -name 'feedback.imported-*' | wc -l | tr -d ' ')" "1"

echo "ds-feedback: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
