#!/usr/bin/env bash
# send-role.sh / send-peer.sh on a root the loop owns (.loop-migrated), U75: the target squad and role
# are checked BEFORE the request is queued, so a typo (`send-role.sh acme <squad> <role> …`, the project as
# the first word) fails in the caller's own terminal with the phone book's error and the usage line,
# and writes no `messages` row. A known target writes one message row (U45: loop.db `messages`, no
# `requests` row; send-peer also logs it in cross-squad.md). No backend call is made by the check
# (--project given). Hermetic: a temp root whose bin/ links to this checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for f in bin conventions roles AGENTS.md; do ln -s "$ROOT/$f" "$TMP/$f"; done
S="$TMP/state"; mkdir -p "$S/fx/squads"
echo '{"home_repo":"fx"}' > "$S/fx/dispatcher.json"
cat > "$S/fx/squads/t1.json" <<'JSON'
{"topic":"t1","repo":"fx","type":"feature","status":"running","run_id":"run1","lead_wt":"wtl","worktrees":["wtl","wtt"],
 "members":[{"role":"lead","wt":"wtl"},{"role":"thinker","wt":"wtt"}],"units":[]}
JSON
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$1" in current) echo "${FAKE_CURRENT:-wt-elsewhere}" ;; ps) echo '{"result":{"worktrees":[]}}' ;; *) echo '{}' ;; esac
FAKE
chmod +x "$TMP/fakeb"
export FAKE_LOG="$TMP/log" BACKEND="$TMP/fakeb" DS_STATE_ROOT="$S" DS_NOW=1800000000
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
"$TMP/bin/ds" import >/dev/null
: > "$S/.loop-migrated"

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
rows() { "${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  console.log(d.query("SELECT COUNT(*) FROM messages").values()[0][0] + d.query("SELECT COUNT(*) FROM requests WHERE kind IN (\"send-role\", \"send-peer\")").values()[0][0] * 100)' "$S/loop.db"; }
run() { (cd "$TMP" && "$@"); }
: > "$FAKE_LOG"

# The project as the first word: squad 'fx' does not exist.
rc=0; run bin/role/send-role.sh fx t1 lead hi >"$TMP/out" 2>"$TMP/err" || rc=$?
ck "send-role: unknown squad exits 2" "$rc" "2"
ck "send-role: the phone book's error" "$(grep -c "no squad 'fx' in 'fx'" "$TMP/err")" "1"
ck "send-role: the usage line" "$(grep -c '^usage: send-role.sh' "$TMP/err")" "1"
ck "send-role: nothing queued" "$(rows)" "0"

: > "$FAKE_LOG"
rc=0; run bin/role/send-role.sh t1 nobody hi there --project fx >/dev/null 2>"$TMP/err" || rc=$?
ck "send-role: unknown role exits 2" "$rc" "2"
ck "send-role: names the role" "$(grep -c "no member 'nobody' in squad 't1'" "$TMP/err")" "1"
ck "send-role: unknown role queues nothing" "$(rows)" "0"
ck "send-role: with --project the check made no backend call" "$(cat "$FAKE_LOG")" ""

rc=0; run bin/role/send-role.sh t1 lead hi there --project fx >/dev/null 2>&1 || rc=$?
ck "send-role: a known target queues" "$rc $(rows)" "0 1"

# send-peer: the same, for a Thinker/Lead target.
rc=0; run bin/role/send-peer.sh nosuch thinker s b --project fx >/dev/null 2>"$TMP/err" || rc=$?
ck "send-peer: unknown squad exits 2" "$rc" "2"
ck "send-peer: the phone book's error and usage" "$(grep -c "no squad 'nosuch' in 'fx'" "$TMP/err") $(grep -c '^usage: send-peer.sh' "$TMP/err")" "1 1"
ck "send-peer: nothing more queued" "$(rows)" "1"
rc=0; run bin/role/send-peer.sh t1 thinker s b --project fx --from other/lead >/dev/null 2>&1 || rc=$?
ck "send-peer: a known target queues" "$rc $(rows)" "0 2"
ck "send-peer: logged with its message id" "$(grep -c '^- .* other/lead → t1/thinker \[s\] msg#2$' "$S/fx/cross-squad.md")" "1"
rc=0; run bin/role/send-peer.sh t1 thinker s b --project fx --from other/lead >/dev/null 2>&1 || rc=$?
ck "send-peer: the same send again is the same row, logged once" "$rc $(rows) $(wc -l < "$S/fx/cross-squad.md")" "0 2 1"
rc=0; run bin/role/send-peer.sh t1 thinker s b --project fx --from t1/lead >/dev/null 2>"$TMP/err" || rc=$?
ck "send-peer: own squad is refused, pointing to send-role" "$rc $(grep -c 'send-role.sh t1 thinker' "$TMP/err") $(rows)" "2 1 2"

