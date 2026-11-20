# shellcheck shell=bash
# board-setup.sh — the fixture squad, fake backend, mkdb/render/board helpers and jt/eq every tests/board*.sh file builds (sourced, not run).
# The caller sets ROOT and `set -euo pipefail`; this sets LBL, SD, TMP, DBR, NP and the counters.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib.sh"
LBL="zzboard_$$"; SD="$DS_STATE_ROOT/$LBL/squads"
TMP="$(mktemp -d)"
trap 'rm -rf "$DS_STATE_ROOT/$LBL" "$DS_STATE_ROOT/zzord_$$" "$DS_STATE_ROOT/zzstall_$$" "$DS_STATE_ROOT/zzquiet_$$" "$DS_STATE_ROOT/zzext_$$" "$DS_STATE_ROOT/zzhdr_$$" "$TMP" "$DS_STATE_PARENT"; [ -s "$TMP/lvfake.pid" ] && kill "$(cat "$TMP/lvfake.pid")" 2>/dev/null; [ -n "${SPID:-}" ] && kill "$SPID" 2>/dev/null; true' EXIT
export MUSE_MODEL_CATALOG_DIR="$TMP/emptycat"; mkdir -p "$TMP/emptycat"   # hermetic: no host muse rows
mkdir -p "$SD"
cat > "$SD/manual-testing.json" <<JSON
{"run_id":"run_9","task_id":"task_abc","type":"testing","autonomy":"checkpoints","status":"running","repo":"/no/repo",
 "devenv":"http://localhost:21300 up","worktrees":["wtLead","wtTe","wtBp"],
 "members":[
  {"role":"lead","wt":"wtLead","owns":[],"for":""},
  {"role":"tester","wt":"wtTe","owns":["env"],"for":""},
  {"role":"builder","suffix":"platform","wt":"wtBp","owns":["U1-U3 PR #16293"],"for":"structures","account":"work","fallback":true}],
 "units":[{"slug":"a","status":"done"},{"slug":"b","status":"dispatched","builder_wt":"wtBp","pr":"16349"},{"slug":"c","status":"planned","wait_until":4102444800}],
 "waiting_on_you":[{"id":"q1","asker":"lead","blocking":true,"question":"a blocking <b>decision</b>","since":"2026-10-08T09:00:00Z","options":["A","B"]},
                   {"id":"q0","asker":"thinker","blocking":false,"question":"soft one","since":"2026-10-08T08:00:00Z"}],
 "proposed_squads":[{"id":"fix-7","topic":"escrow-vault-bug","repo":"path:/r","framing":"x","status":"proposed"}]}
JSON
# A plan the Thinker saved beside the squad state (the board ships its markdown for the modal).
printf '# Plan\n\nPLAN-MARKER-123 the unit breakdown\n' > "$SD/manual-testing-alpha-plan.md"
printf '# Older\n' > "$SD/manual-testing-beta-plan.md"; touch -d '3 days ago' "$SD/manual-testing-beta-plan.md"
# The backend for the loop's fulfillers of the board's requests (poke, keys), run by ff below. The
# board itself never calls a backend.
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${BOARD_LOG:-/dev/null}"
case "$1" in
  poke)          sleep 0.3; printf '%s\t%s\n' "$2" "$3" >> "$(dirname "$0")/poke.log"; printf 'poke\t%s\n' "$3" >> "$(dirname "$0")/seq.log"; exit "$(cat "$(dirname "$0")/poke.rc" 2>/dev/null || echo 0)" ;;
  keys)          [ -f "$(dirname "$0")/keys.close" ] && cat "$(dirname "$0")/keys.close" >> "$(dirname "$0")/t.jsonl"  # the picker closes as the key lands
                 printf '%s\t%s\n' "$2" "$3" >> "$(dirname "$0")/keys.log"; printf 'keys\t%s%s\n' "$3" "${4:+ +$4}" >> "$(dirname "$0")/seq.log"; exit "$(cat "$(dirname "$0")/keys.rc" 2>/dev/null || echo 0)" ;;
  ping)          printf '%s\t%s\n' "$2" "$3" >> "$(dirname "$0")/ping.log"; echo '{}' ;;
  *) echo '{}' ;;
