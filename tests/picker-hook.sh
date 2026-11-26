#!/usr/bin/env bash
# picker-hook.sh — a terminal AskUserQuestion picker is mirrored onto the board as a
# `picker-…` entry (pre, detached so a slow backend never delays the picker) and cleared
# when answered in the terminal (post). Dedup: a blocking entry already queued for the
# worktree (rule 1), or a picker question restating a queued title (rule 2, the /ds-q
# shape), adds nothing — and a skipped picker never resolves someone else's entry.
set -uo pipefail
# shellcheck source=tests/lib/hook-tree.sh
. "$(dirname "$0")/lib/hook-tree.sh"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/bin/hooks/picker-hook.sh"
FIX="$ROOT/tests/fixtures"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/st/squads"
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$HOOK_LOG"
case "$1" in
  current) echo "${FAKE_WT:-wtB}" ;;
  ping) : ;;
esac
FAKE
chmod +x "$TMP/fakeb"
export HOOK_LOG="$TMP/log" BACKEND="$TMP/fakeb" FAKE_WT=wtB
: > "$HOOK_LOG"

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
mkstate() { rm -rf "$TMP/st/picker-done"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[%s]}' "${2:-}" > "$TMP/st/squads/$1.json"; printf '%s' "$TMP/st/squads/$1.json"; }
# wait_q <state> <jq-cond> <timeout-s>: the pre hook queues detached — poll for it.
wait_q() { local end=$(( $(date +%s) + $3 )); while [ "$(date +%s)" -lt "$end" ]; do
  jq -e "$2" "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }

# --- pre mirrors a picker -------------------------------------------------------
S="$(mkstate basic)"
out="$("$HOOK" pre "$S" thinker wtB < "$FIX/picker-pre.json" 2>/dev/null)"; rc=$?
eq "pre exits 0" "$rc" "0"
eq "pre prints nothing to the agent" "$out" ""
wait_q "$S" '.waiting_on_you | length == 1' 10 || { fail=$((fail+1)); echo "  FAIL: pre queued nothing (timed out)" >&2; }
q="$(jq -c '.waiting_on_you[0]' "$S")"
eq "id is picker-<tool_use_id suffix>" "$(jq -r .id <<<"$q")" "picker-34567890"
eq "asker is the role label" "$(jq -r .asker <<<"$q")" "thinker"
eq "blocking" "$(jq -r .blocking <<<"$q")" "true"
eq "title is header + text" "$(jq -r .title <<<"$q")" "Style: Which color for the banner?"
eq "question carries the picker text" "$(jq -r '.question | contains("Which color for the banner?")' <<<"$q")" "true"
eq "options come from the first question" "$(jq -c '.choices | map(.label)' <<<"$q")" '["Red (warm)","Blue"]'
eq "option what-happens kept" "$(jq -r '.choices[0].does' <<<"$q")" "bold look"
eq "source is picker" "$(jq -r .source <<<"$q")" "picker"
eq "tool_use_id stored" "$(jq -r .tool_use_id <<<"$q")" "toolu_abc1234567890"
eq "transcript stored" "$(jq -r .transcript_path <<<"$q")" "/tmp/ses_rec1.jsonl"
eq "single-select is answerable" "$(jq -r .picker_answerable <<<"$q")" "true"
eq "recommend is option 1" "$(jq -r .suggestion <<<"$q")" "Red (warm)"
eq "why says no recommendation" "$(jq -r '.why | contains("no recommendation")' <<<"$q")" "true"
eq "squad is waiting-on-you" "$(jq -r .status "$S")" "waiting-on-you"
eq "pings the card" "$(grep -c '^ping wtB NEEDS YOU' "$HOOK_LOG")" "1"

# --- post resolves only its own picker entry ------------------------------------
"$HOOK" post "$S" thinker wtB < "$FIX/picker-post.json" >/dev/null 2>&1; eq "post exits 0" "$?" "0"
eq "post clears the picker entry" "$(jq '.waiting_on_you | length' "$S")" "0"
eq "post leaves the squad running" "$(jq -r .status "$S")" "running"

S2="$(mkstate other '{"id":"q9","asker":"thinker","blocking":true,"question":"Real Q?","since":"2026-01-01T00:00:00Z"}')"
"$HOOK" post "$S2" thinker wtB < "$FIX/picker-post.json" >/dev/null 2>&1
eq "post with no matching entry touches nothing" "$(jq -r '.waiting_on_you[0].id' "$S2")" "q9"

# A non-picker entry with the picker's id (the pre hook skipped it through dedup) is never
# cleared by the post hook.
S3="$(mkstate dedup '{"id":"picker-34567890","asker":"lead","blocking":true,"question":"Which color for the banner? Decided on the board.","since":"2026-01-01T00:00:00Z"}')"
"$HOOK" post "$S3" thinker wtB < "$FIX/picker-post.json" >/dev/null 2>&1
eq "post never resolves a non-picker entry" "$(jq '.waiting_on_you | length' "$S3")" "1"

# --- rule 1: a blocking entry for this worktree suppresses; non-blocking doesn't --
S4="$(mkstate r1)"
"$ROOT/bin/role/ask-operator.sh" "$S4" db lead true --title "Which db for sessions?" --question "Pick one." \
  --option "Postgres" "we run it" --option "SQLite" "local only" --recommend 1 --why "we run it" >/dev/null 2>&1
eq "setup queued on this card" "$(jq -r '.waiting_on_you[0].card_wt' "$S4")" "wtB"
"$HOOK" pre "$S4" thinker wtB < "$FIX/picker-pre.json" >/dev/null 2>&1; sleep 2
eq "rule 1: blocking entry on this card suppresses the picker" "$(jq '.waiting_on_you | length' "$S4")" "1"

S5="$(mkstate r1nb)"
"$ROOT/bin/role/ask-operator.sh" "$S5" fu thinker false --title "File the follow-up?" --question "Small fix." \
  --option "file it" "later" --option "drop it" "never" --recommend 1 --why "small" >/dev/null 2>&1
"$HOOK" pre "$S5" thinker wtB < "$FIX/picker-pre.json" >/dev/null 2>&1
if wait_q "$S5" '.waiting_on_you | length == 2' 10; then
  eq "rule 1: an unrelated non-blocking entry does not suppress" "$(jq -r '.waiting_on_you[1].id' "$S5")" "picker-34567890"
else
  fail=$((fail+1)); echo "  FAIL: rule 1: non-blocking entry suppressed the picker" >&2
fi

# --- rule 2: a /ds-q picker restating a queued title adds nothing ----------------
S6="$(mkstate r2)"
"$ROOT/bin/role/ask-operator.sh" "$S6" db lead true --title "Which db for sessions?" --question "Pick one for sessions." \
  --option "Postgres" "we run it" --option "SQLite" "local only" --recommend 1 --why "we run it" >/dev/null 2>&1
FAKE_WT=wtLead "$HOOK" pre "$S6" lead wtLead < "$FIX/picker-dsq.json" >/dev/null 2>&1; sleep 2
eq "rule 2: picker restating a queued title adds nothing" "$(jq '.waiting_on_you | length' "$S6")" "1"

# Without a title the id is the match key.
S7="$(mkstate r2id '{"id":"auth","asker":"lead","blocking":true,"question":"Merge it?","since":"2026-01-01T00:00:00Z"}')"
FAKE_WT=wtLead "$HOOK" pre "$S7" lead wtLead < "$FIX/picker-dsq.json" >/dev/null 2>&1; sleep 2
eq "rule 2: title-less entries match on id" "$(jq '.waiting_on_you | length' "$S7")" "1"

# --- a second picker replaces the first -----------------------------------------
S8="$(mkstate repl)"
"$HOOK" pre "$S8" thinker wtB < "$FIX/picker-pre.json" >/dev/null 2>&1
wait_q "$S8" '.waiting_on_you | length == 1' 10
jq --arg t /tmp/x.jsonl '.tool_use_id = "toolu_XXXX00000123" | .transcript_path = $t' "$FIX/picker-pre.json" \
  | "$HOOK" pre "$S8" thinker wtB >/dev/null 2>&1
wait_q "$S8" 'any(.waiting_on_you[]?; .id == "picker-00000123")' 10 \
  || { fail=$((fail+1)); echo "  FAIL: second picker never queued" >&2; }
eq "a role holds one picker entry" "$(jq '.waiting_on_you | length' "$S8")" "1"
eq "the second picker wins" "$(jq -r '.waiting_on_you[0].id' "$S8")" "picker-00000123"

# --- a slow backend does not delay the hook's exit -------------------------------
cat > "$TMP/slowb" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  current) sleep 8; echo wtB ;;
  ping) : ;;
