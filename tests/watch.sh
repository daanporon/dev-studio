#!/usr/bin/env bash
# watch.sh --worktree — a worker watches its OWN inbox with just an [ms] timeout (no
# <project> <topic>). Regression: the documented-but-wrong form 'watch.sh <project> <topic>
# --worktree <ms>' used to read the project name as the timeout and return immediately.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fake backend: record which inbox verb + arg was used, so we can assert parsing + --poll routing.
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  inbox-wait-self) printf 'wait %s' "$2" > "$GOT"; echo "" ;;
  inbox-peek-self) printf 'peek' > "$GOT"; echo "" ;;
  *) echo "" ;;
esac
FAKE
chmod +x "$TMP/fakeb"
export GOT="$TMP/got"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }

BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree 280000 >/dev/null 2>&1
eq "correct form keeps the ms timeout"           "$(cat "$GOT")" "wait 280000"

BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" acme manual-testing --worktree 280000 >/dev/null 2>&1
eq "stray project/topic ignored, ms still used"  "$(cat "$GOT")" "wait 280000"

BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree acme >/dev/null 2>&1
eq "non-numeric timeout falls back to default"   "$(cat "$GOT")" "wait 90000"

# --poll routes to the NON-BLOCKING peek (no inbox-wait long-poll held).
BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree --poll >/dev/null 2>&1
eq "--poll uses the non-blocking peek (0 slots)" "$(cat "$GOT")" "peek"

# INSTRUCTIONS line: re-read only when the instruction files changed since THIS worktree
# (cwd) last saw them. The rewake hook's --poll peeks must neither print nor mark it seen.
export DS_INSTR_SEEN="$TMP/seen"
printf 'v1' > "$TMP/role.md"; export DS_INSTR_FILES="$TMP/role.md"
mkdir -p "$TMP/wt1" "$TMP/wt2"
tick(){ (cd "$1" && BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree 1000 ${2:+"$2"} 2>/dev/null | grep '^INSTRUCTIONS' || true); }
eq "poll prints no INSTRUCTIONS line"        "$(tick "$TMP/wt1" --poll)" ""
case "$(tick "$TMP/wt1")" in *changed*re-read*) r=ok ;; *) r=no ;; esac
eq "first real tick says re-read (poll didn't mark seen)" "$r" "ok"
case "$(tick "$TMP/wt1")" in *unchanged*) r=ok ;; *) r=no ;; esac
eq "second tick says unchanged"              "$r" "ok"
case "$(tick "$TMP/wt2")" in *changed*re-read*) r=ok ;; *) r=no ;; esac
eq "another worktree has its own seen mark"  "$r" "ok"
printf 'v2' > "$TMP/role.md"
case "$(tick "$TMP/wt1")" in *changed*re-read*) r=ok ;; *) r=no ;; esac
eq "an edited instruction file says re-read" "$r" "ok"
case "$(tick "$TMP/wt1")" in *unchanged*) r=ok ;; *) r=no ;; esac
eq "and then unchanged again"                "$r" "ok"

# Lead mode WORK ITEMS: every dispatched Builder shows `<state> <age>` + its last words with an
# age; a sitting one shows `since HH:MM`, not epoch ms; missing cols 4-5 print the state only.
LBL="zzwa_$$"; SD="$DS_STATE_ROOT/$LBL/squads"
trap 'rm -rf "$TMP" "$DS_STATE_ROOT/$LBL"' EXIT
mkdir -p "$SD"
printf '{"run_id":"r1","units":[{"slug":"u3","status":"dispatched","builder_wt":"wtW"},{"slug":"u4","status":"dispatched","builder_wt":"wtI5"},{"slug":"u5","status":"dispatched","builder_wt":"wtI20"},{"slug":"u6","status":"dispatched","builder_wt":"wtBare"}]}' > "$SD/mt.json"
now=$(date +%s); ago(){ echo $(( (now - $1 * 60) * 1000 )); }
s20="$(ago 20)"; hm20="$(jq -rn --argjson s "$((s20 / 1000))" '$s|strflocaltime("%H:%M")')"
{ printf 'wtW\tworking\tW\t%s\trunning the integration tests…\n' "$(ago 130)"
  printf 'wtI5\tidle\tI5\t%s\tpushed, waiting on CI\n' "$(ago 5)"
  printf 'wtI20\tidle\tI20\t%s\tdone with the refactor\n' "$s20"
  printf 'wtBare\tworking\tBare\n'; } > "$TMP/states"