esac
FAKE
chmod +x "$TMP/fakeb"

export BOARD_LOG="$TMP/board.log"; : > "$BOARD_LOG"

# loop.db: built in a staging root from state/<label> (+ HOSTST's accounts.tsv / tokens.tsv, and
# DS_TOKENS_FILE) by `bin/ds import` and tests/board-db.ts with $SEED, then moved into $DBR, which
# holds loop.db only. The default seed is manual-testing's crew as Orca sees it: wtLead working,
# wtTe waiting, wtBp working with two live terminals (a duplicate), three live worktrees.
DBR="$TMP/db"; mkdir -p "$DBR"
SEED="$TMP/seed.json"
cat > "$SEED" <<'JSON'
{"workers":[["wtLead","working","ds-lead"],["wtTe","waiting","ds-tester"],["wtBp","working","ds-bp"]],
 "terminals":[["term_a","wtLead","manual-testing"],["term_b","wtBp","manual-testing"],["term_c","wtBp","manual-testing"]],
 "worktrees":[["wtLead",null],["wtTe",null],["wtBp",null]]}
JSON
mkdb(){ # <label>...
  local st="$TMP/stage" l
  rm -rf "$st"; mkdir -p "$st"
  for l in "$@"; do [ ! -d "$DS_STATE_ROOT/$l" ] || cp -a "$DS_STATE_ROOT/$l" "$st/$l"; done
  # What the served board's write routes wrote (it runs with DS_STATE_ROOT=$DBR) goes in too.
  for l in "$@"; do for cf in limits.conf roles.conf; do [ ! -f "$DBR/$l/$cf" ] || { mkdir -p "$st/$l"; cp "$DBR/$l/$cf" "$st/$l/"; }; done; done
  [ -z "${HOSTST:-}" ] || cp -a "$HOSTST"/. "$st"/
  [ -z "${DS_TOKENS_FILE:-}" ] || cp "$DS_TOKENS_FILE" "$st/tokens.tsv"
  DS_STATE_ROOT="$st" "$ROOT/bin/ds" import >/dev/null
  DS_STATE_ROOT="$st" bun "$ROOT/tests/board-db.ts" "$SEED" "$@"
  # ACCT_OFF="claude:b ..." : those accounts are switched off, as `ds account disable` does.
  for a in ${ACCT_OFF:-}; do DS_STATE_ROOT="$st" "$ROOT/bin/ds" account disable "$a" >/dev/null; done
  # MEMBER_WISH="<member> <ds want args>" : one member wish written as `ds want member` does (U151).
  # shellcheck disable=SC2086 # the args are words on purpose
  [ -z "${MEMBER_WISH:-}" ] || DS_STATE_ROOT="$st" "$ROOT/bin/ds" want member $MEMBER_WISH >/dev/null
  # U256: after the cut-over the served board's settings writes are config rows in $DBR/loop.db, the
  # only copy; carry each project's rows into the rebuilt db before it replaces that one.
  [ ! -f "$DBR/loop.db" ] || bun -e 'const {Database}=require("bun:sqlite");const d=new Database(process.argv[1]);d.run("ATTACH ? AS old",[process.argv[2]]);d.run("INSERT OR REPLACE INTO main.config SELECT * FROM old.config WHERE project <> \x27\x27")' "$st/loop.db" "$DBR/loop.db"
  rm -f "$DBR"/loop.db*; mv "$st"/loop.db* "$DBR"/; rm -rf "$st"
}
# The PATH every render gets: this one minus orca, gh and git.
NP="$TMP/nopath"; mkdir -p "$NP"
IFS=: read -r -a _dirs <<< "$PATH"
for d in "${_dirs[@]}"; do for f in "$d"/*; do n="${f##*/}"
  case "$n" in orca|gh|git) continue ;; esac
  [ -x "$f" ] && [ ! -e "$NP/$n" ] && ln -s "$f" "$NP/$n"; done; done 2>/dev/null || true