esac
FAKE
chmod +x "$TMP/slowb"
S9="$(mkstate slow)"
SECONDS=0
BACKEND="$TMP/slowb" "$HOOK" pre "$S9" thinker wtB < "$FIX/picker-pre.json" >/dev/null 2>&1; rc=$?
eq "slow backend: pre still exits 0" "$rc" "0"
eq "slow backend: pre exits at once (<5s of an 8s backend)" "$([ "$SECONDS" -lt 5 ] && echo fast || echo slow)" "fast"
wait_q "$S9" '.waiting_on_you | length == 1' 20 \
  || { fail=$((fail+1)); echo "  FAIL: slow backend: the detached queueing never landed" >&2; }

# --- multi-question / multiSelect pickers are not board-answerable ----------------
S10="$(mkstate multi)"
"$HOOK" pre "$S10" lead wtLead < "$FIX/picker-pre-multi.json" >/dev/null 2>&1
wait_q "$S10" '.waiting_on_you | length == 1' 10 \
  || { fail=$((fail+1)); echo "  FAIL: multi picker never queued" >&2; }
eq "multi picker is not answerable" "$(jq -r '.waiting_on_you[0].picker_answerable' "$S10")" "false"
eq "multi picker joins every question" "$(jq -r '.waiting_on_you[0].question | contains("Who writes the migration?")' "$S10")" "true"
eq "multi picker options are the first question's" "$(jq -c '.waiting_on_you[0].choices | map(.label)' "$S10")" '["Everything","Split it"]'

