#!/usr/bin/env bash
# ask-operator.sh — the ONE way a role raises a question to the operator. It must refuse a
# state file it can't find (the silent-skip failure: a wrong path wrote nowhere), put the
# question on the board, ping, and read it back as a receipt. A failed ping is loud.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/stub" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  current) echo wt_me ;;
  ping)    [ -z "${STUB_PING_FAIL:-}" ] || exit 1 ;;
esac
STUB
chmod +x "$TMP/stub"
export STUB_LOG="$TMP/log" BACKEND="$TMP/stub"
A="$ROOT/bin/role/ask-operator.sh"
pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want $3, got $2)" >&2; fi; }

"$A" "$TMP/nope.json" q1 thinker true "Q?" "yes" "why" >/dev/null 2>&1; eq "refuses a missing state file" "$?" "1"
eq "never creates a state file at a wrong path" "$([ -e "$TMP/nope.json" ] && echo yes || echo no)" "no"
printf '{"status":"running"}' > "$TMP/norun.json"
"$A" "$TMP/norun.json" q1 thinker true "Q?" "yes" "why" >/dev/null 2>&1; eq "refuses a state file with no run" "$?" "1"

printf '{"run_id":"run_1","status":"running","waiting_on_you":[]}' > "$TMP/bad.json"
"$A" "$TMP/bad.json" q1 thinker yes "Q?" "yes" "why" >/dev/null 2>&1; eq "rejects a blocking value other than true/false" "$?" "2"
eq "a rejected call leaves the squad status alone" "$(jq -r .status "$TMP/bad.json")" "running"

# The state root: <tmp>/state/<label>/squads/<topic>.json with plans beside it.
SR="$TMP/state"; SQD="$SR/proj/squads"; mkdir -p "$SQD" "$SR/proj/archive"
PLAIN='## In plain words

- **What you get:** a thing.
- **Steps:** two changes.
- **Risky or can'"'"'t be undone:** nothing.
- **Cost and time:** a few runs.
- **You are approving:** the thing.
'
printf '# X plan\n\n%s\n## Rest\n' "$PLAIN" > "$SQD/topic-x-plan.md"
S="$SQD/topic.json"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[]}' > "$S"; : > "$STUB_LOG"
out="$("$A" "$S" plan-x thinker true "Approve plan X?" "approve" "tests green" 2>&1)"; rc=$?
eq "happy path exits 0"                      "$rc" "0"
eq "sets the squad waiting-on-you"           "$(jq -r .status "$S")" "waiting-on-you"
eq "queues the question"                     "$(jq -r '.waiting_on_you[0].question' "$S")" "Approve plan X?"
eq "records which card it pinged"           "$(jq -r '.waiting_on_you[0].card_wt' "$S")" "wt_me"
eq "pings the caller's own worktree"         "$(grep -c '^ping wt_me NEEDS YOU' "$STUB_LOG")" "1"
eq "prints the board receipt"                "$(printf '%s' "$out" | grep -c 'ON BOARD: plan-x')" "1"
eq "tells the agent to offer /ds-q"          "$(printf '%s' "$out" | grep -c '/ds-q')" "1"
eq "a plan ask links its plan by the id rule" "$(jq -r '.waiting_on_you[0].doc_path' "$S")" "proj/squads/topic-x-plan.md"
eq "a plan ask prints the five lines"        "$(printf '%s' "$out" | grep -c -E '^  (What you get|Steps|Risky or can.t be undone|Cost and time|You are approving): ')" "5"

# --doc: stored relative to the real state root, also through a symlinked root.
ln -s "$SR" "$TMP/link"
"$A" "$S" plan-x thinker true --title "t" --question q --option alpha b --option gamma d --recommend 1 --why w --doc "$TMP/link/proj/squads/topic-x-plan.md" >/dev/null 2>&1
eq "--doc through a symlinked root is stored the same" "$(jq -r '.waiting_on_you[0].doc_path' "$S")" "proj/squads/topic-x-plan.md"
"$A" "$TMP/link/proj/squads/topic.json" plan-x thinker true --title "t" --question q --option alpha b --option gamma d --recommend 1 --why w >/dev/null 2>&1
eq "a symlinked state path resolves the same" "$(jq -r '.waiting_on_you[0].doc_path' "$S")" "proj/squads/topic-x-plan.md"
printf 'x' > "$TMP/outside.md"; printf 'x' > "$SR/proj/archive/old.md"; printf 'x' > "$SQD/notes.txt"
SB="$SQD/b.json"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[]}' > "$SB"
bad_doc() { "$A" "$SB" q9 thinker true --title t --question q --option alpha b --option gamma d --recommend 1 --why w --doc "$1" >/dev/null 2>&1; echo "$?:$(jq -r '.waiting_on_you | length' "$SB"):$(jq -r .status "$SB")"; }
eq "a doc outside squads/ is refused, nothing written" "$(bad_doc "$TMP/outside.md")" "1:0:running"
eq "a missing doc is refused"                "$(bad_doc "$SQD/none.md")" "1:0:running"
eq "a non-.md doc is refused"                "$(bad_doc "$SQD/notes.txt")" "1:0:running"
eq "a doc in archive/ is accepted"           "$(bad_doc "$SR/proj/archive/old.md")" "0:1:waiting-on-you"
eq "..and stored as archive path"            "$(jq -r '.waiting_on_you[0].doc_path' "$SB")" "proj/archive/old.md"

