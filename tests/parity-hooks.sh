#!/usr/bin/env bash
# parity-hooks.sh — the hook ports (U190: bin/commands/<hook>-ts.ts, run by the hook scripts since U193) do what the shell
# bodies did, on the same recorded inputs: a Thinker/Lead woken with mail, idle without mail, busy
# (woken by its own wake with the message still there), an unbound terminal (no handle, the peek
# fails), a loop-owned squad, a done unit, a terminal picker (queued, answered, deduped), and the
# arm / reassert writes. The shell side is the tree at PARITY_BASE (default e153edd, the last commit
# before the ports), unpacked with git archive; the port side is this checkout. Each
# case runs once per tree in its own copy of the same world (state, worktrees, logs) and must match
# in stdout, stderr, exit code, every file the hook wrote (logs, state, settings, briefs, pid/shown/
# seen) and every fake-Orca call (backend and watch.sh), after the tree and world paths and the
# clock are normalised.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PARITY_BASE:-e153edd}"
# Under $XDG_RUNTIME_DIR, as tests/lib/review-unit-prelude.sh: bun starts slowly in a crowded /tmp.
TMP="$(mktemp -d -p "$( [ -d "${XDG_RUNTIME_DIR:-}" ] && [ -w "$XDG_RUNTIME_DIR" ] && echo "$XDG_RUNTIME_DIR" || echo "${TMPDIR:-/tmp}")")"
trap 'rm -rf "$TMP"' EXIT

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-hooks: $BASE is not in this clone — skipped"; echo "parity-hooks: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old" "$TMP/new"
git -C "$ROOT" archive "$BASE" bin conventions roles studio | tar -x -C "$TMP/old"
cp -r "$ROOT/bin" "$ROOT/conventions" "$ROOT/roles" "$ROOT/studio" "$TMP/new/"
mkdir "$TMP/home"; export HOME="$TMP/home"   # nothing on the host is read
unset ORCA_TERMINAL_HANDLE CLAUDE_PROJECT_DIR DS_LOOP_ACTIVITY DS_LOOP_CHILD DS_PREFIX
FIX="$ROOT/tests/fixtures"

# Fakes (one copy, both trees): the backend records each call and answers ps from the world; the
# watch.sh stand-in records its args and prints the inbox the case set (FAKE_INBOX, a file).
cat > "$TMP/fakeb" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$W/calls"
case "$1" in
  ps) printf '{"result":{"worktrees":[{"worktreeId":"wtLead","path":"%s/wtLead"},{"worktreeId":"wtB","path":"%s/wtB"},{"worktreeId":"wtStudio","path":"%s/wtStudio"},{"worktreeId":"wtNoDir","path":"%s/nope"}]}}\n' "$W" "$W" "$W" "$W" ;;
  current) echo wtB ;;
esac
EOS
cat > "$TMP/fakewatch" <<'EOS'
#!/usr/bin/env bash
printf 'watch %s\n' "$*" >> "$W/calls"
[ -z "${FAKE_INBOX:-}" ] || cat "$FAKE_INBOX"
[ "${FAKE_WATCH_RC:-0}" = 0 ]
EOS
chmod +x "$TMP/fakeb" "$TMP/fakewatch"
export BACKEND="$TMP/fakeb"
for t in old new; do cp "$TMP/fakewatch" "$TMP/$t/bin/lib/watch.sh"; done

QUIET='(none — do a check-in and re-arm)'
printf 'MESSAGES:\n  • [msg] wtLead — ping  (id=msg_1)\nACK-ID: dlv_9 (pass to --ack)\n' > "$TMP/in-mail"
printf '%s\n' "$QUIET" > "$TMP/in-quiet"
printf '%s\n  ⏸ sitting\tu1\twtSit\t20m idle\ttokS\t(since 10:05)\n  ‼ merged\t  ‼ merged\twtM\tPR #41 MERGED\tmark it done\n  ★ finished\ttopicA\ttok-ab\tall units merged\n' "$QUIET" > "$TMP/in-lead"
printf '%s\nREQUESTS:\n  ↻ request\trestart-thinker\n' "$QUIET" > "$TMP/in-req"