cat > "$TMP/fakel" <<'FAKE'
#!/usr/bin/env bash
case "$1" in worker-states) cat "$STATES" ;; *) echo "" ;; esac
FAKE
chmod +x "$TMP/fakel"
lout="$(STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" mt 1000 2>&1)" || true
has(){ if grep -qF -- "$3" <<< "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — missing [$3] in:" >&2; printf '%s\n' "$2" >&2; fi; }
hasnt(){ if grep -qF -- "$3" <<< "$2"; then fail=$((fail+1)); echo "  FAIL: $1 — has [$3]" >&2; else pass=$((pass+1)); fi; }
has   "working 130m -> working 2h10m"        "$lout" $'u3\twtW\tworking 2h10m'
has   "its last words with an age"           "$lout" "last said (≤2h10m ago): running the integration tests…"
has   "idle 5m -> idle 5m"                   "$lout" $'u4\twtI5\tidle 5m'
hasnt "idle 5m is not sitting"               "$lout" $'sitting\tu4'
has   "idle 20m -> sitting since HH:MM"      "$lout" $'⏸ sitting\tu5\twtI20\t20m idle\tnudge it\t(since '"$hm20"')'
hasnt "no raw epoch ms on the sitting line"  "$lout" "$s20"
eq    "missing since/said -> state only"     "$(printf '%s\n' "$lout" | grep $'\tu6\t')" $'  ⟳ dispatched\tu6\twtBare\tworking'

# Cancelled units (retire-builder U3): an ✗ row naming the into target (an empty
# builder_wt must not shift it into the wrong field), never a `?` row.
printf '{"run_id":"r1","units":[{"slug":"u2","status":"cancelled","superseded_by":"PR#19717"},{"slug":"u3","status":"cancelled"}]}' > "$SD/cx.json"
cout="$(STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" cx 1000 2>&1)" || true
has   "cancelled row names its into target"  "$cout" $'✗ cancelled\tu2\t(folded into PR#19717)'
has   "cancelled without into shows plain"   "$cout" $'✗ cancelled\tu3'
hasnt "no ? row for a cancelled unit"        "$cout" $'?\tu2'

# The loop delivers ready-unit messages; a tick must not synthesize a rewake-ready line.
printf '{"run_id":"run9","units":[{"slug":"next","status":"planned"}]}' > "$SD/rd.json"
rout="$(STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" rd --poll 2>&1)" || true
hasnt "ready units belong to the loop" "$rout" '▶ ready'