# A plan ask must find its plan and the section; nothing is written otherwise.
SC="$SQD/c.json"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[]}' > "$SC"
out="$("$A" "$SC" plan-nope thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "plan with no plan file is refused"       "$rc" "1"
eq "..naming the expected path"              "$(printf '%s' "$out" | grep -c 'c-nope-plan.md')" "1"
eq "..and writes nothing"                    "$(jq -c '[.status, (.waiting_on_you|length)]' "$SC")" '["running",0]'
printf '# P\n\n**PROBLEM:** p\n' > "$SQD/c-bare-plan.md"
out="$("$A" "$SC" plan-bare thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "plan without the section is refused"     "$rc" "1"
eq "..naming the heading"                    "$(printf '%s' "$out" | grep -c 'In plain words')" "1"
eq "..state unchanged"                       "$(jq -c '[.status, (.waiting_on_you|length)]' "$SC")" '["running",0]'
printf '# P\n\n## In plain words\n\n- **What you get:** a\n- **Steps:** b\n' > "$SQD/c-part-plan.md"
out="$("$A" "$SC" plan-part thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "plan missing labels is refused"          "$rc" "1"
eq "..naming a missing label"                "$(printf '%s' "$out" | grep -c 'Cost and time')" "1"
# A non-plan question with --doc and no section passes.
"$A" "$SC" fu-1 thinker false --title t --question q --option alpha b --option gamma d --recommend 1 --why w --doc "$SQD/c-bare-plan.md" >/dev/null 2>&1
eq "a non-plan question with --doc and no section passes" "$(jq -r '.waiting_on_you[0].doc_path' "$SC")" "proj/squads/c-bare-plan.md"

# R5/R6: a plan already approved needs a complete revision note, newer than the saved approved copy's.
export DS_STATE_ROOT="$SR"
SR5="$SQD/r.json"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[],"approved_plans":[]}' > "$SR5"
rev() { # <rev number> <body lines...>: the plan with a revisions section
  printf '# R plan\n\n%s\n## Revisions\n\n%s\n## Rest\n' "$PLAIN" "$1" > "$SQD/r-x-plan.md"
}
FULL=$'### Rev 2 — 2026-11-17 — fix\n- **What changed:** a.\n- **Why:** b.\n- **Steps touched:** c.\n- **Stays as approved:** d.\n'
printf '# R plan\n\n%s\n## Rest\n' "$PLAIN" > "$SQD/r-x-plan.md"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "a first approval is unchanged"           "$rc" "0"
: > /dev/null; printf '{"run_id":"run_1","status":"running","waiting_on_you":[],"approved_plans":[]}' > "$SR5"
"$ROOT/bin/role/squad-state.sh" "$SR5" approve-plan "$SQD/r-x-plan.md" >/dev/null 2>&1
eq "approve-plan wrote the copy"             "$(cmp -s "$SQD/r-x-plan.md" "$SQD/r-x-plan.approved.md" && echo same)" "same"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "re-approval without ## Revisions refused" "$rc" "1"
eq "..says what to add"                      "$(printf '%s' "$out" | grep -c 'Rev 2')" "1"
eq "..state unchanged"                       "$(jq -c '[.status, (.waiting_on_you|length)]' "$SR5")" '["running",0]'
rev $'### Rev 2 — 2026-11-17 — fix\n- **What changed:** a.\n- **Why:** b.\n- **Steps touched:** c.\n'
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "an entry missing a line is refused"      "$rc" "1"
eq "..naming the line"                       "$(printf '%s' "$out" | grep -c 'Stays as approved')" "1"
eq "..showing the exact line form"           "$(printf '%s' "$out" | grep -cF -- '- **Stays as approved:**')" "1"
eq "..and the form of a line to copy"        "$(printf '%s' "$out" | grep -cF -- '- **What changed:** …')" "1"
rev "${FULL//Rev 2/Rev 1}"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "an entry not newer than the copy is refused" "$rc" "1"
rev "$FULL"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "a newer complete entry passes"           "$rc" "0"
eq "..and prints the four lines"             "$(printf '%s' "$out" | grep -c -E '^    (What changed|Why|Steps touched|Stays as approved): ')" "4"
rev "$(printf '%s' "$FULL" | sed 's/^- \*\*/**/')"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "an unbulleted complete entry passes"     "$rc" "0"
rev "${FULL/- **What changed:** a./- **What changed:** a.$'\n'"  **Note:** more"}"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "a bold continuation line passes"         "$rc" "0"
eq "..and prints the full line"              "$(printf '%s' "$out" | grep -cF -- 'a. **Note:** more')" "1"
rev "$FULL"
cp "$SQD/r-x-plan.md" "$SQD/r-x-plan.approved.md"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "a copy with the same Rev refuses it"     "$rc" "1"
rm -f "$SQD/r-x-plan.approved.md"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "approved with no copy: Rev 2 passes"     "$rc" "0"
# hold-cancels-queue-undo-approval U2: revoke-plan takes the approval back, so the plan reads as never
# approved again — a fresh plan-* ask needs no revision note.
printf '# R plan\n\n%s\n## Rest\n' "$PLAIN" > "$SQD/r-x-plan.md"
"$ROOT/bin/role/squad-state.sh" "$SR5" approve-plan "$SQD/r-x-plan.md" >/dev/null 2>&1
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "approved again: no revision note refused" "$rc" "1"
"$ROOT/bin/role/squad-state.sh" "$SR5" revoke-plan "$SQD/r-x-plan.md" --why "approved by mistake" >/dev/null 2>&1
kept=("$SQD"/r-x-plan.revoked-*.md)
eq "revoke-plan moved the copy aside"        "$(test -f "$SQD/r-x-plan.approved.md" || printf '%s\n' "${kept[@]}" | grep -c 'revoked-[0-9]\{8\}-[0-9]\{6\}\.md$')" "1"
out="$("$A" "$SR5" plan-x thinker true "Approve?" "approve" "why" 2>&1)"; rc=$?
eq "after revoke-plan a fresh plan ask passes" "$rc" "0"
unset DS_STATE_ROOT