# --- bad input never blocks the picker -------------------------------------------
S11="$(mkstate bad)"
printf '' | "$HOOK" pre "$S11" thinker wtB >/dev/null 2>&1; eq "empty stdin exits 0" "$?" "0"
echo '{"tool_name":"Other","tool_use_id":"x"}' | "$HOOK" pre "$S11" thinker wtB >/dev/null 2>&1; eq "non-picker tool exits 0" "$?" "0"
echo '{"tool_name":"AskUserQuestion"}' | "$HOOK" post "$S11" thinker wtB >/dev/null 2>&1; eq "post without id exits 0" "$?" "0"
"$HOOK" bogus >/dev/null 2>&1; eq "bad mode exits 0" "$?" "0"
sleep 1
eq "bad input queues nothing" "$(jq '.waiting_on_you | length' "$S11")" "0"
eq "the detached run logs beside the squad states" "$([ -s "$TMP/st/picker-hook.log" ] && echo yes || echo no)" "yes"

# --- post beating the enqueue leaves no corpse (tombstone) --------------------------
S12="$(mkstate race)"
"$HOOK" post "$S12" thinker wtB < "$FIX/picker-post.json" >/dev/null 2>&1   # answer first…
eq "post drops a tombstone" "$([ -e "$TMP/st/picker-done/picker-34567890" ] && echo yes || echo no)" "yes"
"$HOOK" pre "$S12" thinker wtB < "$FIX/picker-pre.json" >/dev/null 2>&1     # …enqueue lands after
sleep 2
eq "post-before-pre queues nothing" "$(jq '.waiting_on_you | length' "$S12")" "0"
eq "the tombstone is consumed" "$([ -e "$TMP/st/picker-done/picker-34567890" ] && echo stays || echo gone)" "gone"
mkdir -p "$TMP/st/picker-done"; touch -t 202001010000 "$TMP/st/picker-done/picker-stale"
S13="$(mkstate prune)"
"$HOOK" pre "$S13" thinker wtB < "$FIX/picker-pre.json" >/dev/null 2>&1
wait_q "$S13" '.waiting_on_you | length == 1' 10 \
  || { fail=$((fail+1)); echo "  FAIL: prune setup never queued" >&2; }