# ★ finished: a running feature squad with every unit done or cancelled prints the close-out line (with
# the exact /ds-close-squad <topic> text); not while a unit is dispatched, planned or held,
# not for a testing squad, an empty squad, or one already marked done. Shows on --poll too.
fin() { printf '%s' "$2" > "$SD/$1.json"; STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" "$1" "${3:-1000}" 2>&1 || true; }
FL=$'★ finished\tfz\t'
ftok() { fin "$@" | awk -F'\t' '/★ finished/ {print $3}'; }
has   "finished feature squad prints the close-out line" "$(fin fz '{"run_id":"r","units":[{"slug":"a","status":"done"},{"slug":"b","status":"cancelled"}]}')" "$FL"
has   "the close-out line says the squad is wrapping up" "$(fin fz '{"run_id":"r","units":[{"slug":"a","status":"done"}]}')" "wrapping up"
# squad-done-definition U1: a held unit is open work, whatever its hold kind — no line.
for hk in '"hold":true' '"hold":true,"hold_by":"plan"' '"hold":true,"hold_by":"parked"' '"hold":true,"hold_reason":"freeze"'; do
  hasnt "a held unit ($hk) holds the line back" "$(fin fy "{\"run_id\":\"r\",\"units\":[{\"slug\":\"a\",\"status\":\"done\"},{\"slug\":\"h\",\"status\":\"planned\",$hk}]}")" '★ finished'
done
has   "the close-out line also shows on --poll"         "$(fin fz '{"run_id":"r","units":[{"slug":"a","status":"done"}]}' --poll)" "$FL"
has   "the close-out line names the close command"      "$(fin fz '{"run_id":"r","units":[{"slug":"a","status":"done"}]}')" "/ds-close-squad fz"
has   "the close-out line asks for the debrief first"  "$(fin fz '{"run_id":"r","units":[{"slug":"a","status":"done"}]}')" "write the debrief (set-debrief), then set-status done"
hasnt "the line no longer skips the testability handoff" "$(fin fz '{"run_id":"r","units":[{"slug":"a","status":"done"}]}')" "skip it for docs-only"
hasnt "a tester member holds the line back"             "$(fin fy '{"run_id":"r","members":[{"role":"lead"},{"role":"tester"}],"units":[{"slug":"a","status":"done"}]}')" '★ finished'
T_AB="$(ftok fz '{"run_id":"r","units":[{"slug":"a","status":"done"},{"slug":"b","status":"done"}]}')"
T_BA="$(ftok fz '{"run_id":"r","units":[{"slug":"b","status":"done"},{"slug":"a","status":"done"}]}')"
T_ABC="$(ftok fz '{"run_id":"r","units":[{"slug":"a","status":"done"},{"slug":"b","status":"done"},{"slug":"c","status":"done"}]}')"
T_RUN="$(ftok fz '{"run_id":"r2","units":[{"slug":"a","status":"done"},{"slug":"b","status":"done"}]}')"
T_MEM="$(ftok fz '{"run_id":"r","members":[{"role":"lead"}],"units":[{"slug":"a","status":"done"},{"slug":"b","status":"done"}]}')"
eq "finish token is set"                              "$([ -n "$T_AB" ] && echo y)" "y"
eq "finish token ignores unit order"                  "$T_AB" "$T_BA"
eq "finish token changes when a unit is added"        "$([ "$T_AB" != "$T_ABC" ] && echo y)" "y"
eq "finish token changes with a new run id"           "$([ "$T_AB" != "$T_RUN" ] && echo y)" "y"
eq "finish token changes when member roles differ"    "$([ "$T_AB" != "$T_MEM" ] && echo y)" "y"
hasnt "a dispatched unit holds the line back"           "$(fin fy '{"run_id":"r","units":[{"slug":"a","status":"done"},{"slug":"b","status":"dispatched"}]}')" '★ finished'
hasnt "a planned unheld unit holds the line back"       "$(fin fy '{"run_id":"r","units":[{"slug":"a","status":"done"},{"slug":"b","status":"planned","deps":["a"]}]}')" '★ finished'
hasnt "a testing squad never gets the line"             "$(fin fy '{"run_id":"r","type":"testing","units":[{"slug":"a","status":"done"}]}')" '★ finished'
hasnt "an empty squad gets no line"                     "$(fin fy '{"run_id":"r","units":[]}')" '★ finished'
hasnt "a squad already done gets no line"               "$(fin fy '{"run_id":"r","status":"done","units":[{"slug":"a","status":"done"}]}')" '★ finished'

# REQUESTS: restart requests the removed sweep filed. A Lead sees its squad's (requests/<topic>/);
# the Studio sees requests/_studio/ via --worktree --requests <label>, also on a --poll peek.
RQ="$DS_STATE_ROOT/$LBL/requests"; mkdir -p "$RQ/mt" "$RQ/_studio"
echo "restart builder-u3 of mt (hung since 10:00)" > "$RQ/mt/mt.builder-u3-1.txt"
echo "restart lead of mt (dead since 03:00)" > "$RQ/_studio/mt.lead-1.txt"
lout="$(STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" mt 1000 2>&1)" || true
has   "Lead tick lists its squad's request"  "$lout" "↻ request"$'\t'"restart builder-u3 of mt (hung since 10:00)"
has   "and says to clear it with done-request.sh" "$lout" "bin/role/done-request.sh $RQ/mt/mt.builder-u3-1.txt"
hasnt "and never a bare rm"                  "$lout" "then: rm "
hasnt "Lead tick does not show the Studio's" "$lout" "restart lead of mt"
sout="$(BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree --requests "$LBL" --poll 2>&1)" || true
has   "Studio peek lists _studio requests"   "$sout" "↻ request"$'\t'"restart lead of mt (dead since 03:00)"
hasnt "Studio peek skips squad requests"     "$sout" "restart builder-u3 of mt"
# A request the operator filed from the board names the command to run, not a restart.
echo "board: the operator asks you to run: /ds-close-squad mt" > "$RQ/_studio/board-close-mt-1.txt"
sout="$(BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree --requests "$LBL" --poll 2>&1)" || true
has   "board request listed"                 "$sout" "↻ request"$'\t'"board: the operator asks you to run: /ds-close-squad mt"
has   "board request: run it, then done-request" "$sout" "run that command (the operator asked from the board), then: $ROOT/bin/role/done-request.sh $RQ/_studio/board-close-mt-1.txt"
hasnt "board request: no restart hint"       "$(printf '%s' "$sout" | grep -A1 'ds-close-squad')" "restart-role.sh"
rm -f "$RQ/_studio/board-close-mt-1.txt"
# The loop's morning brief (U3) asks the Studio to write it, not to restart anything.
echo 'briefing: write the morning brief for mt, 2027-01-11 (since Sun 09:00) — studio/studio.md "Morning brief"; facts: bin/ds briefing-input mt --date 2027-01-11' > "$RQ/_studio/briefing-7.txt"
sout="$(BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree --requests "$LBL" --poll 2>&1)" || true
has   "briefing request listed"              "$sout" "↻ request"$'\t'"briefing: write the morning brief for mt"
has   "briefing request: write it, then done-request" "$sout" "write the morning brief (studio/studio.md, \"Morning brief\"), then clear it with done-request.sh: $ROOT/bin/role/done-request.sh $RQ/_studio/briefing-7.txt"
hasnt "briefing request: no restart hint"    "$(printf '%s' "$sout" | grep -A1 'facts: bin/ds briefing-input')" "restart-role.sh"
rm -f "$RQ/_studio/briefing-7.txt"
# The sweep's usage-limit switch names the exact restart to run (a plain restart keeps the exhausted account).
echo "switch: restart lead of mt (usage limit on a: x) on the next pick — run: bin/commands/restart-role.sh mt mt lead --resume --agent claude --model sonnet --account b" > "$RQ/_studio/mt.lead-1.txt"
sout="$(BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree --requests "$LBL" --poll 2>&1)" || true
has   "switch request: run that exact command" "$sout" "usage limit: run that exact command"
rm -f "$RQ/_studio/mt.lead-1.txt"
wout="$(BACKEND="$TMP/fakeb" "$ROOT/bin/lib/watch.sh" --worktree --poll 2>&1)" || true
hasnt "a plain worker has no REQUESTS"       "$wout" "REQUESTS"

