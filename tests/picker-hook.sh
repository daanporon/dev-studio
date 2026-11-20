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

echo "picker-hook: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