# A NON-blocking question (e.g. "file this follow-up?") queues + pings but must not turn the
# whole squad red — the squad keeps working while it waits on the board.
S2="$TMP/sq2.json"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[]}' > "$S2"
"$A" "$S2" fu-1 builder-u3 false "[follow-up] file X?" "yes" "small" >/dev/null 2>&1
eq "non-blocking leaves the squad running"   "$(jq -r .status "$S2")" "running"
eq "non-blocking is still queued"            "$(jq -r '.waiting_on_you[0].blocking' "$S2")" "false"

"$A" "$S" plan-x thinker true "Approve plan X v2?" "approve" "v2 fixes it" >/dev/null 2>&1
eq "re-asking an id replaces it (no duplicate)" "$(jq '.waiting_on_you | length' "$S")" "1"
eq "re-ask keeps the newest text"            "$(jq -r '.waiting_on_you[0].question' "$S")" "Approve plan X v2?"

out="$(STUB_PING_FAIL=1 "$A" "$S" q2 thinker false "Test it?" "skip" "docs only" 2>&1)"; rc=$?
eq "a failed ping exits non-zero"            "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
eq "a failed ping still leaves it on the board" "$(jq '[.waiting_on_you[] | select(.id=="q2")] | length' "$S")" "1"
eq "a failed ping says you were NOT pinged"  "$(printf '%s' "$out" | grep -c 'NOT pinged')" "1"

# Every question carries a suggested answer and a reason (KD4): without them, refuse and write nothing.
S3="$TMP/sq3.json"; EMPTY='{"run_id":"run_1","status":"running","waiting_on_you":[]}'; printf '%s' "$EMPTY" > "$S3"
"$A" "$S3" u3 lead true "Use v2 API for u3?" >/dev/null 2>&1; eq "five args (no suggestion) -> exit 2" "$?" "2"
eq "five args writes nothing"                "$(jq -c . "$S3")" "$EMPTY"
"$A" "$S3" u3 lead true "Use v2 API for u3?" "" "why" >/dev/null 2>&1; eq "empty suggestion -> exit 2" "$?" "2"
"$A" "$S3" u3 lead true "Use v2 API for u3?" "yes" "" >/dev/null 2>&1; eq "empty why -> exit 2" "$?" "2"
eq "empty suggestion/why writes nothing"     "$(jq -c . "$S3")" "$EMPTY"
out="$("$A" "$S3" u3 lead true "Use v2 API for u3?" "yes — v1 is deprecated in March" "u3 touches only new endpoints" 2>&1)"; rc=$?
eq "seven args exits 0"                      "$rc" "0"
eq "stores the suggestion"                   "$(jq -r '.waiting_on_you[0].suggestion' "$S3")" "yes — v1 is deprecated in March"
eq "stores the why"                          "$(jq -r '.waiting_on_you[0].why' "$S3")" "u3 touches only new endpoints"
eq "receipt printed"                         "$(printf '%s' "$out" | grep -c 'ON BOARD: u3')" "1"

# An optional 8th arg lists the choices ('A|B|C'); the board shows them as buttons.
S4="$TMP/sq4.json"; printf '%s' "$EMPTY" > "$S4"
"$A" "$S4" db lead true "Which db?" "Postgres" "we run it" "Postgres|SQLite" >/dev/null 2>&1; eq "eight args exits 0" "$?" "0"
eq "stores the options"                      "$(jq -c '.waiting_on_you[0].options' "$S4")" '["Postgres","SQLite"]'
"$A" "$S4" db2 lead true "Q?" "a" "b" "x|y" "extra" >/dev/null 2>&1; eq "nine args -> exit 2" "$?" "2"

# Raising a new id while others are open lists them, so a Lead that re-raises the same decision
# under a new id (blocking AND non-blocking copies on the board) is told to resolve the old one.
S5="$TMP/sq5.json"; printf '%s' "$EMPTY" > "$S5"
out="$("$A" "$S5" first lead false "Redeploy staging?" "yes" "gate" 2>&1)"
eq "no other open questions -> no list"      "$(printf '%s' "$out" | grep -c 'ALSO OPEN')" "0"
out="$("$A" "$S5" second lead true "Merge on local run?" "yes" "same gate" 2>&1)"
eq "lists the other open question"           "$(printf '%s' "$out" | grep -c 'first (non-blocking): Redeploy staging?')" "1"
eq "names the resolve command"               "$(printf '%s' "$out" | grep -c 'resolve-question <id>')" "1"
eq "does not list the new one"               "$(printf '%s' "$out" | grep -c '  second ')" "0"

# The structured form: a short title (the board's one-line row), the question, 2+ options each with
# what happens, and which option is recommended + why. Old positional calls keep working (above).
S6="$TMP/sq6.json"; printf '%s' "$EMPTY" > "$S6"; : > "$STUB_LOG"
out="$("$A" "$S6" wal thinker true --title "Let readers see multisig wallets?" --question "Issuer gets 404 on the Wallets tab." \
  --option "Fix now as U32" "readers already see member wallets" --option "Drop + Low ticket" "close the squad on the seat half" \
  --recommend 1 --why "a 404 for a wallet that exists is wrong" 2>&1)"; rc=$?