# A failed read must not hide independent requests or a Lead's check-in. A failed poll
# gives the hook only a real request to wake on, never a partial team report.
cat > "$TMP/fakefail" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  inbox-*) echo 'consumer_fenced: inbox unavailable' >&2; exit 1 ;;
  worker-states) cat "$STATES" ;;
esac
FAKE
chmod +x "$TMP/fakefail"
echo 'restart lead of mt (failed read)' > "$RQ/_studio/mt.lead-failed.txt"
rc=0; fout="$(BACKEND="$TMP/fakefail" "$ROOT/bin/lib/watch.sh" --worktree --requests "$LBL" 1000)" || rc=$?
eq    "failed foreground request tick exits nonzero" "$rc" 1
has   "failed foreground still shows request" "$fout" $'↻ request\t'"restart lead of mt (failed read)"
eq    "failed foreground ends with error" "$(tail -n1 <<<"$fout")" "INBOX READ FAILED: consumer_fenced: inbox unavailable"
hasnt "failed foreground never claims empty inbox" "$fout" "do a check-in and re-arm"
hasnt "failed foreground gives no ACK-ID" "$fout" "ACK-ID:"
rc=0; fout="$(STATES="$TMP/states" BACKEND="$TMP/fakefail" "$ROOT/bin/lib/watch.sh" "$LBL" mt 1000)" || rc=$?
eq    "failed Lead tick exits nonzero" "$rc" 1
has   "failed Lead still shows squad request" "$fout" $'↻ request\t'"restart builder-u3 of mt (hung since 10:00)"
has   "failed Lead still shows team" "$fout" "TEAM:"
has   "failed Lead still shows work" "$fout" "WORK ITEMS:"
eq    "failed Lead ends with error" "$(tail -n1 <<<"$fout")" "INBOX READ FAILED: consumer_fenced: inbox unavailable"
rc=0; pout="$(BACKEND="$TMP/fakefail" "$ROOT/bin/lib/watch.sh" --worktree --requests "$LBL" --poll 2>"$TMP/poll.err")" || rc=$?
eq    "failed poll with request exits nonzero" "$rc" 1
has   "failed poll still wakes for request" "$pout" $'↻ request\t'"restart lead of mt (failed read)"
eq    "failed poll starts with REQUESTS" "$(head -n1 <<<"$pout")" "REQUESTS:"
hasnt "failed poll has no inbox header" "$pout" "=== "
hasnt "failed poll has no team" "$pout" "TEAM:"
hasnt "failed poll has no work sections" "$pout" "WORK ITEMS:"
hasnt "failed poll has no messages section" "$pout" "MESSAGES:"
hasnt "failed poll has no ACK-ID" "$pout" "ACK-ID:"
hasnt "failed poll has no empty inbox" "$pout" "do a check-in and re-arm"
has   "failed poll puts error on stderr" "$(cat "$TMP/poll.err")" "INBOX READ FAILED: consumer_fenced: inbox unavailable"
rc=0; pout="$(STATES="$TMP/states" BACKEND="$TMP/fakefail" "$ROOT/bin/lib/watch.sh" "$LBL" rd --poll 2>"$TMP/poll.err")" || rc=$?
eq    "failed Lead poll without request exits nonzero" "$rc" 1
eq    "failed Lead poll without request leaves stdout empty" "$pout" ""
has   "failed Lead poll error stays on stderr" "$(cat "$TMP/poll.err")" "INBOX READ FAILED: consumer_fenced: inbox unavailable"
rm -f "$RQ/_studio/mt.lead-failed.txt"

