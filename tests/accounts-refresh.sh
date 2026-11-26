#!/usr/bin/env bash
# accounts-refresh.sh — its arguments, the --max-age staleness guard, the one-refresh-at-a-time lock
# (.accounts-refresh.lock), and that a limit episode blocks an account only for a real limit on a
# member with a recorded account. Fake backends log or stub their calls; each suite has its own temp
# state root and the second pins the clock with DS_NOW; never the live state.
# Issue #125 (U1): the list comes from loop.db's accounts table (seeded here) plus Orca's profiles (a fake
# `orca` in DS_ORCA_CLI_BIN_DIR, none by default), not from the backend's account-list.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/state"
# The skills column reads each account's config dir; `system` is ~/.claude, so never the caller's.
unset CLAUDE_CONFIG_DIR DS_CLAUDE_SYSTEM_JSON_DIR CODEX_HOME XDG_CONFIG_HOME; export HOME="$TMP/home"; mkdir -p "$HOME"
# No orca CLI unless a suite puts one here, and Orca's data folder is the temp dir's.
export DS_ORCA_CLI_BIN_DIR="$TMP/nobin" DS_ORCA_DATA="$TMP/orca"; mkdir -p "$TMP/nobin"

# seed <state> <agent:account:source:folder[:default]>...: loop.db migrated, with these accounts rows; a
# folder is made on disk ("-": no config_dir).
cat > "$TMP/seed.ts" <<'TS'
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
const [db, ...specs] = process.argv.slice(2);
const d = new Database(db);
d.run("DELETE FROM accounts");
for (const s of specs) {
  const [agent, account, source, dir, dflt] = s.split(":");
  if (dir !== "-") mkdirSync(dir, { recursive: true });
  d.run("INSERT INTO accounts (agent, account, source, config_dir, is_default, observed_at) VALUES (?, ?, ?, ?, ?, 1)",
    [agent, account, source === "-" ? null : source, dir === "-" ? null : dir, dflt ? 1 : 0]);
}
d.close();
TS
seed() { local st="$1"; shift; mkdir -p "$st"; "$ROOT/bin/ds" --state "$st" migrate >/dev/null; bun "$TMP/seed.ts" "$st/loop.db" "$@"; }

cat > "$TMP/backend" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$AR/calls"
case "$1" in
  account-list) cat "$AR/account-list" 2>/dev/null || true ;;