eq "structured form exits 0"                 "$rc" "0"
eq "stores the title"                        "$(jq -r '.waiting_on_you[0].title' "$S6")" "Let readers see multisig wallets?"
eq "stores the question"                     "$(jq -r '.waiting_on_you[0].question' "$S6")" "Issuer gets 404 on the Wallets tab."
eq "stores choices with what happens"        "$(jq -c '.waiting_on_you[0].choices[1]' "$S6")" '{"label":"Drop + Low ticket","does":"close the squad on the seat half"}'
eq "options stay the labels (old readers)"   "$(jq -c '.waiting_on_you[0].options' "$S6")" '["Fix now as U32","Drop + Low ticket"]'
eq "suggestion is the recommended label"     "$(jq -r '.waiting_on_you[0].suggestion' "$S6")" "Fix now as U32"
eq "stores the why"                          "$(jq -r '.waiting_on_you[0].why' "$S6")" "a 404 for a wallet that exists is wrong"
eq "pings with the title"                    "$(grep -c '^ping wt_me NEEDS YOU: Let readers see multisig wallets?$' "$STUB_LOG")" "1"
eq "receipt names the title"                 "$(printf '%s' "$out" | grep -c 'ON BOARD: wal (blocking) — Let readers see multisig wallets?')" "1"
eq "a structured call gets no old-form nudge" "$(printf '%s' "$out" | grep -c 'old form')" "0"

# Unit links are routing metadata, not a PR gate: an upstream question can block a Builder
# while its own PR is conflicting. A typo must never silently leave that Builder unblocked.
SU="$TMP/unit.json"; printf '{"run_id":"run_1","status":"running","units":[{"slug":"u29"}],"waiting_on_you":[]}' > "$SU"
"$A" "$SU" routing lead true --unit u29 --title "Who owns the upstream fix?" --question "Route the source fix." \
  --option Assign "assign an owner" --option Defer "defer the work" --recommend 1 --why "outside this unit" >/dev/null 2>&1
eq "a Lead question can name its blocked unit" "$?" "0"
eq "the board entry keeps the unit link" "$(jq -r '.waiting_on_you[0].unit' "$SU")" "u29"
before="$(jq -c . "$SU")"
"$A" "$SU" typo lead true --unit missing --title T --question Q --option Alpha a --option Beta b --recommend 1 --why w >/dev/null 2>&1
eq "an unknown unit is refused" "$?" "2"
eq "an unknown unit changes nothing" "$(jq -c . "$SU")" "$before"
out="$("$A" "$SU" typo lead true --unit U2 --title T --question Q --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"
eq "an unknown unit names itself and lists the slugs" "$(printf '%s' "$out" | grep -c "^ask-operator: unknown unit 'U2' in $SU — this squad's units: u29$")" "1"
eq "... with no usage line" "$(printf '%s' "$out" | grep -c 'usage:')" "0"
SU2="$TMP/unit2.json"; printf '{"run_id":"run_1","status":"running","units":[{"slug":"u1-a","plan_unit":"U1","status":"dispatched","pr":"31"},{"slug":"u2-b","plan_unit":"U2","status":"planned"}],"waiting_on_you":[]}' > "$SU2"
out="$("$A" "$SU2" typo lead true --unit nosuch --title "About #31" --question Q --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?
eq "an unknown unit plus a PR mention reports the unit" "$rc" "2"
eq "... listing both units with their plan ids" "$(printf '%s' "$out" | grep -c "this squad's units: u1-a (U1), u2-b (U2)$")" "1"
eq "... and no PR refusal" "$(printf '%s' "$out" | grep -c 'loop asks')" "0"
eq "... nothing written" "$(jq '.waiting_on_you | length' "$SU2")" "0"
SU0="$TMP/unit0.json"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[]}' > "$SU0"
out="$("$A" "$SU0" typo lead true --unit u1 --title T --question Q --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?
eq "a squad with no units says so" "$rc" "2"
eq "... and what to do" "$(printf '%s' "$out" | grep -c 'has no units yet — register the plan first, or leave out --unit$')" "1"
out="$("$A" "$S6" old lead false "Q?" "a" "b" 2>&1)"
eq "an old positional call is nudged"        "$(printf '%s' "$out" | grep -c 'old form')" "1"

S7="$TMP/sq7.json"; printf '%s' "$EMPTY" > "$S7"
ok() { "$A" "$S7" x lead true "$@" >/dev/null 2>&1; echo $?; }
O2=(--option Alpha "a" --option Beta "b")
eq "no title -> 2"          "$(ok --question Q "${O2[@]}" --recommend 1 --why w)" "2"
eq "long title -> 2"        "$(ok --title "$(printf 'x%.0s' {1..81})" --question Q "${O2[@]}" --recommend 1 --why w)" "2"
eq "no question -> 2"       "$(ok --title T "${O2[@]}" --recommend 1 --why w)" "2"
eq "one option -> 2"        "$(ok --title T --question Q --option Alpha a --recommend 1 --why w)" "2"
eq "option without what -> 2" "$(ok --title T --question Q --option Alpha "" --option Beta b --recommend 1 --why w)" "2"
eq "recommend out of range -> 2" "$(ok --title T --question Q "${O2[@]}" --recommend 3 --why w)" "2"
eq "recommend by label works" "$(ok --title T --question Q "${O2[@]}" --recommend Beta --why w)" "0"
eq "recommend unknown label -> 2" "$(ok --title T --question Q "${O2[@]}" --recommend Gamma --why w)" "2"
eq "no why -> 2"            "$(ok --title T --question Q "${O2[@]}" --recommend 1)" "2"
eq "unknown flag -> 2"      "$(ok --title T --question Q "${O2[@]}" --recommend 1 --why w --nope)" "2"
eq "label with | -> 2"      "$(ok --title T --question Q --option "Alpha|Beta" a --option Gamma c --recommend 1 --why w)" "2"
eq "rejected calls wrote only the valid one" "$(jq '.waiting_on_you | length' "$S7")" "1"