# A failed inbox read plus unavailable worker states must not tell the Lead to
# re-dispatch healthy members or units. The durable roster still appears.
cat > "$TMP/fakefailstates" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  inbox-*|worker-states) echo 'orca unavailable' >&2; exit 1 ;;
esac
FAKE
chmod +x "$TMP/fakefailstates"
printf '{"run_id":"r1","members":[{"role":"thinker","wt":"wtT"},{"role":"builder","wt":"wtB"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtB"}]}' > "$SD/broken.json"
rc=0; fout="$(BACKEND="$TMP/fakefailstates" "$ROOT/bin/lib/watch.sh" "$LBL" broken 1000)" || rc=$?
eq    "failed Lead tick with no worker states exits nonzero" "$rc" 1
has   "failed Lead tick still shows roster" "$fout" "thinker"
has   "failed Lead tick still shows work" "$fout" "u1"
has   "failed Lead tick labels unavailable worker states" "$fout" "worker state unavailable"
hasnt "failed Lead tick does not invent GONE" "$fout" "GONE"
hasnt "failed Lead tick does not advise re-dispatch" "$fout" "re-dispatch"
eq    "failed Lead tick ends with read error" "$(tail -n1 <<<"$fout")" "INBOX READ FAILED: orca unavailable"

# Full bodies: no 500-char cut, newlines kept (indented); --all re-reads via inbox-all-self.
cat > "$TMP/fakem" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  inbox-peek-self|inbox-wait-self) echo "$1" > "$GOT"; cat "$MSGS" ;;
  inbox-all-self) echo "$1" > "$GOT"; cat "$MSGS" ;;
  *) echo "" ;;
esac
FAKE
chmod +x "$TMP/fakem"
long="$(head -c 1200 /dev/zero | tr '\0' 'x')TAIL-END-MARKER-0123456789-0123456789-0123456789"
jq -n --arg b "$long" '{result:{deliveryId:"dlv1",messages:[{id:"m1",type:"msg",from_handle:"a",subject:"s",body:$b}]}}' > "$TMP/msgs1"
mout="$(MSGS="$TMP/msgs1" BACKEND="$TMP/fakem" "$ROOT/bin/lib/watch.sh" --worktree --poll 2>&1)"
has   "a 1200-char body is printed to the end" "$mout" "TAIL-END-MARKER-0123456789-0123456789-0123456789"
hasnt "no truncation marker"                   "$mout" " …"
has   "poll prints the ACK-ID"                 "$mout" "ACK-ID: dlv1"
jq -n '{result:{messages:[{id:"m2",type:"msg",from_handle:"a",subject:"s",body:"line one\nline two\nline three"}]}}' > "$TMP/msgs2"
mout="$(MSGS="$TMP/msgs2" BACKEND="$TMP/fakem" "$ROOT/bin/lib/watch.sh" --worktree --poll 2>&1)"
eq    "three body lines, indented"             "$(printf '%s\n' "$mout" | grep -c '^      line ')" "3"
mout="$(MSGS="$TMP/msgs1" BACKEND="$TMP/fakem" "$ROOT/bin/lib/watch.sh" --worktree --all 2>&1)"
eq    "--all uses inbox-all-self"              "$(cat "$GOT")" "inbox-all-self"
has   "--all prints the body"                  "$mout" "TAIL-END-MARKER"
hasnt "--all prints no ACK-ID"                 "$mout" "ACK-ID"

# U61: while the loop's pane holds the Run, Lead mode reads the Lead's OWN worktree inbox, where the
# loop relays the Run's mail; the Run inbox (fenced to that pane) is never read. A relayed question
# names the `ds reply` that answers it. Orca can't say who holds the Run -> the Run inbox, as before.
cat > "$TMP/fakeh" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  run-coordinator) [ -n "${HOLDER:-}" ] || exit 1; echo "$HOLDER" ;;
  inbox-peek-self|inbox-wait-self|inbox-all-self) echo "$1" >> "$GOT"; cat "$MSGS" ;;
  inbox-peek|inbox-wait|inbox-all) echo "$1" >> "$GOT"; echo "error: consumer_fenced: This caller is not bound to Run $2." >&2; exit 1 ;;
  *) echo "" ;;
esac
FAKE
chmod +x "$TMP/fakeh"
jq -n '{result:{deliveryId:"dlv9",messages:[{id:"msg_fwd",type:"status",from_handle:"term_loop",subject:"Question",
  body:"[run mail · question from dispatch:ctx_b · id msg_q1 · task task_1]\nWhich base branch?\nanswer: ds reply msg_q1 \"<answer>\""}]}}' > "$TMP/msgs3"
