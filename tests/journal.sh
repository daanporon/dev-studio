#!/usr/bin/env bash
# journal.sh — a standing agent's decision/keep log and its briefing (keeps + last 30 decisions).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zzjn_$$"; JD="$DS_STATE_ROOT/$LBL/journals"
state_root_on_exit 'rm -rf "$DS_STATE_ROOT/$LBL"'
J="$ROOT/bin/role/journal.sh"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }

# Paths (KTD6): per topic+role, Builders per unit, the Studio one file.
eq "role path"         "$("$J" "$LBL" mt thinker path)"     "$JD/mt-thinker.md"
eq "builder per unit"  "$("$J" "$LBL" mt builder-u3 path)"  "$JD/mt-builder-u3.md"
eq "studio path"       "$("$J" "$LBL" studio studio path)"  "$JD/studio.md"

# add keep -> briefing shows it (creates the directory).
"$J" "$LBL" mt thinker add keep "never touch billing" "operator said so" >/dev/null
b="$("$J" "$LBL" mt thinker briefing)"
has "keep entry in briefing" "$b" "[keep] never touch billing — operator said so"
case "$(head -1 "$JD/mt-thinker.md")" in
  "- 20"*"T"*" [keep] never touch billing — operator said so") r=ok ;; *) r=no ;; esac
eq "entry format: - <ISO time> [kind] text — why" "$r" "ok"

# 40 decisions -> briefing shows the latest 30, oldest first, after the keeps.
for i in $(seq 1 40); do "$J" "$LBL" mt lead add decision "d$i" "w$i" >/dev/null; done
"$J" "$LBL" mt lead add keep "k1" "kw" >/dev/null
b="$("$J" "$LBL" mt lead briefing)"
eq "30 decisions shown" "$(printf '%s\n' "$b" | grep -c '\[decision\]')" "30"
eq "keeps first"        "$(printf '%s\n' "$b" | grep -m1 '^- ' | grep -o '\[keep\] k1')" "[keep] k1"
first="$(printf '%s\n' "$b" | grep '\[decision\]' | head -1)"; last="$(printf '%s\n' "$b" | grep '\[decision\]' | tail -1)"
has "oldest shown is d11" "$first" "[decision] d11 — w11"
has "newest shown is d40" "$last"  "[decision] d40 — w40"

# U266: the newest checkpoint closes the briefing, behind 30 newer decisions; no checkpoint, no line.
eq "no checkpoint, no trailer" "$(printf '%s\n' "$b" | grep -c '^newest checkpoint')" "0"
"$J" "$LBL" mt builder-u9 add keep "checkpoint stop-old: first" "x" >/dev/null
"$J" "$LBL" mt builder-u9 add keep "checkpoint stop-new: done A; next step B" "before a planned restart" >/dev/null
for i in $(seq 1 35); do "$J" "$LBL" mt builder-u9 add decision "d$i" "w$i" >/dev/null; done
b="$("$J" "$LBL" mt builder-u9 briefing)"
has "newest checkpoint last" "$(printf '%s\n' "$b" | tail -1)" "newest checkpoint (continue from its next step; the 35 newer entries above came after it): "
has "it is the newest one"   "$(printf '%s\n' "$b" | tail -1)" "[keep] checkpoint stop-new: done A; next step B"
"$J" "$LBL" mt builder-u8 add keep "checkpoint stop-a: next step C" "x" >/dev/null
eq "nothing after it, no count" "$("$J" "$LBL" mt builder-u8 briefing | tail -1 | grep -c 'newest checkpoint (continue from its next step): ')" "1"
printf -- '- 2027-01-15T08:00:00Z [keep] checkpoint failed stop-b: no checkpoint within 5 minutes — read the work tree\n' >> "$JD/mt-builder-u8.md"
has "a failed one says so" "$("$J" "$LBL" mt builder-u8 briefing | tail -1)" "newest checkpoint failed (read the work tree and the PR before you go on): "

# Unknown kind -> exit 2, nothing written.
set +e; "$J" "$LBL" mt nope add maybe "x" "y" >/dev/null 2>&1; rc=$?; set -e
eq "unknown kind exits 2" "$rc" "2"
[ -e "$JD/mt-nope.md" ] && r=written || r=none
eq "unknown kind writes nothing" "$r" "none"

# Quotes and | round-trip.
t='he said "ship it" | then '"'"'stop'"'"''
"$J" "$LBL" mt thinker add decision "$t" 'a|b "c"' >/dev/null
has "quotes and pipes survive" "$("$J" "$LBL" mt thinker briefing)" "[decision] $t — a|b \"c\""

echo "journal: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
