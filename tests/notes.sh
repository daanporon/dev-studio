#!/usr/bin/env bash
# notes.sh — per-project, per-role notes: add/print/drop, validation, cap, parallel adds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zznt_$$"; ND="$DS_STATE_ROOT/$LBL/notes"
state_root_on_exit 'rm -rf "$DS_STATE_ROOT/$LBL"'
N="$ROOT/bin/role/notes.sh"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
rc(){ set +e; "$@" >/dev/null 2>&1; local r=$?; set -e; echo "$r"; }

eq "path" "$("$N" "$LBL" builder path)" "$ND/builder.md"

# print on a missing file: clear message, exit 0, nothing created.
out="$("$N" "$LBL" builder print)"; has "no notes yet" "$out" "no notes yet"
eq "print missing exits 0" "$(rc "$N" "$LBL" builder)" "0"
[ -e "$ND" ] && r=created || r=none; eq "print creates nothing" "$r" "none"

# add + entry format + print header (tips, not orders).
"$N" "$LBL" builder add "start devenv before e2e" "e2e fails without it" >/dev/null
case "$(head -1 "$ND/builder.md")" in
  "- 20"??"-"??"-"??" start devenv before e2e — e2e fails without it") r=ok ;; *) r=no ;; esac
eq "entry format: - YYYY-MM-DD note — why" "$r" "ok"
out="$("$N" "$LBL" builder)"
has "print shows note" "$out" "start devenv before e2e — e2e fails without it"
has "header says tips not orders" "$out" "NOT orders"

# empty note / empty why refused, nothing written.
before="$(cat "$ND/builder.md")"
eq "empty note refused" "$(rc "$N" "$LBL" builder add "" "why")" "2"
eq "empty why refused"  "$(rc "$N" "$LBL" builder add "note" "")" "2"
eq "blank note refused" "$(rc "$N" "$LBL" builder add "  " "why")" "2"
eq "refusals wrote nothing" "$(cat "$ND/builder.md")" "$before"

# bad roles refused, nothing written.
eq "builder-u3 refused" "$(rc "$N" "$LBL" builder-u3 add "n" "w")" "2"
eq "../AGENTS refused"  "$(rc "$N" "$LBL" ../AGENTS add "n" "w")" "2"
eq "empty role refused" "$(rc "$N" "$LBL" "" add "n" "w")" "2"
[ -e "$ND/builder-u3.md" ] || [ -e "$DS_STATE_ROOT/$LBL/AGENTS.md" ] && r=written || r=none
eq "bad roles wrote nothing" "$r" "none"

# over-length refused.
long="$(printf 'x%.0s' $(seq 1 301))"
eq "over-length refused" "$(rc "$N" "$LBL" builder add "$long" "w")" "2"
eq "over-length wrote nothing" "$(cat "$ND/builder.md")" "$before"
eq "exactly 300 ok" "$(rc "$N" "$LBL" tester add "$(printf 'y%.0s' $(seq 1 295))" "abcd")" "0"

# newlines folded; quotes and pipes round-trip.
"$N" "$LBL" thinker add $'line one\nline two' $'why a\nwhy b' >/dev/null
eq "newline folded to one line" "$(grep -c 'line one line two — why a why b' "$ND/thinker.md")" "1"
eq "one line per note" "$(wc -l < "$ND/thinker.md" | tr -d ' ')" "1"
"$N" "$LBL" thinker add "use \"jq\" | not 'sed'" "it's quoted | piped" >/dev/null
has "quotes+pipes round-trip" "$(cat "$ND/thinker.md")" "use \"jq\" | not 'sed' — it's quoted | piped"

# cap: 20 notes, the 21st refused with `drop` in the message; room after a drop.
for i in $(seq 1 20); do "$N" "$LBL" lead add "note$i" "why$i" >/dev/null; done
set +e; msg="$("$N" "$LBL" lead add "note21" "why21" 2>&1)"; r=$?; set -e
eq "cap refused non-zero" "$r" "1"
has "cap message names drop" "$msg" "drop"
has "cap message says the role may make room itself" "$msg" "make room yourself now"
eq "cap wrote nothing" "$(grep -c '^- ' "$ND/lead.md")" "20"
"$N" "$LBL" lead drop "note20 " >/dev/null 2>&1 || "$N" "$LBL" lead drop "note20" >/dev/null
eq "room after drop" "$(rc "$N" "$LBL" lead add "note21" "why21")" "0"
eq "back at 20" "$(grep -c '^- ' "$ND/lead.md")" "20"