: > "$GOT"
hout="$(HOLDER=term_loop ORCA_TERMINAL_HANDLE=term_lead MSGS="$TMP/msgs3" STATES="$TMP/states" BACKEND="$TMP/fakeh" "$ROOT/bin/lib/watch.sh" "$LBL" mt --poll 2>&1)" || true
eq    "loop holds the Run -> the Lead's own inbox" "$(cat "$GOT")" "inbox-peek-self"
has   "the relayed question is shown"          "$hout" "Which base branch?"
has   "it names the ds reply with the question id" "$hout" "you MUST answer: ~/.dev-studio/bin/ds reply msg_q1"
has   "the header says the loop relays"        "$hout" "the loop holds run=r1"
hasnt "no fenced error"                        "$hout" "consumer_fenced"
: > "$GOT"
HOLDER=term_lead ORCA_TERMINAL_HANDLE=term_lead MSGS="$TMP/msgs3" STATES="$TMP/states" BACKEND="$TMP/fakeh" "$ROOT/bin/lib/watch.sh" "$LBL" mt --poll >/dev/null 2>&1 || true
eq    "the Lead holds the Run -> the Run inbox" "$(cat "$GOT")" "inbox-peek"
: > "$GOT"
MSGS="$TMP/msgs3" STATES="$TMP/states" BACKEND="$TMP/fakeh" "$ROOT/bin/lib/watch.sh" "$LBL" mt --poll >/dev/null 2>&1 || true
eq    "holder unknown -> the Run inbox"        "$(cat "$GOT")" "inbox-peek"

# CROSS-SQUAD: lines naming this squad, last 24h only; (none) when the log is absent.
lout="$(STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" mt 1000 2>&1)" || true
has   "no log -> CROSS-SQUAD (none)"           "$(printf '%s\n' "$lout" | sed -n '/^CROSS-SQUAD:/,$p')" "(none)"
nowiso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; oldiso="$(date -u -d '30 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
{ echo "- $nowiso mt/thinker → other/thinker [fresh-ping] m1"
  echo "- $oldiso mt/thinker → other/lead [stale-ping] m2"
  echo "- $nowiso x/thinker → y/thinker [unrelated-ping] m3"; } > "$DS_STATE_ROOT/$LBL/cross-squad.md"
lout="$(STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" mt 1000 2>&1)" || true
has   "recent exchange shown"                  "$lout" "[fresh-ping]"
hasnt "older than 24h hidden"                  "$lout" "[stale-ping]"
hasnt "other squads' exchanges hidden"         "$lout" "[unrelated-ping]"

# CREW CHAT: the operator's board chats to this squad's crew (fulfil/chat.ts), last 24h, at most 10;
# (none) when the log is absent. A log line, never mail.
crew() { printf '%s\n' "$lout" | sed -n '/^CREW CHAT:/,$p'; }
eq    "no crew log -> CREW CHAT (none)"        "$(crew)" "$(printf 'CREW CHAT:\n  (none)')"
{ echo "- $oldiso operator → mt/builder-u1: [stale-chat]"
  for i in 1 2 3 4 5 6 7 8 9 10 11; do echo "- $nowiso operator → mt/builder-u$i: [chat-$i]"; done
  echo "- $nowiso operator → mtx/builder-u1: [prefix-chat]"
  echo "- $nowiso operator → other/tester: [other-chat]"; } > "$DS_STATE_ROOT/$LBL/crew-chat.md"
lout="$(STATES="$TMP/states" BACKEND="$TMP/fakel" "$ROOT/bin/lib/watch.sh" "$LBL" mt 1000 2>&1)" || true
has   "recent crew chat shown"                 "$(crew)" "[chat-11]"
eq    "at most 10 crew chats"                  "$(crew | grep -c 'operator →')" "10"
hasnt "the oldest of 11 dropped"               "$(crew)" "[chat-1]"
hasnt "crew chat older than 24h hidden"        "$(crew)" "[stale-chat]"
hasnt "another squad's crew chat hidden"       "$(crew)" "[other-chat]"
hasnt "a squad sharing the prefix hidden"      "$(crew)" "[prefix-chat]"
has   "CREW CHAT comes after CROSS-SQUAD"      "$(printf '%s\n' "$lout" | sed -n '/^CROSS-SQUAD:/,$p')" "CREW CHAT:"

# U78: in a squad the loop runs, the TEAM + WORK ITEMS block lists only what changed since the last
# tick plus one count line; --full lists all; a squad the loop does not run prints as today.
cat > "$TMP/fakeq" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  run-coordinator) [ -n "${HOLDER:-}" ] && echo "$HOLDER" ;;
  worker-states) cat "$STATES" ;;
  inbox-*) echo "" ;;
  *) echo "" ;;