# world <dir>: a fresh copy of the same starting world.
world() {
  rm -rf "$1"; mkdir -p "$1/state/proj/squads" "$1/wtLead/.claude" "$1/wtB" "$1/wtStudio" "$1/pids"
  git init -q "$1/wtLead"; git init -q "$1/wtB"
  printf '{"studio_wt":"wtStudio"}\n' > "$1/state/proj/dispatcher.json"
  printf '{"run_id":"run_1","status":"running","units":[{"slug":"u1","builder_wt":"wtB","status":"done"}],"members":[{"role":"lead","wt":"wtLead"},{"role":"builder","wt":"wtB","suffix":"u1"},{"role":"thinker","wt":"wtGone"}],"waiting_on_you":[]}\n' > "$1/state/proj/squads/topicA.json"
  printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/x/bin/rewake-hook.sh proj topicA"}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/mine/guard.sh"}]}]},"model":"m"}\n' > "$1/wtLead/.claude/settings.local.json"
  : > "$1/calls"
}
# norm: tree and world paths, clock and pids out.
norm() {
  local s; s="$(cat)"; s="${s//$TMP\/old/<ROOT>}"; s="${s//$TMP\/new/<ROOT>}"; s="${s//$TMP\/w-old/<W>}"; s="${s//$TMP\/w-new/<W>}"
  printf '%s' "$s" | sed -E 's/^[0-9]{2}:[0-9]{2}:[0-9]{2} /T /; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z/ISO/g; s/\b1[0-9]{9}\b/EPOCH/g; s/pid [0-9]+/pid N/g'
}
# snap <world>: every file in it (name + content; a pid file's content is a pid; loop.db, made by the
# withdb wrapper and only read by the hook, by its query result), normalised.
snap() {
  (cd "$1" && find . -type f ! -path './wt*/.git/*' ! -path './home/*' | LC_ALL=C sort | while IFS= read -r f; do
    printf '== %s\n' "$f"; case "$f" in *.pid) echo '<pid>' ;; *.db) bun -e 'import { Database } from "bun:sqlite"; console.log(JSON.stringify(new Database(process.argv.at(-1), { readonly: true }).query("SELECT * FROM coordinators").all()))' "$f" </dev/null ;; *) cat "$f" ;; esac; echo
  done) | norm
}

pass=0; fail=0; ran=()
# same <label> <env…> -- <script under bin/> <args…>: run in both trees, each in its own world; compare.
# The env may name @W (the side's world) and @IN:<file>; stdin is <label>'s $STDIN file (or empty).
same() {
  local label="$1"; shift
  local -a envs=(); while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  local side w rc
  for side in old new; do
    w="$TMP/w-$side"; world "$w"
    local -a e=() a=(); local x; for x in ${envs[@]+"${envs[@]}"}; do e+=("${x//@W/$w}"); done
    for x in "$@"; do a+=("${x//@W/$w}"); done
    rc=0
    (cd "$w/${CWD:-wtB}" && env W="$w" DS_STATE_ROOT="$w/state" DS_REWAKE_LOG="$w/rewake.log" DS_REWAKE_PIDDIR="$w/pids" \
      DS_REWAKE_SEEN="$w/seen" DS_REWAKE_WINDOW_SEC=0 DS_REWAKE_POLL_GAP_SEC=0 DS_REWAKE_BACKOFF_SEC=0 TMPDIR="$w" \
      CLAUDE_PROJECT_DIR="$TMP/wt-common" ${e[@]+"${e[@]}"} "$TMP/$side/bin/${a[0]}" "${a[@]:1}" <"${STDIN:-/dev/null}" >"$TMP/out-$side" 2>"$TMP/err-$side") || rc=$?
    printf '%s\n' "$rc" > "$TMP/rc-$side"
    snap "$w" > "$TMP/snap-$side"
  done
  local what bad=""
  for what in rc out err snap; do
    if ! diff <(norm < "$TMP/$what-old") <(norm < "$TMP/$what-new") > "$TMP/diff" 2>&1; then
      bad="$bad $what"; echo "  FAIL: $label — $what differs (< shell, > port):" >&2; head -20 "$TMP/diff" | sed 's/^/    /' >&2
    fi
  done
  if [ -z "$bad" ]; then pass=$((pass+1)); ran+=("ok   $label (rc $(cat "$TMP/rc-new"))"); else fail=$((fail+1)); ran+=("FAIL $label:$bad"); fi
}

