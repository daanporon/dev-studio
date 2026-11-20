#!/usr/bin/env bash
# parity-role-tools.sh — the ported role tools (U192) give what the shell versions gave: the same output
# and exit code for each refusal and for the plain paths that need no backend. The shell side is the tree
# at PARITY_BASE (default e153edd, the last commit with the shell versions), unpacked with git archive;
# the port side is this checkout. The tools' own tests (finish-unit.sh, send-role.sh, send-peer.sh,
# approve-handoff.sh, done-request.sh, ds-feedback.sh, pause.sh) run unchanged against the port.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PARITY_BASE:-e153edd}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-role-tools: $BASE is not in this clone — skipped"; echo "parity-role-tools: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old"; git -C "$ROOT" archive "$BASE" bin conventions | tar -x -C "$TMP/old"

# one run in a tree: stdout + stderr + exit code, with the tree's own path and the scratch root made generic
runin() { # <tree> <tool> <args…>
  local tree="$1" tool="$2" rc=0 out side=new; shift 2
  [ "$tree" = "$TMP/old" ] && side=old
  out="$(cd "$TMP/work" && env -u ORCA_TERMINAL_HANDLE -u DS_LOOP_CHILD DS_STATE_ROOT="$TMP/state-$side" \
    DS_FEEDBACK_LOG="" BACKEND=/bin/false "$tree/bin/role/$tool" "$@" 2>&1)" || rc=$?
  printf '%s\n[rc=%s]\n' "$out" "$rc" | sed "s|$tree|TREE|g; s|$TMP/state-$side|STATE|g"
}
mkdir -p "$TMP/work" "$TMP/state-old/p/squads" "$TMP/state-new/p/squads" "$TMP/state-old/p/requests/t" "$TMP/state-new/p/requests/t"
for s in old new; do
  printf '%s' '{"repo":"","units":[{"slug":"u1"}]}' > "$TMP/state-$s/p/squads/t.json"
  printf '%s' '{bad' > "$TMP/state-$s/p/squads/bad.json"
  printf 'first line\nsecond\n' > "$TMP/state-$s/p/requests/t/a.txt"
  printf 'other\n' > "$TMP/state-$s/p/requests/t/b.txt"
done
# the same state root name in both trees' output after normalising
check() { # <name> <tool> <args…>   args may name @S for the state root of the tree
  local name="$1" tool="$2"; shift 2
  local oa=() na=() a
  for a in "$@"; do oa+=("${a//@S/$TMP/state-old}"); na+=("${a//@S/$TMP/state-new}"); done
  local o n
  o="$(runin "$TMP/old" "$tool" "${oa[@]}")"; n="$(runin "$ROOT" "$tool" "${na[@]}")"
  if [ "$o" = "$n" ]; then pass=$((pass + 1)); echo "ok   $name"
  else fail=$((fail + 1)); echo "FAIL $name"; diff <(printf '%s\n' "$o") <(printf '%s\n' "$n") | head -10; fi
}

check "finish-unit: no args"            finish-unit.sh
check "finish-unit: --help"             finish-unit.sh --help
check "finish-unit: missing state"      finish-unit.sh @S/p/squads/nope.json u1
check "finish-unit: invalid JSON"       finish-unit.sh @S/p/squads/bad.json u1
check "finish-unit: unknown unit"       finish-unit.sh @S/p/squads/t.json nope
check "finish-unit: bad flag"           finish-unit.sh @S/p/squads/t.json u1 --bogus
check "finish-unit: bad --wait"         finish-unit.sh @S/p/squads/t.json u1 --wait
check "send-role: no args"              send-role.sh
check "send-role: 3 args"               send-role.sh a b c
check "send-role: --help"               send-role.sh --help
check "send-peer: no args"              send-peer.sh
check "send-peer: builder target"       send-peer.sh sq builder-x subj body
check "send-peer: unknown option"       send-peer.sh --nope a b c d
check "send-peer: no project"           send-peer.sh sq thinker subj body --from sq/lead
check "send-peer: bad --from"           send-peer.sh sq thinker subj body --project p --from nope
check "done-request: no args"           done-request.sh
check "done-request: outside requests"  done-request.sh /tmp/x.txt
check "done-request: dotdot"            done-request.sh "@S/p/requests/t/../t/a.txt"
check "done-request: clears and lists"  done-request.sh @S/p/requests/t/a.txt
check "done-request: clears the last"   done-request.sh @S/p/requests/t/b.txt
check "ds-feedback: no args"            ds-feedback.sh
check "ds-feedback: empty note"         ds-feedback.sh ""
check "approve-handoff: no args"        approve-handoff.sh
check "approve-handoff: no state"       approve-handoff.sh @S/p/squads/nope.json plan wt
check "approve-handoff: no plan"        approve-handoff.sh @S/p/squads/t.json "$TMP/nope.md" wt
check "pause-checkpoint: no args"       pause-checkpoint.sh
check "pause-checkpoint: no terminal"   pause-checkpoint.sh p sq lead - 1 note --commands-finished

# ds-feedback's log line: the same text after the timestamp, in the same file
for s in old new; do rm -f "$TMP/fb-$s"; done
env DS_FEEDBACK_LOG="$TMP/fb-old" "$TMP/old/bin/role/ds-feedback.sh" "builder on p: a note" "and more" >/dev/null
env DS_FEEDBACK_LOG="$TMP/fb-new" "$ROOT/bin/role/ds-feedback.sh" "builder on p: a note" "and more" >/dev/null
if [ "$(sed 's/^- [^ ]* //' "$TMP/fb-old")" = "$(sed 's/^- [^ ]* //' "$TMP/fb-new")" ] \
   && [ "$(sed 's/[0-9]/N/g' "$TMP/fb-old")" = "$(sed 's/[0-9]/N/g' "$TMP/fb-new")" ]; then pass=$((pass + 1)); echo "ok   ds-feedback: log line"
else fail=$((fail + 1)); echo "FAIL ds-feedback: log line"; fi

echo "parity-role-tools: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
