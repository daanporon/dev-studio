#!/usr/bin/env bash
# lane-rules.sh — bin/role/lane-rules.sh add|print|drop|path in a temp state dir (light-lane plan U5).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export DS_STATE_ROOT="$T"
L="$ROOT/bin/role/lane-rules.sh"
pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
rc(){ set +e; "$@" >/dev/null 2>&1; local r=$?; set -e; echo "$r"; }

eq "path" "$("$L" acme path)" "$T/acme/lanes.md"
has "print before any add" "$("$L" acme print)" "no lane rules yet"
has "print without rules: lane is cost, not tier" "$("$L" acme print)" "# Lane = what a unit's checks cost (the files it touches), not its Tier; a running unit can be retagged while under light_lane_cpu_h CPU-h."
[ -e "$T/acme" ] && r=created || r=none; eq "print creates nothing" "$r" "none"

"$L" acme add contracts-only light "only contracts/ and docs/ change" "acme sample, 0.3 CPU-h" >/dev/null
eq "line format" "$(tail -1 "$T/acme/lanes.md")" "- contracts-only: light — only contracts/ and docs/ change — acme sample, 0.3 CPU-h"
has "print shows the rule" "$("$L" acme)" "contracts-only: light"
has "print with rules: lane is cost, not tier" "$("$L" acme print)" "not its Tier; a running unit can be retagged while under light_lane_cpu_h CPU-h."
"$L" acme add big-refactor normal "touches many folders" "ran 20 CPU-h" >/dev/null
eq "two rules" "$(grep -c '^- ' "$T/acme/lanes.md")" "2"

eq "duplicate id refused" "$(rc "$L" acme add contracts-only light a b)" "1"
eq "bad lane refused" "$(rc "$L" acme add x fast a b)" "2"
eq "bad id refused" "$(rc "$L" acme add 'x y' light a b)" "2"
eq "empty evidence refused" "$(rc "$L" acme add x light a "")" "2"
eq "too long refused" "$(rc "$L" acme add x light "$(printf 'a%.0s' $(seq 1 300))" "$(printf 'b%.0s' $(seq 1 200))")" "2"
eq "missing args refused" "$(rc "$L" acme add x light a)" "2"

eq "drop" "$(rc "$L" acme drop contracts-only)" "0"
eq "rule gone" "$(grep -c 'contracts-only' "$T/acme/lanes.md" || true)" "0"
eq "other rule kept" "$(grep -c 'big-refactor' "$T/acme/lanes.md")" "1"
eq "drop unknown" "$(rc "$L" acme drop nope)" "1"
eq "id prefix is not a match" "$(rc "$L" acme drop big)" "1"

echo "lane-rules.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