# The picker's --picker flag (bin/hooks/picker-hook.sh): stores source + tool_use_id +
# transcript_path + picker_answerable on the entry. Only the structured form takes it.
S8="$TMP/sq8.json"; printf '%s' "$EMPTY" > "$S8"
out="$("$A" "$S8" picker-34567890 thinker true --title "Style: Which color?" --question "Which color for the banner?" \
  --option "Red (warm)" "bold look" --option "Blue" "calm look" \
  --recommend 1 --why "raised from thinker's terminal picker" \
  --picker toolu_abc1234567890 /tmp/ses.jsonl true 2>&1)"; rc=$?
eq "--picker exits 0"                       "$rc" "0"
eq "--picker stores source"                 "$(jq -r '.waiting_on_you[0].source' "$S8")" "picker"
eq "--picker stores tool_use_id"            "$(jq -r '.waiting_on_you[0].tool_use_id' "$S8")" "toolu_abc1234567890"
eq "--picker stores transcript_path"       "$(jq -r '.waiting_on_you[0].transcript_path' "$S8")" "/tmp/ses.jsonl"
eq "--picker stores picker_answerable"     "$(jq -r '.waiting_on_you[0].picker_answerable' "$S8")" "true"
eq "--picker keeps the receipt"             "$(printf '%s' "$out" | grep -c 'ON BOARD: picker-34567890')" "1"
"$A" "$S8" m2 thinker true --title "T?" --question "Q" --option Alpha a --option Beta b --recommend 1 --why w \
  --picker toolu_x /tmp/x.jsonl false >/dev/null 2>&1
eq "--picker false stays boolean false"     "$(jq -r '.waiting_on_you[1].picker_answerable' "$S8")" "false"
S9="$TMP/sq9.json"; printf '%s' "$EMPTY" > "$S9"
"$A" "$S9" x lead true --title T --question Q --option Alpha a --option Beta b --recommend 1 --why w \
  --picker toolu_x /tmp/x.jsonl maybe >/dev/null 2>&1; eq "--picker bad answerable -> 2" "$?" "2"
"$A" "$S9" x lead true --title T --question Q --option Alpha a --option Beta b --recommend 1 --why w \
  --picker toolu_x >/dev/null 2>&1; eq "--picker missing values -> 2" "$?" "2"
eq "--picker rejections write nothing"      "$(jq '.waiting_on_you | length' "$S9")" "0"
eq "no --picker means no source field"      "$(jq -r '.waiting_on_you[0] | has("source")' "$S6")" "false"