eq "stale tombstones are pruned" "$([ -e "$TMP/st/picker-done/picker-stale" ] && echo stays || echo gone)" "gone"

# --- odd shapes are padded or refused, never fatal -----------------------------------
S14="$(mkstate single)"
jq '.tool_input.questions[0].options |= [.[0]]' "$FIX/picker-pre.json" \
  | "$HOOK" pre "$S14" thinker wtB >/dev/null 2>&1
wait_q "$S14" '.waiting_on_you | length == 1' 10 \
  || { fail=$((fail+1)); echo "  FAIL: single-option picker never queued" >&2; }
eq "one option is padded to two" "$(jq -r '.waiting_on_you[0].choices | length' "$S14")" "2"
eq "padding keeps the real option first" "$(jq -r '.waiting_on_you[0].choices[0].label' "$S14")" "Red (warm)"
S15="$(mkstate nodesc)"
jq '.tool_input.questions[0].options[0].description = ""' "$FIX/picker-pre.json" \
  | "$HOOK" pre "$S15" thinker wtB >/dev/null 2>&1
wait_q "$S15" '.waiting_on_you | length == 1' 10 \
  || { fail=$((fail+1)); echo "  FAIL: no-description picker never queued" >&2; }
eq "empty description falls back to the label" "$(jq -r '.waiting_on_you[0].choices[0].does' "$S15")" "Red (warm)"
"$HOOK" pre "$TMP/st/squads/missing.json" thinker wtB < "$FIX/picker-pre.json" >/dev/null 2>&1
eq "missing state exits 0" "$?" "0"
sleep 1
eq "missing state writes nothing" "$([ -e "$TMP/st/squads/missing.json" ] && echo wrote || echo clean)" "clean"

# --- permission: a safety-check prompt reaches the board (PermissionRequest hook) -----
bun -e "(await import('$ROOT/bin/loop/core/store.ts')).open('$TMP').close()"
PTR="$TMP/perm/ses_p.jsonl"; PSUB="$TMP/perm/ses_p/subagents/agent-a1b2.jsonl"; mkdir -p "$(dirname "$PSUB")"
# use <transcript> <tool_use_id> <tool> <input-json>; result <transcript> <tool_use_id>
use() { jq -cn --arg id "$2" --arg n "$3" --argjson i "$4" '{type:"assistant",message:{content:[{type:"tool_use",id:$id,name:$n,input:$i}]}}' >> "$1"; }
result() { jq -cn --arg id "$2" '{type:"user",message:{content:[{type:"tool_result",tool_use_id:$id}]}}' >> "$1"; }
CMD="$(jq -r .tool_input.command "$FIX/permission-bash.json")"
IN="$(jq -c .tool_input "$FIX/permission-bash.json")"
# hookin [jq-filter]: the fixture with this test's transcript path.
hookin() { jq -c --arg t "$PTR" ".transcript_path=\$t | ${1:-.}" "$FIX/permission-bash.json"; }
# ask <state> [jq-filter]: run the hook, wait for its entry (a prompt not yet in the transcript is retried for 2s).
ask() { hookin "${2:-}" | "$HOOK" permission "$1" builder-u1 wtB >/dev/null 2>&1
  wait_q "$1" '[.waiting_on_you[] | select(.picker_kind=="permission")] | length == 1' 15 || { fail=$((fail+1)); echo "  FAIL: permission entry never queued ($1)" >&2; }; }