# --- rewake-hook ----------------------------------------------------------------------------------
H=hooks/rewake-hook.sh
printf '{"stop_hook_active":false}' > "$TMP/stop"; printf '{"stop_hook_active":true}' > "$TMP/stop-active"; printf 'not json' > "$TMP/stop-bad"
STDIN="$TMP/stop" same "rewake: Thinker idle with mail wakes"        ORCA_TERMINAL_HANDLE=term_1 FAKE_INBOX="$TMP/in-mail" -- $H --worktree
STDIN="$TMP/stop" same "rewake: Thinker idle without mail keeps alive" ORCA_TERMINAL_HANDLE=term_1 FAKE_INBOX="$TMP/in-quiet" -- $H --worktree
STDIN="$TMP/stop" same "rewake: Lead idle without mail reconciles"    ORCA_TERMINAL_HANDLE=term_1 FAKE_INBOX="$TMP/in-quiet" -- $H proj topicA
STDIN="$TMP/stop" same "rewake: Lead sees sitting/merged/finished"    ORCA_TERMINAL_HANDLE=term_1 FAKE_INBOX="$TMP/in-lead" -- $H proj topicA
STDIN="$TMP/stop" same "rewake: a restart request wakes"              FAKE_INBOX="$TMP/in-req" -- $H --worktree --requests proj
STDIN="$TMP/stop-active" same "rewake: busy — own wake, mail still there" FAKE_INBOX="$TMP/in-mail" -- $H --worktree
STDIN="$TMP/stop-active" same "rewake: own wake, inbox handled re-arms" FAKE_INBOX="$TMP/in-quiet" -- $H --worktree
same "rewake: unbound terminal, peek fails"                            FAKE_WATCH_RC=1 -- $H --worktree
STDIN="$TMP/stop-bad" same "rewake: unreadable hook input"             FAKE_INBOX="$TMP/in-quiet" -- $H --worktree
STDIN="$TMP/stop" same "rewake: Builder's unit done goes dark"         FAKE_INBOX="$TMP/in-quiet" -- $H --worktree --done-check @W/state/proj/squads/topicA.json wtB
same "rewake: --done-check without its args"                           -- $H --worktree --done-check x
# withdb <script> <args…>: the world is rebuilt per side, so the loop db is made first, then the hook runs.
cat > "$TMP/withdb" <<'EOS'
#!/usr/bin/env bash
bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.env.DS_STATE_ROOT + "/loop.db");
  d.run("CREATE TABLE coordinators(project TEXT, squad TEXT, run_id TEXT)");
  d.run("INSERT INTO coordinators VALUES (?,?,?),(?,?,?)", ["proj", "topicA", "run_1", "proj", "loop", ""]);' 
exec "$(dirname "$0")/$1" "${@:2}"
EOS
chmod +x "$TMP/withdb"; for t in old new; do cp "$TMP/withdb" "$TMP/$t/bin/withdb"; done
STDIN="$TMP/stop" same "rewake: a loop-owned Lead stays off"  FAKE_INBOX="$TMP/in-mail" -- withdb $H proj topicA
STDIN="$TMP/stop" same "rewake: a loop-owned Builder stays off" FAKE_INBOX="$TMP/in-mail" CLAUDE_PROJECT_DIR=/x/ds-proj-builder-u1-topicA -- withdb $H --worktree
STDIN="$TMP/stop" same "rewake: an unbound squad is not loop-owned" FAKE_INBOX="$TMP/in-quiet" -- withdb $H proj loop