esac
FAKE
chmod +x "$TMP/backend"
export AR="$TMP" BACKEND="$TMP/backend" DS_STATE_ROOT="$TMP/state"
S="$TMP/state"; OUT="$S/accounts.tsv"; LOCK="$S/.accounts-refresh.lock"
seed "$S" "claude:a1:ds:$TMP/acct/a1"

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
calls() { cat "$TMP/calls" 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
run() { rm -f "$TMP/calls"; set +e; "$ROOT/bin/lib/accounts-refresh.sh" "$@" >/dev/null 2>&1; rc=$?; set -e; }

run --bogus
eq "an unknown argument exits 2" "$rc" "2"
eq "an unknown argument calls no backend" "$(calls)" ""

run
eq "a refresh exits 0" "$rc" "0"
eq "a refresh reads the accounts, their usage and the limits" "$(calls)" "account-usage account-resets limited status account-list"
eq "a refresh writes accounts.tsv: the table's row, then muse's and codex's own login" "$(awk -F'\t' 'NR>1{print $1":"$2}' "$OUT" | tr '\n' ' ')" "claude:a1 muse:default codex:default "
eq "a refresh releases the lock" "$([ -e "$LOCK" ] && echo held || echo free)" "free"

run --max-age 60
eq "--max-age: a younger accounts.tsv is left alone" "$(calls)" ""
touch -d '@1000000000' "$OUT"
run --max-age 60
eq "--max-age: an older accounts.tsv is refreshed" "$(calls)" "account-usage account-resets limited status account-list"

printf '%s\n' "x 1 limited" > "$TMP/limited"
run --limited "$TMP/limited"
eq "--limited: the caller's rows, no backend limited read" "$(calls)" "account-usage account-resets status account-list"

mkdir "$LOCK"; before="$(cat "$OUT")"
run
eq "a held lock: exits 0" "$rc" "0"
eq "a held lock: no backend call" "$(calls)" ""
eq "a held lock: accounts.tsv untouched" "$(cat "$OUT")" "$before"
eq "a held lock: the holder's lock stays" "$([ -d "$LOCK" ] && echo held || echo free)" "held"

touch -d '@1000000000' "$LOCK"
run
eq "a lock older than 10 min is taken over" "$(calls)" "account-usage account-resets limited status account-list"
eq "the taken-over lock is released" "$([ -e "$LOCK" ] && echo held || echo free)" "free"

seed "$S"
run
eq "no accounts: exits 0" "$rc" "0"
eq "no accounts: the system login stands in" "$(awk -F'\t' 'NR==2{print $1":"$2":"$9}' "$OUT")" "claude:system:system login"
eq "no accounts: the lock is released" "$([ -e "$LOCK" ] && echo held || echo free)" "free"

# --- the skills column (account-skills U3) ---
# A complete skills home for `sys` (claude-config-dir empty -> ~/.claude), an empty one for `brk`, no
# config dir for `nodir` (warn), and a codex row that gets `-`.
DS_ROLE_CE_SKILLS="$("$ROOT/bin/ds" account-skills role-skills ce)"
DS_ROLE_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills user)"
DS_ROLE_OPTIONAL_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills optional)"
CE_ID="compound-engineering@compound-engineering-plugin"
SYS="$HOME/.claude"; SYS_PATH="$SYS/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
for sk in $DS_ROLE_CE_SKILLS; do mkdir -p "$SYS_PATH/skills/$sk"; : > "$SYS_PATH/skills/$sk/SKILL.md"; done
for sk in $DS_ROLE_USER_SKILLS $DS_ROLE_OPTIONAL_USER_SKILLS; do mkdir -p "$SYS/skills/$sk"; : > "$SYS/skills/$sk/SKILL.md"; done
printf '{"version":2,"plugins":{"%s":[{"scope":"user","installPath":"%s"}]}}' "$CE_ID" "$SYS_PATH" > "$SYS/plugins/installed_plugins.json"
printf '{"enabledPlugins":{"%s":true}}' "$CE_ID" > "$SYS/settings.json"
mkdir -p "$TMP/brk"
cat > "$TMP/sk-backend" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  account-list) printf 'claude\tsystem\tS\nclaude\tbrk\tB\nclaude\tnodir\tN\ncodex\tcx\tC\n' ;;
  claude-config-dir) case "$2" in system) echo "" ;; brk) echo "$AR/brk" ;; *) exit 1 ;; esac ;;
esac
FAKE
chmod +x "$TMP/sk-backend"
seed "$TMP/sk-state" "claude:system:system:-" "claude:brk:ds:$TMP/brk" "claude:nodir:ds:$TMP/nodir" "codex:cx:ds:$TMP/cx"
BACKEND="$TMP/sk-backend" DS_STATE_ROOT="$TMP/sk-state" bash "$ROOT/bin/lib/accounts-refresh.sh" >/dev/null 2>&1
SKT="$TMP/sk-state/accounts.tsv"
col() { awk -F'\t' -v a="$1" '$2==a{print $'"$2"'}' "$SKT"; }
eq "skills: the header gains the 11th column" "$(head -1 "$SKT" | cut -f10,11)" "note	skills"
eq "skills: every row has 13 columns" "$(awk -F'\t' '{print NF}' "$SKT" | sort -u)" "13"
eq "skills: a complete home is ok" "$(col system 11)" "ok"
case "$(col brk 11)" in "broken: "?*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL: skills: an empty home is broken: <reason> (got [$(col brk 11)])" >&2 ;; esac
case "$(col nodir 11)" in "warn: the backend has no Claude config dir"*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "  FAIL: skills: no config dir is warn (got [$(col nodir 11)])" >&2 ;; esac
eq "skills: a non-claude row gets -" "$(col cx 11)" "-"
eq "skills: note stays as it was" "$(col system 10)" "-"
eq "skills: no tab leaks into a reason" "$(awk -F'\t' 'NF!=13' "$SKT" | wc -l | tr -d ' ')" "0"