esac
FAKE
chmod +x "$TMP/fakeq"
printf '{"run_id":"rq","members":[{"role":"lead","wt":"wL"},{"role":"thinker","wt":"wT"},{"role":"builder","suffix":"a","wt":"wA"}],"units":[{"slug":"d1","status":"done"},{"slug":"p1","status":"planned","hold":true},{"slug":"w1","status":"dispatched","builder_wt":"wA"}]}' > "$SD/lq.json"
{ printf 'wL\tworking\tL\n'; printf 'wT\tidle\tT\n'; printf 'wA\tworking\tA\n'; } > "$TMP/states"
rm -f "$SD/lq.watch-seen"
lq() { HOLDER=term_loop ORCA_TERMINAL_HANDLE=term_lead STATES="$TMP/states" BACKEND="$TMP/fakeq" "$ROOT/bin/lib/watch.sh" "$LBL" lq 1000 "$@" 2>&1 || true; }
q1="$(lq)"
has   "first tick lists every worker"           "$q1" $'idle\tthinker'
has   "first tick lists every unit"             "$q1" $'✓ done\td1'
hasnt "first tick has no count line"            "$q1" "units unchanged"
q2="$(lq)"
has   "unchanged team: the count line"          "$q2" "(3 workers, 3 units unchanged"
hasnt "unchanged team: no worker rows"          "$q2" $'idle\tthinker'
hasnt "unchanged units: no unit rows"           "$q2" $'✓ done\td1'
lq --poll >/dev/null
lq --ack dlvX >/dev/null
q3="$(lq)"
has   "a --poll peek leaves the snapshot alone" "$q3" "(3 workers, 3 units unchanged"
printf 'wL\tworking\tL\nwT\tidle\tT\n' > "$TMP/states"
q4="$(lq)"
has   "a worker gone is listed"                 "$q4" $'GONE\tbuilder-a'
has   "its unit shows as gone"                  "$q4" $'⚠ dispatched\tw1\twA\tGONE'
has   "the rest is still counted"               "$q4" "(2 workers, 2 units unchanged"
printf '{"run_id":"rq","members":[{"role":"lead","wt":"wL"},{"role":"thinker","wt":"wT"},{"role":"builder","suffix":"a","wt":"wA"}],"units":[{"slug":"d1","status":"done"},{"slug":"p1","status":"planned"},{"slug":"w1","status":"dispatched","builder_wt":"wA"}]}' > "$SD/lq.json"
printf 'wL\tworking\tL\nwT\tidle\tT\nwA\tworking\tA\n' > "$TMP/states"
lq >/dev/null
printf '{"run_id":"rq","members":[{"role":"lead","wt":"wL"},{"role":"thinker","wt":"wT"},{"role":"builder","suffix":"a","wt":"wA"}],"units":[{"slug":"d1","status":"done"},{"slug":"p1","status":"cancelled"},{"slug":"w1","status":"dispatched","builder_wt":"wA"}]}' > "$SD/lq.json"
q6="$(lq)"
has   "a unit that changed status is listed"    "$q6" $'✗ cancelled\tp1'
hasnt "the unchanged units are not"             "$q6" $'✓ done\td1'
q7="$(lq --full)"
has   "--full lists the workers"                "$q7" $'idle\tthinker'
has   "--full lists the units"                  "$q7" $'✓ done\td1'
hasnt "--full has no count line"                "$q7" "units unchanged"
LQR="$TMP/lqrepo"; git init -q "$LQR"; git -C "$LQR" remote add origin https://github.com/acme/lq.git
# a PR line that changes (live gh path: checks go red) re-lists its unit
cat > "$TMP/ghq" <<'FAKE'
#!/usr/bin/env bash
printf '{"state":"%s","mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"%s"}]}' "$GHS" "$GHC"
FAKE
chmod +x "$TMP/ghq"
printf '{"run_id":"rq","repo":"path:%s","members":[{"role":"lead","wt":"wL"}],"units":[{"slug":"w1","status":"dispatched","builder_wt":"wA","pr":7}]}' "$LQR" > "$SD/lq.json"
printf 'wL\tworking\tL\nwA\tworking\tA\n' > "$TMP/states"
pq() { GHC="$1" GHS="${2:-OPEN}" DS_GH="$TMP/ghq" HOLDER=term_loop ORCA_TERMINAL_HANDLE=term_lead STATES="$TMP/states" BACKEND="$TMP/fakeq" "$ROOT/bin/lib/watch.sh" "$LBL" lq 1000 2>&1 || true; }
pq SUCCESS >/dev/null
has   "unchanged PR: unit counted, not listed"  "$(pq SUCCESS)" "(1 workers, 1 units unchanged"
has   "checks went red: the unit is listed"     "$(pq FAILURE)" "checks failing"
printf 'wL\tworking\tL\nwA\tidle\tA\t%s\n' "$(( ($(date +%s) - 1200) * 1000 ))" > "$TMP/states"
mergedq="$(pq SUCCESS MERGED)"
has   "live merged PR gets its action row"     "$mergedq" $'‼ merged\tw1\twA\tPR #7 MERGED\tthe loop has not marked it done: mark it done and retire the Builder'
hasnt "merged PR suppresses sitting nudge"      "$mergedq" "⏸ sitting"
has   "merged action survives quiet mode"       "$(pq SUCCESS MERGED)" $'‼ merged\tw1\twA\tPR #7 MERGED'
printf '{"run_id":"rq","members":[{"role":"lead","wt":"wL"}],"units":[{"slug":"d1","status":"done"}]}' > "$SD/lq.json"
rm -f "$SD/lq.watch-seen"; lq >/dev/null
HOLDER="" STATES="$TMP/states" BACKEND="$TMP/fakeq" "$ROOT/bin/lib/watch.sh" "$LBL" lq 1000 >/dev/null 2>&1 || true
nl="$(HOLDER="" STATES="$TMP/states" BACKEND="$TMP/fakeq" "$ROOT/bin/lib/watch.sh" "$LBL" lq 1000 2>&1 || true)"
has   "a squad the loop does not run prints all" "$nl" $'✓ done\td1'
hasnt "and has no count line"                    "$nl" "units unchanged"