entry() { jq -r ".waiting_on_you[] | select(.picker_kind==\"permission\") | $2" "$1"; }

use "$PTR" toolu_old0001 Bash "$IN"; result "$PTR" toolu_old0001
use "$PTR" toolu_new00002222 Bash "$IN"
use "$PTR" toolu_other003333 Bash '{"command":"ls"}'
P1="$(mkstate p1)"
out="$(hookin | "$HOOK" permission "$P1" builder-u1 wtB 2>/dev/null)"; rc=$?
eq "permission exits 0" "$rc" "0"
eq "permission prints nothing: no decision" "$out" ""
wait_q "$P1" '.waiting_on_you | length == 1' 15 || { fail=$((fail+1)); echo "  FAIL: permission queued nothing" >&2; }
eq "permission id comes from the unanswered tool_use" "$(entry "$P1" '[.id,.tool_use_id,.transcript_path]|join(" ")')" "picker-00002222 toolu_new00002222 $PTR"
eq "permission is a blocking picker entry" "$(entry "$P1" '[.source,.picker_kind,.blocking,.picker_answerable,.tool]|map(tostring)|join(" ")')" "picker permission true false Bash"
eq "permission keeps the command verbatim" "$(entry "$P1" .shown)" "$CMD"
eq "question carries the command in a code block" "$(entry "$P1" .question)" "$(printf '```\n%s\n```\n\nin /tmp/wt-builder' "$CMD")"
eq "permission title" "$(entry "$P1" .title)" "builder-u1 asks: run this command?"
eq "permission choices" "$(entry "$P1" '.choices|map(.label)|join(",")')" "Yes,No"
eq "no helper agent on a main-session prompt" "$(entry "$P1" 'has("agent")')" "false"
wait_events() { local end=$(( $(date +%s) + 10 )); while [ "$(date +%s)" -lt "$end" ]; do [ "$(events | wc -l)" -ge "$1" ] && return; sleep 0.2; done; }
events() { bun -e "const {Database}=await import('bun:sqlite'); for (const r of new Database('$TMP/loop.db').query(\"SELECT project, squad, payload FROM events WHERE kind='permission_asked' ORDER BY id\").all()) console.log(r.project+' '+r.squad+' '+r.payload)"; }
wait_events 1
eq "one permission_asked event" "$(events | wc -l)" "1"
eq "event payload" "$(events | cut -d' ' -f1-2) $(events | cut -d' ' -f3- | jq -r '[.role,.tool,.via,(.agent|tostring),.text]|join("|")')" "st p1 builder-u1|Bash|hook|false|$CMD"

# A helper agent's call is only in its own transcript, beside the session's.
use "$PSUB" toolu_sub00004444 Bash "$IN"
P2="$(mkstate p2)"; ask "$P2" '.agent_id="a1b2" | .agent_type="general-purpose"'
eq "helper agent: id from its transcript, which is stored" "$(entry "$P2" '[.tool_use_id,.transcript_path,.agent]|join(" ")')" "toolu_sub00004444 $PSUB general-purpose"

# No match: still queued, with a made-up id.
P3="$(mkstate p3)"; ask "$P3" '.tool_input.command="echo not-in-the-transcript"'
eq "no match: synthetic id, not answerable" "$(entry "$P3" '(.tool_use_id|test("^permission-[0-9a-f]{8}$")|tostring)+" "+(.picker_answerable|tostring)')" "true false"

