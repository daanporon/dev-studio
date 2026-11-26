#!/usr/bin/env bash
# host-no-orca.sh — orca-backend-alternatives U58: a project whose Studio and squads run on tmux needs no Orca for
# the host commands. With Orca absent (the adapter a stub that logs and exits 127, no `orca` on PATH), `ds team`,
# `directory.sh list|reach`, `set-orca-depth` and `account-skills check` exit 0 with their line
# and never call the stub for that project (`accounts-refresh` lists loop.db's accounts, issue #125); a Studio off Orca asking an Orca-only verb gets `<verb>: not on tmux`,
# exit 2, no stack. tests/board.sh covers the board side by side with an Orca project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zznoorca_$$"; SD="$DS_STATE_ROOT/$LBL"
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$SD" "$TMP"'
unset DS_MEMBER DS_BACKEND BACKEND DS_ORCA_CLI_BIN_DIR ORCA_CLI_BIN_DIR || true

pass=0; fail=0
ok()  { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1"; [ -n "${2:-}" ] && printf '  got: %s\n' "$2"; return 0; }
check() { if [ "$2" = "$3" ]; then ok; else bad "$1" "$3 (want $2)"; fi; }
has()   { case "$2" in *"$3"*) ok ;; *) bad "$1" "$2" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1" "$2" ;; *) ok ;; esac; }

# The project: Studio on tmux (dispatcher.json), one squad on tmux whose members are local:: worktrees.
q() { bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1]!);
  const r = d.query(process.argv[2]!).get() as Record<string, unknown> | null; if (r) console.log(Object.values(r)[0]);' "$DS_STATE_ROOT/loop.db" "$1"; }
mkdir -p "$SD/squads"
echo '{"home_repo":"zznoorca","studio_backend":"tmux"}' > "$SD/dispatcher.json"
"$ROOT/bin/ds" import >/dev/null 2>&1 || true
# The squad's backend is written once, at spawn: the row first, then its file imported over it.
q "INSERT INTO squads (project, topic, observed_at, updated_at, backend, worktree_provider) VALUES ('$LBL', 'sq', 1, 1, 'tmux', 'git')" >/dev/null
printf '{"topic":"sq","status":"running","type":"feature","run_id":"r-sq","members":[
  {"role":"lead","wt":"local::%s/lead","owns":[],"for":""},
  {"role":"builder","suffix":"u1","wt":"local::%s/b1","owns":["u1"],"for":""}]}\n' "$TMP" "$TMP" > "$SD/squads/sq.json"
"$ROOT/bin/ds" import >/dev/null 2>&1 || true
check "fixture: the squad is on tmux" "tmux" "$(q "SELECT backend FROM squads WHERE project = '$LBL' AND topic = 'sq'")"

# Orca absent: the adapter a stub that logs every call and exits 127; PATH without orca; no Orca CLI dir.
LOG="$TMP/orca.log"; : > "$LOG"
cat > "$TMP/orca-stub" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
exit 127
STUB
chmod +x "$TMP/orca-stub"
mkdir -p "$TMP/nobin" "$TMP/xdg"
mkdir -p "$TMP/bunbin"; ln -s "$(command -v bun)" "$TMP/bunbin/bun"   # bun alone: its own folder may hold an orca
NOPATH="$TMP/bunbin:/usr/bin:/bin"
export STUB_LOG="$LOG" PATH="$NOPATH" XDG_CONFIG_HOME="$TMP/xdg" DS_ORCA_DATA="$TMP/xdg/orca"
check "fixture: no orca on PATH" "" "$(command -v orca || true)"

# ds team: the roster, with no Orca call (a host shell: no `current`; contract members: no worker-states).
rc=0; out="$(BACKEND="$TMP/orca-stub" "$ROOT/bin/ds" team "$LBL" 2>&1)" || rc=$?
check "team: exits 0" "0" "$rc"
has "team: lists the squad's builder" "$out" "builder-u1"
check "team: never calls the Orca stub" "" "$(cat "$LOG")"
# --switch: no focus or terminal-switch on tmux, so the attach line, exit 0.
rc=0; out="$(BACKEND="$TMP/orca-stub" "$ROOT/bin/ds" team "$LBL" --topic sq --switch builder-u1 2>&1)" || rc=$?
check "team --switch: exits 0" "0" "$rc"
has "team --switch: prints the tmux attach line" "$out" "tmux -L ds-$LBL attach"
check "team --switch: never calls the Orca stub" "" "$(cat "$LOG")"
rc=0; out="$(BACKEND="$TMP/orca-stub" "$ROOT/bin/ds" team "$LBL" --topic sq --reap 2>&1)" || rc=$?
check "team --reap: exits 0" "0" "$rc"
has "team --reap: leaves the terminals to the loop" "$out" "on tmux: the loop closes its stray and duplicate terminals"
check "team --reap: never calls the Orca stub" "" "$(cat "$LOG")"

