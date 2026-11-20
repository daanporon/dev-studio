#!/usr/bin/env bash
# parity-ask-watch.sh — the ports of watch.sh and ask-operator.sh (U260: bin/commands/{watch,ask-operator}-ts.ts)
# do what the shell bodies did. The shell side is the tree at PARITY_BASE (default 8b0818e, the last
# commit with the shell bodies), unpacked with git archive; the port side is a copy of this checkout.
# Each case runs once per tree in a fresh copy of the same world at the same path (state, inbox, fake
# Orca, fake gh) and must match in stdout, stderr, exit code, every file written (state, beat,
# watch-seen, instruction fingerprint) and every fake-Orca and gh call, after the tree path and the
# clock are normalised. Covered: watch with no mail, one batch then --ack then never shown again, mail
# arriving during --worktree <ms>, the INSTRUCTIONS line, the Lead's team/work-item/question blocks
# (quiet and --full), and ask-operator's refusals, question row and the answer the asker waits for.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PARITY_BASE:-8b0818e}"
# Under $XDG_RUNTIME_DIR: bun starts slowly in a crowded /tmp.
TMP="$(mktemp -d -p "$( [ -d "${XDG_RUNTIME_DIR:-}" ] && [ -w "$XDG_RUNTIME_DIR" ] && echo "$XDG_RUNTIME_DIR" || echo "${TMPDIR:-/tmp}")")"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-ask-watch: $BASE is not in this clone — skipped"; echo "parity-ask-watch: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old" "$TMP/new"
git -C "$ROOT" archive "$BASE" bin conventions roles studio | tar -x -C "$TMP/old"
cp -r "$ROOT/bin" "$ROOT/conventions" "$ROOT/roles" "$ROOT/studio" "$TMP/new/"
mkdir "$TMP/home"; export HOME="$TMP/home"   # nothing on the host is read
export TZ=UTC
unset ORCA_TERMINAL_HANDLE CLAUDE_PROJECT_DIR DS_LOOP_CHILD DS_PREFIX DS_INSTR_FILES DS_INSTR_SEEN DS_SIT_NUDGE_MIN DS_SIT_RESTART_MIN GH
W="$TMP/w"; export W

