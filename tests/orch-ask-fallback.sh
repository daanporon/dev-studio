#!/usr/bin/env bash
# orch-ask-fallback.sh — U267 (3): `orch.sh ask` when the backend refuses it because the caller's
# dispatch is closed or missing sends the question to the squad's Lead (send-role.sh <squad> lead,
# the squad found by its Run id in the state files), prints one line naming watch.sh --worktree and
# exits 5. With an open dispatch it blocks and prints the answer as before; any other refusal fails
# with the backend's own code and sends nothing. Hermetic: a temp state root, a fake backend and phone book.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$TMP" "$DS_STATE_PARENT"'
S="$DS_STATE_ROOT"; mkdir -p "$S/fx/squads"
printf '%s' '{"topic":"t1","run_id":"run_t1","lead_wt":"wtl","units":[]}' > "$S/fx/squads/t1.json"
printf '%s' '{"topic":"t2","run_id":"run_t2","lead_wt":"wt2","units":[]}' > "$S/fx/squads/t2.json"

cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  ask) case "$FAKE_ASK" in
         open) echo '{"ok":true,"result":{"answer":"use the store"}}' ;;
         closed) echo '{"ok":false,"error":{"code":"dispatch_inactive","message":"ask requires an active supervised Dispatch."}}'
                 echo "orca adapter: ask failed for run $2 (see error above)" >&2; exit 1 ;;
         other) echo '{"ok":false,"error":{"code":"run_not_found","message":"no such run"}}'; exit 1 ;;
       esac ;;
  send) echo "msg_fake" ;;
  *) echo '{}' ;;
esac
FAKE
cat > "$TMP/fakedir" <<'FAKE'
#!/usr/bin/env bash
printf 'dir %s\n' "$*" >> "$FAKE_LOG"
[ "$1" = reach ] && [ "$3" = lead ] && { printf 'run\trun:run_%s\trun_%s\twtl\n' "$2" "$2"; exit 0; }
exit 2
FAKE
chmod +x "$TMP/fakeb" "$TMP/fakedir"
export FAKE_LOG="$TMP/log" BACKEND="$TMP/fakeb" DIRECTORY="$TMP/fakedir"
unset DS_LOOP_CHILD DS_WHO
export ORCA_TERMINAL_HANDLE=term_builder

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
ask() { : > "$FAKE_LOG"; rc=0; (cd "$TMP" && FAKE_ASK="$1" "$ROOT/bin/role/orch.sh" ask "$2" "Which store?" >"$TMP/out" 2>"$TMP/err") || rc=$?; }

# A closed dispatch: the question goes to the Lead of the squad whose Run it is, exit 5.
ask closed run_t1
ck "closed: exit code" "$rc" 5
ck "closed: one line on stdout naming the inbox" "$(grep -c 'watch.sh --worktree' "$TMP/out")" 1
ck "closed: the refusal still shown" "$(grep -c dispatch_inactive "$TMP/out")" 1
ck "closed: reached the t1 Lead" "$(grep -c '^dir reach t1 lead --project fx' "$FAKE_LOG")" 1
ck "closed: sent to the Lead's Run with the question" "$(grep -c ' send run_t1 Question from .* (ask fell back) .*Which store?' <(tr '\n' ' ' < "$FAKE_LOG"))" 1
ck "closed: the asker named in the body" "$(grep -c 'term_builder' "$FAKE_LOG")" 1

# An open dispatch: blocks and prints the answer, nothing sent.
ask open run_t1
ck "open: exit code" "$rc" 0
ck "open: the answer" "$(grep -c 'use the store' "$TMP/out")" 1
ck "open: no send" "$(grep -c '^send' "$FAKE_LOG")" 0

# Another refusal: the backend's code, nothing sent.
ask other run_t1
ck "other refusal: exit code" "$rc" 1
ck "other refusal: no send" "$(grep -c '^send\|^dir' "$FAKE_LOG")" 0

# A closed dispatch on a Run no squad state names: the backend's code, nothing sent.
ask closed run_none
ck "unknown run: exit code" "$rc" 1
ck "unknown run: no send" "$(grep -c '^send' "$FAKE_LOG")" 0
ck "unknown run: says so" "$(grep -c 'no squad state names Run run_none' "$TMP/err")" 1

# --help names the fallback and its code.
out="$("$ROOT/bin/role/orch.sh" --help)"
ck "--help: fallback" "$(grep -c 'watch.sh --worktree' <<<"$out")" 2
ck "--help: exit code 5" "$(grep -c '5 = ask fell back' <<<"$out")" 1

echo "orch-ask-fallback: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