# directory.sh list|reach: the phone book, with no Orca call.
rc=0; out="$(BACKEND="$TMP/orca-stub" "$ROOT/bin/lib/directory.sh" list --project "$LBL" 2>&1)" || rc=$?
check "directory list: exits 0" "0" "$rc"
has "directory list: lists the builder" "$out" "builder"
rc=0; BACKEND="$TMP/orca-stub" "$ROOT/bin/lib/directory.sh" check sq builder-u1 --project "$LBL" >/dev/null 2>&1 || rc=$?
check "directory check: exits 0" "0" "$rc"
# reach: no tmux pane runs in the fixture, so the driver's answer is "not running" (exit 3), not an Orca failure.
rc=0; out="$(BACKEND="$TMP/orca-stub" "$ROOT/bin/lib/directory.sh" reach sq builder-u1 --project "$LBL" 2>&1)" || rc=$?
check "directory reach: not running, from the driver" "3" "$rc"
has "directory reach: says no live terminal" "$out" "no live terminal"
check "directory: never calls the Orca stub" "" "$(cat "$LOG")"

# set-orca-depth: Orca's own setting, nothing to do (by --project, and by the member's project).
rc=0; out="$(BACKEND="$TMP/orca-stub" "$ROOT/bin/ds" set-orca-depth --project "$LBL" 2>&1)" || rc=$?
check "set-orca-depth: exits 0" "0" "$rc"
check "set-orca-depth: says so in one line" "set-orca-depth: Orca only, nothing to do for $LBL on tmux" "$out"
rc=0; out="$(DS_MEMBER="$LBL/sq/lead" BACKEND="$TMP/orca-stub" "$ROOT/bin/ds" set-orca-depth 6 2>&1)" || rc=$?
check "set-orca-depth from a member: exits 0 with the line" "0 set-orca-depth: Orca only, nothing to do for $LBL on tmux" "$rc $out"
check "set-orca-depth: never calls the Orca stub" "" "$(cat "$LOG")"

# Accounts (issue #125, U1): with no Orca CLI where the adapter looks, the refresh lists loop.db's table (a ds row
# here) and the logged-in system login, prints no skip line, and says Orca is absent.
mkdir -p "$TMP/home/.claude" "$TMP/zzds"; : > "$TMP/home/.claude/.credentials.json"
q "INSERT INTO accounts (agent, account, source, config_dir, observed_at) VALUES ('claude', 'zzds', 'ds', '$TMP/zzds', 1)" >/dev/null
refresh() { HOME="$TMP/home" DS_CLAUDE_SYSTEM_JSON_DIR="$TMP/home" DS_ORCA_CLI_BIN_DIR="$TMP/nobin" "$ROOT/bin/ds" accounts-refresh 2>&1; }
claude_rows() { awk -F'\t' 'NR>1 && $1=="claude"{print $2}' "$DS_STATE_ROOT/accounts.tsv" | sort | tr '\n' ' '; }
rc=0; out="$(refresh)" || rc=$?
check "accounts-refresh: exits 0" "0" "$rc"
hasnt "accounts-refresh: no issue #125 skip line" "$out" "issue #125"
check "accounts-refresh: the ds row and the system login" "system zzds " "$(claude_rows)"
check "accounts-refresh: Orca absent" "orca: absent" "$(head -1 "$DS_STATE_ROOT/accounts-orca.tsv")"
rc=0; out="$(DS_ORCA_CLI_BIN_DIR="$TMP/nobin" "$ROOT/bin/ds" account-skills check 2>&1)" || rc=$?
check "account-skills check: exits 0" "0" "$rc"
has "account-skills check: names issue #125" "$out" "issue #125"
# An Orca CLI that is there but does not answer (exits 127): the adapter's preflight fails, the same one line.
ln -s "$TMP/orca-stub" "$TMP/nobin/orca"
rm -f "$DS_STATE_ROOT/accounts.tsv"
rc=0; out="$(refresh)" || rc=$?
check "accounts-refresh, Orca not answering: exits 0, no #125 line, the table's list" "0 0 system zzds " "$rc $(printf '%s\n' "$out" | grep -c 'issue #125') $(claude_rows)"
check "accounts-refresh, Orca not answering: unreachable" "orca: unreachable" "$(head -1 "$DS_STATE_ROOT/accounts-orca.tsv")"
rc=0; out="$(DS_ORCA_CLI_BIN_DIR="$TMP/nobin" "$ROOT/bin/ds" account-skills check 2>&1)" || rc=$?
check "account-skills check, Orca not answering: exits 0 with the #125 line" "0 1" "$rc $(printf '%s\n' "$out" | grep -c 'issue #125')"
rm -f "$TMP/nobin/orca"; : > "$LOG"

# The Studio off Orca: an Orca-only verb with no contract path is refused in one line, exit 2, no stack and no
# Orca call; a member verb still goes to the contract; `preflight` (the host's accounts) stays on the host.
probe() { DS_MEMBER="$LBL/_studio/studio" DS_ORCA_CLI_BIN_DIR="$TMP/nobin" bun -e '
  import { backend } from "'"$ROOT"'/bin/lib/shared.ts";
  const r = await backend([process.argv[1]!]); process.stdout.write(r.err); process.exit(r.rc);' "$1" 2>&1; }
for verb in ps loop-terminals studio-start repo-ensure worktree-ensure; do
  rc=0; out="$(probe "$verb")" || rc=$?
  check "studio off Orca: $verb is refused" "2 $verb: not on tmux" "$rc $out"
done
rc=0; out="$(probe ps)" || rc=$?
hasnt "studio off Orca: no stack" "$out" "    at "
check "studio off Orca: the refusals never call Orca" "" "$(cat "$LOG")"
rc=0; out="$(probe preflight)" || rc=$?
hasnt "studio off Orca: preflight is not refused" "$out" "not on tmux"

echo "host-no-orca: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
