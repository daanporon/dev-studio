#!/usr/bin/env bash
# ship-mode.sh / ds_ship_mode — view+set a project's ship mode, operator override wins, survives
# updates (the project's ship-mode row), default is ce-pipeline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
# shellcheck source=tests/lib/twins.sh
. "$ROOT/tests/lib/twins.sh"
LBL="zzmode_$$"
trap 'rm -rf "$DS_STATE_ROOT/$LBL"' EXIT

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — missing [$3]" >&2; fi; }

eq "default is ce-pipeline"              "$(ds_ship_mode "$LBL")" "ce-pipeline"

"$ROOT/bin/commands/ship-mode.sh" "$LBL" no-mistakes >/dev/null
eq "set writes the override"             "$(ds_ship_mode "$LBL")" "no-mistakes"
eq "override stored as a row (U256)"     "$("$ROOT/bin/ds" --state "$DS_STATE_ROOT" config get "$LBL" ship-mode mode | jq -r .value)" "no-mistakes"
eq "...and no ship-mode file"            "$(test -e "$DS_STATE_ROOT/$LBL/ship-mode" && echo file || echo none)" "none"
has "view reports the current mode"      "$("$ROOT/bin/commands/ship-mode.sh" "$LBL")" "no-mistakes"

rc=0; "$ROOT/bin/commands/ship-mode.sh" "$LBL" bogus >/dev/null 2>&1 || rc=$?
eq "invalid mode rejected"               "$rc" "2"
eq "invalid mode didn't change it"       "$(ds_ship_mode "$LBL")" "no-mistakes"

"$ROOT/bin/commands/ship-mode.sh" "$LBL" default >/dev/null
eq "clearing reverts to default"         "$(ds_ship_mode "$LBL")" "ce-pipeline"
eq "override file removed"               "$([ -f "$DS_STATE_ROOT/$LBL/ship-mode" ] && echo yes || echo no)" "no"

echo "ship-mode: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