# --- picker-hook ----------------------------------------------------------------------------------
P=hooks/picker-hook.sh
SF=@W/state/proj/squads/topicA.json
# in-<name> <script> <args…>: pre-async's input file (removed by the hook) is copied into the world first.
mkin() { printf '#!/usr/bin/env bash\ncp "%s" "$W/in.json"; exec "$(dirname "$0")/$1" "${@:2}" "$W/in.json"\n' "$2" > "$TMP/in-$1"
  chmod +x "$TMP/in-$1"; for t in old new; do cp "$TMP/in-$1" "$TMP/$t/bin/in-$1"; done; }
printf '{"tool_name":"Bash","tool_use_id":"toolu_x","transcript_path":"/t.jsonl","tool_input":{"command":"ls"}}' > "$TMP/other.json"
jq '.tool_input.questions[0].options = [{"label":"Only"}]' "$FIX/picker-pre.json" > "$TMP/one-opt.json"
jq '.tool_input.questions[0].options = []' "$FIX/picker-pre.json" > "$TMP/no-opt.json"
mkin pre "$FIX/picker-pre.json"; mkin multi "$FIX/picker-pre-multi.json"; mkin dsq "$FIX/picker-dsq.json"
mkin other "$TMP/other.json"; mkin oneopt "$TMP/one-opt.json"; mkin noopt "$TMP/no-opt.json"
same "picker: pre-async queues the picker"        -- in-pre $P pre-async $SF thinker wtB
same "picker: pre-async multi-question"           -- in-multi $P pre-async $SF builder-u1 wtB
same "picker: pre-async /ds-q shape"              -- in-dsq $P pre-async $SF thinker wtB
same "picker: pre-async one option gets Other"    -- in-oneopt $P pre-async $SF thinker wtB
same "picker: pre-async no options is ignored"    -- in-noopt $P pre-async $SF thinker wtB
same "picker: not an AskUserQuestion"             -- in-other $P pre-async $SF thinker wtB
same "picker: an unreadable state"                -- in-pre $P pre-async @W/nope/squads/x.json thinker wtB
STDIN="$FIX/picker-post.json" same "picker: post with no queued entry leaves a tombstone" -- $P post $SF thinker wtB
same "picker: usage"                              -- $P pre
same "picker: unknown mode"                       -- $P bogus a b c

# --- arm-picker / arm-rewake ----------------------------------------------------------------------
same "arm-picker: merge into a Lead's settings"   -- hooks/arm-picker.sh wtLead $SF lead
same "arm-picker: a bare worktree"                -- hooks/arm-picker.sh wtB $SF builder-u1
same "arm-picker: a remote worktree"              -- hooks/arm-picker.sh wtGone $SF lead
same "arm-picker: usage"                          -- hooks/arm-picker.sh wtB
same "arm-rewake: a Lead"                         -- hooks/arm-rewake.sh wtLead -- proj topicA
same "arm-rewake: the Studio"                     -- hooks/arm-rewake.sh wtStudio -- --worktree --requests proj
same "arm-rewake: no watch args"                  -- hooks/arm-rewake.sh wtLead --
same "arm-rewake: a remote worktree"              -- hooks/arm-rewake.sh wtNoDir -- --worktree

# --- reassert-roles -------------------------------------------------------------------------------
same "reassert-roles: Studio + squad members"     -- hooks/reassert-roles.sh proj
same "reassert-roles: unknown project"            -- hooks/reassert-roles.sh nosuch
same "reassert-roles: usage"                      -- hooks/reassert-roles.sh

printf '%s\n' "${ran[@]}"
# Canary: a different answer must be caught (the comparison is not vacuous).
printf 'x' > "$TMP/out-old"; printf 'y' > "$TMP/out-new"
if diff <(norm < "$TMP/out-old") <(norm < "$TMP/out-new") >/dev/null; then fail=$((fail+1)); echo "  FAIL: canary — a differing output compared equal" >&2; fi
echo "parity-hooks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