# U96/U100: an idle standing role is not read as settled. A Thinker reading `done`
# with an open dispatch prints `waiting` (the word an idle role already gets); with a
# settled dispatch it prints `⚠ settled`; a rebound-settled one (the loop settled it
# after its own rebind) prints `waiting`; a Thinker whose dispatch read is stale and one
# with no dispatch on record keep `done`; a Builder reading `done` still prints `done`.
# The word is the loop's own verdict via `bin/ds members`, never a new Orca call.
printf '{"run_id":"r96","members":[{"role":"lead","wt":"wL"},{"role":"thinker","suffix":"open","wt":"wTopen"},{"role":"thinker","suffix":"shut","wt":"wTshut"},{"role":"thinker","suffix":"reb","wt":"wTreb"},{"role":"thinker","suffix":"stale","wt":"wTstale"},{"role":"builder","suffix":"b","wt":"wB"},{"role":"thinker","suffix":"unk","wt":"wTunk"}],"units":[]}' > "$SD/u96.json"
{ printf 'wL\tworking\tL\n'
  printf 'wTopen\tdone\tT\n'
  printf 'wTshut\tdone\tT\n'
  printf 'wTreb\tdone\tT\n'
  printf 'wTstale\tdone\tT\n'
  printf 'wB\tdone\tB\n'
  printf 'wTunk\tdone\tT\n'; } > "$TMP/states96"
ST96="$TMP/ds96"; rm -rf "$ST96"; mkdir -p "$ST96/$LBL/squads"
cp "$SD/u96.json" "$ST96/$LBL/squads/u96.json"
DS_STATE_ROOT="$ST96" "$ROOT/bin/ds" import >/dev/null
cat > "$TMP/seed96.ts" <<TS
import { open, now } from "$ROOT/bin/loop/core/store.ts";
const s = open(); const at = now();
for (const [wt, d] of [["wTopen", "dispatched"], ["wTshut", "succeeded"], ["wTreb", "failed"]] as const)
  s.upsert("observed_workers", { project: "$LBL", wt }, { state: "done", dispatch: d, dispatch_seen_at: at, observed_at: at });
s.upsert("observed_workers", { project: "$LBL", wt: "wTreb" }, { dispatch_id: "ctx_r" });
s.upsert("observed_workers", { project: "$LBL", wt: "wTstale" }, { state: "done", dispatch: "succeeded", dispatch_seen_at: at - 3600, observed_at: at });
s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?)",
  [at, "$LBL", "u96", "wTreb", "member_rebound_settled", JSON.stringify({ dispatch: "ctx_r" })]);
s.close();
TS
DS_STATE_ROOT="$ST96" bun "$TMP/seed96.ts"
cp "$SD/u96.json" "$ST96/$LBL/squads/u96.json"   # watch.sh reads the squad file from the same root now: put the hand-written one back after import
t96="$(STATES="$TMP/states96" BACKEND="$TMP/fakel" DS_STATE_ROOT="$ST96" "$ROOT/bin/lib/watch.sh" "$LBL" u96 1000  2>&1)" || true
has   "open dispatch reads waiting, not done" "$t96" $'waiting\tthinker-open'
hasnt "the idle thinker keeps no done row"    "$t96" $'done\tthinker-open'
has   "settled dispatch reads settled"        "$t96" $'⚠ settled\tthinker-shut'
has   "the settled row names the verdict"     "$t96" "(dispatch settled"
has   "rebound-settled reads waiting"         "$t96" $'waiting\tthinker-reb'
has   "stale dispatch read keeps done"        "$t96" $'done\tthinker-stale'
has   "a done Builder still reads done"       "$t96" $'done\tbuilder-b'
has   "no dispatch on record keeps done"      "$t96" $'done\tthinker-unk'
mkdir -p "$TMP/empty96/$LBL/squads"; cp "$SD/u96.json" "$TMP/empty96/$LBL/squads/u96.json"
e96="$(STATES="$TMP/states96" BACKEND="$TMP/fakel" DS_STATE_ROOT="$TMP/empty96" "$ROOT/bin/lib/watch.sh" "$LBL" u96 1000 2>&1)" || true
has   "loop down keeps today's word"          "$e96" $'done\tthinker-open'
rm -f "$SD/u96.json"

echo "watch: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
