#!/usr/bin/env bash
# start-pick — add-role starts on what `bin/ds pick` (the loop's picker) says, and records
# it; no account free holds a Builder's unit / refuses a spawn; the roster override (roles.sh) and a
# unit's tier and PR phase reach the picker. loop.db is seeded from a fixture accounts.tsv and the
# roles.conf files by `ds import` (a temp DS_STATE_ROOT); the clock is pinned by DS_NOW. The picker's own
# rules (fill-first, floors, plans, caps) are tests/loop/pick.test.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
mkdir -p "$TMP/state"; export DS_STATE_ROOT="$TMP/state"   # temp root: no write to the live state (U253)
LABEL="pickseam-$$"; SD="$DS_STATE_ROOT/$LABEL"
trap 'rm -rf "$TMP" "$SD"' EXIT
mkdir -p "$TMP/state/$LABEL/squads"   # a project dir with squads/: what `ds import` discovers
export MUSE_MODEL_CATALOG_DIR="$TMP/emptycat"; mkdir -p "$TMP/emptycat"   # hermetic: no host muse rows

cat > "$TMP/backend" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PK/calls"
case "$1" in
  run-create)        echo run_pk ;;
  task-create)       echo task_pk ;;
  wt-create)         echo wtLead ;;
  role-start)        echo "wt-$7" ;;
  ps)                echo '{"result":{"worktrees":[]}}' ;;
esac
FAKE
chmod +x "$TMP/backend"
export PK="$TMP" BACKEND="$TMP/backend" DS_STATE_ROOT="$TMP/state"
N="$(date +%s)"; export DS_NOW="$N"   # real now: ready-units compares wait_until with jq's clock

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }

T=$'\t'
accounts() { printf '%s\n' "$@" > "$TMP/account-list"; }          # accounts "claude${T}a${T}A" ...
# usage <agent> <account> <session%> <session_reset> <weekly%> <weekly_reset> <limited_until>
HDR="agent${T}account${T}session_pct${T}session_reset${T}weekly_pct${T}weekly_reset${T}limited_until${T}updated"
usage_reset() { printf '%s\n' "$HDR" > "$TMP/state/accounts.tsv"; }
usage() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" "$N" >> "$TMP/state/accounts.tsv"; }
# sync: loop.db from the fixtures — a listed account with no usage row is unknown usage; the project's
# roles.conf (written to $SD/roles.conf by a case) is the override `ds import` reads.
sync() {
  local a b
  [ -f "$TMP/state/accounts.tsv" ] || usage_reset
  while IFS=$'\t' read -r a b _; do
    [ -n "$a" ] || continue
    awk -F'\t' -v a="$a" -v b="$b" '$1==a && $2==b{f=1} END{exit !f}' "$TMP/state/accounts.tsv" || usage "$a" "$b" - - - - -
  done < "$TMP/account-list"
  : # roles.conf already sits in the temp state root (SD is under it)
  rm -f "$TMP/state"/loop.db*
  "$ROOT/bin/ds" import >/dev/null
}
row() { printf '%s\t%s\t%s\t%s\t%s' "$@"; }
pick() { sync; "$ROOT/bin/ds" pick "$LABEL" "$@" 2>/dev/null; }

two() { accounts "claude${T}a${T}first" "claude${T}b${T}second" "muse${T}default${T}default"; usage_reset; }

SF="$SD/squads/t.json"; mkdir -p "$SD/squads"