# The fake Orca: records each call, answers from the world. The inbox is $W/inbox/<delivery>.json,
# one batch each; a batch replays until its delivery is acked ($W/acked/<delivery>). A wait verb
# blocks up to its ms for a batch to land.
cat > "$TMP/fakeb" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$W/calls"
pending() { local f; for f in "$W"/inbox/*.json; do [ -f "$f" ] || continue; [ -e "$W/acked/$(basename "$f" .json)" ] || { cat "$f"; return 0; }; done; return 1; }
read_inbox() { # <wait:0|1> <ms> <ack>
  if [ -n "${FAKE_READ_RC:-}" ]; then printf 'fake read broke\nsecond line\n' >&2; exit "$FAKE_READ_RC"; fi
  [ -z "$3" ] || { mkdir -p "$W/acked"; : > "$W/acked/$3"; }
  [ "$1" = 0 ] || [ ! -f "$W/onwait" ] || bash "$W/onwait"   # the world changes while the tick waits
  local n=0 max=$(( ${2:-0} / 50 ))
  while :; do
    pending && return 0
    [ "$1" = 1 ] && [ "$n" -lt "$max" ] && [ -z "${FAKE_NOWAIT:-}" ] || break
    sleep 0.05; n=$((n + 1))
  done
  echo '{"result":{"messages":[]}}'
}
case "$1" in
  current) printf '%s\n' "${FAKE_CURRENT-wtB}" ;;
  ping) exit "${FAKE_PING_RC:-0}" ;;
  run-coordinator) [ ! -f "$W/holder" ] || cat "$W/holder" ;;
  worker-states) [ ! -f "$W/states" ] || cat "$W/states"; exit "${FAKE_STATES_RC:-0}" ;;
  inbox-wait-self) read_inbox 1 "$2" "${3:-}" ;;
  inbox-wait) read_inbox 1 "$3" "${4:-}" ;;
  inbox-peek-self|inbox-peek) read_inbox 0 0 "" ;;
  inbox-all-self|inbox-all) if [ -f "$W/all.json" ]; then cat "$W/all.json"; else read_inbox 0 0 ""; fi ;;
esac
EOS
# The fake gh: `pr view <n>` prints $W/gh/<n>.json, `api graphql` prints $W/gh/graphql.json; else exit 1.
cat > "$TMP/fakegh" <<'EOS'
#!/usr/bin/env bash
printf 'gh %s %s %s\n' "$1" "$2" "$3" >> "$W/calls"
case "$1 $2" in
  "pr view") [ -f "$W/gh/$3.json" ] && cat "$W/gh/$3.json" ;;
  "api graphql") [ -f "$W/gh/graphql.json" ] && cat "$W/gh/graphql.json" ;;
  *) exit 1 ;;
esac
EOS
chmod +x "$TMP/fakeb" "$TMP/fakegh"
export BACKEND="$TMP/fakeb" DS_GH="$TMP/fakegh" DS_STATE_ROOT="$W/state" DS_INSTR_SEEN="$W/seen" DS_INSTR_FILES="$W/instr/*.md $W/instr/none.md"

NOW="$(date +%s)"
ISO_RECENT="$(date -u -d "@$((NOW - 3600))" +%Y-%m-%dT%H:%M:%SZ)"
ISO_OLD="$(date -u -d "@$((NOW - 172800))" +%Y-%m-%dT%H:%M:%SZ)"
SIT_MS="$(( (NOW - 1230) * 1000 ))"    # 20.5 min ago: a 20m sit, nudge stage
LONG_MS="$(( (NOW - 3000) * 1000 ))"   # 50 min ago: the restart stage
LONGQ="$(printf 'why %.0s' $(seq 1 90))"

# world: a fresh copy of the same starting world (one squad `topicA`, project `proj`).
world() {
  rm -rf "$W"; mkdir -p "$W/state/proj/squads" "$W/wt" "$W/inbox" "$W/instr" "$W/gh"
  printf 'agents\n' > "$W/instr/a.md"; printf 'roles\n' > "$W/instr/b.md"
  git init -q "$W/repo"; git -C "$W/repo" remote add origin git@github.com:o/r.git
  printf '{"run_id":"run_1","status":"running","repo":"path:%s/repo","units":[{"slug":"u1","status":"planned"}],"members":[{"role":"lead","wt":"wtLead"},{"role":"thinker","wt":"wtT","owns":["plan.md"]}],"waiting_on_you":[]}\n' "$W" > "$W/state/proj/squads/topicA.json"
  printf 'wtLead\tworking\t-\t1\t\n' > "$W/states"
  : > "$W/calls"
}
mail() { # <delivery> <messages json array>
  printf '{"result":{"deliveryId":"%s","messages":%s}}\n' "$1" "$2" > "$W/inbox/$1.json"
}
later() { # <seconds> <delivery> <messages json>: a batch lands while the tick waits
  ( sleep "$1"; printf '{"result":{"deliveryId":"%s","messages":%s}}\n' "$2" "$3" > "$W/inbox/.tmp"; mv "$W/inbox/.tmp" "$W/inbox/$2.json" ) &
}
# t <tool> <args…>: one run of a tool from tree $T in the world's worktree, appended to $W/out.
t() {
  local tool="$1" rc=0; shift
  printf '$ %s %s\n' "$tool" "$*" >> "$W/out"
  (cd "$W/wt" && "$T/bin/$tool" "$@" >> "$W/out" 2> "$W/err") || rc=$?
  { sed 's/^/err: /' "$W/err"; printf '[rc=%s]\n' "$rc"; } >> "$W/out"; rm -f "$W/err"
}
W_() { t lib/watch.sh "$@"; }
AO() { t role/ask-operator.sh "$@"; }
S="$W/state/proj/squads/topicA.json"
# The Lead tick's CREW CHAT: section (board chat, U2) is newer than the shell bodies: it is dropped
# (header and its indented lines) before comparing; tests/watch.sh covers it. U1 of ask-operator-silent-failures reworded
# two ask-operator refusals (a bad --unit, now one line with no usage line, and the loop-asks-PR-questions line that
# names the poster): both are normalised on both sides; exit codes, files written and calls are still compared.
norm() {
  local s; s="$(cat)"; s="${s//$TMP\/old/<ROOT>}"; s="${s//$TMP\/new/<ROOT>}"
  printf '%s' "$s" | sed -E 's/^(err: )?usage: ask-operator\.sh .*$/\1usage: ask-operator.sh <USAGE>/; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z/ISO/g; s/\b1[0-9]{9}([0-9]{3})?\b/EPOCH/g' \
    | sed -E 's/^(err: )?ask-operator: the loop asks PR questions.*$/\1ask-operator: <LOOP-PR-REFUSAL>/' \
    | awk '/^err: ask-operator: unknown unit / { print "err: ask-operator: <UNKNOWN-UNIT>"; unit = 1; next } unit && /^err: usage: ask-operator\.sh / { unit = 0; next } { unit = 0 } { print }' \
    | awk '/^CREW CHAT:$/ { skip = 1; next } skip && /^  / { next } { skip = 0; print }'
}
snap() { # every file in the world but the git checkout, name + content
  (cd "$W" && find . -type f ! -path './repo/*' | LC_ALL=C sort | while IFS= read -r f; do printf '== %s\n' "$f"; case "$f" in *.db*) echo "<db>" ;; *) cat "$f" ;; esac; echo; done) | norm
}
# same <name> <case fn>: the case in each tree from a fresh world; everything it left must match.
same() {
  local name="$1" fn="$2" o n
  T="$TMP/old"; world; "$fn"; wait; o="$(snap)"
  T="$TMP/new"; world; "$fn"; wait; n="$(snap)"
  if [ "$o" = "$n" ]; then pass=$((pass + 1)); echo "ok   $name"
  else fail=$((fail + 1)); echo "FAIL $name"; diff <(printf '%s\n' "$o") <(printf '%s\n' "$n") | head -20 || true; fi
}

# ---- watch: a worker's own inbox ----
c_nomail()   { W_ --worktree 1; W_ --worktree 1; }
c_batch() {
  mail dlv_1 '[{"id":"m1","type":"question","from_handle":"term_L","subject":"which way?","body":"line one\r\nline two"},{"id":"m2","from":"wtLead","body":"[run mail · question · id q_77] pick one"},{"type":"msg","body":""},{"id":"m4","subject":"plain","body":"[run mail · question with no id"}]'
  W_ --worktree 1; W_ --worktree 1 --ack dlv_1; W_ --worktree 1
}
c_arrive()   { later 0.4 dlv_7 '[{"id":"m7","from_handle":"term_L","subject":"go","body":"start now"}]'; W_ --worktree 5000; W_ --worktree 1 --ack dlv_7; W_ --worktree 1; }
c_instr()    { W_ --worktree 1; printf 'roles v2\n' > "$W/instr/b.md"; W_ --worktree 1; W_ --worktree 1; }
c_poll()     { mail dlv_2 '[{"id":"m1","body":"hi"}]'; W_ --worktree --poll; W_ --worktree --poll --ack dlv_2; W_ --worktree 1; }
c_all()      { printf '{"result":{"deliveryId":"dlv_old","messages":[{"id":"m0","body":"old"}]}}\n' > "$W/all.json"; W_ --worktree --all; }
c_readfail() { FAKE_READ_RC=3 W_ --worktree 1; FAKE_READ_RC=4 W_ --worktree --poll; }
c_odd() {
  printf 'not json\n' > "$W/inbox/dlv_a.json"; W_ --worktree 1; rm "$W/inbox/dlv_a.json"
  mail dlv_b '[{"id":"m1","body":"fine"},{"id":"m2","body":7}]'; W_ --worktree 1 --ack dlv_b
  printf '{"result":{"delivery":{"id":"dlv_c"},"messages":[{"id":"m1","deliveryId":"dlv_x","body":"x"}]}}\n' > "$W/inbox/dlv_c.json"; W_ --worktree 1
  printf '{"result":{"messages":[{"deliveryId":"dlv_m","body":"y"}]}}\n' > "$W/inbox/dlv_d.json"; W_ --worktree 1 --ack dlv_c
}
c_args()     { W_ --worktree proj topicA 1; FAKE_NOWAIT=1 W_ --worktree abc; W_ --run run_9 1; W_ --run run_9 --poll; W_ proj; W_ proj nosuch 1; printf '{"units":[]}\n' > "$S"; W_ proj topicA 1; }
c_requests() {
  mkdir -p "$W/state/proj/requests/_studio"
  local i=0 k
  for k in "board: ds roles x" "switch: restart-role.sh a (early, while idle)" "switch: restart-role.sh b" "briefing: proj 2026-11-13" "idle: builder-u1" "thinker stuck"; do
    i=$((i + 1)); printf '%s\nsecond line\n' "$k" > "$W/state/proj/requests/_studio/r$i.txt"
  done
  : > "$W/state/proj/requests/_studio/.hidden.txt"; mkdir "$W/state/proj/requests/_studio/dir.txt"
  W_ --worktree --requests proj 1; rm -rf "$W"/state/proj/requests/_studio/*; W_ --worktree --requests proj 1; FAKE_READ_RC=2 W_ --worktree --requests proj --poll
}

# ---- watch: the Lead's tick ----
lead_world() {
  cat > "$S" <<EOF
{"run_id":"run_1","status":"running","type":"feature","repo":"path:$W/repo",
 "members":[{"role":"lead","wt":"wtLead"},{"role":"thinker","wt":"wtT","owns":["plan.md","b.md"]},{"role":"researcher","wt":"wtR","suffix":"x"},
            {"role":"builder","wt":"wtB1","suffix":"u2"},{"role":"tester","wt":"wtGone"},{"role":"reviewer","wt":""}],
 "units":[{"slug":"u1","status":"planned"},{"slug":"u2","status":"dispatched","builder_wt":"wtB1","pr":41},
          {"slug":"u3","status":"dispatched","builder_wt":"wtB2","pr":"https://github.com/o/r/pull/42"},{"slug":"u4","status":"dispatched","builder_wt":"wtB3","pr":43},
          {"slug":"u5","status":"dispatched","builder_wt":"wtB4","pr":44},{"slug":"u6","status":"dispatched","builder_wt":"wtNo"},
          {"slug":"u7","status":"dispatched","builder_wt":"wtB5"},{"slug":"u8","status":"done"},{"slug":"u9","status":"cancelled","superseded_by":"u2"},
          {"slug":"u10","status":"cancelled"},{"slug":"u11","status":"odd"},{"status":"planned"}],
 "waiting_on_you":[{"id":"q1","asker":"thinker","blocking":true,"since":"$ISO_RECENT","question":"line\n\nnext $LONGQ"},{"id":"q2","blocking":false,"question":"short?"}]}
EOF
  printf 'wtLead\tworking\t-\t1\t\nwtT\tidle\t-\t%s\tshould I split u4?\nwtR\tdone\t-\t%s\tall done?\nwtB1\tidle\t-\t%s\tPR is up\nwtB2\tidle\t-\t%s\tstuck?\nwtB3\tworking\t-\tnot-a-number\tbusy\nwtB4\tblocked\n' \
    "$SIT_MS" "$SIT_MS" "$SIT_MS" "$LONG_MS" > "$W/states"
  printf '{"state":"MERGED"}\n' > "$W/gh/41.json"
  printf '{"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"},{"state":"PENDING"},{"conclusion":"","state":"SUCCESS"}]}\n' > "$W/gh/42.json"
  printf '{"state":"OPEN","statusCheckRollup":[{"conclusion":"FAILURE"}]}\n' > "$W/gh/43.json"
  printf '{"state":"CLOSED"}\n' > "$W/gh/44.json"
  mkdir -p "$W/state/proj/requests/topicA"; printf 'restart thinker\n' > "$W/state/proj/requests/topicA/r1.txt"
  printf -- '- %s topicA/lead -> other/thinker: about u2\n- %s other/lead -> topicA/thinker: old\n- %s x/lead → y z topicA/lead: fifth field\nnot a line\n' "$ISO_RECENT" "$ISO_OLD" "$ISO_RECENT" > "$W/state/proj/cross-squad.md"
}
c_lead()      { lead_world; mail dlv_1 '[{"id":"m1","type":"worker_done","from_handle":"term_B","subject":"u2 done","body":"PR #41"}]'; W_ proj topicA 1; W_ proj topicA 1 --ack dlv_1; }
c_lead_wake() { # the loop rewrites the squad during the wait: the blocks show it as it is after
  lead_world; mail dlv_1 '[{"id":"m1","type":"worker_done","body":"merged"}]'
  cat > "$W/onwait" <<'EOS'
s="$W/state/proj/squads/topicA.json"
jq -c '.units |= map(if .slug == "u2" then .status = "done" else . end) | .waiting_on_you = [{"id":"q9","question":"new?"}] + .waiting_on_you' "$s" > "$s.tmp" && mv "$s.tmp" "$s"
EOS
  W_ proj topicA 1
}
c_lead_poll() { lead_world; W_ proj topicA --poll; FAKE_READ_RC=5 W_ proj topicA --poll; }
c_lead_fail() { lead_world; FAKE_READ_RC=6 FAKE_STATES_RC=1 W_ proj topicA 1; : > "$W/states"; FAKE_READ_RC=6 W_ proj topicA 1; }
c_lead_quiet() {
  lead_world; printf 'term_loop\n' > "$W/holder"
  W_ proj topicA 1; W_ proj topicA 1; W_ proj topicA 1 --full
  sed -i 's/^wtLead\tworking/wtLead\tidle/' "$W/states"; W_ proj topicA 1 --ack dlv_0; W_ proj topicA 1
  ORCA_TERMINAL_HANDLE=term_loop W_ proj topicA 1
}
c_finished() {
  # squad-done-definition U1 changed the ★ finished rule (a held unit is open work) and its text (wrapping
  # up), so the first world keeps no held unit and a Tester holds the line back in both trees;
  # tests/watch.sh covers the line itself.
  printf '{"run_id":"run_1","status":"running","units":[{"slug":"b","status":"done"},{"slug":"a","status":"cancelled"}],"members":[{"role":"lead","wt":"wtLead"},{"role":"thinker","wt":"wtT"},{"role":"tester","wt":"wtTs"}]}\n' > "$S"
  W_ proj topicA 1
  printf '{"run_id":"run_1","status":"running","units":[{"slug":"b","status":"done"},{"slug":"c","status":"planned"}],"members":[]}\n' > "$S"; W_ proj topicA 1
  printf '{"run_id":"run_1","type":"testing","units":[{"slug":"b","status":"done"}],"worktrees":["wtLead","path:x::wtGone",null]}\n' > "$S"; W_ proj topicA 1
}

# ---- ask-operator ----
NEW=(--title "Ship it or wait" --question "Ship u1 now or wait for u2?" --option "Ship" "u1 goes out" --option "Wait" "hold for u2" --recommend 2 --why "u2 fixes a bug")
c_ao_bad() {
  AO; AO "$S" q1 thinker maybe x; AO "$S" q1 thinker true --nope; AO "$S" q1 thinker true --title
  AO "$S" q1 thinker true --title "$(printf 'x%.0s' $(seq 1 81))" --question q --option a b --option c d --recommend 1 --why w
  AO "$S" q1 thinker true --title t --question q --option a b --recommend 1 --why w
  AO "$S" q1 thinker true --title t --question q --option a b --option c d --recommend 3 --why w
  AO "$S" q1 thinker true --title t --question q --option "a|b" x --option c d --recommend 1 --why w
  AO "$S" q1 thinker true --title t --question q --option a b --option c d --recommend 1 --why w --unit u1 --unit u2
  AO "$S" q1 thinker true --title t --question q --option a b --option c d --recommend 1 --why w --pr 3 --pr 4
  AO "$S" q1 thinker true --title t --question q --option a b --option c d --recommend 1 --why w --picker t1 /p maybe
  AO "$S" q1 thinker true "question" "suggestion" ""
  AO "$W/state/proj/squads/nope.json" q1 thinker true "${NEW[@]}"
  AO "$S" q1 thinker true "${NEW[@]}" --unit nosuch
  AO "$S" q1 thinker true --title "PR #5 and #6" --question q --option a b --option c d --recommend c --why w
}
c_ao_norun()  { printf '{"units":[]}\n' > "$S"; AO "$S" q1 thinker true "${NEW[@]}"; }
c_ao_builder() {
  printf '{"run_id":"run_1","units":[{"slug":"u1","status":"dispatched","pr":12},{"slug":"u2","status":"done","pr":13}]}\n' > "$S"
  AO "$S" q1 builder-u1 true --title "Review #12 please" --question q --option a b --option c d --recommend 1 --why w
  AO "$S" q1 lead true --title "about #12 and #13" --question q --option a b --option c d --recommend 1 --why w
  AO "$S" q1 builder true "${NEW[@]}" --pr 99
  AO "$S" q2 builder-u1 false --title "See #13 again" --question "is /pull/13 fine?" --option a b --option c d --recommend 1 --why w
}
c_ao_ok() {
  AO "$S" q1 thinker true "${NEW[@]}" --unit u1
  AO "$S" q2 thinker false --title "Name the flag" --question "Which flag name?" --option "--fast" "short" --option "--quick" "long" --recommend --quick --why "reads well"
  AO "$S" q3 lead false "Old style question?" "yes" "because" "yes|no"
}
c_ao_noping() { FAKE_PING_RC=1 AO "$S" q1 thinker true "${NEW[@]}"; FAKE_CURRENT="" AO "$S" q2 thinker false "${NEW[@]}"; }
c_ao_pr() {
  AO "$S" q1 thinker true "${NEW[@]}" --pr 7
  AO "$S" q2 thinker true --title "Sign off #7" --question "Is #7 ok?" --option a b --option c d --recommend 1 --why w
  printf '{"data":{"repository":{"pullRequest":{"state":"OPEN","isDraft":false,"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","reviewDecision":null,"reviewThreads":{"nodes":[]},"baseRef":null,"commits":{"nodes":[]}}}}}\n' > "$W/gh/graphql.json"
  AO "$S" q3 thinker true "${NEW[@]}" --pr 7
  AO "$S" q4 thinker false --title "two at once" --question "#8 or #9?" --option a b --option c d --recommend 1 --why w --picker tool_1 /t.jsonl true
}
# ask, then wait for the operator's answer in the asker's own inbox
c_ao_answer() {
  AO "$S" q1 thinker true "${NEW[@]}"
  later 0.4 dlv_ans '[{"id":"m9","type":"answer","from_handle":"operator","subject":"q1 answered","body":"Wait — hold for u2"}]'
  W_ --worktree 5000; W_ --worktree 1 --ack dlv_ans; W_ --worktree 1
}

same "watch: no mail (first tick, then unchanged)"          c_nomail
same "watch: one batch, --ack, never shown again"           c_batch
same "watch: mail arriving during --worktree <ms>"          c_arrive
same "watch: INSTRUCTIONS changed after an edit"            c_instr
same "watch: --poll peeks without ack or fingerprint"       c_poll
same "watch: --all re-read has no ACK-ID"                   c_all
same "watch: inbox read failure (wait, poll)"               c_readfail
same "watch: odd inbox payloads and delivery ids"           c_odd
same "watch: argument shapes and refusals"                  c_args
same "watch: Studio requests"                               c_requests
same "watch: Lead tick (team, units, PRs, questions)"       c_lead
same "watch: Lead sees the squad as it is after the wait" c_lead_wake
same "watch: Lead --poll"                                   c_lead_poll
same "watch: Lead with the inbox and states unreadable"     c_lead_fail
same "watch: Lead in a loop-run squad (quiet, --full)"      c_lead_quiet
same "watch: finished and legacy squads"                    c_finished
same "ask-operator: refusals"                               c_ao_bad
same "ask-operator: no run_id"                              c_ao_norun
same "ask-operator: PR questions from a Builder or Lead"    c_ao_builder
same "ask-operator: question rows and receipts"             c_ao_ok
same "ask-operator: on the board but not pinged"            c_ao_noping
same "ask-operator: --pr readiness and one question per PR" c_ao_pr
same "ask-operator: question row, then the answer wait"     c_ao_answer

# a flag with no value: the shell died on set -u (exit 1); the port says which flag, with the same exit code
for flag in --run --ack --requests; do
  o=0; n=0; world
  (cd "$W/wt" && "$TMP/old/bin/lib/watch.sh" --worktree "$flag" >/dev/null 2>&1) || o=$?
  (cd "$W/wt" && "$TMP/new/bin/lib/watch.sh" --worktree "$flag" >/dev/null 2>&1) || n=$?
  if [ "$o" = 1 ] && [ "$n" = 1 ]; then pass=$((pass + 1)); echo "ok   watch: $flag with no value exits 1"
  else fail=$((fail + 1)); echo "FAIL watch: $flag with no value exits 1 (old $o, new $n)"; fi
done

echo "parity-ask-watch: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