# --- the plan column (U123): oauthAccount.organizationRateLimitTier of each account's .claude.json ---
eq "plan: the header ends with plan" "$(head -1 "$SKT" | cut -f12)" "plan"
eq "plan: no .claude.json is no plan" "$(col system 12)" "-"
printf '{"oauthAccount":{"organizationRateLimitTier":"default_claude_max_5x"},"accessToken":"SECRET-TOKEN-1"}' > "$HOME/.claude.json"
printf '{"oauthAccount":{"organizationRateLimitTier":"default_claude_max_20x"}}' > "$TMP/brk/.claude.json"
refresh() { BACKEND="$TMP/sk-backend" DS_STATE_ROOT="$TMP/sk-state" bash "$ROOT/bin/lib/accounts-refresh.sh" >/dev/null 2>&1; }
refresh
eq "plan: default_claude_max_5x is Max (system reads ~/.claude.json)" "$(col system 12)" "Max"
eq "plan: default_claude_max_20x is Ultra" "$(col brk 12)" "Ultra"
eq "plan: an account whose folder has no .claude.json has none" "$(col nodir 12)" "-"
eq "plan: an agent without a reader has none" "$(col cx 12)" "-"
printf '{"oauthAccount":{"organizationRateLimitTier":"team_new_tier"}}' > "$TMP/brk/.claude.json"
refresh
eq "plan: an unknown tier keeps its raw text, and a change is picked up" "$(col brk 12)" "team_new_tier"
printf '{"oauthAccount":{}}' > "$TMP/brk/.claude.json"; refresh
eq "plan: a missing field is no plan" "$(col brk 12)" "-"
printf 'not json' > "$TMP/brk/.claude.json"; refresh
eq "plan: an unreadable file is no plan" "$(col brk 12)" "-"
eq "plan: no token reaches accounts.tsv" "$(grep -c SECRET-TOKEN "$SKT" || true)" "0"
rm -f "$HOME/.claude.json" "$TMP/brk/.claude.json"

# --- which notices block an account ---
mkdir -p "$TMP/lim-state/p/squads"
seed "$TMP/lim-state" "claude:acctA:ds:$TMP/acct/acctA" "claude:acctB:ds:$TMP/acct/acctB"

T=$'\t'
cat > "$TMP/lim-backend" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  account-list)  printf 'claude\tacctA\tA\nclaude\tacctB\tB\n' ;;
  account-usage) printf 'claude\tacctA\t10\t-\t16\t-\nclaude\tacctB\t10\t-\t42\t-\n' ;;
esac
FAKE
chmod +x "$TMP/lim-backend"
cat > "$TMP/lim-state/p/squads/s.json" <<'J'
{"members":[{"wt":"wt-noacct","agent":"claude"},{"wt":"wt-acct","agent":"claude","account":"acctB"}]}
J
export BACKEND="$TMP/lim-backend" DS_STATE_ROOT="$TMP/lim-state" DS_NOW=1000000

# lim <rows...>: refresh from a fresh episode file; prints limited_until of acctA, acctB
lim() {
  rm -f "$TMP/lim-state/.accounts.episodes"; printf '%s\n' "$@" > "$TMP/lim"
  bash "$ROOT/bin/lib/accounts-refresh.sh" --limited "$TMP/lim"
  awk -F'\t' 'NR>1 && $1=="claude"{printf "%s ", $7}' "$TMP/lim-state/accounts.tsv"
}
POOL="Request rejected (429)"; COOL="All credentials for model claude-sonnet-5-5 are cooling down"
RESET="Usage limit reset · Continuing automatically"; REAL="You've hit your weekly limit · resets 5pm"