# Over the cap: cut, marked, not answerable.
P4="$(mkstate p4)"; ask "$P4" '.tool_input.command=("x" * 2500)'
eq "long command is cut and marked" "$(entry "$P4" '(.shown|length|tostring)+" "+(.shown|endswith("(cut)")|tostring)+" "+(.picker_answerable|tostring)')" "2008 true false"
P5="$(mkstate p5)"; ask "$P5" '.tool_name="Write" | .tool_input={file_path:"/tmp/wt/big.txt",content:("y" * 2500)}'
eq "long Write is cut, path first, file title" "$(entry "$P5" '[(.shown|startswith("/tmp/wt/big.txt\ny")|tostring),(.shown|endswith("(cut)")|tostring),.title,(.picker_answerable|tostring)]|join("|")')" "true|true|builder-u1 asks: change this file?|false"

# An input shown as JSON: its values are redacted before serialising, where a newline becomes the two
# characters "\n" and would join the token's first letter. The made-up token is put together here.
P9="$(mkstate p9)"; ask "$P9" '.tool_name="mcp__x__post" | .tool_input={body:("line one\n" + "gh" + "p_" + ("a" * 36))}'
eq "JSON input: a token at a line start is redacted" "$(jq -r '.waiting_on_you[0] | [(.shown|contains("[redacted]")|tostring),(tostring|contains("a" * 36)|tostring)]|join(" ")' "$P9")" "true false"

# The question tool and the plan dialog queue nothing and leave a live picker entry alone.
P6="$(mkstate p6 '{"id":"picker-live","asker":"builder-u1","card_wt":"wtB","source":"picker","blocking":true,"question":"Which?","since":"2026-01-01T00:00:00Z"}')"
for t in AskUserQuestion ExitPlanMode; do hookin ".tool_name=\"$t\"" | "$HOOK" permission "$P6" builder-u1 wtB >/dev/null 2>&1; done
sleep 4
eq "AskUserQuestion/ExitPlanMode queue nothing" "$(jq -r '[.waiting_on_you[].id]|join(",")' "$P6")" "picker-live"
# A real prompt replaces the role's earlier picker, and an open blocking question doesn't hide it.
P7="$(mkstate p7 '{"id":"q1","asker":"builder-u1","card_wt":"wtB","blocking":true,"question":"Real?","title":"echo","since":"2026-01-01T00:00:00Z"},{"id":"picker-live","asker":"builder-u1","card_wt":"wtB","source":"picker","blocking":true,"question":"Which?","since":"2026-01-01T00:00:00Z"}')"
ask "$P7"
eq "queued beside a blocking question; old picker cleared" "$(jq -r '[.waiting_on_you[].id]|join(",")' "$P7")" "q1,picker-00002222"

# ask-operator.sh failing never reaches the prompt.
out="$(hookin | BACKEND=/bin/false "$HOOK" permission "$TMP/st/squads/missing.json" builder-u1 wtB 2>/dev/null)"; rc=$?
eq "failing queue: exit 0, nothing printed" "$rc $out" "0 "
P8="$(mkstate p8)"; jq 'del(.run_id)' "$P8" > "$P8.new" && mv "$P8.new" "$P8"
out="$(hookin | "$HOOK" permission "$P8" builder-u1 wtB 2>/dev/null)"; rc=$?
eq "refused ask-operator: exit 0, nothing printed" "$rc $out" "0 "
end=$(( $(date +%s) + 10 )); while [ "$(date +%s)" -lt "$end" ] && ! grep -q 'NOT queued' "$TMP/st/picker-hook.log"; do sleep 0.2; done
eq "refused ask-operator is logged" "$(grep -c 'permission: picker-00002222 NOT queued' "$TMP/st/picker-hook.log")" "1"
eq "permission without args exits 0" "$("$HOOK" permission </dev/null 2>/dev/null; echo $?)" "0"

echo "picker-hook: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