# --- add-role: a wish writer; the loop picks and starts (U157) -----------------------
printf '{"home_repo":"path:/r"}' > "$SD/dispatcher.json"
newsquad() { printf '{"run_id":"run_x","lead_wt":"wtLead","status":"running","units":[{"slug":"u2","status":"planned","deps":["u1"],"tier":"hard"}]}' > "$SF"; mkdir -p "$TMP/state/$LABEL/squads"; : > "$TMP/calls"; }
dbq() { bun -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$TMP/state/loop.db" "$1"; }
addrole() { sync; "$ROOT/bin/commands/add-role.sh" "$LABEL" t "$@"; }

newsquad; two; usage claude a 72 $((N + 7200)) 41 - -; usage claude b 34 $((N + 1800)) 18 - -
addrole builder u2 --spec x >/dev/null 2>&1
eq "add-role: writes a wish, no backend call" "$(cat "$TMP/calls")" ""
eq "add-role: wish running, requested, unplaced (tier comes from the unit at pick)" "$(dbq "SELECT want, json_extract(want_payload, '$.request'), json_extract(want_payload, '$.unit'), agent IS NULL, tier IS NULL, phase, status FROM members WHERE suffix = 'u2'")" "running	1	u2	1	1	build	wanted"
"$ROOT/bin/commands/add-role.sh" "$LABEL" t builder u2 --spec x >"$TMP/out" 2>&1
eq "add-role: asking again is a no-op" "$(jq -r .changed "$TMP/out")" "false"
addrole builder u2 --agent codex --model opus --spec x >/dev/null 2>&1
eq "add-role: placement flags are ignored, nothing pinned" "$(dbq "SELECT json_extract(want_payload, '$.agent') IS NULL, json_extract(want_payload, '$.model') IS NULL FROM members WHERE suffix = 'u2'")" "1	1"
rc=0; addrole builder u9 --spec x >/dev/null 2>&1 || rc=$?
eq "add-role: unknown unit refuses" "$rc" "2"
eq "  and writes nothing" "$(dbq "SELECT COUNT(*) FROM members")" "0"
addrole reviewer r1 --spec x >/dev/null 2>&1
eq "add-role reviewer: wish, no unit" "$(dbq "SELECT role, want, json_extract(want_payload, '$.request') FROM members WHERE suffix = 'r1'")" "reviewer	running	1"
rc=0; addrole lead x >/dev/null 2>&1 || rc=$?
eq "add-role lead: refused" "$rc" "2"

# --- one login, two folders (issue #125 U3) -----------------------------------------------
newsquad; two; usage claude a 10 $((N + 1800)) 18 - -; usage claude b 72 $((N + 7200)) 41 - -; sync
bun -e 'const { Database } = require("bun:sqlite"); new Database(process.argv[1]).run("UPDATE accounts SET login_id = ?, is_default = (account = ?) WHERE agent = ? AND account IN (?, ?)", ["L1", "b", "claude", "a", "b"])' "$TMP/state/loop.db"
eq "one login: the default folder is offered, though the other has more room" \
  "$("$ROOT/bin/ds" pick "$LABEL" builder --tier standard 2>/dev/null | cut -f4)" "b"

# --- spawn-squad (U158): only a wish; the loop picks and starts (tests/loop/squad-lifecycle.test.ts).
# The pick itself is covered above through add-role and `ds pick`.

# --- roles.sh: the 6th column ------------------------------------------------------------
RP="rolespk-$$"; trap 'rm -rf "$TMP" "$SD" "$DS_STATE_ROOT/$RP"' EXIT
# The project's own roles rows (U256: loop.db rows, read through the export; no roles.conf file).
ownroles() { "$ROOT/bin/ds" config export --project "$RP" | awk '/^#== /{s=($2=="roles.conf");next} s&&NF'; }
fbof() { ownroles | awk -v r="$1" '$1==r{print $6}'; }
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus >/dev/null
# The default's own row (claude opus, its list): settings.ts writes no row, the role keeps the default's list.
eq "roles.sh set, fallbacks omitted: keeps the default's" "$("$ROOT/bin/commands/roles.sh" list --json "$RP" | jq -r '.roles[]|select(.role=="builder")|.fallbacks')" "claude:sonnet,muse:muse-spark-1.3"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" high "muse:x,claude:sonnet" >/dev/null
eq "roles.sh set: writes the list (effort kept)"  "$(ownroles | awk '$1=="builder"{print $5" "$6}')" "high muse:x,claude:sonnet"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus >/dev/null
eq "roles.sh set again, omitted: keeps the current list" "$(fbof builder)" "muse:x,claude:sonnet"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" - >/dev/null
eq "roles.sh set -: clears it"                     "$(fbof builder)" ""
rc=0; "$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" bad >/dev/null 2>&1 || rc=$?
eq "roles.sh set: malformed list exits 2"          "$rc" "2"
has "roles.sh list shows the column"               "$("$ROOT/bin/commands/roles.sh" list "$RP")" "(none)"

# --- roles.sh --json / reset (B8) ---------------------------------------------------------
rj() { "$ROOT/bin/commands/roles.sh" list --json "$RP"; }
"$ROOT/bin/commands/roles.sh" reset "$RP" builder >/dev/null
eq "reset: the project's row is gone (U267)"       "$(ownroles | awk '$1=="builder"')" ""
eq "reset: the role runs the default row again"    "$(rj | jq -r '.roles[]|select(.role=="builder")|[.agent,.model,.spawn,.fallbacks,.source]|join(" ")')" "$(awk '$1=="builder"{print $2,$3,$4,$6,"default"}' "$ROOT/conventions/roles.conf")"
"$ROOT/bin/commands/roles.sh" set "$RP" builder-standard claude sonnet "" high "claude:opus,muse:muse-spark-1.3" >/dev/null
eq "--json: override row differs from default"     "$(rj | jq -r '.roles[]|select(.role=="builder-standard")|[.source,.effort,.fallbacks,.default.fallbacks]|join("|")')" "override|high|claude:opus,muse:muse-spark-1.3|claude:opus"
eq "--json: untouched rows stay default"           "$(rj | jq -r '[.roles[]|select(.role!="builder-standard")|.source]|unique|join(",")')" "default"
eq "--json: catalog for the pickers"               "$(rj | jq -r '[(.catalog[]|select(.model=="sonnet")|.label),(.catalog[]|select(.agent=="muse")|.model)]|join(",")')" "Claude · Sonnet,muse-spark,muse-wonder,muse-wonder-full,muse-spark-1.3"
# the unit's start really uses the override (Done: ds pick follows the board's roles.conf)
two; usage_reset; usage claude a 72 $((N + 7200)) 41 - -; usage claude b 34 $((N + 1800)) 18 - -   # fresh usage: earlier cases leave rows behind
mkdir -p "$TMP/state/$RP/squads"; "$ROOT/bin/ds" import >/dev/null
eq "ds pick follows the override's effort"    "$("$ROOT/bin/ds" pick "$RP" builder --tier standard 2>/dev/null | cut -f1-3 | tr '\t' ' ')" "claude sonnet high"
"$ROOT/bin/commands/roles.sh" reset "$RP" builder-standard >/dev/null
eq "reset: --json says default again"              "$(rj | jq -r '.roles[]|select(.role=="builder-standard")|.source')" "default"
eq "reset: roster not shrunk"                      "$(rj | jq '.roles|length')" "$(grep -cvE '^[[:space:]]*(#|$)' "$ROOT/conventions/roles.conf")"
rc=0; "$ROOT/bin/commands/roles.sh" reset "$RP" nope >/dev/null 2>&1 || rc=$?
eq "reset: unknown role exits 2"                   "$rc" "2"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus ondemand - 'claude:opus:-:Ultra' Max >/dev/null
eq "roles.sh round-trips both step plans" "$(rj | jq -r '.roles[]|select(.role=="builder")|[.plan,.fallbacks]|join("|")')" "Max|claude:opus:-:Ultra"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus >/dev/null
eq "roles.sh omitted plan keeps the first step" "$(rj | jq -r '.roles[]|select(.role=="builder")|.plan')" "Max"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus ondemand - - - >/dev/null
eq "roles.sh explicit Any clears the first step" "$(rj | jq -r '.roles[]|select(.role=="builder")|.plan')" ""

echo "start-pick: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