eq "account-less member: pool 429"     "$(lim "wt-noacct${T}-${T}$POOL")" "- - "
eq "account-less member: cooling down" "$(lim "wt-noacct${T}-${T}$COOL")" "- - "
eq "account-less member: reset notice" "$(lim "wt-noacct${T}-${T}$RESET")" "- - "
eq "account-less member: real limit"   "$(lim "wt-noacct${T}2000000${T}$REAL")" "- - "
eq "unknown member: real limit"        "$(lim "wt-ghost${T}2000000${T}$REAL")" "- - "
eq "member with account: pool 429"     "$(lim "wt-acct${T}-${T}$POOL")" "- - "
eq "member with account: cooling down" "$(lim "wt-acct${T}-${T}$COOL")" "- - "
eq "member with account: reset notice" "$(lim "wt-acct${T}-${T}$RESET")" "- - "
eq "member with account: real limit, parsed reset" "$(lim "wt-acct${T}2000000${T}$REAL")" "- 2000000 "
eq "member with account: real limit, no reset -> +1h" "$(lim "wt-acct${T}-${T}$REAL")" "- 1003600 "
# a billing error (5th field credits) names no account: its own 1h limit is never stamped (the loop holds it)
CRED="model failed: API error 402 [request_id=r]: Billing verification failed"
eq "member with account: billing error -> no limit stamped" "$(lim "wt-acct${T}-${T}$CRED${T}-${T}credits")" "- - "
eq "billing error keeps a timing-only episode" "$(cut -f2-4 "$TMP/lim-state/.accounts.episodes" | tr '\t' ' ')" "1003600 - -"
eq "the same row without the credits kind would stamp" "$(lim "wt-acct${T}-${T}$CRED")" "- 1003600 "
# an ended login (5th field login) names no account either: no limited_until, and a timing-only episode
LOGIN="Invalid API key · Please run /login"
eq "member with account: ended login -> no limit stamped" "$(lim "wt-acct${T}-${T}$LOGIN${T}-${T}login")" "- - "
eq "ended login keeps a timing-only episode" "$(cut -f2-4 "$TMP/lim-state/.accounts.episodes" | tr '\t' ' ')" "1003600 - -"

# timing-only episode for a skipped notice: recorded without an account, blocks nothing
lim "wt-noacct${T}-${T}$RESET" >/dev/null
eq "skipped notice keeps a timing-only episode" "$(cut -f2-4 "$TMP/lim-state/.accounts.episodes" | tr '\t' ' ')" "1003600 - -"

# a notice that stays on screen later never extends the episode
lim "wt-acct${T}-${T}$REAL" >/dev/null
DS_NOW=1000500 bash "$ROOT/bin/lib/accounts-refresh.sh" --limited "$TMP/lim"
eq "episode not extended" "$(awk -F'\t' 'NR==3{print $7}' "$TMP/lim-state/accounts.tsv")" "1003600"

# the picker still picks a free claude account (nothing blocked), from the accounts.tsv just written
mkdir -p "$TMP/lim-state/p/squads"; rm -f "$TMP/lim-state"/loop.db*
lim "wt-noacct${T}-${T}$RESET" >/dev/null
out="$(DS_STATE_ROOT="$TMP/lim-state" DS_NOW=1000000 bash -c '"$1/bin/ds" import >/dev/null 2>&1; "$1/bin/ds" pick p builder --agent claude --model opus 2>/dev/null || true' _ "$ROOT")"
eq "picker not WAITing" "$(printf '%s' "$out" | grep -c '^WAIT' || true)" "0"