# render <label> [args]: board.sh on $DBR with state/<label> moved away and NP as PATH.
render(){
  local l="$1" rc=0
  [ ! -d "$DS_STATE_ROOT/$l" ] || mv "$DS_STATE_ROOT/$l" "$TMP/hidden-$l"
  DS_STATE_ROOT="$DBR" PATH="$NP" "$ROOT/bin/board/board.sh" "$@" || rc=$?
  [ ! -d "$TMP/hidden-$l" ] || mv "$TMP/hidden-$l" "$DS_STATE_ROOT/$l"
  return "$rc"
}
tb(){ mkdb "$1"; render "$@"; }   # the text board

pass=0; fail=0
# jt <name> <json-file> <jq-filter>: passes when the filter is true for the file.
jt(){ if jq -e "$3" "$2" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$3] got: $(jq -c "${4:-.}" "$2" 2>&1 | head -c 300)" >&2; fi; }
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want $3, got $2)" >&2; fi; }
export DS_LIMIT_COMPACT_IDLE_MIN=7  # an env-set limit for the /api/limits tests
board(){ mkdb "$1"; render "$@" --json; }
# helpers the parts share (defined mid-file in the one-file board test)
dbw(){ bun -e 'const {Database}=require("bun:sqlite");const d=new Database(process.argv[1]);d.run(process.argv[2])' "$DBR/loop.db" "$1"; }
mq(){ printf '{"run_id":"%s","status":"%s","type":"feature","members":[{"role":"lead","wt":"wl"}%s],"units":%s}' "$1" "$2" "$3" "$4" > "$SD/$1.json"; }
ds_of(){ echo ".squads[] | select(.topic==\"$1\") | $2"; }
has(){ if printf '%s' "$2" | grep -F -- "$3" >/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — missing [$3]" >&2; fi; }
lines(){ if printf '%s\n' "$2" | grep -xF -- "$3" >/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — no exact line [$3]" >&2; fi; }
hasre(){ if printf '%s\n' "$2" | grep -E -- "$3" >/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — no match for [$3]" >&2; fi; }
tokboard(){ DS_TOKENS_FILE="$TMP/tokens.tsv" tb "$LBL" "$@"; }
# briefs_fixture: ten dated briefs and a notes file under state/<label>/briefings (U5), as the one-file test wrote them mid-way.
briefs_fixture() {
  BD="$DS_STATE_ROOT/$LBL/briefings"; mkdir -p "$BD"
  for d in 2026-11-02 2026-11-03 2026-11-04 2026-11-05 2026-11-06 2026-11-09 2026-11-10 2026-11-11 2026-11-12 2026-11-13; do printf '# Brief %s\n\nNeeds you: nothing.\n' "$d" > "$BD/$d.md"; done
  printf 'notes\n' > "$BD/notes.md"   # not a dated brief: not imported
}
RD="$DS_STATE_ROOT/zzrdy_$$/squads"; mkdir -p "$RD"
# st11_fixture: the host state dir with the 11-column accounts.tsv several tests read through HOSTST.
st11_fixture() {
  mkdir -p "$TMP/st11"
  printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills\nclaude\tsystem\t72\t-\t41\t-\t-\t%s\tme@example.com\t-\tbroken: compound-engineering not installed\nclaude\tb\t-\t-\t-\t-\t-\t%s\tb@example.com\t-\twarn: no config dir\nclaude\tc\t10\t-\t5\t-\t-\t%s\tc@example.com\t-\tok\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\tMuse\t-\t-\n' "$NOW" "$NOW" "$NOW" "$NOW" > "$TMP/st11/accounts.tsv"
}
NOW="$(date +%s)"