# U70: --pr <n> — one PR per question, and the PR must be ready for a human (only human gates left).
R="$TMP/root"; mkdir -p "$R/proj/squads"; SP="$R/proj/squads/sq.json"
printf '{"run_id":"run_1","status":"running","waiting_on_you":[]}' > "$SP"
(cd "$ROOT" && DS_STATE_ROOT="$R" bun -e '
  import { open } from "./bin/loop/core/store.ts";
  const s = open(process.env.DS_STATE_ROOT!);
  const pr = (n: number, set: object) => s.upsert("observed_prs", { project: "proj", ref: `o/r#${n}` }, { pr: n, repo: "o/r", state: "OPEN", observed_at: 1, ...set });
  pr(1, { verdict: "blocked", reasons: JSON.stringify("conflicting,checks-failing") });
  pr(2, { verdict: "waiting", reasons: JSON.stringify("required:signoff,checks-running") });
  pr(3, { verdict: "ready", reasons: JSON.stringify("") });
  pr(4, { verdict: "waiting", reasons: JSON.stringify("required:deploy-preview") });
  s.upsert("squads", { project: "proj", topic: "sq" }, { repo: "path:/x", observed_at: 1, updated_at: 1 });
  s.upsert("config", { project: "proj", file: "github", key: "repo:path:/x" }, { value: "o/r", observed_at: 1 });
  s.close();') || echo "  FAIL: seeding loop.db" >&2
PA() { "$A" "$SP" "$@" --title T --question Q --option Alpha a --option Beta b --recommend 1 --why w; }
out="$(PA pq1 lead true --pr 1 2>&1)"; rc=$?
eq "--pr from a Lead is refused (the loop asks)" "$rc" "1"
eq "... with the loop message"                "$(printf '%s' "$out" | grep -c 'the loop asks PR questions; #')" "1"
out="$(PA pq1 thinker true --pr 1 2>&1)"; rc=$?
eq "--pr on a conflicting PR is refused"      "$rc" "1"
eq "... naming PR and reasons"                "$(printf '%s' "$out" | grep -c 'PR #1 is not ready (conflicting,checks-failing): send its Builder to fix it first')" "1"
eq "... and writes nothing"                   "$(jq '.waiting_on_you | length' "$SP")" "0"
eq "... nor changes the status"               "$(jq -r .status "$SP")" "running"
PA pq2 thinker true --pr 2 >/dev/null 2>&1;   eq "--pr on a PR blocked only by a human gate is enqueued" "$?" "0"
eq "... with the PR on the entry"             "$(jq -r '.waiting_on_you[0].pr' "$SP")" "2"
out="$(PA pq3b thinker true --pr 4 2>&1)"; eq "a missing non-human check (deploy-preview) is refused" "$?" "1"
PA pq3 thinker false --pr 3 >/dev/null 2>&1;  eq "--pr on a ready PR is enqueued" "$?" "0"
out="$(PA pq4 lead true --pr 2 --pr 3 2>&1)"; rc=$?
eq "two --pr flags are refused"               "$rc" "2"
eq "... saying one question per PR"           "$(printf '%s' "$out" | grep -c 'one question per PR')" "1"
eq "... and write nothing"                    "$(jq '[.waiting_on_you[] | select(.id=="pq4")] | length' "$SP")" "0"
# no observed row: one gh read decides
cat > "$TMP/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG.gh"
cat <<'JSON'
{"data":{"repository":{"pullRequest":{"state":"OPEN","isDraft":false,"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","reviewDecision":null,"reviewThreads":{"nodes":[]},"baseRef":{"rules":{"nodes":[]},"refUpdateRule":null},"commits":{"nodes":[]}}}}}
JSON
GH
chmod +x "$TMP/gh"
out="$(GH="$TMP/gh" PA pq5 thinker true --pr 9 2>&1)"; rc=$?
eq "an unseen PR is read once with gh and refused" "$rc" "1"
eq "... gh asked once"                        "$(wc -l < "$STUB_LOG.gh" | tr -d ' ')" "1"
eq "... with its reasons"                     "$(printf '%s' "$out" | grep -c 'PR #9 is not ready (conflicting)')" "1"

# U86: no --pr — a PR reference in the title or question names the PR anyway, and one
# PR keeps one open question (a second question about it closes the first).
(cd "$ROOT" && DS_STATE_ROOT="$R" bun -e '
  import { open } from "./bin/loop/core/store.ts";
  const s = open(process.env.DS_STATE_ROOT!);
  const pr = (n: number, set: object) => s.upsert("observed_prs", { project: "proj", ref: `o/r#${n}` }, { pr: n, repo: "o/r", state: "OPEN", observed_at: 1, ...set });
  pr(21223, { verdict: "waiting", reasons: JSON.stringify("draft") });
  pr(21196, { verdict: "waiting", reasons: JSON.stringify("required:signoff") });
  pr(21197, { verdict: "waiting", reasons: JSON.stringify("required:signoff") });
  s.close();') || echo "  FAIL: seeding loop.db (U86)" >&2
Q86() { "$A" "$SP" "${@/lead/thinker}" --option Alpha a --option Beta b --recommend 1 --why w; }
out="$(Q86 draft-q lead true --title "Approve #21223" --question "Please approve #21223." 2>&1)"; rc=$?
eq "a title naming a draft PR is refused with no --pr" "$rc" "1"
eq "... naming the PR and reason"          "$(printf '%s' "$out" | grep -c 'PR #21223 is not ready (draft): send its Builder to fix it first')" "1"
eq "... and writes nothing"                "$(jq '[.waiting_on_you[] | select(.id=="draft-q")] | length' "$SP")" "0"
out="$("$A" "$SP" lead-q lead true --title "Approve #21223" --question "Please approve #21223." --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?
eq "a Lead question merely mentioning a non-unit PR enqueues" "$rc" "0"
eq "... with no pr stored (not a loop PR question)" "$(jq -r '.waiting_on_you[] | select(.id=="lead-q") | has("pr")' "$SP")" "false"
(cd "$ROOT" && DS_STATE_ROOT="$R" bun -e '
  import { open } from "./bin/loop/core/store.ts";
  const s = open(process.env.DS_STATE_ROOT!);
  s.upsert("observed_prs", { project: "proj", ref: "o/r#21223" }, { reasons: JSON.stringify("required:signoff") });
  s.close();') || echo "  FAIL: updating loop.db (U86)" >&2
out="$(Q86 ship-q lead true --title "Approve #21223" --question "Please approve #21223." 2>&1)"; rc=$?
eq "the same PR enqueues once only human gates remain" "$rc" "0"
eq "... stored with pr"                    "$(jq -r '.waiting_on_you[] | select(.id=="ship-q") | .pr' "$SP")" "21223"
out="$(Q86 two-q lead true --title "Pick one" --question "Approve #20350 and #20473?" 2>&1)"; rc=$?
eq "two distinct PRs in one question are refused" "$rc" "2"
eq "... saying one question per PR"        "$(printf '%s' "$out" | grep -c 'one question per PR')" "1"
eq "... naming both PRs"                  "$(printf '%s' "$out" | grep -c '#20350 #20473')" "1"
eq "... and write nothing"                 "$(jq '[.waiting_on_you[] | select(.id=="two-q")] | length' "$SP")" "0"
out="$(Q86 split-q lead true --title "About #20350" --question "And what of #20473?" 2>&1)"; rc=$?
eq "one PR in the title and one in the question are refused too" "$rc" "2"
SPU="$TMP/squ.json"; printf '{"run_id":"run_1","status":"running","waiting_on_you":[],"units":[{"slug":"u1","status":"dispatched","pr":"21223"}]}' > "$SPU"
out="$("$A" "$SPU" unit-q lead true --title "Approve #21223" --question "Please approve #21223." --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?
eq "a Lead naming its unit PR is refused (the loop asks)" "$rc" "1"
eq "... with the loop message"             "$(printf '%s' "$out" | grep -c 'the loop asks PR questions; #')" "1"
out="$("$A" "$SPU" unit2-q builder-u1 true --title "T" --question "Approve #21223 and #13?" --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?
eq "a Builder naming its unit PR plus another is refused" "$rc" "1"
eq "... with the loop message"             "$(printf '%s' "$out" | grep -c 'the loop asks PR questions; #')" "1"
# the refusal names its poster: (a) an open loop question, (b) only human gates, (c) not ready, (d) unread.
(cd "$ROOT" && DS_STATE_ROOT="$R" bun -e '
  import { open } from "./bin/loop/core/store.ts";
  const s = open(process.env.DS_STATE_ROOT!);
  const pr = (n: number, set: object) => s.upsert("observed_prs", { project: "proj", ref: `o/r#${n}` }, { pr: n, repo: "o/r", state: "OPEN", observed_at: 1, ...set });
  pr(51, { verdict: "waiting", reasons: JSON.stringify("required:signoff") });
  pr(52, { verdict: "blocked", reasons: JSON.stringify("conflicting,checks-failing") });
  pr(53, { verdict: "waiting", reasons: JSON.stringify("required:signoff") });
  s.close();') || echo "  FAIL: seeding loop.db (refusals)" >&2
SPR="$R/proj/squads/sq-refusals.json"
printf '%s' '{"run_id":"run_1","status":"running","units":[{"slug":"u1-a","status":"dispatched","pr":"51"},{"slug":"u2-b","status":"dispatched","pr":"52"},{"slug":"u3-c","status":"dispatched","pr":"53"},{"slug":"u4-d","status":"dispatched","pr":"54"}],"waiting_on_you":[{"id":"loop-pr-53","asker":"loop","pr":"53","blocking":false,"question":"q"}]}' > "$SPR"
rf() { out="$("$A" "$SPR" "$1" "$2" true --title "About #$3" --question Q --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?; }
cnt() { printf '%s' "$out" | grep -c -- "$1"; }
nw() { jq '.waiting_on_you | length' "$SPR"; }
rf r1 lead 53
eq "(a) open loop question: exit 1" "$rc" "1"
eq "(a) ... names the question id and that nothing is to post" "$(cnt "#53 already has its question on the board as loop-pr-53 — nothing to post")" "1"
rf r2 lead 51
eq "(b) human gates only: exit 1" "$rc" "1"
eq "(b) ... the loop posts it once the Builder finished" "$(cnt "#51 has only human gates left, so the loop posts it once its Builder has finished — nothing to post")" "1"
rf r3 lead 52
eq "(c) not ready, Lead: exit 1" "$rc" "1"
eq "(c) ... gives the reasons" "$(cnt "#52 is not ready (conflicting,checks-failing), so nobody asks yet")" "1"
eq "(c) ... sends the Lead to the Builder" "$(cnt 'send-role.sh sq-refusals builder-u2-b ')" "1"
eq "(c) ... and to --unit for a decision" "$(cnt 'ask about the unit with --unit u2-b and no PR number')" "1"
rf r4 builder-u2-b 52
eq "(c) not ready, Builder: exit 1" "$rc" "1"
eq "(c) ... fix it in its unit, Lead via send-role" "$(cnt 'fix it in your unit, and if the cause is outside your unit tell your Lead: ~/.dev-studio/bin/role/send-role.sh sq-refusals lead')" "1"
rf r5 lead 54
eq "(d) unread PR state, Lead: exit 1" "$rc" "1"
eq "(d) ... says the loop has not read it, with the Lead step" "$(cnt '#54 is in a state the loop has not read yet')" "1"
out="$("$A" "$SPR" r6 lead true --pr 77 --title T --question Q --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?
eq "an explicit --pr that is no unit's: exit 1 with the general rule" "$rc" "1"
eq "... starts with the loop rule" "$(cnt '^ask-operator: the loop asks PR questions; #77 is not one of this squad')" "1"
eq "every refusal writes nothing" "$(nw)" "1"
eq "... nor changes the status" "$(jq -r .status "$SPR")" "running"
out="$("$A" "$SP" two-mention lead true --title "T" --question "Close #12 and #13?" --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"; rc=$?
eq "a Lead mentioning two non-unit numbers enqueues" "$rc" "0"
Q86 issu-q lead true --title "T" --question "PRD-18424 for U6?" >/dev/null 2>&1
eq "an issue key and a unit enqueue without a PR check" "$?" "0"
eq "... with no pr on the entry"           "$(jq -r '.waiting_on_you[] | select(.id=="issu-q") | has("pr")' "$SP")" "false"
Q86 glued-q lead true --title "Migrate C#2" --question "Like acme#45 does?" >/dev/null 2>&1
eq "a # glued to an identifier is not a PR ref" "$?" "0"
eq "... with no pr on the entry"           "$(jq -r '.waiting_on_you[] | select(.id=="glued-q") | has("pr")' "$SP")" "false"
Q86 paren-q lead true --title "Approve (#21197)" --question "Please sign off." >/dev/null 2>&1
eq "a parenthesised ref still names the PR" "$?" "0"
eq "... stored with pr"                    "$(jq -r '.waiting_on_you[] | select(.id=="paren-q") | .pr' "$SP")" "21197"
out="$(Q86 slash-q lead true --title "T" --question "Ship #1/#2 together?" 2>&1)"; rc=$?
eq "'#1/#2' still reads as two PRs"        "$rc" "2"
eq "... saying one question per PR"        "$(printf '%s' "$out" | grep -c 'one question per PR: this question names #1 #2')" "1"
Q86 first-21196 lead true --title "Review #21196" --question "Please review #21196." >/dev/null 2>&1
eq "a first question on #21196 enqueues"   "$?" "0"
Q86 second-21196 lead true --title "Sign off #21196" --question "Sign off https://github.com/o/r/pull/21196?" >/dev/null 2>&1
eq "a second question on #21196 enqueues"  "$?" "0"
eq "... with pr stored"                    "$(jq -r '.waiting_on_you[] | select(.id=="second-21196") | .pr' "$SP")" "21196"
eq "... closing the first open one"        "$(jq '[.waiting_on_you[] | select(.id=="first-21196")] | length' "$SP")" "0"
eq "... while unrelated entries stay"      "$(jq '[.waiting_on_you[] | select(.id=="ship-q" or .id=="issu-q")] | length' "$SP")" "2"

# A mirrored picker question naming a PR is not refused (the picker is already open).
S10="$TMP/sq10.json"; printf '%s' "$EMPTY" > "$S10"
"$A" "$S10" picker-1 builder-u1 true --title "Approve #21223" --question "Approve #21223?" --option Alpha a --option Beta b --recommend 1 --why w --picker toolu_x /tmp/x.jsonl true >/dev/null 2>&1
eq "a mirrored picker question naming a PR enqueues" "$?" "0"
eq "... with no pr stored"                 "$(jq -r '.waiting_on_you[0] | has("pr")' "$S10")" "false"

# Off Orca (U11b): a member of a squad on a contract backend, with no BACKEND set, asks through
# bin/backend/contract.sh: on the board with its local:: worktree, exit 0, and nothing reaches Orca (an `orca`
# stub on PATH and as the Orca CLI dir logs every call). tests/loop/role-scripts-contract.test.ts covers the rest.
mkdir -p "$TMP/obin" "$TMP/owt"; : > "$TMP/olog"
printf '#!/usr/bin/env bash\necho "$*" >> "%s/olog"; exit 1\n' "$TMP" > "$TMP/obin/orca"; chmod +x "$TMP/obin/orca"
S11="$TMP/sq11.json"; printf '%s' "$EMPTY" > "$S11"
out="$(cd "$TMP/owt" && env -u BACKEND PATH="$TMP/obin:$PATH" DS_ORCA_CLI_BIN_DIR="$TMP/obin" DS_BACKEND=tmux DS_WT="$TMP/owt" \
  "$A" "$S11" off-1 thinker true --title "Ship it" --question "Ship u1?" --option Alpha a --option Beta b --recommend 1 --why w 2>&1)"
eq "off Orca: asks through the contract adapter"  "$?" "0"
eq "... is on the board"                   "$(printf '%s' "$out" | grep -c '^ON BOARD: off-1 (blocking)')" "1"
eq "... and pinged (nothing to ping)"      "$(printf '%s' "$out" | grep -c 'NOT pinged')" "0"
eq "... with its local:: worktree"         "$(jq -r '.waiting_on_you[0].card_wt' "$S11")" "local::$TMP/owt"
eq "... and no Orca call"                  "$(wc -c < "$TMP/olog" | tr -d ' ')" "0"

# Markdown questions: an option named with one letter or digit is refused, except a picker mirror
# (its labels are the terminal picker's); a long one-line question warns; newlines are stored.
SW="$TMP/sqw.json"; printf '%s' "$EMPTY" > "$SW"
NAMED=(--option "Keep it" "no change" --option "Raise limit" "one line")
for bad in A b 2 " C " É; do
  out="$("$A" "$SW" w1 thinker true --title T --question Q --option "$bad" x --option "Raise limit" y --recommend 2 --why w 2>&1)"; rc=$?
  eq "one-character label '$bad' -> 2"        "$rc" "2"
done
eq "..says to name the option"               "$(printf '%s' "$out" | grep -c 'name the option: `É` says nothing on the card — use 1–3 words')" "1"
eq "..and writes nothing"                    "$(jq -c . "$SW")" "$EMPTY"
"$A" "$SW" picker-w thinker true --title T --question Q --option A x --option 2 y --recommend 1 --why w --picker toolu_w /tmp/w.jsonl true >/dev/null 2>&1
eq "a --picker mirror keeps its labels -> 0" "$?" "0"
eq "..and is queued with them"               "$(jq -c '.waiting_on_you[] | select(.id=="picker-w") | .options' "$SW")" '["A","2"]'
LONG="$(printf 'word %.0s' {1..80})"
err="$("$A" "$SW" w-long thinker true --title T --question "$LONG" "${NAMED[@]}" --recommend 1 --why w 2>&1 >/dev/null)"; rc=$?
eq "a long one-line question is queued"      "$rc:$(jq '[.waiting_on_you[] | select(.id=="w-long")] | length' "$SW")" "0:1"
eq "..with the markdown warning"             "$(printf '%s' "$err" | grep -c 'write it as markdown: a plain lead, bullets, the ask last (conventions/escalation.md)')" "1"
MD="$(printf 'Start: fix — cause: x\n\nThe export fails.\n\n- it times out\n- %s\n\n**Raise the limit?**' "$LONG")"
err="$("$A" "$SW" w-md thinker true --title T --question "$MD" "${NAMED[@]}" --recommend 1 --why w 2>&1 >/dev/null)"; rc=$?
eq "named labels are accepted"               "$rc" "0"
eq "a long multi-line question does not warn" "$(printf '%s' "$err" | grep -c 'write it as markdown')" "0"
eq "newlines reach the state file intact"    "$(jq -r '.waiting_on_you[] | select(.id=="w-md") | .question' "$SW")" "$MD"

echo "ask-operator: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