# U285: from a folder in no squad (the host checkout) the sender is "unknown", never "operator";
# ORCA_TERMINAL_HANDLE names the member whose terminal this is, whatever the folder.
frm() { "${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  console.log(d.query("SELECT from_role FROM messages WHERE id = ?").values(+process.argv[2])[0][0])' "$S/loop.db" "$1" 2>/dev/null || true; }
ck "send-role: from a folder with no member the sender is unknown" "$(frm 1)" "unknown"
"${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]);
  d.run("INSERT INTO observed_terminals (project, handle, wt, observed_at) VALUES (?, ?, ?, ?)", ["fx", "term_lead", "wtl", 1800000000])' "$S/loop.db"
rc=0; ORCA_TERMINAL_HANDLE=term_lead run bin/role/send-role.sh t1 thinker from-handle body --project fx >/dev/null 2>&1 || rc=$?
ck "send-role: the terminal handle names the Lead" "$rc $(frm 3)" "0 lead"
unset ORCA_TERMINAL_HANDLE

# Off the loop (an unmarked root) the check is not made: today's path, the child judges.
rm "$S/.loop-migrated"; : > "$FAKE_LOG"
rc=0; run bin/role/send-role.sh nosuch lead hi there --project fx >/dev/null 2>&1 || rc=$?
ck "send-role: unmarked root still exits 2 from the lookup" "$rc" "2"

# U210: the Run inbox send is refused -> the same message goes to the Lead's worktree through the Run.
mkdir "$TMP/bare"
cat > "$TMP/fakedir" <<'FAKE'
#!/usr/bin/env bash
printf 'run\tlead\trun1\twtl\n'
FAKE
cat > "$TMP/fakeb2" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG2"
case "$1" in
  run-coordinator) echo term_loop ;;
  send) echo "orca adapter: send failed for run run1: run_inbox_refused: no" >&2; exit 1 ;;
  send-run-worker) [ -z "${FAKE_BOTH_FAIL:-}" ] || { echo "orca adapter: send-run-worker failed: worker_gone: x" >&2; exit 1; }; echo ok ;;
esac
FAKE
chmod +x "$TMP/fakedir" "$TMP/fakeb2"
export FAKE_LOG2="$TMP/log2"
runb() { DS_STATE_ROOT="$TMP/bare" BACKEND="$TMP/fakeb2" DIRECTORY="$TMP/fakedir" "$TMP/bin/role/send-role.sh" "$@"; }
rc=0; runb t1 lead hi there --project fx >"$TMP/out" 2>"$TMP/err" || rc=$?
ck "send-role: a refused run send falls back, exit 0" "$rc" "0"
ck "send-role: the output says so" "$(grep -c 'worktree-run, run inbox refused' "$TMP/out")" "1"
ck "send-role: sent to the Lead's worktree" "$(grep -c '^send-run-worker run1 wtl' "$TMP/log2")" "1"
rc=0; FAKE_BOTH_FAIL=1 runb t1 lead hi there --project fx >"$TMP/out" 2>"$TMP/err" || rc=$?
ck "send-role: both sends failing exits 1" "$rc" "1"
ck "send-role: Orca's error text reaches stderr" "$(grep -c 'worker_gone' "$TMP/err")" "1"

echo "send-role: $pass passed, $fail failed"
[ "$fail" = 0 ]