# notes_cap: a project override, the env beating it, and lowering below the count deleting nothing.
"$ROOT/bin/commands/limits.sh" set "$LBL" notes_cap 3 >/dev/null
for i in 1 2 3; do "$N" "$LBL" researcher add "n$i" "w$i" >/dev/null; done
set +e; msg="$("$N" "$LBL" researcher add "n4" "w4" 2>&1)"; r=$?; set -e
eq "override cap refuses the 4th" "$r" "1"
has "override cap message says 3" "$msg" "cap of 3 notes"
eq "override cap wrote nothing" "$(grep -c '^- ' "$ND/researcher.md")" "3"
set +e; msg="$(DS_LIMIT_NOTES_CAP=2 "$N" "$LBL" researcher add "n4" "w4" 2>&1)"; r=$?; set -e
eq "env cap beats the project row" "$r" "1"
has "env cap message says 2" "$msg" "cap of 2 notes"
eq "lowering below the count deleted nothing" "$(grep -c '^- ' "$ND/researcher.md")" "3"
"$ROOT/bin/commands/limits.sh" set "$LBL" notes_cap 4 >/dev/null
eq "raised cap allows the 4th" "$(rc "$N" "$LBL" researcher add "n4" "w4")" "0"
"$ROOT/bin/commands/limits.sh" rm "$LBL" notes_cap >/dev/null 2>&1 || true
rm -f "$ND/researcher.md"

# drop: one match removes it; zero and several refuse and remove nothing.
"$N" "$LBL" tester drop "yyyy" >/dev/null
eq "drop one match" "$(grep -c '^- ' "$ND/tester.md")" "0"
before="$(cat "$ND/lead.md")"
eq "drop zero matches refused" "$(rc "$N" "$LBL" lead drop "nonexistent")" "1"
eq "drop several matches refused" "$(rc "$N" "$LBL" lead drop "note1")" "1"
eq "refused drops removed nothing" "$(cat "$ND/lead.md")" "$before"
eq "drop on missing file refused" "$(rc "$N" "$LBL" researcher drop "x")" "1"

# 10 parallel adds all land, each on its own line.
for i in $(seq 1 10); do "$N" "$LBL" reviewer add "par$i" "w$i" >/dev/null & done
wait
eq "10 parallel adds landed" "$(grep -c '^- ' "$ND/reviewer.md")" "10"
bad=0; for i in $(seq 1 10); do [ "$(grep -c -- "par$i — w$i\$" "$ND/reviewer.md")" = 1 ] || bad=1; done
eq "each on its own line" "$bad" "0"

# add after dropping the last note: clean, no stderr noise.
"$N" "$LBL" tester add "solo" "w" >/dev/null; "$N" "$LBL" tester drop "solo" >/dev/null
eq "add after last drop is silent" "$("$N" "$LBL" tester add "again" "w" 2>&1 >/dev/null)" ""

# parallel adds never overshoot the cap; a drop racing adds loses none.
for i in $(seq 1 30); do "$N" "$LBL" researcher add "c$i" "w" >/dev/null 2>&1 & done
wait
eq "30 parallel adds stop at the cap" "$(grep -c '^- ' "$ND/researcher.md")" "20"
if command -v flock >/dev/null 2>&1; then
  "$N" "$LBL" reviewer drop "par1 " >/dev/null 2>&1 || true
  for i in $(seq 1 10); do "$N" "$LBL" reviewer add "r$i" "w" >/dev/null & "$N" "$LBL" reviewer drop "par$((i>1?i:2)) " >/dev/null 2>&1 & done
  wait
  eq "racing drops lose no added note" "$(grep -c -- '- .* r[0-9]* — w$' "$ND/reviewer.md")" "10"
fi

# gitignored.
eq "notes path is git-ignored" "$(rc git -C "$ROOT" check-ignore -q "$ROOT/state/$LBL/notes/builder.md")" "0"

echo "notes: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