# --- the resets column (account-free-resets U3): account-resets' JSON per account, `-` without the verb ---
eq "resets: the header ends with resets" "$(head -1 "$SKT" | cut -f13)" "resets"
eq "resets: a backend without the verb writes - for every row" "$(awk -F'\t' 'NR>1{print $13}' "$SKT" | sort -u)" "-"
seed "$TMP/rs-state" "claude:acctA:ds:$TMP/acct/acctA" "claude:acctB:ds:$TMP/acct/acctB" "muse:m1:ds:$TMP/acct/m1"
cat > "$TMP/rs-backend" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  account-list)   printf 'claude\tacctA\tA\nclaude\tacctB\tB\nmuse\tm1\tM\n' ;;
  account-usage)  printf 'claude\tacctA\t10\t-\t16\t-\nclaude\tacctB\t10\t-\t42\t-\n' ;;
  account-resets) printf 'claude\tacctA\t{"state":"reported","count":1,"grants":[{"id":"g1","label":"One reset","left":1,"total":1,"use_by":1796940000,"refills":["session"],"usable_now":true}]}\nmuse\tm1\t{"state":"not_reported"}\n' ;;
esac
FAKE
chmod +x "$TMP/rs-backend"
BACKEND="$TMP/rs-backend" DS_STATE_ROOT="$TMP/rs-state" bash "$ROOT/bin/lib/accounts-refresh.sh" >/dev/null 2>&1
RST="$TMP/rs-state/accounts.tsv"
rcol() { awk -F'\t' -v a="$1" '$2==a{print $13}' "$RST"; }
eq "resets: the account's JSON lands in column 13" "$(rcol acctA)" '{"state":"reported","count":1,"grants":[{"id":"g1","label":"One reset","left":1,"total":1,"use_by":1796940000,"refills":["session"],"usable_now":true}]}'
eq "resets: Muse is not_reported" "$(rcol m1)" '{"state":"not_reported"}'
eq "resets: an account the verb skipped is -" "$(rcol acctB)" "-"
eq "resets: every row still has 13 columns" "$(awk -F'\t' '{print NF}' "$RST" | sort -u)" "13"
eq "resets: the usage columns are as without the verb" "$(awk -F'\t' '$2=="acctA"{print $3,$4,$5,$6}' "$RST")" "10 - 16 -"

# --- the list is dev-studio's (issue #125, U1): Orca's profiles, the system login, the folder scan ---
OS="$TMP/or-state"; OB="$TMP/or-bin"; OD="$TMP/or-data"; mkdir -p "$OB"
# A fake orca: `account list --json` prints $OR/orca.json (exit $OR/orca.rc, default 0).
cat > "$OB/orca" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-} ${2:-}" = "account list" ]; then cat "$OR/orca.json" 2>/dev/null; exit "$(cat "$OR/orca.rc" 2>/dev/null || echo 0)"; fi
exit 0
FAKE
chmod +x "$OB/orca"
printf '{"result":{"claude":{"activeAccountIdsByRuntime":{"host":"prof-b"},"systemDefaultEmail":"me@example.test","accounts":[{"id":"prof-a","email":"a@example.test","managedAuthRuntime":"host"},{"id":"prof-b","email":"b@example.test","managedAuthRuntime":"host"},{"id":"prof-w","email":"w@example.test","managedAuthRuntime":"wsl"}]}}}' > "$TMP/orca.json"
mkdir -p "$OD/claude-profiles/prof-a/home" "$OD/claude-profiles/prof-b/home" "$OD/claude-profiles/orphan/home"
printf '{"oauthAccount":{"accountUuid":"uuid-a"}}' > "$OD/claude-profiles/prof-a/home/.claude.json"
: > "$OD/claude-profiles/prof-a/home/.credentials.json"
seed "$OS" "claude:old:-:-"
orx() { DS_ORCA_CLI_BIN_DIR="$OB" DS_ORCA_DATA="$OD" OR="$TMP" BACKEND="$TMP/backend" DS_STATE_ROOT="$OS" bash "$ROOT/bin/lib/accounts-refresh.sh" 2>"$TMP/or-err"; }
orx
OT="$OS/accounts.tsv"
eq "orca import under another BACKEND: accounts-orca.tsv says here" "$(head -1 "$OS/accounts-orca.tsv")" "orca: here"
eq "orca import: one line per host profile, then the system login" "$(tail -n +2 "$OS/accounts-orca.tsv" | cut -f1,2,4 | tr '\t\n' ': ')" "prof-a:a@example.test:0 prof-b:b@example.test:1 system:system login (me@example.test):0 "
eq "orca import: a profile's home is its Orca folder" "$(awk -F'\t' '$1=="prof-a"{print $3}' "$OS/accounts-orca.tsv")" "$OD/claude-profiles/prof-a/home"
eq "orca import: Orca's active profile is first, the sourceless and orphan ones are not listed" "$(awk -F'\t' 'NR>1 && $1=="claude"{print $2}' "$OT" | tr '\n' ' ')" "prof-b prof-a "
eq "orca import: the label is Orca's" "$(awk -F'\t' '$2=="prof-a"{print $9}' "$OT")" "a@example.test"
eq "no skip line" "$(grep -c 'issue #125' "$TMP/or-err" || true)" "0"
eq "folder scan: Orca's profile folders, the orphan's too" "$(cut -f1,2 "$OS/account-folders.tsv" | grep -c 'claude-profiles')" "3"
eq "folder scan: a folder's login id and credentials" "$(awk -F'\t' -v d="$OD/claude-profiles/prof-a/home" '$2==d{print $3,$4}' "$OS/account-folders.tsv")" "uuid-a 1"
eq "folder scan: a folder without them" "$(awk -F'\t' -v d="$OD/claude-profiles/orphan/home" '$2==d{print $3,$4}' "$OS/account-folders.tsv")" "- 0"

mkdir -p "$HOME/.claude"; : > "$HOME/.claude/.credentials.json"; printf '{"oauthAccount":{"accountUuid":"uuid-sys"}}' > "$HOME/.claude.json"
orx
eq "a logged-in system login is a line" "$(awk -F'\t' '$1=="claude" && $2=="system"{print $9}' "$OT")" "system login (me@example.test)"
eq "folder scan: the system folder with the system login id" "$(awk -F'\t' -v d="$HOME/.claude" '$2==d{print $1,$3,$4}' "$OS/account-folders.tsv")" "claude uuid-sys 1"
rm -f "$HOME/.claude/.credentials.json" "$HOME/.claude.json"

printf '1' > "$TMP/orca.rc"; orx
eq "orca not answering: unreachable" "$(cat "$OS/accounts-orca.tsv")" "orca: unreachable"
rm -f "$TMP/orca.rc"
DS_ORCA_DATA="$OD" OR="$TMP" BACKEND="$TMP/backend" DS_STATE_ROOT="$OS" bash "$ROOT/bin/lib/accounts-refresh.sh" 2>/dev/null
eq "no orca CLI: absent" "$(cat "$OS/accounts-orca.tsv")" "orca: absent"

# A table that cannot be read keeps last run's files: a pre-0059 loop.db, then a corrupt one.
orx; before="$(cat "$OT")"; before_orca="$(cat "$OS/accounts-orca.tsv")"
rm -f "$OS"/loop.db*
mkdir -p "$TMP/old-mig"; for m in "$ROOT"/bin/loop/migrations/*.sql; do case "$(basename "$m")" in 0059-*|006*|007*|008*|009*) ;; *) cp "$m" "$TMP/old-mig/" ;; esac; done
DS_LOOP_MIGRATIONS="$TMP/old-mig" "$ROOT/bin/ds" --state "$OS" migrate >/dev/null
touch -d '@1000000000' "$OT"; orx
eq "a pre-0059 table: accounts.tsv kept" "$(cat "$OT")" "$before"
eq "a pre-0059 table: accounts-orca.tsv kept" "$(cat "$OS/accounts-orca.tsv")" "$before_orca"
eq "a pre-0059 table: one line says why" "$(grep -c 'unreadable' "$TMP/or-err")" "1"
rm -f "$OS"/loop.db*; printf 'not a database, just text long enough to be a file' > "$OS/loop.db"; orx
eq "a corrupt loop.db: accounts.tsv kept" "$(cat "$OT")" "$before"

echo "accounts-refresh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
