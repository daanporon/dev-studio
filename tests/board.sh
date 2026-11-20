#!/usr/bin/env bash
# board.sh --json — the data the React board renders (first part of the split board tests, see tests/lib/board-setup.sh): the fixture squads, accounts, units, questions, the needs-you inbox, stalls, archive, tokens.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
# shellcheck source=tests/lib/board-setup.sh
. "$ROOT/tests/lib/board-setup.sh"


board "$LBL" > "$TMP/a.json"
J="$TMP/a.json"; S='.squads[] | select(.topic=="manual-testing")'
jt "output is valid JSON with squads"     "$J" '.squads | length == 1'
jt "project label is reported"            "$J" ".project == \"$LBL\""
jt "live worktree count"                  "$J" '.live_worktrees == 3'
jt "capacity: live terminals"              "$J" '.capacity == {"label":"terminals","count":3}'
jt "needs count excludes nothing here"    "$J" '.needs_count == 2'
jt "stored + display status"              "$J" "$S | .status==\"running\" and .display_status==\"implementing\""
jt "type, autonomy, ship mode, task"      "$J" "$S | .type==\"testing\" and .autonomy==\"checkpoints\" and .ship_mode==\"ce-pipeline\" and .task_id==\"task_abc\""
jt "unit progress counts"                 "$J" "$S | .progress == {\"done\":1,\"dispatched\":1,\"planned\":1,\"cancelled\":0,\"total\":3}"
# Accounts: no accounts.tsv -> an empty strip, no error; with one -> text per account.
jt "no accounts.tsv: empty strip"         "$J" '.accounts == []'
jt "member account + fallback"            "$J" "$S | (.members[] | select(.role==\"builder\")) | .account==\"work\" and .fallback==true"
jt "member without account: null/false"  "$J" "$S | (.members[] | select(.role==\"lead\")) | .account==null and .fallback==false"
jt "old unit capacity deadline is ignored" "$J" "$S | (.units[] | select(.slug==\"c\")) | .state != \"waiting\" and .wait_label == null and .wait_until == null"
mkdir -p "$TMP/st"
NOW="$(date +%s)"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\nclaude\tsystem\t72\t%s\t41\t-\t-\t%s\nclaude\tb\t-\t-\t-\t-\t-\t%s\nclaude\tc\t10\t-\t5\t-\t%s\t%s\n' \
  "$((NOW+3600))" "$NOW" "$NOW" "$((NOW+7200))" "$NOW" > "$TMP/st/accounts.tsv"
HOSTST="$TMP/st" board "$LBL" > "$TMP/acc.json"
jt "accounts: one entry per row"          "$TMP/acc.json" '.accounts | length == 3'
jt "accounts: usage + reset + weekly"     "$TMP/acc.json" '.accounts[0].text | test("^system 72% · resets [0-9:]{5} · wk 41%$")'
jt "accounts: unknown shows ?"            "$TMP/acc.json" '.accounts[1].text == "b ?"'
jt "accounts: limited shows reset"        "$TMP/acc.json" '.accounts[2].limited and (.accounts[2].text | test("^c limited · resets [0-9:]{5}$"))'
# U8: label column (new 9-col file) -> label + raw numbers in the JSON; old 8-col file -> label falls back to the id.
mkdir -p "$TMP/st9"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nclaude\tsystem\t72\t%s\t41\t%s\t-\t%s\tme@example.com\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\tdefault\n' \
  "$((NOW+3600))" "$((NOW+86400))" "$NOW" "$NOW" > "$TMP/st9/accounts.tsv"
HOSTST="$TMP/st9" board "$LBL" > "$TMP/acc9.json"
jt "accounts: label + raw numbers"        "$TMP/acc9.json" ".accounts[0] | .label==\"me@example.com\" and .session_pct==72 and .weekly_pct==41 and .session_reset==$((NOW+3600)) and .weekly_reset==$((NOW+86400))"
jt "accounts: unknown usage has nulls"    "$TMP/acc9.json" '.accounts[1] | .label=="default" and .session_pct==null and .weekly_pct==null'
jt "accounts: text unchanged with label"  "$TMP/acc9.json" '.accounts[1].text == "muse:default ?"'
# U14: `note` column (10th) -> note in the JSON, text board still `?`; the 9-col file above has note null.
mkdir -p "$TMP/st14"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\nclaude\tb\t-\t-\t-\t-\t-\t%s\tb@example.com\texpired\nclaude\tc\t10\t-\t5\t-\t-\t%s\tc@example.com\t-\n' "$NOW" "$NOW" > "$TMP/st14/accounts.tsv"
HOSTST="$TMP/st14" board "$LBL" > "$TMP/acc14.json"
jt "accounts: note column passed through"  "$TMP/acc14.json" '.accounts[0].note=="expired" and .accounts[1].note==null'
jt "accounts: expired text stays '?'"      "$TMP/acc14.json" '.accounts[0].text=="b ?"'
# U241: a refused check keeps the last good figures; the note carries when they were good (refused@<epoch>).
mkdir -p "$TMP/st241"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\nclaude\td\t45\t-\t20\t-\t-\t%s\td@example.com\trefused@%s\n' "$NOW" "$((NOW - 300))" > "$TMP/st241/accounts.tsv"
HOSTST="$TMP/st241" board "$LBL" > "$TMP/acc241.json"
jt "accounts: refused keeps stale figures and the as-of note" "$TMP/acc241.json" '.accounts[0] | .session_pct==45 and .weekly_pct==20 and (.note|test("^refused@[0-9]+$"))'
# U15: Muse new window -> `-` numbers + note, so no bars (null pcts) and the card shows the note.
mkdir -p "$TMP/st15"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\tMuse\tno usage yet in this window\n' "$NOW" > "$TMP/st15/accounts.tsv"
HOSTST="$TMP/st15" board "$LBL" > "$TMP/acc15.json"
jt "accounts: muse no-usage note, no pcts"  "$TMP/acc15.json" '.accounts[0] | .note=="no usage yet in this window" and .session_pct==null and .weekly_pct==null'
jt "accounts: 9-col file has note null"    "$TMP/acc9.json" '.accounts[0].note==null'
# account-skills U3: `skills` column (11th) -> a non-ok value in the JSON and the text, with usage known or
# not; `ok` and a 10-col file give null.
st11_fixture
HOSTST="$TMP/st11" board "$LBL" > "$TMP/acc11.json"
jt "skills: broken passed through, usage known" "$TMP/acc11.json" '.accounts[0] | .skills=="broken: compound-engineering not installed" and (.text | endswith("· skills broken: compound-engineering not installed"))'
jt "skills: warn shown, usage unknown"      "$TMP/acc11.json" '.accounts[1] | .skills=="warn: no config dir" and (.text | endswith("b ? · skills warn: no config dir"))'
jt "skills: ok and - say nothing"           "$TMP/acc11.json" '.accounts[2].skills==null and .accounts[3].skills==null and (.accounts[2].text | test("skills") | not)'
jt "skills: a 10-col file has skills null"  "$TMP/acc14.json" '[.accounts[].skills] | all(. == null)'
# plan "disable" U3: a disabled account carries `disabled: true`; the others (and a re-import) say false.
ACCT_OFF="claude:b" HOSTST="$TMP/st11" board "$LBL" > "$TMP/accoff.json"
jt "disabled: only the switched-off account" "$TMP/accoff.json" '[.accounts[] | select(.disabled) | .account] == ["b"]'
jt "disabled: the others are enabled"        "$TMP/acc11.json" '[.accounts[].disabled] | all(. == false)'
ACCT_OFF="claude:b" HOSTST="$TMP/st11" tb "$LBL" > "$TMP/accoff.txt" 2>&1 || true
eq "disabled: the text board says so"        "$(grep '^ACCOUNTS' "$TMP/accoff.txt" | grep -cF "b ? · skills warn: no config dir · disabled")" "1"
# The web page: the row's badge + button + dim class, the "N roles, switch on restart" cell, the event
# lines, and a disabled account left out of the top-strip flags.
W="$ROOT/web/board.html"
eq "web board: disabled row has badge, class; the Enable/Disable button is in the opened panel" "$(grep -cF 'class="bdg off"' "$W")$(grep -cF '(a.disabled ? " off" : "")' "$W")$(sed -n '/^function AccountDetail(/,/^}/p' "$W" | grep -cF '${a.disabled ? "Enable" : "Disable"}</button>')" "111"
eq "web board: button click stops the row toggle" "$(grep -F 'class="abtn"' "$W" | grep -cF 'e.stopPropagation(); switchAccount(')" "1"
eq "web board: no action cell in the row, header has 6 cells" "$(sed -n '/^function AccountRow(/,/^}/p' "$W" | grep -c "class=\"abtn\"")$(grep -cF "<span>In use</span></div>" "$W")" "01"
eq "web board: skills is a chip, no paragraph" "$(grep -cF 'class="sk"' "$W")$(grep -cF '"bdg sk"' "$W")" "01"
eq "web board: squad tooltip capped at 240" "$(grep -cF 'sub.length > 240 ? sub.slice(0, 240)' "$W")" "1"
eq "web board: In use column says switch on restart" "$(grep -cF 'switch on restart' "$W")" "1"
eq "web board: last enabled account asks first" "$(grep -cF 'nothing new can start on " + a.agent + " until one is enabled' "$W")" "1"
eq "web board: strip flag skips disabled" "$(grep -cF 'const accFlag = (a) => a.disabled ? null :' "$W")" "1"
eq "web board: event log lines" "$(grep -cE 'case "account_(en|dis)abled"' "$W")" "2"
HOSTST="$TMP/st11" tb "$LBL" > "$TMP/acc11.txt" 2>&1 || true
eq "text board: broken skills on the ACCOUNTS line" "$(grep '^ACCOUNTS' "$TMP/acc11.txt" | grep -cF "skills broken: compound-engineering not installed")" "1"
# U123: `plan` column (12th) -> plan in the JSON, in the account's text, and on the crew chip (the Builder runs
# on account `work`, the Lead on the default login); `-` and an 11-col file give null and add nothing.
mkdir -p "$TMP/st12"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills\tplan\nclaude\tsystem\t-\t-\t-\t-\t-\t%s\tme@example.com\t-\tok\tMax\nclaude\twork\t-\t-\t-\t-\t-\t%s\twork@example.com\t-\tok\tteam_new_tier\nclaude\tother\t-\t-\t-\t-\t-\t%s\tother@example.com\t-\tok\t-\n' "$NOW" "$NOW" "$NOW" > "$TMP/st12/accounts.tsv"
HOSTST="$TMP/st12" board "$LBL" > "$TMP/acc12.json"
jt "plan: passed through, raw for an unknown tier" "$TMP/acc12.json" '.accounts[0].plan=="Max" and .accounts[1].plan=="team_new_tier" and .accounts[2].plan==null'
jt "plan: in the account text, none for unknown"  "$TMP/acc12.json" '.accounts[0].text=="system (Max) ?" and .accounts[2].text=="other ?"'
jt "plan: crew chip carries the plan"  "$TMP/acc12.json" "$S | (.members[] | select(.role==\"builder\")) | .account_plan==\"team_new_tier\""
jt "plan: default-login crew chip carries it" "$TMP/acc12.json" "$S | (.members[] | select(.role==\"lead\")) | .account_plan==\"Max\""
jt "plan: an 11-col file has plan null"  "$TMP/acc11.json" '[.accounts[].plan] | all(. == null)'
eq "web page: the sub chip and the crew chip render the plan" "$(grep -o 'account_plan ? " (" + s.account_plan\|account_real_plan' "$ROOT/web/board.html" | wc -l | tr -d ' ')" "3"
HOSTST="$TMP/st12" tb "$LBL" > "$TMP/acc12.txt" 2>&1 || true
eq "text board: the plan on the ACCOUNTS line and crew" "$(grep -cF "system (Max)" "$TMP/acc12.txt")" "1"
# account-free-resets U3: the 13th column -> `resets` in the JSON (state, count, earliest use-by, grants), `free resets <n>`
# in the text strip; 0, not_reported, unknown, NULL (12 columns / `-`) and a malformed value read as their state.
mkdir -p "$TMP/st13"
GJ='{"state":"reported","count":2,"grants":[{"id":"g2","label":"Later","left":1,"total":1,"use_by":1800000000,"refills":["weekly_model"],"usable_now":false},{"id":"g1","label":"Sooner","left":1,"total":1,"use_by":1796940000,"refills":["session","weekly"],"usable_now":true}]}'
{ printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills\tplan\tresets\n'
  printf 'claude\ttwo\t-\t-\t-\t-\t-\t%s\ttwo@example.com\t-\tok\t-\t%s\n' "$NOW" "$GJ"
  printf 'claude\tzero\t-\t-\t-\t-\t-\t%s\tzero@example.com\t-\tok\t-\t{"state":"reported","count":0,"grants":[]}\n' "$NOW"
  printf 'muse\tm\t-\t-\t-\t-\t-\t%s\tm@example.com\t-\t-\t-\t{"state":"not_reported"}\n' "$NOW"
  printf 'claude\tunk\t-\t-\t-\t-\t-\t%s\tunk@example.com\t-\tok\t-\t{"state":"unknown","reason":"surface"}\n' "$NOW"
  printf 'claude\tdash\t-\t-\t-\t-\t-\t%s\tdash@example.com\t-\tok\t-\t-\n' "$NOW"
  printf 'claude\tbad\t-\t-\t-\t-\t-\t%s\tbad@example.com\t-\tok\t-\t{not json\n' "$NOW"; } > "$TMP/st13/accounts.tsv"
HOSTST="$TMP/st13" board "$LBL" > "$TMP/acc13.json"
r13() { echo "[.accounts[] | select(.account==\"$1\") | .resets] | .[0] | $2"; }
jt "resets: two grants -> reported, count 2, earliest use-by" "$TMP/acc13.json" "$(r13 two '.state=="reported" and .count==2 and .first_use_by==1796940000 and (.grants|length)==2')"
jt "resets: a grant keeps label, refills, left/total, usable" "$TMP/acc13.json" "$(r13 two '.grants[1] | .label=="Sooner" and .refills==["session","weekly"] and .left==1 and .total==1 and .usable_now==true')"
jt "resets: count 0 is reported with no date" "$TMP/acc13.json" "$(r13 zero '.state=="reported" and .count==0 and .first_use_by==null')"
jt "resets: Muse is not_reported" "$TMP/acc13.json" "$(r13 m '.state=="not_reported"')"
jt "resets: unknown keeps its reason, count null" "$TMP/acc13.json" "$(r13 unk '.state=="unknown" and .reason=="surface" and .count==null')"
jt "resets: a - column reads unknown, never 0" "$TMP/acc13.json" "$(r13 dash '.state=="unknown" and .count==null')"
jt "resets: malformed JSON reads unknown, never 0" "$TMP/acc13.json" "$(r13 bad '.state=="unknown" and .count==null')"
jt "resets: an old 12-column file reads unknown" "$TMP/acc12.json" '[.accounts[].resets.state] | all(. == "unknown")'
jt "resets: the text carries the count only when reported" "$TMP/acc13.json" '(.accounts[]|select(.account=="two")|.text|endswith("free resets 2")) and (.accounts[]|select(.account=="zero")|.text|endswith("free resets 0")) and ([.accounts[]|select(.account=="unk" or .account=="dash" or .account=="m")|.text|contains("free resets")]|all(.==false))'
HOSTST="$TMP/st13" tb "$LBL" > "$TMP/acc13.txt" 2>&1 || true
eq "text board: the ACCOUNTS line shows the free resets count" "$(grep '^ACCOUNTS' "$TMP/acc13.txt" | grep -cF "free resets 2")" "1"
# account-free-resets U4: the last Use press of the hour per account -> `reset_last` (newest wins; older is null).
NRS="$(date +%s)"
rsev(){ bun -e 'const {Database}=require("bun:sqlite"); const [db, at, project, payload] = process.argv.slice(1); new Database(db).run("INSERT INTO events (at, project, kind, payload) VALUES (?, ?, ?, ?)", [Number(at), project, "account_reset_used", payload])' "$DBR/loop.db" "$@"; }
rsev "$((NRS-7200))" "$LBL" '{"agent":"claude","account":"zero","grant":"g0","outcome":"used","detail":""}'
rsev "$((NRS-900))" "$LBL" '{"agent":"claude","account":"two","grant":"g1","outcome":"failed","detail":"HTTP 500"}'
rsev "$((NRS-600))" "$LBL" '{"agent":"claude","account":"two","grant":"g1","outcome":"used","detail":"none · resets left 1"}'
render "$LBL" --json > "$TMP/acc13r.json"
jt "resets: the newest press of the hour is reset_last" "$TMP/acc13r.json" "[.accounts[] | select(.account==\"two\") | .reset_last] | .[0] | .outcome==\"used\" and .grant==\"g1\" and .detail==\"none · resets left 1\" and .at==$((NRS-600))"
jt "resets: a press over an hour old is not shown" "$TMP/acc13r.json" '[.accounts[] | select(.account=="zero") | .reset_last] | .[0] == null'
# account-free-resets U7: an open `account-reset` request -> `reset_pending` {id, at, project, queued}; none -> null.
# `queued` follows the project's pause (this fixture's project may already be pausing, so compare, never assume).
DS_STATE_ROOT="$DBR" bun -e 'import {open} from "'"$ROOT"'/bin/loop/core/store.ts"; const s=open(); s.requestAny("account-reset", {agent:"claude",account:"two",grant:"g1",key:"k-u7"}, {project:process.argv[1], by:"board"}); s.close();' "$LBL"
render "$LBL" --json > "$TMP/acc13p.json"
jt "resets: an open press is reset_pending with its id, time and project" "$TMP/acc13p.json" '[.accounts[] | select(.account=="two") | .reset_pending] | .[0] | (.id|type)=="number" and (.at|type)=="number" and .project!=null and (.queued|type)=="boolean"'
jt "resets: an account with no open press has reset_pending null" "$TMP/acc13p.json" '[.accounts[] | select(.account=="zero") | .reset_pending] | .[0] == null'
jt "resets: queued is the project's pause" "$TMP/acc13p.json" '([.projects[0].pause.state] | .[0] != "active") as $p | [.accounts[] | select(.account=="two") | .reset_pending.queued] | .[0] == $p'
DS_STATE_ROOT="$DBR" bun -e 'import {open} from "'"$ROOT"'/bin/loop/core/store.ts"; const s=open(); s.db.run("UPDATE requests SET done_at = 1 WHERE kind = ?", ["account-reset"]); s.close();'
render "$LBL" --json > "$TMP/acc13p.json"
jt "resets: a finished press is no longer pending" "$TMP/acc13p.json" '[.accounts[] | select(.account=="two") | .reset_pending] | .[0] == null'
eq "text crew: @label (plan)" "$(grep -cF "@work@example.com (team_new_tier)" "$TMP/acc12.txt")" "1"
jt "accounts: old 8-col file has note null" "$TMP/acc.json" '.accounts[1].note==null'
jt "accounts: old 8-col file, label=id"   "$TMP/acc.json" '.accounts[0].label=="system" and .accounts[2].label=="c"'
# U8 addendum: crew chip = account label (known id), id when unknown, default login label when none recorded.
mkdir -p "$TMP/st10"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nclaude\tsystem\t-\t-\t-\t-\t-\t%s\tme@example.com\nclaude\twork\t-\t-\t-\t-\t-\t%s\twork@example.com\n' "$NOW" "$NOW" > "$TMP/st10/accounts.tsv"
HOSTST="$TMP/st10" board "$LBL" > "$TMP/acc10.json"
jt "crew: known id shows label, id kept"  "$TMP/acc10.json" "$S | (.members[] | select(.role==\"builder\")) | .account==\"work\" and .account_label==\"work@example.com\" and .account_default==false"
jt "crew: no account -> default label"    "$TMP/acc10.json" "$S | (.members[] | select(.role==\"lead\")) | .account==null and .account_label==\"me@example.com\" and .account_default==true"
jt "crew: unknown id shows the id"        "$J" "$S | (.members[] | select(.role==\"builder\")) | .account_label==\"work\""
HOSTST="$TMP/st10" tb "$LBL" > "$TMP/acc10.txt" 2>&1 || true
eq "text crew: label + (default)"        "$(grep -cF "@me@example.com (default)" "$TMP/acc10.txt")" "2"
eq "text crew: known id label"            "$(grep -cF "@work@example.com" "$TMP/acc10.txt")" "1"
# Live counts come from the workers' Orca states (observed_workers): the Tester is waiting.
jt "live working/waiting counts"          "$J" "$S | .live == {\"working\":2,\"waiting\":1}"
jt "duplicate terminals flagged"          "$J" "$S | .dup_terminals == true"
jt "dev env split into url + note"        "$J" "$S | .devenv == {\"url\":\"http://localhost:21300\",\"note\":\"up\"}"
jt "questions: blocking first, raw text"  "$J" "$S | .questions[0].id==\"q1\" and .questions[0].blocking and .questions[0].question==\"a blocking <b>decision</b>\" and (.questions[0].age_min > 0)"
jt "member states + labels + terminals"   "$J" "$S | [.members[] | [.label,.state,.terminals]] == [[\"lead\",\"working\",1],[\"tester\",\"waiting\",0],[\"builder-platform\",\"working\",2]]"
# U280: only agent terminals count as sessions: a shell (or a `claude -p` child) beside one agent is no duplicate.
jq '.terminals = [["term_a","wtLead","manual-testing"],["term_b","wtBp","manual-testing"],["term_c","wtBp","manual-testing",false]]' "$SEED" > "$TMP/seed-agents.json"
SEED="$TMP/seed-agents.json" board "$LBL" > "$TMP/agents.json"
jt "an agent terminal plus a shell counts 1"      "$TMP/agents.json" "$S | (.members[] | select(.label==\"builder-platform\")) | .terminals==1"
jt "one agent plus a shell is not a duplicate"    "$TMP/agents.json" "$S | .dup_terminals == false"
jq '.terminals = [["term_a","wtLead","manual-testing"],["term_b","wtBp","manual-testing"],["term_c","wtBp","manual-testing",false],["term_d","wtBp","manual-testing"]]' "$SEED" > "$TMP/seed-agents2.json"
SEED="$TMP/seed-agents2.json" board "$LBL" > "$TMP/agents2.json"
jt "two agents beside a shell still flag duplicates" "$TMP/agents2.json" "$S | .dup_terminals == true and ((.members[] | select(.label==\"builder-platform\")) | .terminals==2)"
# U151: a member's effective state and pending one-time wishes, with age and author.
MEMBER_WISH="wtBp stopped --restart idle --reload --by op" board "$LBL" > "$TMP/wish.json"
jt "member wish: effective state + pending" "$TMP/wish.json" "$S | (.members[] | select(.wt==\"wtBp\")) | .wish.state==\"stopped\" and .wish.own==\"stopped\" and ([.wish.pending[] | [.wish, .by]] == [[\"restart\",\"op\"],[\"reload\",\"op\"]]) and (.wish.pending[0].mode==\"idle\") and (.wish.pending[0].age_s >= 0)"
jt "member without wishes: none pending"  "$TMP/wish.json" "$S | (.members[] | select(.wt==\"wtLead\")) | .wish != null and .wish.pending == []"
tb "$LBL" > "$TMP/text.txt"
eq "text board crew row shows ⚠ 2 sessions (U97)" "1" "$(grep -c '⚠ 2 sessions' "$TMP/text.txt")"
jt "member owns + for"                    "$J" "$S | .members[2].owns==\"U1-U3 PR #16293\" and .members[2].for==\"structures\""
jt "dispatched unit with no PR status = building" "$J" "$S | .units[] | select(.slug==\"b\") | .state==\"building\" and .busy and .pr.num==\"16349\""
cp "$SD/manual-testing.json" "$TMP/unlinked.json"
jq '.waiting_on_you[0] += {unit:"b",title:"Route the upstream fix"}' "$TMP/unlinked.json" > "$SD/manual-testing.json"
board "$LBL" > "$TMP/unit-wait.json"
jt "unit waiting on a board question says what it needs" "$TMP/unit-wait.json" "$S | .units[] | select(.slug==\"b\") | .state==\"waiting\" and .wait_label==\"waiting · Route the upstream fix\" and .waiting_on.id==\"q1\""
jt "the question names its affected unit" "$TMP/unit-wait.json" "$S | .questions[] | select(.id==\"q1\") | .unit==\"b\""
jq '.waiting_on_you[0].unit = "a"' "$SD/manual-testing.json" > "$TMP/finished-wait.json"
cp "$TMP/finished-wait.json" "$SD/manual-testing.json"
board "$LBL" > "$TMP/finished-board.json"
jt "a finished unit never shows a pending wait label" "$TMP/finished-board.json" "$S | .units[] | select(.slug==\"a\") | .state==\"done\" and .wait_label==null and .waiting_on==null"
# A held unit: planned reads `held` (not running), a blocking question wins over it, a dispatched one is
# a paused Builder (`waiting · Lead hold`), a done one stays done.
jq '.units += [{"slug":"d","status":"planned","hold":true},{"slug":"e","status":"planned","hold":true},{"slug":"f","status":"planned","hold":true,"hold_reason":"operator freeze"}]
    | .units[0].hold = true | .units[1].hold = true
    | .waiting_on_you[0] += {unit:"e",title:"Pick the approach"}' "$TMP/unlinked.json" > "$SD/manual-testing.json"
board "$LBL" > "$TMP/held-board.json"
jt "a planned held unit reads held with the label held" "$TMP/held-board.json" "$S | .units[] | select(.slug==\"d\") | .state==\"held\" and .wait_label==\"held\" and .waiting_on==null"
jt "a planned held unit with a blocking question keeps waiting · title" "$TMP/held-board.json" "$S | .units[] | select(.slug==\"e\") | .state==\"waiting\" and .wait_label==\"waiting · Pick the approach\""
jt "a dispatched held unit reads waiting · Lead hold" "$TMP/held-board.json" "$S | .units[] | select(.slug==\"b\") | .state==\"waiting\" and .wait_label==\"waiting · Lead hold\""
jt "a done unit with hold set reads done" "$TMP/held-board.json" "$S | .units[] | select(.slug==\"a\") | .state==\"done\" and .wait_label==null"
eq "text view prints the held label" "$(tb "$LBL" 2>/dev/null | grep -c '○ d.*(held)')" "1"
jt "a reasoned hold shows its reason" "$TMP/held-board.json" "$S | .units[] | select(.slug==\"f\") | .state==\"held\" and .wait_label==\"held · operator freeze\""
eq "text view prints reasoned hold" "$(tb "$LBL" 2>/dev/null | grep -c '○ f.*(held · operator freeze)')" "1"
mv "$TMP/unlinked.json" "$SD/manual-testing.json"
# U181: a dep-ready planned unit whose plan the operator has not approved reads
# `ready, plan not approved` instead of plain planned (the loop logs a ready_unapproved event).
cp "$SD/manual-testing.json" "$TMP/plan-base.json"
jq '.units += [{"slug":"g","status":"planned","plan":"/no/such/squad-plan.md"}]' "$TMP/plan-base.json" > "$SD/manual-testing.json"
board "$LBL" > "$TMP/plan-board.json"
jt "a dep-ready unit with an unapproved plan reads ready, plan not approved" "$TMP/plan-board.json" "$S | .units[] | select(.slug==\"g\") | .state==\"ready\" and .wait_label==\"ready, plan not approved\" and .waiting_on==null"
eq "text view prints ready, plan not approved" "$(tb "$LBL" 2>/dev/null | grep -c '○ g.*(ready, plan not approved)')" "1"
cp "$TMP/plan-base.json" "$SD/manual-testing.json"
jt "PRs from units; free-text owns PR dropped without a repo PR list" "$J" "$S | [.prs[].num] | (index(\"16349\") != null) and (index(\"16293\") == null)"
jt "plan shipped with its markdown"       "$J" "$S | .plans[0].name==\"manual-testing-alpha-plan.md\" and (.plans[0].markdown | contains(\"PLAN-MARKER-123\"))"
jt "plans carry mtime (newer first once sorted)" "$J" "$S | ([.plans[].mtime] | all(. > 0)) and ((.plans | map(select(.name==\"manual-testing-alpha-plan.md\"))[0].mtime) > (.plans | map(select(.name==\"manual-testing-beta-plan.md\"))[0].mtime))"
jt "proposed fix with approve command"    "$J" "$S | .proposals[0] == {\"id\":\"fix-7\",\"topic\":\"escrow-vault-bug\",\"command\":\"~/.dev-studio/bin/commands/approve-fix.sh '$LBL' 'manual-testing' 'fix-7'\"}"
# No jumps: the operator's Orca runs on another machine than the host, so a switch can't reach it.
jt "no jump command on a squad"           "$J" "$S | has(\"jump_command\") | not"
# The inbox: blocking first, then oldest; proposals are approvals; every item carries a command to copy.
jt "inbox: blocking question first"       "$J" '.needs_you[0].kind=="blocking" and .needs_you[0].squad=="manual-testing" and .needs_you[0].from=="lead"'
jt "inbox: proposal is an approval"       "$J" '[.needs_you[] | select(.kind=="approval")] | length==1 and .[0].command != null'
jt "inbox: soft question present"         "$J" '[.needs_you[] | select(.kind=="question")] | length==1'
jt "inbox: only approvals carry a command" "$J" '[.needs_you[] | select(.command != null) | .kind] == ["approval"]'
# The page answers from the inbox: each question names its project, squad and id, plus its choices.
jt "question carries its options"         "$J" "$S | .questions[0].options == [\"A\",\"B\"] and .questions[1].options == []"
jt "inbox question: id + label + options" "$J" ".needs_you[0] | .id==\"q1\" and .label==\"$LBL\" and .options==[\"A\",\"B\"]"
# crew-terminal-access U3: a question card chats with the member its answer goes to (no card_wt: the Lead);
# the panel reads turns from GET /api/chat, so board.json carries none.
jt "inbox question: chat_wt is the asker's member (the Lead here)" "$J" ".needs_you[0].chat_wt == \"wtLead\" and .needs_you[0].chat_label == \"the Lead\" and ($S | .questions[0].chat_wt == \"wtLead\")"
jt "board.json carries no chat turns" "$J" '[.. | objects | has("turns")] | any | not'
jt "inbox approval: no id to answer"      "$J" '[.needs_you[] | select(.kind=="approval")][0] | .id == null and .options == []'
jt "gh status reported"                   "$J" '.gh | has("ok")'

# Big plans: Linux caps ONE argument at 128 KB, macOS all of them at ~1 MB. A 1.5 MB plan must not
# reach jq as an argument ("Argument list too long" blanked the whole board on a real host).
printf '{"run_id":"rb","status":"running","members":[],"units":[]}' > "$SD/big.json"
{ printf '# Big plan\n\n'; head -c 1500000 /dev/zero | tr '\0' 'x'; printf '\n'; } > "$SD/big-alpha-plan.md"
mkdir -p "$DS_STATE_ROOT/$LBL/archive"; printf '{"topic":"big","closed_at":"2026-10-01T00:00:00Z","units":[]}' > "$DS_STATE_ROOT/$LBL/archive/big-1.json"
cp "$SD/big-alpha-plan.md" "$DS_STATE_ROOT/$LBL/archive/big-alpha-plan.md"
board "$LBL" > "$TMP/big.json" 2>"$TMP/big.err" || true
jt "big plan: squad renders"          "$TMP/big.json" '.squads[] | select(.topic=="big") | .plans[0].markdown | length > 1500000' '.squads | map(.topic)'
jt "big plan: archived renders"       "$TMP/big.json" '.archived[] | select(.topic=="big") | .plans[0].markdown | length > 1500000' '.archived | length'
eq "big plan: no jq error"            "$(grep -c 'Argument list too long' "$TMP/big.err" || true)" "0"
rm -rf "$SD/big.json" "$SD/big-alpha-plan.md" "$DS_STATE_ROOT/$LBL/archive"

# A suspended squad: its question is NOT counted and NOT in the inbox; it sorts after running.
printf '{"run_id":"r2","status":"suspended","type":"feature","autonomy":"checkpoints","members":[{"role":"lead","wt":"wl2","owns":[],"for":""}],"units":[],"waiting_on_you":[{"id":"q2","asker":"lead","blocking":true,"question":"parked","since":"2026-10-08T09:00:00Z"}]}' > "$SD/parked.json"
board "$LBL" > "$TMP/b.json"
jt "suspended question not counted"         "$TMP/b.json" '.needs_count == 2'
jt "suspended question not in the inbox"    "$TMP/b.json" '[.needs_you[] | select(.squad=="parked")] | length == 0'
jt "suspended crew is not gone"            "$TMP/b.json" '.squads[] | select(.topic=="parked") | .members[0].state == "suspended"'

# PR links once the GitHub observer resolved the repo selector to a slug (its config row).
GR="$TMP/grepo"
jq --arg a "$GR" --arg b "path:$GR" '.repos = {($a): "acme-org/acme", ($b): "acme-org/acme"}' "$SEED" > "$TMP/seed-gr.json"
printf '{"run_id":"r3","status":"running","repo":"%s","worktrees":[],"members":[],"units":[{"slug":"u","status":"done","pr":"16293"}]}' "$GR" > "$SD/linked.json"
# .repo as an Orca selector ('path:<abs>') must resolve too (no worktree fallback here).
printf '{"run_id":"r4","status":"running","repo":"path:%s","worktrees":[],"members":[],"units":[{"slug":"u","status":"done","pr":"16293"}]}' "$GR" > "$SD/selector.json"
printf '{"run_id":"r5","status":"running","repo":"path:%s","worktrees":[],"members":[],"units":[{"slug":"u","status":"done","pr":"https://github.com/acme-org/acme/pull/16294"}]}' "$GR" > "$SD/urlpr.json"
SEED="$TMP/seed-gr.json" board "$LBL" > "$TMP/c.json"
jt "a unit whose pr is a full URL renders its number and link" "$TMP/c.json" '.squads[] | select(.topic=="urlpr") | .units[0].pr.num=="16294" and .units[0].pr.url=="https://github.com/acme-org/acme/pull/16294"'
jt "PR url from the repo's slug row"      "$TMP/c.json" '.squads[] | select(.topic=="linked") | .prs[0].url=="https://github.com/acme-org/acme/pull/16293"'
jt "repo_slug of a path: selector"        "$TMP/c.json" '.squads[] | select(.topic=="selector") | .units[0].pr.url=="https://github.com/acme-org/acme/pull/16293"'
jt "project_url from the repo's slug row" "$TMP/c.json" '.project_url=="https://github.com/acme-org/acme"'
rm -f "$SD/parked.json" "$SD/linked.json" "$SD/selector.json" "$SD/urlpr.json" "$SD/manual-testing.json"

# No slug row for any squad repo -> no project_url.
NR="$DS_STATE_ROOT/zznorepo_$$/squads"; mkdir -p "$NR"
printf '{"run_id":"r","status":"running","repo":"/no/repo","worktrees":[],"members":[],"units":[]}' > "$NR/x.json"
board "zznorepo_$$" > "$TMP/nr.json"; rm -rf "$DS_STATE_ROOT/zznorepo_$$"
jt "no project_url without a GitHub remote" "$TMP/nr.json" '.project_url == null'

# Sort: needs-you above plain running; suspended stays last despite its question.
OD="$DS_STATE_ROOT/zzord_$$/squads"; mkdir -p "$OD"
printf '{"run_id":"a","status":"running","members":[],"units":[]}' > "$OD/zzz-plain.json"
printf '{"run_id":"b","status":"running","members":[],"units":[],"waiting_on_you":[{"id":"q","asker":"lead","blocking":true,"question":"x","since":"2026-10-08T09:00:00Z"}]}' > "$OD/aaa-attention.json"
printf '{"run_id":"c","status":"suspended","members":[],"units":[],"waiting_on_you":[{"id":"q","asker":"lead","blocking":true,"question":"y","since":"2026-10-08T09:00:00Z"}]}' > "$OD/mmm-held.json"
board "zzord_$$" > "$TMP/ord.json"
eq "squad order: attention, plain, held" "$(jq -r '[.squads[].topic] | join(" ")' "$TMP/ord.json")" "aaa-attention zzz-plain mmm-held"

# Derived display status: planning / fixing / testing.
printf '{"run_id":"p1","status":"running","type":"feature","members":[],"units":[{"slug":"x","status":"planned"}]}' > "$SD/planning-sq.json"
printf '{"run_id":"ft1","status":"running","type":"feature","members":[{"role":"lead","wt":"wl"},{"role":"tester","wt":"wt"}],"units":[{"slug":"x","status":"dispatched","builder_wt":"wb"}]}' > "$SD/fix-sq.json"
printf '{"run_id":"ft2","status":"running","type":"feature","members":[{"role":"lead","wt":"wl"},{"role":"tester","wt":"wt"}],"units":[{"slug":"x","status":"done"}]}' > "$SD/test-sq.json"
board "$LBL" > "$TMP/d.json"
jt "running+only-planned shows planning"     "$TMP/d.json" '.squads[] | select(.topic=="planning-sq") | .display_status=="planning"'
jt "feature+tester+dispatched shows fixing"  "$TMP/d.json" '.squads[] | select(.topic=="fix-sq") | .display_status=="fixing"'
jt "feature+tester+all-done shows testing, not wrapping up" "$TMP/d.json" '.squads[] | select(.topic=="test-sq") | .display_status=="testing"'
jt "a dispatched unit whose builder is gone" "$TMP/d.json" '.squads[] | select(.topic=="fix-sq") | .units[0].state=="gone"'
rm -f "$SD/planning-sq.json" "$SD/fix-sq.json" "$SD/test-sq.json"

# Retest due (U238): a Tester pass ended (tester_pass_done), units reached done after it, nothing
# dispatched, no Tester up -> `retest due`, hover naming the units; a Tester up stays testing;
# a pass with no unit done after it reads as any other squad (wrapping up).
printf '{"run_id":"rt1","status":"running","type":"feature","members":[{"role":"lead","wt":"wl"}],"units":[{"slug":"u1","status":"done","pr":5},{"slug":"u2","status":"done","pr":6}]}' > "$SD/retest-sq.json"
printf '{"run_id":"rt2","status":"running","type":"feature","members":[{"role":"lead","wt":"wl"},{"role":"tester","wt":"wt"}],"units":[{"slug":"u1","status":"done"}]}' > "$SD/retest-up-sq.json"
printf '{"run_id":"rt3","status":"running","type":"feature","members":[{"role":"lead","wt":"wl"}],"units":[{"slug":"u1","status":"done"}]}' > "$SD/retest-none-sq.json"
SEED0="$SEED"; SEED="$TMP/seed-rt.json"
cat > "$SEED" <<'JSON'
{"events":[
 {"at":1000,"squad":"retest-sq","kind":"tester_pass_done","member":"wt"},{"at":2000,"squad":"retest-sq","unit":"u1","kind":"unit_done"},{"at":2100,"squad":"retest-sq","unit":"u2","kind":"unit_done"},
 {"at":1000,"squad":"retest-up-sq","kind":"tester_pass_done","member":"wt"},{"at":2000,"squad":"retest-up-sq","unit":"u1","kind":"unit_done"},
 {"at":3000,"squad":"retest-none-sq","kind":"unit_done","unit":"u1"},{"at":3500,"squad":"retest-none-sq","kind":"tester_pass_done","member":"wt"}]}
JSON
board "$LBL" > "$TMP/rt.json"
tb "$LBL" > "$TMP/rt.txt" 2>&1 || true
SEED="$SEED0"
jt "retest due: pass ended, units done after it, no Tester up" "$TMP/rt.json" '.squads[] | select(.topic=="retest-sq") | .display_status=="retest due" and (.phase_note | test("u1 #5, u2 #6"))'
jt "retest due: a Tester that is up stays testing" "$TMP/rt.json" '.squads[] | select(.topic=="retest-up-sq") | .display_status=="testing"'
jt "retest due: nothing done after the pass reads wrapping up" "$TMP/rt.json" '.squads[] | select(.topic=="retest-none-sq") | .display_status=="wrapping up"'
eq "text board: retest due" "$(grep -cF 'retest-sq  [retest due]' "$TMP/rt.txt" || true)" "1"
rm -f "$SD/retest-sq.json" "$SD/retest-up-sq.json" "$SD/retest-none-sq.json"

# U237: queued / archiving / suspending / resuming, and a close that is stuck.
dbw(){ bun -e 'const {Database}=require("bun:sqlite");const d=new Database(process.argv[1]);d.run(process.argv[2])' "$DBR/loop.db" "$1"; }
mq(){ printf '{"run_id":"%s","status":"%s","type":"feature","members":[{"role":"lead","wt":"wl"}%s],"units":%s}' "$1" "$2" "$3" "$4" > "$SD/$1.json"; }
BW=',{"role":"builder","suffix":"u1"}'
mq q-sq running "$BW" '[{"slug":"u1","status":"planned"},{"slug":"u2","status":"planned"}]'
mq qd-sq running "$BW" '[{"slug":"u1","status":"done"},{"slug":"u2","status":"dispatched"},{"slug":"u3","status":"planned"}]'
mq qb-sq running "$BW" '[{"slug":"u1","status":"planned","deps":["u2"]},{"slug":"u2","status":"dispatched"}]'
mq qh-sq running "$BW" '[{"slug":"u1","status":"planned","hold":true},{"slug":"u2","status":"planned","deps":["u1"]}]'
mq qn-sq running '' '[]'
mq ar-sq running '' '[{"slug":"u1","status":"dispatched"}]'
mq su-sq running '' '[{"slug":"u1","status":"dispatched"}]'
mq st-sq running '' '[{"slug":"u1","status":"dispatched"}]'
mq rs-sq suspended '' '[{"slug":"u1","status":"planned"}]'
mq ok-sq suspended '' '[{"slug":"u1","status":"planned"}]'
board "$LBL" > /dev/null
NOWS=$(date +%s)
dbw "UPDATE members SET want='running', wt=NULL, want_result=NULL WHERE project='$LBL' AND role='builder'"
dbw "INSERT INTO picks (member, project, squad, role, slot, reason, picked_at) SELECT id, project, squad, role, 0, 'WAIT slot: acme has 6 of 6 Builders', $NOWS FROM members WHERE project='$LBL' AND squad='q-sq' AND role='builder'"
dbw "UPDATE squads SET want='gone', want_by='operator', want_at=$NOWS-60 WHERE project='$LBL' AND topic='ar-sq'"
dbw "UPDATE squads SET want='suspended', want_by='operator', want_at=$NOWS-60 WHERE project='$LBL' AND topic='su-sq'"
dbw "UPDATE squads SET want='suspended', want_by='operator', want_at=$NOWS-1200 WHERE project='$LBL' AND topic='st-sq'"
dbw "UPDATE squads SET want='running', want_by='operator', want_at=$NOWS-60 WHERE project='$LBL' AND topic='rs-sq'"
dbw "UPDATE squads SET want='suspended', want_by='operator', want_at=$NOWS-60, want_result='done: suspended' WHERE project='$LBL' AND topic='ok-sq'"
dbw "INSERT INTO events (at, project, squad, kind, payload) VALUES ($NOWS-600, '$LBL', 'st-sq', 'wish_given_up', '{\"error\":\"stop timed out\"}')"
render "$LBL" --json > "$TMP/q.json"
ds_of(){ echo ".squads[] | select(.topic==\"$1\") | $2"; }
jt "queued: planned units + wanted Builder + a pick wait" "$TMP/q.json" "$(ds_of q-sq '.display_status=="queued" and (.phase_note|contains("6 of 6"))')"
jt "queued: a dispatched unit stays implementing"         "$TMP/q.json" "$(ds_of qd-sq '.display_status=="implementing"')"
jt "queued: a unit blocked by a dep does not queue (dispatched dep -> implementing)" "$TMP/q.json" "$(ds_of qb-sq '.display_status=="implementing"')"
jt "queued: a held unit with a planned dependent is parked (U8)" "$TMP/q.json" "$(ds_of qh-sq '.display_status=="parked · 1 held"')"
jt "queued: no units is planning"                         "$TMP/q.json" "$(ds_of qn-sq '.display_status=="planning"')"
jt "want gone on a running squad shows archiving"         "$TMP/q.json" "$(ds_of ar-sq '.display_status=="archiving" and (.phase_note|contains("operator")) and .phase_stuck==false')"
jt "want suspended on a running squad shows suspending"   "$TMP/q.json" "$(ds_of su-sq '.display_status=="suspending"')"
jt "a 20-minute wish is stuck, with the wish_given_up reason" "$TMP/q.json" "$(ds_of st-sq '.display_status=="suspending" and .phase_stuck==true and (.phase_note|contains("stop timed out"))')"
jt "want running on a suspended squad shows resuming"     "$TMP/q.json" "$(ds_of rs-sq '.display_status=="resuming"')"
jt "a granted wish shows the stored status"               "$TMP/q.json" "$(ds_of ok-sq '.display_status=="suspended"')"
TXT="$(render "$LBL")"
grep -qF -- "queued: waiting for a Builder" <<<"$TXT" && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: text board queued note" >&2; }
grep -qF -- "⚠stuck" <<<"$TXT" && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: text board stuck flag" >&2; }
rm -f "$SD"/{q,qd,qb,qh,qn,ar,su,st,rs,ok}-sq.json

# Wrapping up (U2; squad-done-definition U1): a running feature squad with >=1 unit, every
# unit done or cancelled and no done unit's PR open (squad-finish.ts) shows it; dispatched,
# planned, held, testing and empty squads do not — a held unit is open work, whatever its hold
# kind. A feature+tester squad shows testing even when every unit is done; retiring the Tester
# (removing the member) is what makes it wrapping up.
printf '{"run_id":"rc1","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"done"}]}' > "$SD/ready-sq.json"
printf '{"run_id":"rc2","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned","hold":true}]}' > "$SD/ready-held-sq.json"
printf '{"run_id":"rc3","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned","hold":true},{"slug":"u3","status":"planned","deps":["u2"]}]}' > "$SD/held-dep-sq.json"
printf '{"run_id":"rc2p","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned","hold":true,"hold_by":"plan"}]}' > "$SD/held-plan-sq.json"
printf '{"run_id":"rc2r","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned","hold":true,"hold_reason":"operator freeze"}]}' > "$SD/held-reason-sq.json"
printf '{"run_id":"rc2c","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"cancelled"}]}' > "$SD/ready-cancel-sq.json"
printf '{"run_id":"rc2o","status":"running","type":"feature","repo":"path:/rc/openpr","members":[],"units":[{"slug":"u1","status":"done","pr":"31001"}]}' > "$SD/openpr-sq.json"
printf '{"run_id":"rc2m","status":"running","type":"feature","repo":"path:/rc/openpr","members":[],"units":[{"slug":"u1","status":"done","pr":"31002"}]}' > "$SD/mergedpr-sq.json"
jq '.repos = {"path:/rc/openpr": "acme/rc"} | .prs = [{"repo":"acme/rc","pr":31001,"state":"OPEN","head":"rc-a"},{"repo":"acme/rc","pr":31002,"state":"MERGED","head":"rc-b"}]' "$SEED" > "$TMP/seed-rc.json"
printf '{"run_id":"rc3","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"dispatched"}]}' > "$SD/notready-disp-sq.json"
printf '{"run_id":"rc4","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned"}]}' > "$SD/notready-plan-sq.json"
printf '{"run_id":"rc5","status":"running","type":"testing","members":[],"units":[{"slug":"u1","status":"done"}]}' > "$SD/notready-testing-sq.json"
printf '{"run_id":"rc6","status":"running","type":"feature","members":[],"units":[]}' > "$SD/notready-empty-sq.json"
printf '{"run_id":"rc7","status":"done","type":"feature","members":[],"units":[{"slug":"u1","status":"done"}]}' > "$SD/already-done-sq.json"
printf '{"run_id":"rc9","status":"running","type":"feature","members":[{"role":"lead","wt":"wl"}],"units":[{"slug":"x","status":"done"}]}' > "$SD/tester-gone-sq.json"
printf '{"run_id":"rc8","status":"running","type":"feature","members":[{"role":"lead","wt":"wl"},{"role":"tester","wt":"wt"}],"units":[{"slug":"x","status":"planned"}]}' > "$SD/still-testing-sq.json"
SEED="$TMP/seed-rc.json" board "$LBL" > "$TMP/rc.json"
jt "all-units-done running squad shows wrapping up" "$TMP/rc.json" '.squads[] | select(.topic=="ready-sq") | .display_status=="wrapping up" and .status=="running"'
jt "wrapping up: a held planned unit blocks it" "$TMP/rc.json" '.squads[] | select(.topic=="ready-held-sq") | .display_status!="wrapping up"'
jt "wrapping up: a plan hold blocks it" "$TMP/rc.json" '.squads[] | select(.topic=="held-plan-sq") | .display_status!="wrapping up"'
jt "wrapping up: a reasoned hold blocks it" "$TMP/rc.json" '.squads[] | select(.topic=="held-reason-sq") | .display_status!="wrapping up"'
jt "wrapping up: done plus cancelled shows it" "$TMP/rc.json" '.squads[] | select(.topic=="ready-cancel-sq") | .display_status=="wrapping up"'
jt "wrapping up: a done unit whose PR is open blocks it" "$TMP/rc.json" '.squads[] | select(.topic=="openpr-sq") | .display_status!="wrapping up"'
jt "wrapping up: a done unit whose PR merged shows it" "$TMP/rc.json" '.squads[] | select(.topic=="mergedpr-sq") | .display_status=="wrapping up"'
jt "wrapping up: absent while dispatched" "$TMP/rc.json" '.squads[] | select(.topic=="notready-disp-sq") | .display_status!="wrapping up"'
jt "wrapping up: absent while unheld planned" "$TMP/rc.json" '.squads[] | select(.topic=="notready-plan-sq") | .display_status!="wrapping up"'
jt "wrapping up: absent for testing squads" "$TMP/rc.json" '.squads[] | select(.topic=="notready-testing-sq") | .display_status!="wrapping up"'
jt "wrapping up: absent for empty squads" "$TMP/rc.json" '.squads[] | select(.topic=="notready-empty-sq") | .display_status!="wrapping up"'
jt "stored done still shows done, not wrapping up" "$TMP/rc.json" '.squads[] | select(.topic=="already-done-sq") | .display_status=="done"'
jt "wrapping up: tester retired (member removed) after all-done" "$TMP/rc.json" '.squads[] | select(.topic=="tester-gone-sq") | .display_status=="wrapping up"'
jt "feature+tester with planned work shows testing" "$TMP/rc.json" '.squads[] | select(.topic=="still-testing-sq") | .display_status=="testing"'
SEED="$TMP/seed-rc.json" tb "$LBL" > "$TMP/rc.txt" 2>&1 || true
eq "text board: wrapping up" "$(grep -cF 'ready-sq  [wrapping up]' "$TMP/rc.txt" || true)" "1"
eq "text board: a held-only squad is not wrapping up" "$(grep -cF 'ready-held-sq  [wrapping up]' "$TMP/rc.txt" || true)" "0"
# squad-done-definition U3: a running squad with only held work is parked, whatever the hold kind.
jt "parked: a held-only squad shows parked · 1 held" "$TMP/rc.json" '.squads[] | select(.topic=="ready-held-sq") | .display_status=="parked · 1 held" and .display_key=="held-only" and .held==1 and .status=="running"'
jt "parked: plan and reasoned holds park it too" "$TMP/rc.json" '[.squads[] | select(.topic=="held-plan-sq" or .topic=="held-reason-sq") | .display_key=="held-only"] | all'
jt "parked: a planned dependent of the held unit still parks it, hover counts it" "$TMP/rc.json" '.squads[] | select(.topic=="held-dep-sq") | .display_status=="parked · 1 held" and .display_key=="held-only" and (.explain.means|test("\\+1 waiting on them"))'
jt "parked: a squad with no held unit has held 0 and its own key" "$TMP/rc.json" '.squads[] | select(.topic=="ready-sq") | .held==0 and .display_key=="wrapping-up"'
eq "text board: a parked squad's header" "$(grep -cF 'ready-held-sq  [parked · 1 held]' "$TMP/rc.txt" || true)" "1"
rm -f "$SD"/{held-plan,held-reason,ready-cancel,openpr,mergedpr}-sq.json "$SD/ready-sq.json" "$SD/ready-held-sq.json" "$SD/notready-disp-sq.json" "$SD/notready-plan-sq.json" "$SD/notready-testing-sq.json" "$SD/notready-empty-sq.json" "$SD/already-done-sq.json" "$SD/still-testing-sq.json" "$SD/tester-gone-sq.json"

# A running squad meeting the finished condition sorts below every active squad and
# just above done/failed, deterministically — needs-you still ranks first, and both
# views share the order (the text board walks the same sorted squad array).
RD="$DS_STATE_ROOT/zzrdy_$$/squads"; mkdir -p "$RD"
printf '{"run_id":"a","status":"running","type":"feature","members":[],"units":[],"waiting_on_you":[{"id":"q","asker":"lead","blocking":true,"question":"x","since":"2026-10-08T09:00:00Z"}]}' > "$RD/aaa-needy.json"
printf '{"run_id":"b","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"dispatched"}]}' > "$RD/mmm-active.json"
printf '{"run_id":"c","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"done"}]}' > "$RD/bbb-ready.json"
printf '{"run_id":"d","status":"done","type":"feature","members":[],"units":[{"slug":"u1","status":"done"}]}' > "$RD/zzz-done.json"
printf '{"run_id":"e","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned","hold":true}]}' > "$RD/ccc-parked.json"
printf '{"run_id":"f","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"dispatched"},{"slug":"u2","status":"planned","hold":true},{"slug":"u3","status":"planned","hold":true}]}' > "$RD/ddd-running-held.json"
printf '{"run_id":"g","status":"done","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned","hold":true}]}' > "$RD/zzy-done-held.json"
printf '{"run_id":"h","status":"running","type":"feature","members":[],"units":[{"slug":"u1","status":"done"},{"slug":"u2","status":"planned","hold":true}],"waiting_on_you":[{"id":"q","asker":"lead","blocking":false,"question":"x","since":"2026-10-08T09:00:00Z"}]}' > "$RD/eee-parked-asking.json"
board "zzrdy_$$" > "$TMP/rdy.json"
eq "wrapping up sorts below active and parked, above done" "$(jq -r '[.squads[].topic] | join(" ")' "$TMP/rdy.json")" "aaa-needy eee-parked-asking ddd-running-held mmm-active ccc-parked bbb-ready zzy-done-held zzz-done"
eq "text board: same squad order" "$(tb "zzrdy_$$" 2>/dev/null | grep -o '^▣ [^ ]*' | awk '{print $2}' | tr '\n' ' ' | sed 's/ $//')" "aaa-needy eee-parked-asking ddd-running-held mmm-active ccc-parked bbb-ready zzy-done-held zzz-done"
jt "parked sorts below running, above wrapping up; keeps status running" "$TMP/rdy.json" '.squads[] | select(.topic=="ccc-parked") | .display_status=="parked · 1 held" and .status=="running" and .pause.state=="active"'
jt "a running squad with held units shows the badge count, not parked" "$TMP/rdy.json" '.squads[] | select(.topic=="ddd-running-held") | .held==2 and .display_key!="held-only"'
jt "a stored done squad with held units shows the badge count" "$TMP/rdy.json" '.squads[] | select(.topic=="zzy-done-held") | .held==1 and .display_status=="done"'
jt "a parked squad with a question sorts into needs-you first" "$TMP/rdy.json" '.squads[] | select(.topic=="eee-parked-asking") | .display_key=="held-only" and (.questions|length)==1'
eq "text board: a running squad's held badge" "$(tb "zzrdy_$$" 2>/dev/null | grep -cF 'ddd-running-held  [implementing] 2 held' || true)" "1"
# squad-done-definition U4: every state explains itself; a stored done squad is a Needs-you row.
jt "explain: wrapping up has means, set_by, you_can" "$TMP/rdy.json" '.squads[] | select(.topic=="bbb-ready") | .display_key=="wrapping-up" and .display_status=="wrapping up" and (.explain.means|length)>0 and (.explain.set_by|length)>0 and (.explain.you_can|length)>0'
jt "explain: parked and done have one" "$TMP/rdy.json" '[.squads[] | select(.topic=="ccc-parked" or .topic=="zzz-done") | .explain.you_can|length>0] | all'
jt "done: a Needs-you row with Close squad" "$TMP/rdy.json" '[.needs_you[] | select(.kind=="done" and .squad=="zzz-done")] | length==1 and (.[0].act.label=="Close squad") and (.[0].title|test("read the debrief, then Close squad"))'
jt "done: the row sorts after the questions and is counted" "$TMP/rdy.json" '(.needs_you|last|.kind)=="done" and .needs_count==([.needs_you[]]|length)'
jt "no board text says ready to close" "$TMP/rdy.json" '[.. | strings | select(test("ready to close"))] | length==0'
TXT="$(tb "zzrdy_$$" 2>/dev/null)"
eq "text board: the explanation line" "$(printf '%s\n' "$TXT" | grep -cF 'wrapping up: every unit is done or cancelled')" "1"
eq "text board: the paused/suspended/parked legend" "$(printf '%s\n' "$TXT" | grep -cF 'parked: nobody stopped it')" "1"
rm -rf "$DS_STATE_ROOT/zzrdy_$$"

# Lavish review pages (lavish-axi's state.json) show on the squad whose worktree holds the artifact.
mkdir -p "$TMP/lv" "$TMP/wtL/.lavish"
printf '{"run_id":"l1","status":"running","members":[],"units":[],"worktrees":["u1::%s/wtL"]}' "$TMP" > "$SD/lav-sq.json"
printf '{"sessions":{"k1":{"key":"k1","file":"%s/wtL/.lavish/brainstorm.html","url":"http://h:4387/session/k1","status":"open"},"k2":{"key":"k2","file":"%s/wtLx/.lavish/other.html","url":"http://h:4387/session/k2","status":"open"}}}' "$TMP" "$TMP" > "$TMP/lv/state.json"
LAVISH_AXI_STATE_DIR="$TMP/lv" board "$LBL" > "$TMP/lv.json"
jt "lavish session on its squad"  "$TMP/lv.json" '.squads[] | select(.topic=="lav-sq") | .lavish == [{"key":"k1","name":"brainstorm.html","dir":".lavish","mtime":0,"url":"http://h:4387/session/k1","status":"open"}]' '.squads[] | select(.topic=="lav-sq") | .lavish'
jt "no lavish state = empty list" "$J" '.squads[0].lavish == []'
rm -f "$SD/lav-sq.json"

# Dependency DAG: u2 no deps -> ready; u3 waits on u1(done)+u4 -> blocked. Natural order u1..u10.
printf '{"run_id":"w1","status":"running","type":"feature","members":[],"units":[{"slug":"u10-last","status":"planned","deps":["u3"]},{"slug":"u1","status":"done"},{"slug":"u3","status":"planned","deps":["u1","u4"]},{"slug":"u2","status":"planned","deps":[]},{"slug":"u4","status":"planned","deps":[]}]}' > "$SD/deps-sq.json"
board "$LBL" > "$TMP/e.json"
D='.squads[] | select(.topic=="deps-sq")'
jt "no-dep planned unit is ready"      "$TMP/e.json" "$D | .units[] | select(.slug==\"u2\") | .state==\"ready\""
jt "unit with an unmet dep is blocked" "$TMP/e.json" "$D | .units[] | select(.slug==\"u3\") | .state==\"blocked\" and .deps==[\"u1\",\"u4\"]"
eq "units in natural order" "$(jq -r "$D | [.units[].slug] | join(\" \")" "$TMP/e.json")" "u1 u2 u3 u4 u10-last"
jt "mermaid flowchart with a node per unit" "$TMP/e.json" "$D | .mermaid | startswith(\"flowchart LR\") and contains(\"nu3[\\\"u3\\\"]\")"
eq "two edges into u3" "$(jq -r "$D | .mermaid" "$TMP/e.json" | grep -c -- '--> nu3$')" "2"
rm -f "$SD/deps-sq.json"

# One malformed squad must not blank the board: it shows as broken, the others still render.
printf '{"run_id":"ok","status":"running","members":[],"units":[{"slug":"u1","status":"done"}]}' > "$SD/aaa-fine.json"
printf '{"run_id":"bad","status":"running","members":[],"units":[{"slug":"u3","status":"planned","deps":[3]},{"slug":"u2","deps":"u1"}]}' > "$SD/zzz-broken.json"
# A file that isn't JSON never becomes a row; a squads row whose doc won't parse is the broken case.
jq '.docs = {"zzz-unparseable": "{not json"}' "$SEED" > "$TMP/seed-bad.json"
SEED="$TMP/seed-bad.json" board "$LBL" > "$TMP/bad.json" || true
jt "board survives a malformed squad"  "$TMP/bad.json" '[.squads[].topic] | index("aaa-fine") != null'
jt "unparseable squad flagged broken"  "$TMP/bad.json" '[.squads[] | select(.error) | .topic] == ["zzz-unparseable"]'
jt "odd units (numeric/string deps) still render" "$TMP/bad.json" '.squads[] | select(.topic=="zzz-broken") | [.units[].slug] == ["u2","u3"] and .units[1].deps == ["3"]'
rm -f "$SD/aaa-fine.json" "$SD/zzz-broken.json"

# A dispatched unit whose Builder reports done is BUILT (in flight), never counted as merged;
# a worker row with gone_at means the worker is gone. A done Builder with no
# recorded PR shows "no PR" instead of built, so a Builder that stopped short is visible.
printf '{"run_id":"bt","status":"running","members":[{"role":"builder","wt":"wtBlank"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtDone","pr":"77"},{"slug":"u2","status":"dispatched","builder_wt":"wtBlank"},{"slug":"u3","status":"dispatched","builder_wt":"wtDone"}]}' > "$SD/built.json"
echo '{"workers":[["wtDone","done","b"],["wtBlank",null]]}' > "$TMP/seed-built.json"
SEED="$TMP/seed-built.json" board "$LBL" > "$TMP/built.json"
jt "dispatched + builder done + PR = built" "$TMP/built.json" '.squads[] | select(.topic=="built") | .units[0].state=="built" and (.units[0].busy|not) and .progress.done==0'
jt "dispatched + builder done, no PR = no PR" "$TMP/built.json" '.squads[] | select(.topic=="built") | .units[2].state=="no PR" and (.units[2].busy|not) and .progress.done==0'
eq "web board: no-PR state styled amber" "$(grep -cF '.dot.fixing,.dot.noPR{background:var(--amber)}' "$ROOT/web/board.html")$(grep -cF '.ust.fixing,.ust.noPR{color:var(--amber)}' "$ROOT/web/board.html")" "11"
jt "worker with gone_at = gone"         "$TMP/built.json" '.squads[] | select(.topic=="built") | .units[1].state=="gone" and .members[0].state=="gone"'
jt "no beat-stale threshold is shipped"   "$TMP/built.json" 'has("stale_s") | not'
rm -f "$SD/built.json"

# Copied commands are shell-quoted: a hostile proposal id can't smuggle in a second command.
printf '{"run_id":"inj","status":"running","members":[],"units":[],"proposed_squads":[{"id":"p1;touch /tmp/pwned","topic":"t","status":"proposed"}]}' > "$SD/inj.json"
board "$LBL" > "$TMP/inj.json"
jt "approve command quotes the id" "$TMP/inj.json" ".squads[] | select(.topic==\"inj\") | .proposals[0].command == \"~/.dev-studio/bin/commands/approve-fix.sh '$LBL' 'inj' 'p1;touch /tmp/pwned'\""
rm -f "$SD/inj.json"

# Orca rows stale (the Orca observer failing): say so, and report worker states as unknown — not "gone".
printf '{"run_id":"bd","status":"running","members":[{"role":"lead","wt":"wl"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wb"}]}' > "$SD/bdown.json"
jq '.orca_age = 3600' "$SEED" > "$TMP/seed-down.json"
SEED="$TMP/seed-down.json" board "$LBL" > "$TMP/bdown.json"
jt "backend down is reported"         "$TMP/bdown.json" '.backend_ok == false'
jt "states unknown when backend down" "$TMP/bdown.json" '.squads[] | select(.topic=="bdown") | .units[0].state=="unknown" and .members[0].state=="unknown"'
jt "backend up is reported"           "$J" '.backend_ok == true'
rm -f "$SD/bdown.json"

# U267: a failed report (the Builder's own worker_done, no PR) shows the unit waiting on its Lead while the
# Builder's dispatch is still the one it named; a new dispatch or a PR ends it.
printf '{"run_id":"fr","status":"running","members":[{"role":"lead","wt":"wl"},{"role":"builder","wt":"wtFr"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtFr"}]}' > "$SD/frep.json"
jq '.workers += [["wtFr","idle","ds-fr",null,60,null,"completed",null,"ctx_fr"]]' "$SEED" > "$TMP/seed-fr.json"
frep(){ SEED="$TMP/seed-fr.json" mkdb "$LBL"
  dbw "INSERT INTO episodes (project, subject, kind, squad, started_at, episode_key, state, source, observed_at) VALUES ('$LBL', 'frep.builder.idle', 'idle', 'frep', 1, 'failed|u1|ctx_fr', 'failed_report', 'loop', 1)"
  [ -z "${1:-}" ] || dbw "$1"
  render "$LBL" --json; }
frep > "$TMP/frep.json"
jt "a failed report: the unit waits on the Lead" "$TMP/frep.json" '.squads[] | select(.topic=="frep") | .units[0] | .state=="waiting" and .wait_label=="waiting · Lead · ended with no PR"'
frep "UPDATE observed_workers SET dispatch_id = 'ctx_fr2' WHERE wt = 'wtFr'" > "$TMP/frep2.json"
jt "a failed report for an older dispatch: not waiting" "$TMP/frep2.json" '.squads[] | select(.topic=="frep") | .units[0] | .state!="waiting" and .wait_label==null'
frep "UPDATE episodes SET state = 'cleared', ended_at = 2 WHERE subject = 'frep.builder.idle'" > "$TMP/frep3.json"
jt "a cleared failed report: not waiting" "$TMP/frep3.json" '.squads[] | select(.topic=="frep") | .units[0] | .state!="waiting"'
rm -f "$SD/frep.json"

# U2 (builder-idle-no-pr-card): a Builder at its prompt with only a background command left. The loop keeps one
# open `at-prompt` episode (started_at = the end of its turn); the board marks the crew row, the text board and
# the unit's Flow card (active_at is that moment, not now). A cleared episode or none marks nothing.
printf '{"run_id":"apt","status":"running","members":[{"role":"lead","wt":"wl"},{"role":"builder","wt":"wtAp"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtAp"}]}' > "$SD/apt.json"
jq '.workers += [["wtAp","working","ds-apt",null,60,null,"completed",null,"ctx_ap"]]' "$SEED" > "$TMP/seed-ap.json"
apt(){ SEED="$TMP/seed-ap.json" mkdb "$LBL"
  dbw "INSERT INTO episodes (project, subject, kind, squad, started_at, ended_at, episode_key, state, source, observed_at) VALUES ('$LBL', 'apt.builder.prompt', 'at-prompt', 'apt', $(( $(date +%s) - 45*60 )), NULL, 'prompt|u1|wtAp', 'open', 'loop', 1)"
  dbw "INSERT INTO events (at, project, squad, unit, kind, payload) VALUES ($(( $(date +%s) - 3*3600 )), '$LBL', 'apt', 'u1', 'unit_dispatched', '{}')"
  for d in 1 2 3 4 5; do   # five earlier units that built for 20 minutes: the typical Building time
    for kv in "0 unit_dispatched" "1200 unit_pr" "1500 unit_done"; do
      dbw "INSERT INTO events (at, project, squad, unit, kind, payload) VALUES ($(( $(date +%s) - 20*3600 + d*7200 + ${kv%% *} )), '$LBL', 'apt', 'old$d', '${kv#* }', '{\"pr\":\"$d\"}')"; done; done
  [ -z "${1:-}" ] || dbw "$1"
  render "$LBL" "${2---json}"; }
apt > "$TMP/apt.json"
jt "an at-prompt Builder: since on its crew row" "$TMP/apt.json" '.squads[] | select(.topic=="apt") | (.members[] | select(.role=="builder") | .at_prompt.since) as $s | ($s != null and ($s | type) == "number")'
jt "an at-prompt Builder: the lead has no marker" "$TMP/apt.json" '.squads[] | select(.topic=="apt") | (.members[] | select(.role=="lead") | .at_prompt) == null'
jt "an at-prompt Builder's Flow card is stuck" "$TMP/apt.json" '[.flow.cards[] | select(.squad=="apt")] | length == 1 and all(.stuck == true)'
apt "" "" > "$TMP/apt.txt"
grep -qF -- "at prompt 45 min · background only · no PR" "$TMP/apt.txt" && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: text board at-prompt marker" >&2; }
apt "UPDATE episodes SET state = 'cleared', ended_at = 2 WHERE kind = 'at-prompt'" > "$TMP/apt2.json"
jt "a cleared at-prompt episode: no marker, working keeps the card alive" "$TMP/apt2.json" '(.squads[] | select(.topic=="apt") | all(.members[]; .at_prompt == null)) and ([.flow.cards[] | select(.squad=="apt")] | all(.stuck == false))'
rm -f "$SD/apt.json"

# A DONE squad with no live workers gets a close nudge.
printf '{"run_id":"d1","status":"done","type":"feature","members":[],"units":[{"slug":"u1","status":"done"}]}' > "$SD/done-sq.json"
board "$LBL" > "$TMP/f.json"
jt "done squad is nudged to close" "$TMP/f.json" '.squads[] | select(.topic=="done-sq") | .close_nudge == true'
rm -f "$SD/done-sq.json"

# Archived squads are listed separately with their progress, PRs and closed date.
AD="$DS_STATE_ROOT/$LBL/archive"; mkdir -p "$AD"
printf '{"topic":"old-feature","closed_at":"2026-10-09T10:00:00Z","type":"feature","status":"closed","units":[{"slug":"u","status":"done","pr":"999"}]}' > "$AD/old-feature-20261009-100000.json"
board "$LBL" > "$TMP/g.json"
jt "archived squad listed" "$TMP/g.json" '.archived[0].topic=="old-feature" and .archived[0].closed_at=="2026-10-09T10:00:00Z" and .archived[0].progress.done==1 and .archived[0].prs[0].num=="999"'
jt "archived not among live squads" "$TMP/g.json" '[.squads[].topic] | index("old-feature") == null'
# U5: the archive carries a squad's debrief (null without one); a done live squad shows its own.
printf '{"topic":"with-debrief","closed_at":"2026-10-10T10:00:00Z","type":"feature","status":"closed","debrief":"Set out to X Shipped #1","units":[]}' > "$AD/with-debrief-20261010-100000.json"
printf '{"run_id":"dd","status":"done","type":"feature","debrief":"live debrief","members":[],"units":[{"slug":"u1","status":"done"}]}' > "$SD/dd-sq.json"
board "$LBL" > "$TMP/g2.json"
jt "U5: archived squad with a debrief" "$TMP/g2.json" '.archived[] | select(.topic=="with-debrief") | .debrief=="Set out to X Shipped #1"'
jt "U5: archived squad without one: null" "$TMP/g2.json" '.archived[] | select(.topic=="old-feature") | .debrief==null'
jt "U5: a done live squad carries its debrief" "$TMP/g2.json" '.squads[] | select(.topic=="dd-sq") | .debrief=="live debrief"'
rm -f "$SD/dd-sq.json"
eq "U5: page shows the Debrief group in Docs and the muted label" "$(grep -cF 'const DebriefChip' "$ROOT/web/board.html")$(grep -cF 'id: "debrief", label: "Debrief"' "$ROOT/web/board.html")$(grep -cF '>no debrief<' "$ROOT/web/board.html")$(grep -cF '<${Docs} s=${a} onPlan=${setPlan} closed=${true}' "$ROOT/web/board.html")$(grep -cF 'closed=${s.status === "done"}' "$ROOT/web/board.html")" "01111"
rm -rf "$AD"

# U5: briefs. No files -> empty list; ten files over two weeks -> newest first, only the first has markdown.
board "$LBL" > "$TMP/b0.json"
jt "U5: no briefs -> briefings is empty" "$TMP/b0.json" '.briefings == []'
briefs_fixture
board "$LBL" > "$TMP/b1.json"
jt "U5: ten briefs listed newest first" "$TMP/b1.json" '(.briefings | length) == 10 and .briefings[0].date=="2026-11-13" and .briefings[9].date=="2026-11-02"'
jt "U5: only the latest carries markdown" "$TMP/b1.json" '(.briefings[0].markdown | startswith("# Brief 2026-11-13")) and ([.briefings[1:][] | has("markdown")] | any | not)'
eq "U5: page groups briefs by week and loads on click" "$(grep -cF 'Briefs — none yet' "$ROOT/web/board.html")$(grep -cF 'const weekOf' "$ROOT/web/board.html")$(grep -cF 'fetch("api/briefing?project="' "$ROOT/web/board.html")$(grep -cF 'lstore.set("b:briefs"' "$ROOT/web/board.html")" "1112"

# U1: the latest brief's `prs` map comes from observed_prs: a known #n has its url, an unknown one
# is absent, and a number two repos share (two urls) is left out too.
printf '# Brief 2026-11-14\n\nShipped #409, #77 and #12. Also #999.\n' > "$BD/2026-11-14.md"
jq '.prs = [{"repo":"acme-org/dev-studio","pr":409,"url":"https://github.com/acme-org/dev-studio/pull/409"},{"repo":"a/x","pr":77,"url":"https://github.com/a/x/pull/77"},{"repo":"b/y","pr":77,"url":"https://github.com/b/y/pull/77"},{"repo":"a/x","pr":12}]' "$SEED" > "$TMP/seed-bp.json"
SEED="$TMP/seed-bp.json" board "$LBL" > "$TMP/bp.json"
jt "U1: the latest brief's prs has the known url" "$TMP/bp.json" '.briefings[0].prs == {"409":"https://github.com/acme-org/dev-studio/pull/409"}'
jt "U1: an older brief carries no prs" "$TMP/bp.json" '.briefings[1] | has("prs") | not'
rm -f "$BD/2026-11-14.md"

# U2 (morning-brief-polish): board.json's briefing_schedule. Off (the default) -> on=false, next=null and the
# page renders no #briefs; on (the env override the Limits tab reads) -> the values and a next slot.
jt "U2: schedule off by default: on=false, next=null" "$TMP/bp.json" '.briefing_schedule == {"time":"off","days":"mon-fri","on":false,"next":null}'
DS_LIMIT_BRIEFING_TIME=08:30 DS_LIMIT_BRIEFING_DAYS=daily board "$LBL" > "$TMP/bs-on.json"
jt "U2: schedule on has time, days, on and a next epoch" "$TMP/bs-on.json" '.briefing_schedule | .time=="08:30" and .days=="daily" and .on==true and (.next|type)=="number"'
DS_LIMIT_BRIEFING_TIME=25:99 board "$LBL" > "$TMP/bs-bad.json"
jt "U2: a bad stored time is off" "$TMP/bs-bad.json" '.briefing_schedule | .on==false and .next==null'
eq "U2: page renders no Briefs section when off, and the next send when on" "$(grep -cF 'if (schedule && !schedule.on) return null;' "$ROOT/web/board.html")$(grep -cF '" · next due now"' "$ROOT/web/board.html")$(grep -cF 'schedule=${data.briefing_schedule}' "$ROOT/web/board.html")" "111"

# Shared stall: 3+ running squads whose Lead stopped reading its mail within ~2 minutes of each
# other -> one banner (the wake hook/session host stopped), not N separate alarms. A Lead that
# is merely idle (nothing unread) is not a stall however long it has been idle.
XD="$DS_STATE_ROOT/zzstall_$$/squads"; mkdir -p "$XD"
for t in s1 s2 s3; do
  printf '{"run_id":"%s","status":"running","members":[{"role":"lead","wt":"wt%s"}],"units":[]}' "$t" "$t" > "$XD/$t.json"
  touch -t "$(date -v-60M +%Y%m%d%H%M 2>/dev/null || date -d '-60 min' +%Y%m%d%H%M)" "$XD/$t.beat"
done
cat > "$TMP/seed-st.json" <<JSON
{"workers":[["wts1","idle",null,null,3600],["wts2","done",null,null,3600],["wts3","idle",null,null,3600]],
 "unread":[["wts1",1,900],["wts2",2,860],["wts3",1,840]], "events":[]}
JSON
SEED="$TMP/seed-st.json" board "zzstall_$$" > "$TMP/h.json"
jt "shared stall detected"           "$TMP/h.json" '.stall.count == 3 and .stall.minutes >= 13 and .stall.minutes <= 15'
jt "lead verdict per squad"          "$TMP/h.json" '[.squads[].lead | [.silent, .verdict]] == [[true,"not responding"],[true,"not responding"],[true,"not responding"]]'
# With the loop down the rows stop moving with it: no verdict and no stall.
jq '.health_age = 61' "$TMP/seed-st.json" > "$TMP/seed-down.json"
SEED="$TMP/seed-down.json" board "zzstall_$$" > "$TMP/h2.json"
jt "loop down: no stall, no stuck Lead" "$TMP/h2.json" '.loop.down and .stall == null and [.squads[].lead.silent] == [false,false,false] and [.squads[].lead.verdict] == [null,null,null]'
jq '.unread[2][2] = 200' "$TMP/seed-st.json" > "$TMP/seed-st2.json"   # one Lead's mail only 3 min old -> 2 not responding
SEED="$TMP/seed-st2.json" board "zzstall_$$" > "$TMP/i.json"
jt "no stall banner below 3"         "$TMP/i.json" '.stall == null'
# Three Leads idle for 60+ minutes with nothing unread: nothing is wrong, no banner.
jq '.unread = []' "$TMP/seed-st.json" > "$TMP/seed-st3.json"
SEED="$TMP/seed-st3.json" board "zzstall_$$" > "$TMP/j.json"
jt "three merely idle Leads: no banner, no verdict" "$TMP/j.json" '.stall == null and ([.squads[].lead | .silent or .verdict != null] | any | not)'
eq "text board: idle Leads carry no marker" "$(SEED="$TMP/seed-st3.json" tb "zzstall_$$" 2>/dev/null | grep -c 'LEAD-')" "0"
eq "text board: not-responding markers" "$(SEED="$TMP/seed-st.json" tb "zzstall_$$" 2>/dev/null | grep -c 'LEAD-NOT-RESPONDING(1[3-5]m)')" "3"

# U88: a quiet Lead is told from its last output, not the .beat marker (watch.sh's beat
# stopped moving once Run mail is typed into the Lead's terminal). The age is the newest of
# .beat, the Lead worktree's last_output_at and the last relayed Run mail; .beat counts only
# when it is newer. A Lead whose relay keeps failing after its last output shows unreachable.
QD="$DS_STATE_ROOT/zzquiet_$$/squads"; mkdir -p "$QD"
for t in q1 q2 q3 q4 q5 q6 q7 q8 q9 q10 q11; do printf '{"run_id":"%s","status":"running","members":[{"role":"lead","wt":"wtQ%s"}],"units":[]}' "$t" "${t#q}" > "$QD/$t.json"; done
touch -t "$(date -v-12H +%Y%m%d%H%M 2>/dev/null || date -d '-12 hours' +%Y%m%d%H%M)" "$QD/q1.beat"
touch -t "$(date -v-61M +%Y%m%d%H%M 2>/dev/null || date -d '-61 min' +%Y%m%d%H%M)" "$QD/q5.beat"
touch -t "$(date -v-60M +%Y%m%d%H%M 2>/dev/null || date -d '-60 min' +%Y%m%d%H%M)" "$QD/q6.beat"
cat > "$TMP/seed-q.json" <<JSON
{"workers":[["wtQ1","working",null,null,120],["wtQ2","working"],["wtQ3","working",null,null,3660],["wtQ4","working",null,null,120],["wtQ5","working"],["wtQ6","working"],
  ["wtQ7","done",null,null,4800],["wtQ8","idle",null,null,4800],["wtQ9","idle",null,null,4800],["wtQ10","working",null,null,2100],["wtQ11","done",null,null,4800]],
 "unread":[["wtQ8",1,900],["wtQ9",1,300],["wtQ11",0,3600]],
 "terminals":[["tq1","wtQ1","q1"]],
 "worktrees":[["wtQ1",null],["wtQ2",null],["wtQ3",null],["wtQ4",null],["wtQ5",null],["wtQ6",null],["wtQ7",null],["wtQ8",null],["wtQ9",null],["wtQ10",null],["wtQ11",null]],
 "events":[]}
JSON
QN="$NOW"
jq --argjson now "$QN" '.events=[] |
 .relayed=[{squad:"q1",seenAge:60,forwardedAge:60},
  {squad:"q3",seenAge:7200,error:"send-run-worker NOT delivered — no live terminal: wtQ3 has no live agent terminal"},
  {squad:"q4",seenAge:10800,forwardedAge:60, error:"send-run-worker NOT delivered — no live terminal"},
  {squad:"q5",seenAge:3700,error:"misdelivered to term_x9, not the Lead'"'"'s agent terminal term_a1"}]' \
 "$TMP/seed-q.json" > "$TMP/seed-q1.json"
SEED="$TMP/seed-q1.json" board "zzquiet_$$" > "$TMP/q.json"
jt "fresh output beats a 12h .beat: not silent"       "$TMP/q.json" '.squads[] | select(.topic=="q1") | .lead | .silent==false and .active_age_s != null and .active_age_s < 1500 and .unreachable==false'
jt "no output, no relay, no beat: nothing to show"     "$TMP/q.json" '.squads[] | select(.topic=="q2") | .lead | .silent==false and .active_age_s==null and .verdict==null'
jt "relay still failing after later output: unreachable" "$TMP/q.json" '.squads[] | select(.topic=="q3") | .lead | .silent==true and .unreachable==true and .verdict=="unreachable" and .since_s==null and .active_age_s > 1500'
jt "a forwarded mark is not stuck even with an error note" "$TMP/q.json" '.squads[] | select(.topic=="q4") | .lead | .silent==false and .unreachable==false'
jt "a misdelivered relay also reads unreachable"     "$TMP/q.json" '.squads[] | select(.topic=="q5") | .lead | .silent==true and .unreachable==true'
jt "no lead carries the old beat field"                "$TMP/q.json" '[.squads[] | .lead | has("beat_age_s")] | any | not'
jt "idle Lead, 80 min, nothing unread: no verdict (the screenshot case)" "$TMP/q.json" '.squads[] | select(.topic=="q7") | .lead | .silent==false and .verdict==null and .since_s==null'
jt "idle Lead, unread 15 min: not responding"        "$TMP/q.json" '.squads[] | select(.topic=="q8") | .lead | .silent==true and .verdict=="not responding" and (.since_s|floor) >= 899 and .since_s < 960'
jt "idle Lead, unread 5 min: no verdict yet"          "$TMP/q.json" '.squads[] | select(.topic=="q9") | .lead | .silent==false and .verdict==null'
jt "working Lead, no output 35 min: hung"             "$TMP/q.json" '.squads[] | select(.topic=="q10") | .lead | .verdict=="hung" and (.since_s|floor) >= 2099'
jt "old unread episode but the count is 0: no verdict" "$TMP/q.json" '.squads[] | select(.topic=="q11") | .lead | .verdict==null'
jt "an unreachable relay wins over another verdict"   "$TMP/q.json" '.squads[] | select(.topic=="q3") | .lead | .verdict=="unreachable"'
jt "one not-responding Lead is no stall"              "$TMP/q.json" '.stall == null'
eq "text board: two unreachable leads" "$(SEED="$TMP/seed-q1.json" tb "zzquiet_$$" 2>/dev/null | grep -c LEAD-UNREACHABLE)" "2"
# Fresh output everywhere: no stall, no quiet Lead, even with the stale .beats above.
jq '.workers |= map([.[0], .[1], .[2], .[3], 60]) | .unread = [] | .events = []' "$TMP/seed-q.json" > "$TMP/seed-q2.json"
SEED="$TMP/seed-q2.json" board "zzquiet_$$" > "$TMP/qf.json"
jt "fresh output: no stall, no quiet lead" "$TMP/qf.json" '.stall == null and ([.squads[].lead | .verdict] | map(select(. != null and . != "unreachable")) | length) == 0'

# PR status from the GitHub observer's rows: an open green PR awaiting review, a merged one.
GR="$TMP/ghrepo"
jq --arg r "path:$GR" '.repos = {($r): "acme/app"} | .prs = [{"repo":"acme/app","pr":501,"state":"OPEN","ci":"green","review":"none","head":"x"},{"repo":"acme/app","pr":402,"state":"MERGED"}]' "$SEED" > "$TMP/seed-pr.json"
printf '{"run_id":"r","status":"running","repo":"path:%s","members":[{"role":"builder","wt":"wtBp"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtBp","pr":"501"},{"slug":"u2","status":"done","pr":"402"}]}' "$GR" > "$SD/prs.json"
SEED="$TMP/seed-pr.json" board "$LBL" > "$TMP/pr1.json"
jt "a merged PR shows its status" "$TMP/pr1.json" '.squads[] | select(.topic=="prs") | .units[] | select(.slug=="u2") | .pr.status=="merged"'
jt "a green PR awaiting review = babysitting" "$TMP/pr1.json" '.squads[] | select(.topic=="prs") | .units[] | select(.slug=="u1") | .state=="babysitting" and .busy'
jt "PR and CI columns: the PR row with its status" "$TMP/pr1.json" '.squads[] | select(.topic=="prs") | [.prs[] | [.num, .status]] == [["402","merged"],["501","open"]]'
jq '.prs[0].ci = "red"' "$TMP/seed-pr.json" > "$TMP/seed-pr2.json"
SEED="$TMP/seed-pr2.json" board "$LBL" > "$TMP/pr2.json"
jt "CI red = failing, unit fixing" "$TMP/pr2.json" '.squads[] | select(.topic=="prs") | (.prs[] | select(.num=="501") | .status=="failing") and (.units[] | select(.slug=="u1") | .state=="fixing")'
jq '.prs[0].ci = "pending"' "$TMP/seed-pr.json" > "$TMP/seed-pr3.json"
SEED="$TMP/seed-pr3.json" board "$LBL" > "$TMP/pr3.json"
jt "CI pending = running, unit testing" "$TMP/pr3.json" '.squads[] | select(.topic=="prs") | (.prs[] | select(.num=="501") | .status=="running") and (.units[] | select(.slug=="u1") | .state=="testing")'
jq '.prs[0].gone = true' "$TMP/seed-pr.json" > "$TMP/seed-pr4.json"
SEED="$TMP/seed-pr4.json" board "$LBL" > "$TMP/pr4.json"
jt "an open PR the observer lost has no status, not open" "$TMP/pr4.json" '.squads[] | select(.topic=="prs") | .prs[] | select(.num=="501") | .status==null'
rm -f "$SD/prs.json"
# Merged units count as finished (U58): the page's finished, lifted out, over the board's units. A done
# unit whose recorded PR has no observed row (403) or a merged one (402) is hidden by "hide finished";
# a done unit with an open PR (501) stays, and so does a dispatched one.
printf '{"run_id":"f","status":"running","repo":"path:%s","members":[],"units":[{"slug":"f1","status":"done","pr":"402"},{"slug":"f2","status":"done","pr":"403"},{"slug":"f3","status":"done","pr":"501"},{"slug":"f4","status":"dispatched","pr":"403"}]}' "$GR" > "$SD/fin.json"
SEED="$TMP/seed-pr.json" board "$LBL" > "$TMP/fin.json"
rm -f "$SD/fin.json"
jt "U58: an unseen recorded PR has no status, a merged one merged, an open one open" "$TMP/fin.json" '[.squads[] | select(.topic=="fin") | .units[] | .pr.status] == [ "merged", null, "open", null ]'
fin="$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8"), i = h.indexOf("const finished =");
  const finished = new Function(h.slice(i, h.indexOf("\n", i)) + "return finished;")();
  const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).squads.find((x) => x.topic === "fin");
  console.log(s.units.filter((u) => !finished(u)).map((u) => u.slug).join(","), s.units.filter(finished).length);' "$ROOT/web/board.html" "$TMP/fin.json" 2>&1)"
eq "U58: hide finished hides the unseen and merged done units, keeps the open one" "$fin" "f3,f4 2"

# Phantom free-text PRs (U2): a #NN in framing/owns renders only when the repo has that PR (#501
# has a row, #123/#999 have none — #123 must not become a phantom open row). A unit-recorded PR
# with no row (402 here) still renders.
printf '{"run_id":"ph","status":"running","type":"feature","repo":"path:%s","framing":"see #123 and #501","members":[{"role":"builder","wt":"wtBp","owns":["notes #999","work #501"]}],"units":[{"slug":"u1","status":"done","pr":"402"}]}' "$GR" > "$SD/phantom-sq.json"
jq '.prs |= map(select(.pr == 501))' "$TMP/seed-pr.json" > "$TMP/seed-ph.json"
SEED="$TMP/seed-ph.json" board "$LBL" > "$TMP/phantom.json"
jt "phantom: framing #123 with no such PR yields no 123 row" "$TMP/phantom.json" '.squads[] | select(.topic=="phantom-sq") | [.prs[].num] | index("123") == null'
jt "phantom: owns #999 with no such PR yields no 999 row" "$TMP/phantom.json" '.squads[] | select(.topic=="phantom-sq") | [.prs[].num] | index("999") == null'
jt "phantom: free-text #501 in the repo list renders" "$TMP/phantom.json" '.squads[] | select(.topic=="phantom-sq") | [.prs[].num] | index("501") != null'
jt "phantom: unit-recorded PR outside the list still renders" "$TMP/phantom.json" '.squads[] | select(.topic=="phantom-sq") | [.prs[].num] | index("402") != null'
jt "phantom: no PR row is a phantom open" "$TMP/phantom.json" '.squads[] | select(.topic=="phantom-sq") | [.prs[] | select(.num=="123" or .num=="999")] | length == 0'
rm -f "$SD/phantom-sq.json"

# A question about a PR links to it (U87): the squad JSON carries pr {num, url, state} from
# observed_prs; a question without pr has none.
QR="$TMP/qrrepo"
jq --arg a "$QR" --arg b "path:$QR" '.repos = {($a): "acme/app", ($b): "acme/app"} | .prs = [{"repo":"acme/app","pr":21196,"state":"OPEN","ci":"green","review":"none","head":"x"},{"repo":"acme/app","pr":21197,"state":"OPEN","draft":true,"head":"y"}]' "$SEED" > "$TMP/seed-qpr.json"
printf '{"run_id":"qp","status":"running","repo":"path:%s","members":[],"units":[],"waiting_on_you":[{"id":"qpr","asker":"lead","blocking":true,"title":"Approve #21196?","question":"Is PR #21196 good to merge? Also see PRD-18424 and U7.","since":"2026-10-08T09:00:00Z","pr":21196},{"id":"qdraft","asker":"lead","blocking":false,"question":"Draft #21197 needs eyes","since":"2026-10-08T09:00:00Z","pr":21197},{"id":"qplain","asker":"lead","blocking":false,"question":"plain one","since":"2026-10-08T09:00:00Z"}]}' "$QR" > "$SD/qpr-sq.json"
SEED="$TMP/seed-qpr.json" board "$LBL" > "$TMP/qpr.json"
jt "U87: a PR question carries its url and state" "$TMP/qpr.json" '.squads[] | select(.topic=="qpr-sq") | .questions[] | select(.id=="qpr") | .pr == {"num":"21196","url":"https://github.com/acme/app/pull/21196","state":"open"}'
jt "U87: a draft PR question reads draft" "$TMP/qpr.json" '.squads[] | select(.topic=="qpr-sq") | .questions[] | select(.id=="qdraft") | .pr == {"num":"21197","url":"https://github.com/acme/app/pull/21197","state":"draft"}'
jt "U87: a question without pr has none" "$TMP/qpr.json" '.squads[] | select(.topic=="qpr-sq") | .questions[] | select(.id=="qplain") | .pr == null'
jt "U87: the inbox carries the PR link fields" "$TMP/qpr.json" '.needs_you[] | select(.id=="qpr") | .pr.num == "21196" and .pr.url == "https://github.com/acme/app/pull/21196" and .pr.state == "open" and .repo_slug == "acme/app"'
# Answered through the store, as /api/answer does: the answered page keeps the PR link fields.
DS_STATE_ROOT="$DBR" bun -e 'import { open } from "'"$ROOT"'/bin/loop/core/store.ts";
  import { answer } from "'"$ROOT"'/bin/loop/messages/questions.ts";
  import { questionsPage } from "'"$ROOT"'/bin/board/board-data.ts";
  const s = open(); answer(s, "'"$LBL"'", "qpr-sq", "qpr", "ship it", "board"); s.close();
  console.log(JSON.stringify(questionsPage({ project: "'"$LBL"'", squad: "qpr-sq" })) ?? "null");' > "$TMP/qpa.json" 2>"$TMP/qpa.err" || { fail=$((fail+1)); echo "  FAIL: U87: questionsPage threw: $(cat "$TMP/qpa.err" | head -c 300)" >&2; echo null > "$TMP/qpa.json"; }
jt "U87: the answered page keeps the PR link fields" "$TMP/qpa.json" '.questions[] | select(.id=="qpr") | .pr == {"num":"21196","url":"https://github.com/acme/app/pull/21196","state":"open"} and .answer == "ship it"'
# plan-approval-view U1: a question links its document (doc_path, or the plan-<short> id rule); plan-* questions carry
# the plain section (or the PROBLEM/DONE fallback) and counted facts; a bad plan or a missing document gives nulls.
printf '# Plan\n\n**PROBLEM:** old problem.\n\n## In plain words\n\n- **What you get:** a readable approval.\n- **Steps:** three changes.\n- **Risky or can'"'"'t be undone:** nothing.\n- **Cost and time:** a few hours.\n- **You are approving:** the plain section.\n\n## Units\n\nU1 — first — deps: none — Tier: standard\n  Done: x\nU2 — second — deps: U1 — Tier: hard\nU3 — parked — deps: none — Tier: standard — HELD\n' > "$SD/plq-sq-full-plan.md"
printf '# Plan\n\n**PROBLEM:** a dense paragraph.\n\n**DONE:** it works.\n\nU1 — only — deps: none — Tier: standard\n' > "$SD/plq-sq-old-plan.md"
printf '# Plan\n\nU1 — no tier — deps: none\n' > "$SD/plq-sq-bad-plan.md"
printf '# Findings\n\nFINDINGS-MARKER\n' > "$SD/plq-sq-notes.md"
printf '{"run_id":"pq","status":"running","type":"feature","members":[],"units":[],"waiting_on_you":[{"id":"plan-full","asker":"thinker","blocking":true,"question":"Approve plan: full?","since":"2026-10-08T09:00:00Z"},{"id":"plan-old","asker":"thinker","blocking":true,"question":"Approve plan: old?","since":"2026-10-08T09:00:00Z"},{"id":"plan-bad","asker":"thinker","blocking":true,"question":"Approve plan: bad?","since":"2026-10-08T09:00:00Z"},{"id":"plan-gone","asker":"thinker","blocking":true,"question":"Approve plan: gone?","since":"2026-10-08T09:00:00Z"},{"id":"qdoc","asker":"lead","blocking":false,"question":"Read the findings","doc_path":"%s/squads/plq-sq-notes.md","since":"2026-10-08T09:00:00Z"},{"id":"qnodoc","asker":"lead","blocking":false,"question":"plain","doc_path":"%s/squads/none.md","since":"2026-10-08T09:00:00Z"}]}' "$LBL" "$LBL" > "$SD/plq-sq.json"
board "$LBL" > "$TMP/plq.json"
PQ='.squads[] | select(.topic=="plq-sq") | .questions[]'
jt "plan U1: the id rule links the plan; section lines in order" "$TMP/plq.json" "$PQ | select(.id==\"plan-full\") | .doc.name==\"plq-sq-full-plan.md\" and (.doc.markdown | contains(\"In plain words\")) and .plain_from==\"section\" and ([.plain[].label] == [\"What you get\",\"Steps\",\"Risky or can't be undone\",\"Cost and time\",\"You are approving\"])"
jt "plan U1: facts count steps, hard and start-now (held not counted)" "$TMP/plq.json" "$PQ | select(.id==\"plan-full\") | .facts == {\"steps\":3,\"hard\":1,\"start_now\":1}"
jt "plan U1: a plan without the section gets PROBLEM/DONE" "$TMP/plq.json" "$PQ | select(.id==\"plan-old\") | .plain_from==\"fallback\" and ([.plain[].label]==[\"Problem\",\"Done\"]) and .facts.steps==1"
jt "plan U1: a malformed unit line gives facts null, no error" "$TMP/plq.json" "$PQ | select(.id==\"plan-bad\") | .facts==null and .doc.name==\"plq-sq-bad-plan.md\" and .plain==null and .plain_from==null"
jt "plan U1: a missing plan gives nulls" "$TMP/plq.json" "$PQ | select(.id==\"plan-gone\") | .doc==null and .plain==null and .plain_from==null and .facts==null"
jt "plan U1: a non-plan question links its doc_path, no plain or facts" "$TMP/plq.json" "$PQ | select(.id==\"qdoc\") | .doc.name==\"plq-sq-notes.md\" and (.doc.markdown|contains(\"FINDINGS-MARKER\")) and .plain==null and .plain_from==null and .facts==null"
jt "plan U1: a doc_path with no document is null" "$TMP/plq.json" "$PQ | select(.id==\"qnodoc\") | .doc==null"
jt "plan U1: needs_you items carry the same fields" "$TMP/plq.json" ".needs_you[] | select(.id==\"plan-full\") | .doc.name==\"plq-sq-full-plan.md\" and .plain_from==\"section\" and .facts.steps==3" 
jt "plan U1: needs_you item without a document has nulls" "$TMP/plq.json" ".needs_you[] | select(.id==\"qplain\" or .id==\"qnodoc\") | .doc==null and .plain==null and .facts==null"

# plan-revisions U2: a re-approval question carries the newest revision note and what changed against the saved copy
# (steps with the live state of their unit, other changed parts, parts the note does not cover, the grouped line diff).
printf '# Plan\n\n## In plain words\n\n- **What you get:** x.\n\n## Revisions\n\n### Rev 1 — 2026-11-01 — first\n- **What changed:** nothing.\n- **Why:** none.\n- **Steps touched:** none.\n- **Stays as approved:** all.\n\n## Units\n\nU1 — alpha builder — deps: none — Tier: standard\n  Done: old done\nU2 — beta checker — deps: U1 — Tier: standard\n\n## Risks\n\nold risk line\n' > "$SD/rvq-sq-x-plan.approved.md"
printf '# Plan\n\n## In plain words\n\n- **What you get:** x changed.\n\n## Revisions\n\n### Rev 2 — 2026-11-17 — a fix\n- **What changed:** The alpha builder now does more.\n- **Why:** a bug.\n- **Steps touched:** alpha builder, new gamma tester.\n- **Stays as approved:** the rest.\n\n### Rev 1 — 2026-11-01 — first\n- **What changed:** nothing.\n- **Why:** none.\n- **Steps touched:** none.\n- **Stays as approved:** all.\n\n## Units\n\nU1 — alpha builder — deps: none — Tier: standard\n  Done: new done\nU2 — beta checker — deps: U1 — Tier: standard\nU3 — gamma tester — deps: U2 — Tier: standard\n\n## Risks\n\nnew risk line\n' > "$SD/rvq-sq-x-plan.md"
printf '# Plan\n\n## Revisions\n\n### Rev 2 — 2026-11-17 — fix\n- **What changed:** a.\n- **Why:** b.\n- **Steps touched:** c.\n- **Stays as approved:** d.\n\nU1 — only — deps: none — Tier: standard\n' > "$SD/rvq-sq-y-plan.md"
printf '{"run_id":"rv","status":"running","type":"feature","members":[],"units":[{"slug":"u1-alpha","status":"dispatched","plan":"%s/squads/rvq-sq-x-plan.md","plan_unit":"U1","pr":""}],"waiting_on_you":[{"id":"plan-x","asker":"thinker","blocking":true,"question":"Approve plan: x?","since":"2026-10-08T09:00:00Z"},{"id":"plan-y","asker":"thinker","blocking":true,"question":"Approve plan: y?","since":"2026-10-08T09:00:00Z"}]}' "$LBL" > "$SD/rvq-sq.json"
board "$LBL" > "$TMP/rvq.json"
RQ='.squads[] | select(.topic=="rvq-sq") | .questions[]'
jt "plan rev U2: the revision is the newest note" "$TMP/rvq.json" "$RQ | select(.id==\"plan-x\") | .revision.rev==2 and .revision.date==\"2026-11-17\" and .revision.reason==\"a fix\" and ([.revision.lines[].label]==[\"What changed\",\"Why\",\"Steps touched\",\"Stays as approved\"])"
jt "plan rev U2: steps changed and added, with the unit's state" "$TMP/rvq.json" "$RQ | select(.id==\"plan-x\") | (.changes.steps | map({id,kind,state})) == [{\"id\":\"U1\",\"kind\":\"changed\",\"state\":\"in progress\"},{\"id\":\"U3\",\"kind\":\"added\",\"state\":\"not started\"}]"
jt "plan rev U2: a changed part the note does not name is flagged, a named step is not" "$TMP/rvq.json" "$RQ | select(.id==\"plan-x\") | .changes.sections==[\"Risks\"] and ((.changes.uncovered|map(.name))==[\"Risks\"])"
jt "plan rev U2: the diff is grouped by section, plain words and revisions left out" "$TMP/rvq.json" "$RQ | select(.id==\"plan-x\") | ([.changes.diff[].heading] | index(\"Revisions\") == null and index(\"In plain words\") == null) and (.changes.diff | map(select(.heading==\"Risks\")) | .[0].lines == [{\"t\":\"-\",\"text\":\"old risk line\"},{\"t\":\"+\",\"text\":\"new risk line\"}]) and .changes.truncated==false"
jt "plan rev U2: a re-approval with no saved copy has changes null" "$TMP/rvq.json" "$RQ | select(.id==\"plan-y\") | .revision.rev==2 and .changes==null"
jt "plan rev U2: a plan with no revision has both null" "$TMP/rvq.json" "$PQ | select(.id==\"plan-full\") | .revision==null and .changes==null"
jt "plan rev U2: needs_you items carry revision and changes" "$TMP/rvq.json" ".needs_you[] | select(.id==\"plan-x\" and .squad==\"rvq-sq\") | .revision.rev==2 and (.changes.steps|length)==2"
rm -f "$SD/qpr-sq.json"
# The rendered page: #n in a question links to the PR in a new tab without opening the
# overlay; anything that is not a PR reference stays text.
qp="$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8");
  const html = (s, ...v) => s.map((x, i) => x + (v[i] ?? "")).join("");
  const take = (name) => { const i = h.indexOf("function " + name + "("); return h.slice(i, h.indexOf("\n}", i) + 2); };
  const f = new Function("html", take("linkedQ") + "\nreturn linkedQ;")(html);
  const show = (t, slug) => console.log([].concat(f(t, slug)).join(""));
  show("Is PR #21196 good to merge? Also see PRD-18424 and U7.", "acme/app");
  show("plain one", "acme/app");
  show("Is PR #21196 good?", null);' "$ROOT/web/board.html" 2>&1)"
eq "U87: #n links to the PR in a new tab" "$(printf '%s' "$qp" | sed -n 1p | grep -cF 'href=https://github.com/acme/app/pull/21196 target="_blank"')" "1"
eq "U87: the link stops before the overlay" "$(printf '%s' "$qp" | sed -n 1p | grep -c 'stopPropagation')" "1"
eq "U87: an issue key stays text" "$(printf '%s' "$qp" | sed -n 1p | grep -c 'pull/PRD')" "0"
eq "U87: the unit stays text" "$(printf '%s' "$qp" | sed -n 1p | grep -cF 'and U7.')" "1"
eq "U87: text without a PR ref renders unchanged" "$(printf '%s' "$qp" | sed -n 2p)" 'plain one'
eq "U87: no slug means no links" "$(printf '%s' "$qp" | sed -n 3p)" 'Is PR #21196 good?'
eq "U87: the question chip maps state and stops the overlay" "$(grep -cF 'pr=${{ num: pr.num, status: pr.state, url: pr.url }}' "$ROOT/web/board.html")" "1"
eq "U87: question rows show the PR chip" "$(grep -cF '<${QPr}' "$ROOT/web/board.html")" "5"

# Ported from main (text board + JSON): tiers, suggested answers, stale waiting-on-you.
has(){ if printf '%s' "$2" | grep -F -- "$3" >/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — missing [$3]" >&2; fi; }
printf '%s' '{"status":"running","members":[{"role":"builder","suffix":"p","wt":"wtBp","account":"work","fallback":true}],"units":[{"slug":"c","status":"planned","wait_until":4102444800}]}' > "$SD/acct-text.json"
HOSTST="$TMP/st" tb "$LBL" --topic acct-text > "$TMP/acc.txt"
rm -f "$SD/acct-text.json"
has "text board: accounts strip"          "$(cat "$TMP/acc.txt")" "ACCOUNTS  system 72%"
has "text board: member account"          "$(cat "$TMP/acc.txt")" "@work (fallback)"
eq "text board: old capacity wait is absent" "$(grep -c "waiting · resets" "$TMP/acc.txt" || true)" "0"
lines(){ if printf '%s\n' "$2" | grep -xF -- "$3" >/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — no exact line [$3]" >&2; fi; }

# A stored waiting-on-you with an EMPTY queue (state written before resolve-question reset it)
# is not waiting on anyone: show the derived running status instead.
printf '{"run_id":"s1","status":"waiting-on-you","type":"feature","members":[],"waiting_on_you":[],"units":[{"slug":"x","status":"dispatched","builder_wt":"wb"}]}' > "$SD/stale-wait.json"
board "$LBL" > "$TMP/stale.json"
jt "waiting-on-you with no question shows implementing" "$TMP/stale.json" '.squads[] | select(.topic=="stale-wait") | .display_status == "implementing"'
rm -f "$SD/stale-wait.json"

# Builder tier: a tagged unit shows std / hard / hard↑ plus ·<model> from its Builder member
# (role builder, suffix == unit slug); an untagged unit shows hard? plus ·<model> when a
# Builder exists, so a unit that silently fell to hard can be seen.
printf '{"run_id":"t1","status":"running","type":"feature","members":[{"role":"builder","suffix":"u1","wt":"wtLead","model":"sonnet"},{"role":"builder","suffix":"u2","wt":"wtBp","model":"opus"},{"role":"builder","suffix":"u4","wt":"wtU4","model":"opus"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtLead","tier":"standard"},{"slug":"u2","status":"dispatched","builder_wt":"wtBp","tier":"hard","escalated":true},{"slug":"u3","status":"done","tier":"hard"},{"slug":"u4","status":"done"},{"slug":"u5","status":"planned"}]}' > "$SD/tier-sq.json"
board "$LBL" > "$TMP/tier.json"
T='.squads[] | select(.topic=="tier-sq") | .units'
jt "json: standard unit tier std·sonnet"   "$TMP/tier.json" "$T"' | .[0].tier == "std·sonnet"'
jt "json: escalated unit tier hard↑·opus"  "$TMP/tier.json" "$T"' | .[1].tier == "hard↑·opus"'
jt "json: hard unit without Builder omits model" "$TMP/tier.json" "$T"' | .[2].tier == "hard"'
jt "json: untagged unit with Builder shows hard?·opus" "$TMP/tier.json" "$T"' | .[3].tier == "hard?·opus"'
jt "json: untagged unit without Builder shows hard?" "$TMP/tier.json" "$T"' | .[4].tier == "hard?"'
TT="$(tb "$LBL" 2>/dev/null)"
# Units are a table: a header row, then glyph · unit · tier · spent · state in aligned columns.
has "text: units table header"                   "$TT" 'UNIT TIER'
hasre(){ if printf '%s\n' "$2" | grep -E -- "$3" >/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — no match for [$3]" >&2; fi; }
hasre "text: standard unit line shows std·sonnet"  "$TT" '⟳ u1 +std·sonnet'
has "text: unit state is its own column"         "$TT" '(building)'
hasre "text: escalated unit line shows hard↑·opus" "$TT" '⟳ u2 +hard↑·opus'
has "text: untagged done line"                   "$TT" '✓ u4'
hasre "text: untagged unit with Builder shows hard?·opus" "$TT" '✓ u4 +hard\?·opus'
hasre "text: untagged unit without Builder shows hard?" "$TT" '○ u5 +hard\?'
has "text: untagged planned line"                "$TT" '(planned — no builder yet)'
eq "web board: untagged tier hover explains read-as-hard" "$(grep -cF 'no tier recorded — read as hard' "$ROOT/web/board.html")" "1"
rm -f "$SD/tier-sq.json"

# Real model + account (board-crew-models U1): configured = the members row; real = the live worker's
# account + the newest transcript's model (only while the account is known; <synthetic> is skipped).
mkdir -p "$TMP/st-real"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nclaude\ta\t-\t-\t-\t-\t-\t%s\ta@example.com\nclaude\tb\t-\t-\t-\t-\t-\t%s\tb@example.com\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\tMuse\n' "$NOW" "$NOW" "$NOW" > "$TMP/st-real/accounts.tsv"
printf '{"run_id":"r1","status":"running","type":"feature","members":[{"role":"lead","suffix":"","wt":"wR1","agent":"claude","model":"opus","account":"a"},{"role":"builder","suffix":"u1","wt":"wR2","agent":"muse","model":"muse-wonder-1.0","account":"default"},{"role":"thinker","suffix":"","wt":"wR3","agent":"claude","model":"sonnet","account":"a"},{"role":"tester","suffix":"","wt":"wR4","agent":"muse","model":"muse-wonder-1.0","account":"default"},{"role":"researcher","suffix":"","wt":"wR5","agent":"claude","model":"opus","account":"a"},{"role":"reviewer","suffix":"","wt":"wR6","agent":"claude","model":"opus","account":"a","status":"gone"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wR2","tier":"standard"}]}' > "$SD/real-sq.json"
cat > "$TMP/seed-real.json" <<'JSON'
{"workers":[["wR1","working","l","a"],["wR2","working","b","b"],["wR3","idle","t",null],["wR4","idle","te",null],["wR5","idle","r","a"],["wR6","idle","rv","a"]],
 "worktrees":[["wR1",null],["wR2",null]], "gone_members":["wR6"],
 "transcripts":[["wR1","claude-opus-5-5"],["wR2","claude-sonnet-5-5"],["wR4","claude-sonnet-5-5"],["wR5","claude-opus-5-5"],["wR5","<synthetic>"]]}
JSON
HOSTST="$TMP/st-real" SEED="$TMP/seed-real.json" board "$LBL" > "$TMP/real.json"
R='.squads[] | select(.topic=="real-sq")'
jt "real: alias matches its family, no flag"   "$TMP/real.json" "$R | .members[] | select(.role==\"lead\") | .model==\"opus\" and .model_real==\"claude-opus-5-5\" and .model_label==\"opus-5.5\" and .model_mismatch==false and .account_mismatch==false and .account_real==\"a\""
jt "real: a muse transcript is not its model, its account still flags" "$TMP/real.json" "$R | .members[] | select(.role==\"builder\") | .model_real==null and .model_label==\"muse-wonder-1.0\" and .account_real==\"b\" and .account_real_label==\"b@example.com\" and .model_mismatch==false and .account_mismatch"
jt "real: no transcript shows configured, no flag" "$TMP/real.json" "$R | .members[] | select(.role==\"thinker\") | .model_real==null and .model_label==\"sonnet\" and .model_mismatch==false"
jt "real: NULL worker account -> stale transcript ignored" "$TMP/real.json" "$R | .members[] | select(.role==\"tester\") | .model_real==null and .account_real==null and .model_mismatch==false and .account_mismatch==false"
jt "real: a <synthetic> row is unknown, not a model" "$TMP/real.json" "$R | .members[] | select(.role==\"researcher\") | .model_real==null and .model_label==\"opus\" and .model_mismatch==false"
jt "real: unit tier carries the configured model" "$TMP/real.json" "$R | .units[0] | .tier==\"std·muse-wonder-1.0\""
jt "real: unit builder object"                 "$TMP/real.json" "$R | .units[0].builder | .model_real==null and .model_mismatch==false"
jt "real: account users_count (gone + wt-less not counted, muse member lands on b)" "$TMP/real.json" ".accounts | (map(select(.account==\"a\"))[0].users_count==3) and (map(select(.account==\"b\"))[0].users_count==1)"
jt "real: account users entry"                 "$TMP/real.json" ".accounts[] | select(.account==\"b\") | .users[0] | .squad==\"real-sq\" and .role==\"builder\" and .model_label==\"muse-wonder-1.0\" and .mismatch"
TR="$(HOSTST="$TMP/st-real" SEED="$TMP/seed-real.json" tb "$LBL" 2>/dev/null)"
has "text real: mismatch crew line"            "$TR" '⚠ configured muse-wonder-1.0@default'
has "text real: accounts strip counts roles"   "$TR" '· 1 roles'
# U3: the single-project board counts only its own project's roles (users_other = the rest); the
# all-projects board keeps both. A user carries its Crew row's state + ctx_level.
LBL2="zzboard2_$$"; mkdir -p "$DS_STATE_ROOT/$LBL2/squads"
printf '{"run_id":"r2","status":"running","type":"feature","members":[{"role":"builder","suffix":"x1","wt":"wO1","agent":"claude","model":"sonnet","account":"b"}],"units":[]}' > "$DS_STATE_ROOT/$LBL2/squads/other-sq.json"
jq '.workers += [["wO1","working","o","b"]] | .transcripts += [["wO1","claude-sonnet-5-5"]]' "$TMP/seed-real.json" > "$TMP/seed-real2.json"
HOSTST="$TMP/st-real" SEED="$TMP/seed-real2.json" mkdb "$LBL" "$LBL2"; render "$LBL" --json > "$TMP/real1.json"; render --json > "$TMP/realall.json"
jt "U3: one project: b counts only its roles, users_other 1" "$TMP/real1.json" ".accounts[] | select(.account==\"b\") | .users_count==1 and (.users|length)==1 and .users_other==1" ".accounts"
jt "U3: all projects: b counts both, users_other 0" "$TMP/realall.json" ".accounts[] | select(.account==\"b\") | .users_count==2 and .users_other==0"
jt "U3: user carries state and ctx_level" "$TMP/real1.json" ".accounts[] | select(.account==\"b\") | .users[0] | has(\"state\") and has(\"ctx_level\") and .state==\"working\""
T3="$(render "$LBL" 2>/dev/null)"
has "U3 text: accounts strip counts the filtered roles" "$T3" '· 1 roles'
rm -rf "${DS_STATE_ROOT:?}/$LBL2"
# U2: the page's users-grouping helper, lifted out (the new Function pattern), over the fixture's account users.
gu="$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8"), i = h.indexOf("function groupUsers(");
  const groupUsers = new Function(h.slice(i, h.indexOf("\n}\n", i) + 2) + "return groupUsers;")();
  const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), b = d.accounts.find((a) => a.account === "b");
  const g = groupUsers(b.users, d.project), x = groupUsers(b.users, "other-project");
  console.log(g.roles, g.squads, g.mismatches, g.groups[0].squad, g.groups[0].items[0].role, g.groups[0].items[0].state, "|", x.groups[0].squad);' "$ROOT/web/board.html" "$TMP/real.json" 2>&1)"
eq "web: users grouped by squad with the project prefix rule" "$gu" "1 1 1 real-sq builder-u1 working | $LBL/real-sq"
ga="$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8"), i = h.indexOf("function groupUsers(");
  const groupUsers = new Function(h.slice(i, h.indexOf("\n}\n", i) + 2) + "return groupUsers;")();
  const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), g = groupUsers(d.accounts.find((a) => a.account === "a").users, d.project);
  console.log(g.groups.length, g.groups[0].items.length, g.groups[0].items.map((x) => x.state + ":" + x.ctx_level).join(","));' "$ROOT/web/board.html" "$TMP/real.json" 2>&1)"
eq "web: one squad group holds every role row (squad shown once, on its first row)" "$ga" "1 3 working:,idle:,idle:"
eq "web: account row is a keyboard-toggle button with aria-expanded" "$(grep -c 'aria-expanded=${can ? isOpen' "$ROOT/web/board.html")" "1"
eq "web: mismatch badge has title and aria-label" "$(grep -c 'title=${t} aria-label=${t}' "$ROOT/web/board.html")" "1"
# U105: the crew line shows a member's effort (real from a Claude transcript's perTurnEffort, else the
# configured one) and a Builder's loop phase. Real high = configured high: `high`, no ⚠; real medium
# against configured low: `medium ⚠low`; a Muse member shows its configured effort, no ⚠; a member with
# neither shows no effort; a Builder reads its members.phase (NULL = build), a Lead shows none.
mkdir -p "$TMP/st-eff"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nclaude\ta\t-\t-\t-\t-\t-\t%s\ta@example.com\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\tMuse\n' "$NOW" "$NOW" > "$TMP/st-eff/accounts.tsv"
printf '{"run_id":"re","status":"running","type":"feature","members":[{"role":"lead","suffix":"","wt":"wF1","agent":"claude","model":"opus","effort":"high","account":"a"},{"role":"thinker","suffix":"","wt":"wF2","agent":"claude","model":"sonnet","effort":"low","account":"a"},{"role":"researcher","suffix":"","wt":"wF3","agent":"muse","model":"muse-wonder-1.0","effort":"medium","account":"default"},{"role":"tester","suffix":"","wt":"wF4","agent":"claude","model":"sonnet","account":"a"},{"role":"builder","suffix":"u1","wt":"wF5","agent":"claude","model":"sonnet","effort":"medium","account":"a"},{"role":"builder","suffix":"u2","wt":"wF6","agent":"muse","model":"muse-wonder-1.0","account":"default"}],"units":[]}' > "$SD/eff-sq.json"
cat > "$TMP/seed-eff.json" <<'JSON'
{"workers":[["wF1","working","l","a"],["wF2","idle","t","a"],["wF3","idle","r","default"],["wF4","idle","te","a"],["wF5","working","b5","a",null,null],["wF6","working","b6","default",null,[["claude","opus","a","xhigh"]]]],
 "worktrees":[["wF1",null]], "phases":{"wF5":"babysit","wF6":null},
 "transcripts":[["wF1","claude-opus-5-5","cli","high"],["wF2","claude-sonnet-5-5","cli","medium"],["wF4","claude-sonnet-5-5","cli",null],["wF5","claude-sonnet-5-5","cli","medium"]]}
JSON
HOSTST="$TMP/st-eff" SEED="$TMP/seed-eff.json" board "$LBL" > "$TMP/eff.json"
F='.squads[] | select(.topic=="eff-sq") | .members'
jt "U105: real = configured shows the value, no warning" "$TMP/eff.json" "$F"' | .[0] | .effort_label=="high" and .effort_real=="high" and .effort=="high" and .effort_mismatch==false'
jt "U105: real medium against configured low shows medium ⚠low" "$TMP/eff.json" "$F"' | .[1] | .effort_label=="medium ⚠low" and .effort_mismatch==true'
jt "U105: a Muse member shows its configured effort, no warning" "$TMP/eff.json" "$F"' | .[2] | .effort_label=="medium" and .effort_real==null and .effort_mismatch==false'
jt "U105: a member with neither shows no effort" "$TMP/eff.json" "$F"' | .[3] | .effort_label==null and .effort_mismatch==false'
jt "U105: a Builder with phase babysit shows babysit" "$TMP/eff.json" "$F"' | .[4] | .phase=="babysit"'
jt "U105: a Builder with a NULL phase shows build" "$TMP/eff.json" "$F"' | .[5] | .phase=="build"'
jt "U105: a Lead shows no phase" "$TMP/eff.json" "$F"' | .[0].phase==null and .[1].phase==null'
jt "U105: a review sub-agent carries its effort" "$TMP/eff.json" "$F"' | .[5].subs[0].effort=="xhigh"'
jt "accounts: Builder carries phase and configured effort" "$TMP/eff.json" '.accounts[].users[] | select(.label=="builder-u1" and .sub==false) | .phase=="babysit" and .effort=="medium" and .effort_label=="medium"'
jt "accounts: effort mismatch matches crew" "$TMP/eff.json" '.accounts[].users[] | select(.role=="thinker") | .effort_label=="medium ⚠low" and .effort_mismatch==true and .effort_real=="medium" and .effort=="low"'
jt "accounts: sub has its own effort" "$TMP/eff.json" '.accounts[].users[] | select(.sub==true) | .effort_label=="xhigh" and .effort=="xhigh" and .effort_mismatch==false and .phase=="build"'
jt "accounts: non-Claude configured effort survives" "$TMP/eff.json" '.accounts[].users[] | select(.role=="researcher") | .effort_label=="medium" and .effort_mismatch==false'
jt "accounts: unknown effort stays empty" "$TMP/eff.json" '.accounts[].users[] | select(.role=="tester") | .effort_label==null'
TE="$(HOSTST="$TMP/st-eff" SEED="$TMP/seed-eff.json" tb "$LBL" 2>/dev/null)"
has "U105 text: model, effort and phase in order" "$TE" 'sonnet-5.5 · medium · babysit'
has "U105 text: a mismatch reads medium ⚠low" "$TE" 'sonnet-5.5 · medium ⚠low'
has "U105 text: a sub chip shows its effort" "$TE" '+ sub: opus · xhigh'
rm -f "$SD/eff-sq.json"

# U90: a worker shows every agent it runs — a muse Builder with a live `claude -p` review
# sub-agent shows the main agent as today plus a chip per sub, no mismatch, and lands on both
# accounts (the sub marked sub). The sub's opus transcript is not read as the member's model.
mkdir -p "$TMP/st-sub"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\tMuse\nclaude\tc\t10\t-\t5\t-\t-\t%s\tc@example.com\n' "$NOW" "$NOW" > "$TMP/st-sub/accounts.tsv"
printf '{"run_id":"rsub","status":"running","type":"feature","members":[{"role":"builder","suffix":"u9","wt":"wS9","agent":"muse","model":"muse-spark-1.3","account":"default"},{"role":"builder","suffix":"u9b","wt":"wS9b","agent":"muse","model":"muse-spark-1.3","account":"default"}],"units":[]}' > "$SD/sub-sq.json"
cat > "$TMP/seed-sub.json" <<'JSON'
{"workers":[["wS9","working","b9","default",null,[["claude","opus","c"]]],["wS9b","working","b9b","default"]],
 "worktrees":[["wS9",null],["wS9b",null]],
 "transcripts":[["wS9","claude-opus-5-5"],["wS9b","claude-opus-5-5"]]}
JSON
HOSTST="$TMP/st-sub" SEED="$TMP/seed-sub.json" board "$LBL" > "$TMP/sub.json"
U='.squads[] | select(.topic=="sub-sq") | .members[0]'
jt "U90: sub chip beside the main agent, no mismatch" "$TMP/sub.json" "$U | (.subs|length)==1 and .subs[0].model==\"opus\" and .subs[0].model_label==\"opus\" and .subs[0].account==\"c\" and .model_real==null and .model_mismatch==false and .account_mismatch==false and .account_real==\"default\""
jt "U90: worker on both accounts, the sub marked sub" "$TMP/sub.json" '.accounts[] | select(.account=="c") | .users_count==1 and .users[0].sub==true and .users[0].model_label=="opus" and .users[0].squad=="sub-sq"'
jt "U90: main row stays on its own account, not marked sub" "$TMP/sub.json" '.accounts[] | select(.account=="default") | .users_count==2 and (.users|map(select(.sub==false))|length)==2'
jt "U90: stale claude transcript on a sub-less muse worker is not its model" "$TMP/sub.json" '.squads[] | select(.topic=="sub-sq") | .members[] | select(.wt=="wS9b") | .subs==[] and .model_real==null and .model_mismatch==false and .account_mismatch==false'
TSUB="$(HOSTST="$TMP/st-sub" SEED="$TMP/seed-sub.json" tb "$LBL" 2>/dev/null)"
has "U90 text: sub chip on the member line" "$TSUB" '+ sub: opus @c@example.com'
SUBLINE="$(printf '%s\n' "$TSUB" | grep -F 'builder-u9' || true)"
eq "U90 text: no mismatch flag on a worker with a sub" "0" "$(printf '%s' "$SUBLINE" | grep -c '⚠' || true)"
rm -f "$SD/sub-sq.json" "$SD/real-sq.json"
# U98: a Claude Builder's review shows as a sub-agent, not as its model — while its headless
# `claude -p` reviewer runs, the observer keeps the member's own cli transcript row (never the
# reviewer's sdk-cli one), so the row keeps its own model with a sub chip and no mismatch. A
# member whose only transcript is headless keeps the configured label, never the reviewer's.
printf '{"run_id":"r98","status":"running","type":"feature","members":[{"role":"builder","suffix":"u98","wt":"wS98","agent":"claude","model":"sonnet","account":"c"},{"role":"builder","suffix":"u98b","wt":"wS98b","agent":"claude","model":"sonnet","account":"c"}],"units":[]}' > "$SD/u98-sq.json"
cat > "$TMP/seed-u98.json" <<'JSON'
{"workers":[["wS98","working","b98","c",null,[["claude","opus","c"]]],["wS98b","working","b98b","c"]],
 "worktrees":[["wS98",null],["wS98b",null]],
 "transcripts":[["wS98","claude-sonnet-5-5","cli"],["wS98b","claude-opus-5-5","sdk-cli"]]}
JSON
HOSTST="$TMP/st-sub" SEED="$TMP/seed-u98.json" board "$LBL" > "$TMP/u98.json"
U98='.squads[] | select(.topic=="u98-sq") | .members[0]'
jt "U98: the member's own cli transcript is its model" "$TMP/u98.json" "$U98 | .model_real==\"claude-sonnet-5-5\" and .model_label==\"sonnet-5.5\" and .model_mismatch==false and .account_mismatch==false"
jt "U98: the opus review shows as a sub chip" "$TMP/u98.json" "$U98 | (.subs|length)==1 and .subs[0].model==\"opus\" and .subs[0].model_label==\"opus\" and .subs[0].account==\"c\""
jt "U98: a headless-only transcript never reads as the member's model" "$TMP/u98.json" '.squads[] | select(.topic=="u98-sq") | .members[1] | .model_real==null and .model_label=="sonnet" and .model_mismatch==false and .subs==[]'
T98="$(HOSTST="$TMP/st-sub" SEED="$TMP/seed-u98.json" tb "$LBL" 2>/dev/null)"
has "U98 text: sub chip on the Claude member line" "$T98" '+ sub: opus @c@example.com'
N98="$(printf '%s\n' "$T98" | grep -F 'builder-u98' || true)"
eq "U98 text: the member's own model, no mismatch flag" "0" "$(printf '%s' "$N98" | grep -c '⚠' || true)"
has "U98 text: the member line shows its own model" "$N98" 'sonnet-5.5'
rm -f "$SD/u98-sq.json"
# U98 (Thinker extra case): a Muse Builder's detached `claude -p` reviewer is a sub line on
# system, so the member keeps its Muse account with a sub chip and no account mismatch.
mkdir -p "$TMP/st-u98m"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\tMuse\nclaude\tsystem\t-\t-\t-\t-\t-\t%s\tsystem\n' "$NOW" "$NOW" > "$TMP/st-u98m/accounts.tsv"
printf '{"run_id":"r98m","status":"running","type":"feature","members":[{"role":"builder","suffix":"u9d","wt":"wS9d","agent":"muse","model":"muse-spark-1.3","account":"default"}],"units":[]}' > "$SD/u98m-sq.json"
cat > "$TMP/seed-u98m.json" <<'JSON'
{"workers":[["wS9d","working","b9d","default",null,[["claude","opus","system"]]]],
 "worktrees":[["wS9d",null]],
 "transcripts":[["wS9d","claude-opus-5-5","sdk-cli"]]}
JSON
HOSTST="$TMP/st-u98m" SEED="$TMP/seed-u98m.json" board "$LBL" > "$TMP/u98m.json"
UM='.squads[] | select(.topic=="u98m-sq") | .members[0]'
jt "U98: detached reviewer keeps the Muse account, sub chip, no mismatch" "$TMP/u98m.json" "$UM | .account==\"default\" and .account_real==\"default\" and .account_mismatch==false and .model_mismatch==false and (.subs|length)==1 and .subs[0].model==\"opus\" and .subs[0].account==\"system\""
T98M="$(HOSTST="$TMP/st-u98m" SEED="$TMP/seed-u98m.json" tb "$LBL" 2>/dev/null)"
has "U98 text: detached review shows as a system sub chip" "$T98M" '+ sub: opus @system'
M98="$(printf '%s\n' "$T98M" | grep -F 'builder-u9d' || true)"
eq "U98 text: no mismatch flag on the Muse member line" "0" "$(printf '%s' "$M98" | grep -c '⚠' || true)"
rm -f "$SD/u98m-sq.json"

# A question with a suggested answer carries it (text + JSON + inbox); q8 has neither field
# (old state) and must still render beside it.
printf '{"run_id":"sg","status":"running","type":"feature","members":[],"units":[],"waiting_on_you":[{"id":"q9","asker":"lead","blocking":true,"question":"Use v2 API?","suggestion":"yes","why":"v1 is deprecated","since":"2026-10-08T09:00:00Z"},{"id":"q8","asker":"lead","blocking":false,"question":"a blocking decision","since":"2026-10-08T09:00:00Z"}]}' > "$SD/sugg-sq.json"
board "$LBL" > "$TMP/sugg.json"
jt "json: question carries suggestion + why" "$TMP/sugg.json" '.squads[] | select(.topic=="sugg-sq") | .questions[0] | .suggestion == "yes" and .why == "v1 is deprecated"'
jt "json: old question has null suggestion"  "$TMP/sugg.json" '.squads[] | select(.topic=="sugg-sq") | .questions[1] | .suggestion == null and .question == "a blocking decision"'
jt "json: inbox card carries suggestion"     "$TMP/sugg.json" 'any(.needs_you[]; .squad == "sugg-sq" and .suggestion == "yes" and .why == "v1 is deprecated")'
ST="$(tb "$LBL" 2>/dev/null)"
has "text shows suggestion + why"         "$ST" "suggested: yes — v1 is deprecated"
has "text still renders the old question" "$ST" "a blocking decision"
rm -f "$SD/sugg-sq.json"

# A structured question (title + choices) next to an old one: the old one gets a title from its
# first sentence and choices from its options (or its suggestion), so the overlay renders both.
printf '%s' '{"run_id":"st","status":"running","type":"feature","members":[],"units":[],"waiting_on_you":[
 {"id":"n1","asker":"thinker","blocking":true,"title":"Let readers see multisig wallets?","question":"Issuer gets 404.","suggestion":"Fix now","why":"wrong 404","options":["Fix now","Drop"],"choices":[{"label":"Fix now","does":"widen reads"},{"label":"Drop","does":"file a ticket"}],"since":"2026-10-08T09:00:00Z"},
 {"id":"o1","asker":"lead","blocking":false,"question":"PR3 is blocked on a decision. Brief is written: x.md; more text","options":["A","B"],"since":"2026-10-08T09:00:00Z"},
 {"id":"o2","asker":"lead","blocking":false,"question":"go?","suggestion":"go","since":"2026-10-08T09:00:00Z"},
 {"id":"o3","asker":"lead","blocking":false,"question":"'"$(printf 'word %.0s' {1..40})"'","since":"2026-10-08T09:00:00Z"}]}' > "$SD/struct-sq.json"
board "$LBL" > "$TMP/st.json"; Q='.squads[] | select(.topic=="struct-sq") | .questions[]'
jt "json: structured title kept"          "$TMP/st.json" "[$Q | select(.id==\"n1\")][0] | .title == \"Let readers see multisig wallets?\" and .titled"
jt "json: structured choices kept"        "$TMP/st.json" "[$Q | select(.id==\"n1\")][0].choices[1] == {\"label\":\"Drop\",\"does\":\"file a ticket\"}"
jt "json: old title = first sentence"     "$TMP/st.json" "[$Q | select(.id==\"o1\")][0] | .title == \"PR3 is blocked on a decision.\" and (.titled | not)"
jt "json: old choices from options"       "$TMP/st.json" "[$Q | select(.id==\"o1\")][0].choices == [{\"label\":\"A\",\"does\":null},{\"label\":\"B\",\"does\":null}]"
jt "json: old choices from suggestion"    "$TMP/st.json" "[$Q | select(.id==\"o2\")][0].choices == [{\"label\":\"go\",\"does\":null}]"
jt "json: long old title is cut"          "$TMP/st.json" "[$Q | select(.id==\"o3\")][0].title | length <= 81 and endswith(\"…\")"
jt "json: inbox carries title + choices"  "$TMP/st.json" 'any(.needs_you[]; .id == "n1" and .title == "Let readers see multisig wallets?" and (.choices | length) == 2)'
ST="$(tb "$LBL" 2>/dev/null)"
has "text shows the title"                "$ST" "thinker: Let readers see multisig wallets?"
rm -f "$SD/struct-sq.json"

# Usage limit: the loop lists stuck-on-limit agents in sweep/limited.json; the board flags the
# member and the squad. A file older than 10 min (loop not refreshing) is ignored, not trusted.
mkdir -p "$DS_STATE_ROOT/$LBL/loop"; LS='.squads[] | select(.topic=="lim-sq")'
printf '{"run_id":"l1","status":"running","type":"feature","members":[{"role":"lead","wt":"wtLead"},{"role":"builder","suffix":"platform","wt":"wtBp"}],"units":[]}' > "$SD/lim-sq.json"
printf '[{"wt":"wtBp","who":"builder-platform","topic":"lim-sq","line":"5-hour limit reached ∙ resets 3pm","since":1792144800}]' > "$DS_STATE_ROOT/$LBL/loop/limited.json"
board "$LBL" > "$TMP/lim.json"
jt "limit: member flagged"     "$TMP/lim.json" "$LS"' | .members[] | select(.wt=="wtBp") | .limited.line == "5-hour limit reached ∙ resets 3pm"'
jt "limit: others not flagged" "$TMP/lim.json" "$LS"' | [.members[] | select(.wt!="wtBp") | .limited] | all(. == null)'
jt "limit: squad lists it"     "$TMP/lim.json" "$LS"' | .limited == ["builder-platform"]'
has "limit: text board says so" "$(tb "$LBL" 2>/dev/null)" "usage limit: builder-platform — 5-hour limit reached ∙ resets 3pm"
touch -t "$(date -v-15M +%Y%m%d%H%M 2>/dev/null || date -d "-15 min" +%Y%m%d%H%M)" "$DS_STATE_ROOT/$LBL/loop/limited.json"
board "$LBL" > "$TMP/lim2.json"
jt "limit: stale file ignored" "$TMP/lim2.json" "$LS"' | .limited == [] and ([.members[].limited] | all(. == null))'
# Old capacity waits never become labels; the existing at-limit indication remains.
WU=$(( $(date +%s) + 3600 ))
printf '{"run_id":"l1","status":"running","type":"feature","members":[{"role":"lead","wt":"wtLead"},{"role":"builder","suffix":"platform","wt":"wtBp"}],"units":[{"slug":"platform","status":"dispatched","builder_wt":"wtBp","wait_until":%s}]}' "$WU" > "$SD/lim-sq.json"
printf '[{"wt":"wtBp","who":"builder-platform","topic":"lim-sq","line":"5-hour limit reached","since":1792144800,"wait_until":%s}]' "$WU" > "$DS_STATE_ROOT/$LBL/loop/limited.json"
board "$LBL" > "$TMP/lim3.json"
jt "limit: old wait keeps the at-limit indication without a capacity label" "$TMP/lim3.json" "$LS"' | .members[] | select(.wt=="wtBp") | .limited.line == "5-hour limit reached" and .limited.wait_label == null and .limited.wait_until == null'
jt "limit: old unit wait has no capacity deadline or label" "$TMP/lim3.json" "$LS"' | .units[0].wait_until == null and .units[0].wait_label == null and .units[0].state != "waiting"'
eq "limit: rendered text has no capacity wait" "$(tb "$LBL" 2>/dev/null | grep -c "parked · resets" || true)" "0"
has "limit: rendered text retains usage limit" "$(tb "$LBL" 2>/dev/null)" "usage limit: builder-platform"
rm -rf "$DS_STATE_ROOT/$LBL/loop" "$SD/lim-sq.json"

# Per-worker token spend: the loop's --by-worker file (DS_TOKENS_FILE) joins onto members by worktree path.
TK="$TMP/tok"; mkdir -p "$TK"
WP="$TMP/wtpath/ds-tok-lead-toksq"
WF="$(printf '%s' "$WP" | tr -c 'A-Za-z0-9' '-')"   # like Claude Code: the leading / becomes the one leading dash
mkdir -p "$TK/$WF"
NOWU="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "{\"type\":\"user\",\"message\":{\"content\":\"You are the lead of squad \\\"toksq\\\".\"},\"timestamp\":\"$NOWU\"}" > "$TK/$WF/s.jsonl"
jq -cn --arg ts "$NOWU" '{type:"assistant",timestamp:$ts,message:{id:"t1",model:"claude-opus-5-5",usage:{input_tokens:10,cache_creation_input_tokens:2000,cache_read_input_tokens:5000,output_tokens:3}}}' >> "$TK/$WF/s.jsonl"
printf '{"run_id":"tok1","status":"running","members":[{"role":"lead","wt":"u9::%s"},{"role":"builder","wt":"wtGone"}],"units":[]}' "$WP" > "$SD/tok-sq.json"
"$ROOT/bin/lib/token-usage.sh" --by-worker --dir "$TK" > "$TMP/tokens.tsv"   # what the loop writes
tokboard(){ DS_TOKENS_FILE="$TMP/tokens.tsv" tb "$LBL" "$@"; }
tokboard --json > "$TMP/tok.json"
T='.squads[] | select(.topic=="tok-sq")'
jt "tokens: member with logs gets spend" "$TMP/tok.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .tokens.cache_write == 2000'
jt "tokens: topic from boot prompt" "$TMP/tok.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .tokens.topic == "toksq"'
jt "tokens: ctx from the last turn" "$TMP/tok.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .tokens.ctx == 7010'
jt "tokens: member without logs is null" "$TMP/tok.json" "$T"' | .members[] | select(.wt == "wtGone") | .tokens == null'
has "tokens: text board shows context now" "$(tokboard 2>/dev/null)" "context 7k"
jt "tokens: member spent is price-weighted" "$TMP/tok.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .tokens.spent == 2775 and .ctx_level == "ok"'
# A worker with several rows (restart / model switch + a <synthetic> 0 row) shows the SUM, not the last row.
head -1 "$TMP/tokens.tsv" > "$TMP/tokens-multi.tsv"
WK="$(printf '%s' "$WP" | tr -c 'A-Za-z0-9' '-')"
for r in "opus 5 0 1000 100" "sonnet 9 0 500 50" "<synthetic> 1 0 0 0"; do
  # shellcheck disable=SC2086
  set -- $r
  printf '%s\ttoksq\tlead\t%s\t%s\t0\t%s\t%s\t0\n' "$WK" "$1" "$2" "$4" "$5" >> "$TMP/tokens-multi.tsv"
done
DS_TOKENS_FILE="$TMP/tokens-multi.tsv" tb "$LBL" --json > "$TMP/tokm.json"
jt "tokens: several rows are summed" "$TMP/tokm.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .tokens.cache_write == 1500 and .tokens.turns == 14 and .tokens.model == "sonnet"'
jt "tokens: a file without the ctx column -> ctx null" "$TMP/tokm.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .tokens.ctx == null'
# A finished Builder (unit done, no member row) still shows its tokens on the unit and in the builders total.
BP="$TMP/wtpath/ds-tok-builder-U1"
BK="$(printf '%s' "$BP" | tr -c 'A-Za-z0-9' '-')"
head -1 "$TMP/tokens.tsv" > "$TMP/tokens-unit.tsv"
printf '%s\ttoksq\tlead\topus\t5\t0\t1000\t100\t0\n%s\ttoksq\tbuilder\tsonnet\t7\t0\t4000\t100\t0\n' "$WK" "$BK" >> "$TMP/tokens-unit.tsv"
printf '{"run_id":"tok2","status":"running","members":[{"role":"lead","wt":"u9::%s"}],"units":[{"slug":"U1","status":"done","builder_wt":"b1::%s"}]}' "$WP" "$BP" > "$SD/tok-sq.json"
DS_TOKENS_FILE="$TMP/tokens-unit.tsv" tb "$LBL" --json > "$TMP/toku.json"
jt "tokens: done unit w/o member row has tokens" "$TMP/toku.json" "$T"' | .units[] | select(.slug=="U1") | .tokens.cache_write == 4000 and .tokens.turns == 7'
jt "tokens: role split sums its rows" "$TMP/toku.json" "$T"' | .role_tokens == {"lead":1255,"thinker":0,"builders":5010,"review":0,"other":0}'
has "tokens: text board role line" "$(DS_TOKENS_FILE="$TMP/tokens-unit.tsv" tb "$LBL" 2>/dev/null)" "builders (all units) ≈5k"
jt "tokens: unit total sums the unit rows" "$TMP/toku.json" "$T"' | .unit_tokens == {"spent":5010,"units":1}'
has "tokens: text board units total" "$(DS_TOKENS_FILE="$TMP/tokens-unit.tsv" tb "$LBL" 2>/dev/null)" "spent ≈5k over 1 units (7 days)"
# U102: a Builder's `<worker>:review` row is its own line: role_tokens.review, the unit's review_tokens, and the unit total.
cp "$TMP/tokens-unit.tsv" "$TMP/tokens-rev.tsv"
printf '%s:review\ttoksq\treview\tsonnet\t3\t0\t100\t0\t0\n' "$BK" >> "$TMP/tokens-rev.tsv"
DS_TOKENS_FILE="$TMP/tokens-rev.tsv" tb "$LBL" --json > "$TMP/tokr.json"
jt "tokens: review row is its own role line" "$TMP/tokr.json" "$T"' | .role_tokens.review == 125 and .role_tokens.builders == 5010'
jt "tokens: unit shows review_tokens and counts them in the total" "$TMP/tokr.json" "$T"' | (.units[] | select(.slug=="U1") | .review_tokens.spent == 125) and .unit_tokens.spent == 5135'
awk -F'\t' -v k="$BK" '$1 != k' "$TMP/tokens-rev.tsv" > "$TMP/tokens-review-only.tsv"
DS_TOKENS_FILE="$TMP/tokens-review-only.tsv" tb "$LBL" --json > "$TMP/tokro.json"
jt "tokens: review without a Claude Builder row counts in both totals" "$TMP/tokro.json" "$T"' | .role_tokens.review == 125 and .role_tokens.builders == 0 and .unit_tokens.spent == 125 and (.units[] | select(.slug=="U1") | .tokens == null and .review_tokens.spent == 125)'
jt "tokens: unit carries cache_read and output" "$TMP/toku.json" "$T"' | .units[] | select(.slug=="U1") | .tokens.cache_read == 100 and .tokens.output == 0'
# One decimal below 10: 1.9M, not 1M; 848k stays. The lead row (no ctx column) reads "context ?".
printf '%s\ttoksq\tlead\topus\t5\t0\t1520000\t100\t0\n%s\ttoksq\tbuilder\tsonnet\t7\t0\t678400\t100\t0\n' "$WK" "$BK" > "$TMP/tokens-fmt.body"
{ head -1 "$TMP/tokens.tsv"; cat "$TMP/tokens-fmt.body"; } > "$TMP/tokens-fmt.tsv"
FMT="$(DS_TOKENS_FILE="$TMP/tokens-fmt.tsv" tb "$LBL" 2>/dev/null)"
has "tokens: one decimal below 10" "$FMT" "lead ≈1.9M"
has "tokens: no ctx column -> context ?" "$FMT" "context ?"
has "tokens: 848k stays" "$FMT" "builders (all units) ≈848k"
# grep the file, not a piped string: a big page + `grep -q` + pipefail would SIGPIPE the printf.
# A toast event shows as a toast (U59): toastOf, lifted out of the page, run on events rows.
toasts="$(bun -e 'const h = require("fs").readFileSync(process.argv[1], "utf8"), i = h.indexOf("function toastOf(");
  const toastOf = new Function("mine", h.slice(i, h.indexOf("\n}\n", i) + 2) + "return toastOf;")(new Set());
  console.log(toastOf({ kind: "toast", squad: "demo", member: "4cd1::/x/ds-builder-u7", payload: { level: "error", text: "add-role.sh exit 1: boom" } }));
  console.log(toastOf({ kind: "toast", payload: {} }));' "$ROOT/web/board.html" 2>&1)"
eq "web board: a toast event shows as a toast" "$toasts" "demo: add-role.sh exit 1: boom
null"
# The event log reads plainly (U57): evSentence, lifted out of the page, gives each fixture kind one
# sentence (no raw JSON, no fallback); tick_slow is hidden unless asked; a row opens its full data.
sentences="$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8"), cut = (n) => { const i = h.indexOf(n); return h.slice(i, h.indexOf("\n}\n", i) + 2); };
  const evSentence = new Function("hhmmss", cut("function evSentence(") + "return evSentence;")((d) => d.toTimeString().slice(0, 8));
  for (const e of JSON.parse(fs.readFileSync(process.argv[2], "utf8"))) console.log(e.kind + "\t" + evSentence(e));' "$ROOT/web/board.html" "$ROOT/tests/fixtures/events-each-kind.json" 2>&1)"
eq "web board: no fixture event reads as JSON" "$(printf '%s\n' "$sentences" | awk -F'\t' '$2 ~ /[{}"]|^$/' | wc -l | tr -d ' ')" "0"
eq "web board: every fixture kind but one has its own sentence" "$(jq -r '.[].kind' "$ROOT/tests/fixtures/events-each-kind.json" | sort -u | while read -r k; do grep -qF "case \"$k\":" "$ROOT/web/board.html" || echo "$k"; done)" "host_migrated"
eq "web board: a blocked PR reads as its reasons" "$(printf '%s\n' "$sentences" | grep -m1 '^unit_pr_blocked' | cut -f2)" "PR #20350 is blocked: conflicts, 4 required checks missing"
eq "web board: a role restart names the role and squad" "$(printf '%s\n' "$sentences" | grep '^action_done' | cut -f2)" "done: restart role lead in bank-rail"
eq "web board: a queued pick reads as queued (U180)" "$(printf '%s\n' "$sentences" | grep '^pick' | cut -f2 | grep '^queued')" "queued for the thinker: 4 of 4 start slots in flight"
eq "web board: a pick with no agent says why, not null:null (U180)" "$(printf '%s\n' "$sentences" | grep '^pick' | cut -f2 | grep '^no start')" "no start for the thinker: fallback: no higher rung than 2 fits after this tick's moves"
eq "web board: no pick reads null:null (U180)" "$(printf '%s\n' "$sentences" | grep -c 'null:null')" "0"
eq "web board: a missed fallback move says where it landed and why (U180)" "$(printf '%s\n' "$sentences" | grep '^fallback_missed' | cut -f2 | cut -c1-70)" "thinker moved up for claude:opus@9fece591 but started on codex:gpt-6.1"
eq "web board: tick_slow names the slowest step" "$(printf '%s\n' "$sentences" | grep '^tick_slow' | cut -f2)" "4 of 120 ticks were over 5 s (ticks averaged 3100 ms, longest 7600 ms); slowest step orca:acme (1900 ms a tick)"
shown="$(bun -e 'const h = require("fs").readFileSync(process.argv[1], "utf8"), i = h.indexOf("const evShown =");
  const evShown = new Function(h.slice(i, h.indexOf("\n", i)) + "return evShown;")(), evs = [{ kind: "tick_slow" }, { kind: "unit_pr" }];
  console.log(evShown(evs, false).map((e) => e.kind).join(","), evShown(evs, true).map((e) => e.kind).join(","));' "$ROOT/web/board.html" 2>&1)"
eq "web board: tick_slow hidden by default, shown when asked" "$shown" "unit_pr tick_slow,unit_pr"
eq "web board: the page asks the server to hide noise (tick_slow included) by default" "$(grep -cF 'if (hideNoise) q.set("noise", "hide")' "$ROOT/web/board.html")" "1"
# Event colours (U1, event-log-polish): SEV_SQL, the one rule behind each row's colour and the sev=
# filter, gives each fixture kind the colour in this table (- is neutral), so a new kind is placed on
# purpose; then the payload cases: request_done ok:false, a pick that waits, an info toast, empty reasons.
sevs="$(bun -e 'const { Database } = require("bun:sqlite"), { SEV_SQL } = require(process.argv[1]), fs = require("fs");
  const db = new Database(":memory:"); db.run("CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, payload TEXT)");
  const evs = [...JSON.parse(fs.readFileSync(process.argv[2], "utf8")), { kind: "request_done", payload: { result: { ok: false } } }, { kind: "pick", payload: { wait: 1793816671 } },
    { kind: "toast", payload: { level: "info" } }, { kind: "unit_pr_blocked", payload: { reasons: "" } }, { kind: "action", payload: "not json" }, { kind: "brand_new_kind" }];
  for (const e of evs) db.run("INSERT INTO events (kind, payload) VALUES (?, ?)", [e.kind, typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload ?? null)]);
  console.log(db.query(`SELECT kind, ${SEV_SQL} AS sev FROM events ORDER BY id`).all().map((r) => r.kind + "=" + (r.sev ?? "-")).join(" "));' "$ROOT/bin/board/board-data.ts" "$ROOT/tests/fixtures/events-each-kind.json" 2>&1)"
eq "web board: each event kind gets the colour the rule says" "$sevs" "unit_pr_blocked=wait unit_pr_blocked=ok unit_pr=ok unit_done=ok unit_dispatched=ok unit_into_merged=ok tick_slow=wait \
action=- action_done=ok action_pending=wait action_failed=bad action_dropped=wait action_unhandled=bad member_requested=- member_started=ok member_account=- member_record=- pick=- pick=- pick=- \
limited=wait limit_cleared=ok want=- wish_done=ok wish_failed=bad wish_given_up=bad request=- request_done=ok question_answered=ok service_starting=- service_started=ok \
service_restarted=ok service_failed=bad coordinator=- delivery_sent=- delivery_verified=ok ready_deferred=wait squad_all_done=ok squad_state=- spend=- github_error=bad \
plugin_error=bad toast=bad host_migrated=- fallback_missed=wait request_done=bad pick=wait toast=- unit_pr_blocked=ok action=- brand_new_kind=-"
# A member is named by its folder minus ds-<project>-, so dev-studio's own lead is not "studio-lead".
eq "web board: a dev-studio member reads as its role" "$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8"), i = h.indexOf("function evSentence(");
  const evSentence = new Function("hhmmss", h.slice(i, h.indexOf("\n}\n", i) + 2) + "return evSentence;")(() => "");
  console.log(evSentence({ kind: "member_started", project: "dev-studio", squad: "x", member: "u::/w/ds-dev-studio-lead-x", payload: {} }));' "$ROOT/web/board.html" 2>&1)" "started lead"
eq "web board: a row opens its full data, with Copy" "$(grep -cF 'title="open the full data" onClick=${() => setOpen(e)}' "$ROOT/web/board.html")$(grep -cF 'open.fold ? { acting: open.fold.acting, done: open.fold.done } : open, null, 2)' "$ROOT/web/board.html")$(grep -cF 'onClick=${() => copy(full,' "$ROOT/web/board.html")" "111"
eq "web board: no event id on rows or in the pager" "$(grep -cE '#\$\{e\.id\}|"#" \+ evs\[' "$ROOT/web/board.html")" "0"
eq "web board: units footer" "$(grep -cF 'unit_tokens.units} units' "$ROOT/web/board.html")" "1"
eq "web board: crew footer names builders (all units)" "$(grep -cF 'builders (all units)' "$ROOT/web/board.html")" "1"
# Settings is an overlay (B6b): header button, #settings opens it, Esc closes, tabbed, no inline section.
eq "web board: settings button in the header" "$(grep -cF '⚙ Settings' "$ROOT/web/board.html")" "1"
eq "web board: #settings opens the overlay"   "$(grep -cF 'location.hash === "#settings"' "$ROOT/web/board.html")" "2"
eq "web board: settings overlay closes on Esc" "$(grep -cF 'if (e.key === "Escape") setSettings(false)' "$ROOT/web/board.html")" "1"
eq "web board: settings has a tab list (Limits, Roles, Skills, Pins)" "$(grep -cF 'SETTINGS_TABS = [["limits", "Limits"], ["roles", "Roles"], ["skills", "Skills"], ["pins", "Pins"]]' "$ROOT/web/board.html")" "1"
eq "web board: Roles tab uses the combined ModelPick" "$(grep -cF 'function ModelPick(' "$ROOT/web/board.html")" "1"
eq "web board: Roles tab no longer has a free model datalist" "$(grep -cF 'datalist' "$ROOT/web/board.html")" "0"
eq "web board: Roles is the second tab, mounting RolesTab" "$(grep -cF 'tab === "roles" && html`<${RolesTab}' "$ROOT/web/board.html")" "1"
eq "web board: Skills is the third tab, mounting SkillsTab" "$(grep -cF 'tab === "skills" && html`<${SkillsTab}' "$ROOT/web/board.html")" "1"
eq "web board: no inline settings section"    "$(grep -cF 'set-sec' "$ROOT/web/board.html")" "0"
eq "web board: no fuel icon" "$(grep -cF '⛽' "$ROOT/web/board.html")" "0"
eq "web board: spent in the units footer" "$(grep -cF 'units (7 days)' "$ROOT/web/board.html")" "1"
eq "web board: Limits selects only set a draft (no save from select onChange)" "$(grep -cE '<select[^>]*onChange=\$\{\(e\) => save\(' "$ROOT/web/board.html")" "0"
eq "web board: pipeline editor has an add-step button" "$(grep -cF '+ add step' "$ROOT/web/board.html")" "1"
eq "web board: Roles tab has no Missing section (U268)" "$(grep -cF 'Missing from this project' "$ROOT/web/board.html")" "0"
eq "web board: Roles tab marks a row default or custom" "$(grep -cF '"project" ? "custom" : "default"' "$ROOT/web/board.html")" "1"
eq "web board: no string style attr (React #62: style must be an object)" "$(grep -cE 'style="' "$ROOT/web/board.html")" "0"
eq "web board: no token line under the squad" "$(grep -cF 'tokens · ' "$ROOT/web/board.html")" "0"
# ctx 120k -> amber, 300k -> red, shown as "context 120k".
head -1 "$TMP/tokens.tsv" > "$TMP/tokens-ctx.tsv"
printf '%s\ttoksq\tlead\topus\t5\t0\t1000\t100\t0\t120000\n' "$WK" >> "$TMP/tokens-ctx.tsv"
DS_TOKENS_FILE="$TMP/tokens-ctx.tsv" tb "$LBL" --json > "$TMP/tokc.json"
jt "tokens: ctx 120k is amber" "$TMP/tokc.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .ctx_level == "amber"'
has "tokens: text board context 120k (amber)" "$(DS_TOKENS_FILE="$TMP/tokens-ctx.tsv" tb "$LBL" 2>/dev/null)" "context 120k (amber)"
sed -i 's/\t120000$/\t300000/' "$TMP/tokens-ctx.tsv"
DS_TOKENS_FILE="$TMP/tokens-ctx.tsv" tb "$LBL" --json > "$TMP/tokc.json"
jt "tokens: ctx 300k is red" "$TMP/tokc.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .ctx_level == "red"'
# limits: context_compact 120000 in state/<label>/limits.conf turns a 120k row red; the env var still wins.
sed -i 's/\t300000$/\t120000/' "$TMP/tokens-ctx.tsv"
printf 'context_compact 120000\n' > "$SD/../limits.conf"
DS_TOKENS_FILE="$TMP/tokens-ctx.tsv" tb "$LBL" --json > "$TMP/tokc.json"
jt "limits: override context_compact 120k -> 120k row red" "$TMP/tokc.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .ctx_level == "red"'
jt "limits: squad carries the thresholds in use" "$TMP/tokc.json" "$T"' | .limits.context_compact == 120000 and .limits.context_warn == 100000'
DS_LIMIT_CONTEXT_COMPACT=200000 DS_TOKENS_FILE="$TMP/tokens-ctx.tsv" tb "$LBL" --json > "$TMP/tokc.json"
jt "limits: env beats the override" "$TMP/tokc.json" "$T"' | .members[] | select(.wt | startswith("u9")) | .ctx_level == "amber"'
rm -f "$SD/../limits.conf"
rm -f "$SD/tok-sq.json"

# --html is gone: the page is the React app served by --serve.
if BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --html >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: --html should be rejected" >&2; else pass=$((pass+1)); fi

# expose-hosted-services U3: the open exposed rows (newest first, with the probe's status/reach), the
# legacy dev env as one entry, a gone row hidden, `running` across squads, and the text board's lines.
mq plain running '' '[{"slug":"a","status":"dispatched"}]'
printf '{"run_id":"run_x","status":"running","type":"testing","devenv":"http://localhost:21300 up","members":[{"role":"lead","wt":"wl"}],"units":[]}' > "$SD/manual-testing.json"
SEED_X="$TMP/seed-exposed.json"
jq -n '{workers:[["wl","working","ds-lead"]], exposed:[
  {squad:"manual-testing",name:"app",url:"http://localhost:3000",note:"slot 2",role:"tester",ago:600,status:"up",reach:"remote"},
  {squad:"manual-testing",name:"admin",url:"http://localhost:4000",role:"builder",suffix:"platform",ago:60,status:"up",reach:"host-only"},
  {squad:"manual-testing",name:"old",url:"http://localhost:5000",ago:900,gone:true},
  {squad:"manual-testing",name:"mine",url:"http://localhost:7000",ago:20,audience:"self",status:"up",reach:"remote"},
  {squad:"manual-testing",name:"fresh",url:"http://localhost:8000",ago:10},
  {squad:"plain",name:"board",url:"http://localhost:6000",ago:30,status:"down",reach:"down",down_since:1}]}' > "$SEED_X"
SEED="$SEED_X" board "$LBL" > "$TMP/x.json"
jt "exposed: newest first, legacy dev env last, gone hidden" "$TMP/x.json" "$S | [.exposed[] | .name] == [\"fresh\",\"admin\",\"app\",\"dev env\"]"
jt "exposed: probe status, reach, role" "$TMP/x.json" "$S | (.exposed[1] | .reach==\"host-only\" and .role==\"builder-platform\" and .status==\"up\") and (.exposed[2] | .reach==\"remote\" and .note==\"slot 2\")"
jt "exposed: legacy dev env is the lead's, no badge" "$TMP/x.json" "$S | .exposed[3] | .legacy==true and .role==\"lead\" and .url==\"http://localhost:21300\" and .status==null"
jt "exposed: devenv field unchanged"               "$TMP/x.json" "$S | .devenv.url==\"http://localhost:21300\""
jt "exposed: a --self entry is never listed"      "$TMP/x.json" "$S | [.exposed[] | .name] | index(\"mine\") == null"
jt "exposed: state per entry"                      "$TMP/x.json" "$S | ([.exposed[] | .name+\"=\"+.state] | sort) == [\"admin=host-only\",\"app=open\",\"dev env=open\",\"fresh=checking\"]"
jt "exposed: summary counts"                       "$TMP/x.json" "$S | .exposed_summary == {open:2,down:0,host_only:1,checking:1} and (has(\"unexposed\") | not)"
jt "exposed: a down entry carries down_since"      "$TMP/x.json" "[.squads[] | select(.topic==\"plain\") | .exposed[0]] | .[0] | .state==\"down\" and .down_since==1"
jt "no top-level running list"                     "$TMP/x.json" "has(\"running\") | not"
jt "exposed: a squad with none has an empty list"  "$TMP/x.json" "[.squads[] | select(.topic!=\"manual-testing\" and .topic!=\"plain\") | .exposed | length] | all(. == 0)"
SEED="$SEED_X" tb "$LBL" > "$TMP/x.txt" 2>&1 || true
has "text board: open entry with note"     "$(cat "$TMP/x.txt")" "exposed: app http://localhost:3000 (tester) — slot 2"
has "text board: header open count"        "$(cat "$TMP/x.txt")" "open:2"
has "text board: rest on one line"         "$(cat "$TMP/x.txt")" "not shown: 1 host only · 1 checking"
has "text board: down counted in header"   "$(cat "$TMP/x.txt")" "(1 down)"
eq  "text board: host-only entry not listed" "$(grep -c "exposed: admin" "$TMP/x.txt")" "0"
eq  "text board: down entry not listed"    "$(grep -c "exposed: board" "$TMP/x.txt")" "0"
eq  "text board: self entry not printed"   "$(grep -c "localhost:7000" "$TMP/x.txt")" "0"
eq  "text board: gone entry not printed"   "$(grep -c "localhost:5000" "$TMP/x.txt")" "0"
rm -f "$SD/plain.json" "$SD/manual-testing.json"
# U261: the Studio row. A project whose Studio worktree holds the Studio's claude tab, a ds-loop pane
# running codex and a shell (one observer tick, tests/board-studio-db.ts) shows one adopted Studio on
# the claude account, its walk not unknown; the text board carries its line.
SL="zzstudio_$$"; SR="$TMP/studio-root"; mkdir -p "$SR/$SL"
printf '{"studio_wt":"repo::/tmp/zz-%s-studio","agent":"claude"}\n' "$SL" > "$SR/$SL/dispatcher.json"
DS_STATE_ROOT="$SR" "$ROOT/bin/ds" import >/dev/null
DS_STATE_ROOT="$SR" bun "$ROOT/tests/board-studio-db.ts" "$SL"
DS_STATE_ROOT="$SR" PATH="$NP" "$ROOT/bin/board/board.sh" "$SL" --json > "$TMP/studio.json"
jt "studio: one Studio row" "$TMP/studio.json" '.studio | length == 1'
jt "studio: the claude tab is adopted" "$TMP/studio.json" '.studio[0] | .adopted and .handle == "term_studio" and .agent == "claude"'
jt "studio: on the claude account, its walk not unknown" "$TMP/studio.json" '.studio[0] | .account == "acct-studio" and .walk == "running"' '.studio'
st="$(DS_STATE_ROOT="$SR" PATH="$NP" "$ROOT/bin/board/board.sh" "$SL" 2>&1)"
has "studio: the text board's Studio line" "$st" "studio $SL: claude"
has "studio: the line names the account" "$st" "@acct-studio"
jt "studio: no move yet" "$TMP/studio.json" '.studio[0].moved == null'
# U264: the loop moved the Studio to another account: the board says where to, the text board too.
DS_STATE_ROOT="$SR" bun "$ROOT/tests/board-studio-db.ts" "$SL" --moved
DS_STATE_ROOT="$SR" PATH="$NP" "$ROOT/bin/board/board.sh" "$SL" --json > "$TMP/studio-moved.json"
jt "studio: the move is on the Studio row" "$TMP/studio-moved.json" '.studio[0].moved | .to == "claude:B" and .from == "claude:acct-a" and .handle == "term_studio"'
st="$(DS_STATE_ROOT="$SR" PATH="$NP" "$ROOT/bin/board/board.sh" "$SL" 2>&1)"
has "studio: the text board says where the Studio moved" "$st" "Studio moved to claude:B"

# U266: a member whose planned restart waits on its journal checkpoint shows it, like a pausing one.
mq sc-sq running ',{"role":"builder","suffix":"u1","wt":"wsc"}' '[{"slug":"u1","status":"dispatched"}]'
board "$LBL" > /dev/null
dbw "INSERT INTO stop_checkpoints (member_id, project, squad, role, suffix, stop_key, why, generation, state, created_at, asked_at)
  SELECT id, project, squad, role, suffix, 'restart:1', 'restart', 'stop-gen1', 'asking', 1000, 1010 FROM members WHERE project='$LBL' AND squad='sc-sq' AND role='builder'"
render "$LBL" --json > "$TMP/sc.json"
jt "stop checkpoint: the member carries it" "$TMP/sc.json" '.squads[] | select(.topic=="sc-sq") | .members[] | select(.role=="builder") | .stop_checkpoint | .why == "restart" and .generation == "stop-gen1" and .asked_at == 1010'
jt "stop checkpoint: none on the others" "$TMP/sc.json" '[.squads[] | select(.topic=="sc-sq") | .members[] | select(.role=="lead") | .stop_checkpoint] == [null]'
eq "web board: the member row shows a pending restart" "$(grep -cF 'StopCheckpointInfo} sc=${m.stop_checkpoint}' "$ROOT/web/board.html")" "1"
rm -f "$SD/sc-sq.json"

# provider-billing-fallback U4: muse/default out of credits (a live credits hold) with a Builder that
# cannot move: one Needs-you card after the grace (credits-card.ts files it), the Accounts row reads out
# of credits with the link and is not free; after a clear (hold ended, card resolved) both are gone.
mkdir -p "$TMP/stcr"
NOWC="$(date +%s)" CRL='https://dev.meta.ai/billing/?team_id=1119730230559715'
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\nclaude\tsystem\t10\t-\t5\t-\t-\t%s\nmuse\tdefault\t-\t-\t-\t-\t-\t%s\n' "$NOWC" "$NOWC" > "$TMP/stcr/accounts.tsv"
CRA="$DS_STATE_ROOT/$LBL/alerts.json"
"$ROOT/bin/lib/alerts.sh" "$CRA" add loop-credits.card_muse_default-x "muse/default out of credits" \
  "muse/default is out of credits: model failed: API error 402 [request_id=r1]: Billing verification failed. Stuck on it: builder-u1 (manual-testing). Fix the billing at $CRL, then press Fixed. Or switch the account off and restart them." \
  "" "" "{\"kind\":\"out_of_credits\",\"options\":[\"Fixed\",\"Switch it off\"],\"credits\":{\"agent\":\"muse\",\"account\":\"default\"},\"link\":\"$CRL\"}" >/dev/null
crdb(){ # the hold and its event, as credits.ts writes them
  dbw "INSERT INTO episodes (project, subject, kind, episode_key, state, started_at, ended_at, source, observed_at) VALUES ('', 'credits|muse/default', 'account', 'k', 'muse/default', $((NOWC-1200)), $((NOWC+86400)), 'loop', $NOWC)"
  dbw "INSERT INTO events (at, project, kind, payload) VALUES ($((NOWC-1200)), '', 'account_credits_held', '{\"agent\":\"muse\",\"account\":\"default\",\"from\":\"screen\",\"notice\":\"model failed: API error 402\",\"link\":\"$CRL\"}')"
}
HOSTST="$TMP/stcr" mkdb "$LBL"; crdb; render "$LBL" --json > "$TMP/cr0.json"
jt "U4: an out-of-credits card waits out the grace"   "$TMP/cr0.json" '[.needs_you[] | select(.id=="loop-credits.card_muse_default-x")] | length == 0'
jq --arg t "$(date -u -d "@$((NOWC-1200))" +%Y-%m-%dT%H:%M:%SZ)" '.alerts[0].since = $t' "$CRA" > "$CRA.t" && mv "$CRA.t" "$CRA"
HOSTST="$TMP/stcr" mkdb "$LBL"; crdb; render "$LBL" --json > "$TMP/cr.json"
jt "U4: one Needs-you card naming the account, the 402 and the link" "$TMP/cr.json" "[.needs_you[] | select(.id==\"loop-credits.card_muse_default-x\")] | length == 1 and (.[0].title == \"muse/default out of credits\") and (.[0].text | contains(\"API error 402\") and contains(\"$CRL\"))"
jt "U4: the card offers Fixed and Switch it off"      "$TMP/cr.json" '[.needs_you[] | select(.id=="loop-credits.card_muse_default-x")][0] | [.choices[].label] == ["Fixed","Switch it off"]'
jt "U4: the account row reads out of credits + link"  "$TMP/cr.json" ".accounts[] | select(.agent==\"muse\") | .text == \"muse:default out of credits · $CRL\" and .credits.link == \"$CRL\" and (.credits.notice | test(\"402\"))"
jt "U4: an account out of credits is not free"        "$TMP/cr.json" '.accounts_summary | .free == 1 and .total == 2 and (.credits | map(.account)) == ["default"] and .level == "warn"'
"$ROOT/bin/lib/alerts.sh" "$CRA" resolve loop-credits.card_muse_default-x >/dev/null
HOSTST="$TMP/stcr" board "$LBL" > "$TMP/cr2.json"
jt "U4: after a clear the card is gone"               "$TMP/cr2.json" '[.needs_you[] | select(.id=="loop-credits.card_muse_default-x")] | length == 0'
jt "U4: after a clear the account row is plain"       "$TMP/cr2.json" '.accounts[] | select(.agent=="muse") | .credits == null and (.text | test("out of credits") | not)'
jt "U4: after a clear the account is free again"      "$TMP/cr2.json" '.accounts_summary | .free == 2 and .credits == []'
eq "U4 page: the account row links the billing page" "$(grep -cF 'href=${a.credits.link} target="_blank"' "$ROOT/web/board.html")" "1"
rm -f "$CRA"

# needs-you-dismiss-only U2: a stopped review of a squad unit is a loop note on its squad's row (not Needs-you)
# until it has lasted refusal_needs_min; one with no squad is Needs-you at once.
"$ROOT/bin/lib/alerts.sh" "$CRA" add review-stopped:u2-sq "Reviews stopped: plq-sq U1" "Reviews stopped for u2-sq" \
  "" "" '{"kind":"review_stopped","squad":"plq-sq","unit":"U1","slug":"u1","branch":"u2-sq","failures":2}' >/dev/null
"$ROOT/bin/lib/alerts.sh" "$CRA" add review-stopped:u2-nosq "Reviews stopped: branch u2-nosq" "Reviews stopped for u2-nosq" \
  "" "" '{"kind":"review_stopped","branch":"u2-nosq","failures":2}' >/dev/null
mkdb "$LBL"; render "$LBL" --json > "$TMP/rs.json"
jt "needs-you-dismiss-only U2: a fresh squad-unit stopped review is not in Needs-you" "$TMP/rs.json" '[.needs_you[] | select(.id=="review-stopped:u2-sq")] | length == 0'
jt "needs-you-dismiss-only U2: it is a loop note and on its squad's notes" "$TMP/rs.json" '([.loop_notes[] | select(.id=="review-stopped:u2-sq")] | length == 1) and ([.squads[] | select(.topic=="plq-sq") | .notes[] | select(.id=="review-stopped:u2-sq")] | length == 1)'
jt "needs-you-dismiss-only U2: a stopped review with no squad is Needs-you at once" "$TMP/rs.json" '([.needs_you[] | select(.id=="review-stopped:u2-nosq")] | length == 1) and ([.loop_notes[] | select(.id=="review-stopped:u2-nosq")] | length == 0)'
rm -f "$CRA"

# needs-you-dismiss-only U1: a Studio card's `choices` are its options only when the answer acts (2+ options, or
# `acts_on_answer`); a lone option that does nothing is `when`.
OLDC="$(date -u -d "@$((NOWC-1200))" +%Y-%m-%dT%H:%M:%SZ)"
"$ROOT/bin/lib/alerts.sh" "$CRA" add na-none "Notice" "Just so you know" "" "" '{"kind":"out_of_credits"}' >/dev/null
"$ROOT/bin/lib/alerts.sh" "$CRA" add na-when "Review stopped" "Reviews stopped" "restart it" "" '{"kind":"out_of_credits"}' >/dev/null
"$ROOT/bin/lib/alerts.sh" "$CRA" add na-acts "Studio limited" "Studio is limited" "move it" "" '{"kind":"out_of_credits","acts_on_answer":true}' >/dev/null
"$ROOT/bin/lib/alerts.sh" "$CRA" add na-two "Two answers" "Pick one" "" "" '{"kind":"out_of_credits","options":["Fixed","Switch it off"]}' >/dev/null
jq --arg t "$OLDC" '.alerts |= map(.since = $t)' "$CRA" > "$CRA.t" && mv "$CRA.t" "$CRA"
HOSTST="$TMP/stcr" mkdb "$LBL"; render "$LBL" --json > "$TMP/na.json"
NA='.needs_you[] | select(.id=="%s")'
jt "dismiss-only: no option, no choices, no when"  "$TMP/na.json" "[${NA/\%s/na-none}] | .[0] | .choices == [] and .when == null and .acts_on_answer == false and .suggestion == null"
jt "dismiss-only: a lone non-acting option is when" "$TMP/na.json" "[${NA/\%s/na-when}] | .[0] | .choices == [] and .when == \"restart it\" and .suggestion == null and .options == [\"restart it\"]"
jt "dismiss-only: a lone acting option is a choice" "$TMP/na.json" "[${NA/\%s/na-acts}] | .[0] | [.choices[].label] == [\"move it\"] and .when == null and .acts_on_answer == true"
jt "dismiss-only: two options stay choices"        "$TMP/na.json" "[${NA/\%s/na-two}] | .[0] | [.choices[].label] == [\"Fixed\",\"Switch it off\"] and .when == null"
rm -f "$CRA"

S2='.squads[] | select(.topic=="ov-sq")'
# U24: override scopes: a squad override on the squad card, project and role ones listed for Settings, a member's badge naming
# the broader scope; a member's own pin still wins; a squad pin carries its Clear (page checks below).
mq ov-sq running ',{"role":"builder","wt":"wtOb"},{"role":"tester","wt":"wtOt"}' '[{"slug":"u1","status":"dispatched"}]'
mkdb "$LBL"
dbw "INSERT INTO overrides (member, scope, model, effort, set_by, set_at) VALUES ('$LBL/ov-sq', 'squad', 'sonnet', 'high', 'board', 1)"
dbw "INSERT INTO overrides (member, scope, account, set_by, set_at) VALUES ('$LBL', 'project', 'work', 'board', 2)"
dbw "INSERT INTO overrides (member, scope, model, set_by, set_at) VALUES ('$LBL/tester', 'role', 'haiku', 'board', 3)"
render "$LBL" --json > "$TMP/ovs.json"
jt "U24: the squad card shows its squad override"   "$TMP/ovs.json" "$S2 | .override | .scope==\"squad\" and .model==\"sonnet\" and .effort==\"high\" and .target==\"$LBL/ov-sq\""
jt "U24: a squad without one shows none"           "$TMP/ovs.json" '[.squads[] | select(.topic!="ov-sq") | .override] | all(. == null)'
jt "U24: the board lists squad, role and project overrides" "$TMP/ovs.json" '[.overrides[] | .scope] | sort == ["project","role","squad"]'
jt "U24: a member's badge names the squad scope"    "$TMP/ovs.json" "$S2 | (.members[] | select(.role==\"builder\")) | .override | .scope==\"squad\" and .model==\"sonnet\""
jt "U24: a role override reaches that role only"    "$TMP/ovs.json" "$S2 | (.members[] | select(.role==\"tester\")) | .override.scope==\"squad\""
dbw "UPDATE overrides SET cleared_at = 9 WHERE scope = 'squad'"
render "$LBL" --json > "$TMP/ovs2.json"
jt "U24: cleared squad pin: card empty, the role one now shows on the tester" "$TMP/ovs2.json" "$S2 | .override == null and ((.members[] | select(.role==\"tester\")) | .override.scope==\"role\")"
jt "U24: ... and the builder falls to the project pin" "$TMP/ovs2.json" "$S2 | (.members[] | select(.role==\"builder\")) | .override.scope==\"project\" and .override.account==\"work\""
dbw "INSERT INTO overrides (member, scope, model, set_by, set_at) VALUES ('wtOb', 'member', 'fable', 'board', 10)"
render "$LBL" --json > "$TMP/ovs3.json"
jt "U24: a member's own pin shows as its own"       "$TMP/ovs3.json" "$S2 | (.members[] | select(.role==\"builder\")) | .override | .scope==\"member\" and .model==\"fable\""
eq "U24 page: the squad card has the pin with Clear" "$(grep -cF 'override(s, { wt: null }, { scope: "squad", clear: true }, toast)' "$ROOT/web/board.html")" "1"
eq "U24 page: the Settings Pins tab lists with Clear" "$(sed -n '/^function PinsTab(/,/^}/p' "$ROOT/web/board.html" | grep -cF 'class="btn sm ovr-clear"')" "1"
eq "U24 page: the badge names the broader scope"    "$(grep -cF '" · from " + m.override.scope' "$ROOT/web/board.html")" "1"
dbw "DELETE FROM overrides WHERE scope IN ('squad','role','project') OR member = 'wtOb'"

rm -f "$SD/ov-sq.json"
# board-update-button U3: the `update` field and the UPDATE line, from an observed_update row alone.
UNOW="$(date +%s)"
updrow(){ # <behind> <state> <need> <classes-json> <checked_at> [error] [squads-json] [last_update-json] — one host row
  local err="NULL" eat="NULL" lu="NULL"
  [ -z "${6:-}" ] || { err="'$6'"; eat="$UNOW"; }
  [ -z "${8:-}" ] || lu="'$8'"
  dbw "DELETE FROM observed_update"
  dbw "INSERT INTO observed_update (host, branch, head, behind, ahead, dirty, commits, classes, need, state, error, error_at, checked_at, every_s, last_update, squads, observed_at) VALUES ('h', 'main', 'abc', $1, 0, 0, '[{\"sha\":\"a1\",\"title\":\"fix a\",\"classes\":[\"code\"]},{\"sha\":\"b2\",\"title\":\"role text\",\"classes\":[\"instructions\"]}]', '$4', '$3', '$2', $err, $eat, $5, 600, $lu, '${7:-{\}}', $UNOW)"
}
upd(){ HOSTST="" mkdb "$LBL"; "$@"; render "$LBL" --json > "$TMP/upd.json"; }
upd updrow 0 ok none '[]' "$UNOW"
jt "U3 update: hidden when current"          "$TMP/upd.json" 'has("update") | not'
upd updrow 2 ok reload '["instructions","code"]' "$((UNOW-60))"
jt "U3 update: behind with classes and need" "$TMP/upd.json" '.update | .behind==2 and .need=="reload" and .classes==["instructions","code"] and .state=="ok" and .stale==false and (.commits|length)==2 and .commits[1].title=="role text" and .pending==null and .squads_behind==null'
TXT="$(render "$LBL")"
has "U3 update: text line" "$TXT" "UPDATE 2 new on main (instructions, code) — reload, no restarts — /ds-update"
upd updrow 3 ok restart '["skills"]' "$((UNOW-60))"
jt "U3 update: restart need"                 "$TMP/upd.json" '.update | .need=="restart"'
upd updrow 0 ok none '[]' "$((UNOW-4000))"
jt "U3 update: stale after 3x the interval"  "$TMP/upd.json" '.update | .stale==true'
has "U3 update: stale text" "$(render "$LBL")" "UPDATE can't check:"
upd updrow 2 fetch_failed reload '["code"]' "$((UNOW-60))" "could not resolve host"
jt "U3 update: error keeps the last counts"  "$TMP/upd.json" '.update | .state=="fetch_failed" and .error=="could not resolve host" and .behind==2 and .checked_at != null'
has "U3 update: error text" "$(render "$LBL")" "UPDATE can't check: could not resolve host (last checked"
upd updrow 0 ok none '[]' "$UNOW" "" '{"'"$LBL"'":{"rev":"old","behind":4,"classes":["skills"],"need":"restart"}}'
jt "U3 update: no live members, nothing to refresh" "$TMP/upd.json" 'has("update") | not'
dbw "INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('$LBL', 'zz-upd', 'wt-upd', 'builder', '', 'running', $UNOW, $UNOW)"
render "$LBL" --json > "$TMP/upd.json"
jt "U3 update: squads behind need live members" "$TMP/upd.json" '.update | .workers > 0 and .squads_behind.need=="restart" and .squads_behind.behind==4'
jt "U3 update: workers counts live members"  "$TMP/upd.json" '.update | .workers >= 1'
# U4: `others` = other projects with a live worker, no test projects, no gone members, sorted.
dbw "INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('acme', 'a', 'wt-acme', 'builder', '', 'running', $UNOW, $UNOW)"
dbw "INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('zzother-upd', 'a', 'wt-zz', 'builder', '', 'running', $UNOW, $UNOW)"
dbw "INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('gonep', 'a', 'wt-gone', 'builder', '', 'gone', $UNOW, $UNOW)"
dbw "INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('studioonly', '_studio', 'wt-st', 'studio', '', 'running', $UNOW, $UNOW)"
render "$LBL" --json > "$TMP/upd.json"
jt "U4 update: others names the other live project, no test project, gone or studio-only one" "$TMP/upd.json" '.update.others == ["acme"]'
dbw "DELETE FROM members WHERE project IN ('acme','zzother-upd','gonep','studioonly')"
render "$LBL" --json > "$TMP/upd.json"
jt "U4 update: no other live project is []" "$TMP/upd.json" '.update.others == []'
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-120))"',"outcome":"advanced","line":"advanced main abc..def","branch":"main"}'
jt "U3 update: a result inside the hour shows" "$TMP/upd.json" '.update | .last_update.outcome=="advanced"'
has "U3 update: result text" "$(render "$LBL")" "UPDATE advanced main abc..def"
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-300))"',"outcome":"already","line":"already current main abc"}'
jt "U4 update: an 'already' result, all current, shows no update field" "$TMP/upd.json" 'has("update") | not'
eq "U4 update: an 'already' result prints no UPDATE line" "$(render "$LBL" | grep -c UPDATE)" "0"
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-240))"',"outcome":"advanced","line":"advanced main abc..def","branch":"main"}'
jt "U6 update: an 'advanced' result 4 min old shows" "$TMP/upd.json" '.update | .last_update.outcome=="advanced"'
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-360))"',"outcome":"advanced","line":"x"}'
jt "U6 update: an 'advanced' result 6 min old is hidden" "$TMP/upd.json" 'has("update") | not'
# U6: refused/failed stay until the checkout's HEAD (row head 'abc') moves past the result's after/before.
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-7200))"',"outcome":"failed","line":"install failed: boom","before":"zzz","after":"abc"}'
jt "U6 update: a failed result 2 h old with HEAD at its after shows" "$TMP/upd.json" '.update | .last_update.outcome=="failed"'
has "U6 update: lone failed text" "$(render "$LBL")" "UPDATE failed: install failed: boom — fix it, then /ds-update $LBL"
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-7200))"',"outcome":"failed","line":"x","before":"zzz","after":"def"}'
jt "U6 update: a failed result with HEAD moved past it gives no field" "$TMP/upd.json" 'has("update") | not'
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-7200))"',"outcome":"refused","line":"refused: detached","before":"abc","after":""}'
jt "U6 update: a refused result with only before, HEAD unchanged, shows" "$TMP/upd.json" '.update | .last_update.outcome=="refused"'
upd updrow 0 ok none '[]' "$UNOW" "" "{}" '{"at":'"$((UNOW-7200))"',"outcome":"failed","line":"old"}'
jt "U6 update: a result with neither after nor before, 2 h old, gives no field" "$TMP/upd.json" 'has("update") | not'
upd updrow 3 ok code '["code"]' "$UNOW" "" "{}" '{"at":'"$((UNOW-60))"',"outcome":"failed","line":"boom","before":"zzz","after":"abc"}'
jt "U6 update: behind with a failed result keeps last_update" "$TMP/upd.json" '.update | .behind==3 and .last_update.outcome=="failed"'
has "U6 update: behind line ends last try failed" "$(render "$LBL")" "— /ds-update — last try failed"
upd updrow 1 ok code '["code"]' "$UNOW"
dbw "INSERT INTO requests (kind, project, squad, key, payload, created_at, requested_by) VALUES ('studio', '$LBL', NULL, 'k-upd', '{\"action\":\"update\",\"topic\":null,\"line\":\"x\"}', $((UNOW-30)), 'board')"
render "$LBL" --json > "$TMP/upd.json"
jt "U3 update: a pending request shows"      "$TMP/upd.json" '.update.pending != null'
has "U3 update: pending text" "$(render "$LBL")" "UPDATE asked — waiting for the Studio"
dbw "DELETE FROM observed_update"

# investigate-disk-cleanup U1: the Host tidy card on the board shows a size the measuring pass took
# (`size_from: du`) as it is, and a partial walk not measured yet as `≥ <size>`.
TIDY_TXT="$(bun -e '
  const { open } = await import(process.argv[1] + "/bin/loop/core/store.ts");
  const { cardText } = await import(process.argv[1] + "/bin/loop/fulfil/cleanup.ts");
  const s = open(process.argv[2]), p = process.argv[3], at = Math.floor(Date.now() / 1000);
  s.upsert("projects", { label: p }, { home_repo: null, observed_at: 1 });
  const ins = s.db.query("INSERT INTO observed_cleanup (project, class, key, path, size_kb, first_seen, verdict, facts, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  ins.run(p, "d", "/w/ds-measured", "/w/ds-measured", 3145728, at, "removable", JSON.stringify({ partial: true, size_from: "du", size_at: at }), at);
  ins.run(p, "c", "/h/partial", "/h/partial", 2048, at, "too new", JSON.stringify({ partial: true }), at);
  ins.run(p, "f", "/srv/zzcache-*", "/srv", 10240, at, "removable", JSON.stringify({ folders: 2, count: 40, removable: 30, too_new: 9, not_ours: 0, in_use: 1, partial: true, size_from: "du", size_at: at }), at);
  s.upsert("config", { project: p, file: "limits.conf", key: "cleanup_trim_globs" }, { value: "/srv/zzcache-*, relative-*", observed_at: 1 });
  process.stdout.write(cardText(s, p)); s.close();' "$ROOT" "$TMP/tidy-root" "$LBL")"
"$ROOT/bin/lib/alerts.sh" "$CRA" add "cleanup:$LBL.card" "Host tidy: $LBL" "Needs you: 1 removable.
$TIDY_TXT" "" "" '{"kind":"host_tidy","removable":1}' >/dev/null
board "$LBL" > "$TMP/tidy.json"
TIDY_SEL="(.needs_you[], .loop_notes[]) | select(.title==\"Host tidy: $LBL\") | .text"
jt "U1 sizes: the measured row's size is shown as it is" "$TMP/tidy.json" "[$TIDY_SEL] | length == 1 and (.[0] | contains(\"- [d] removable · 3.0 GB · /w/ds-measured\"))"
jt "U1 sizes: a partial row not measured yet reads ≥"    "$TMP/tidy.json" "[$TIDY_SEL][0] | contains(\"- [c] too new · ≥ 2.0 MB · /h/partial\") and (contains(\"≥ 3.0 GB\") | not)"
jt "U2 trim: the class f row reads its folders kept and entries inside" "$TMP/tidy.json" "[$TIDY_SEL][0] | contains(\"Trim /srv/zzcache-*: 2 folders kept, 40 entries inside (10.0 MB), 30 removable, too new 9, not ours 0, in use 1.\") and contains(\"- [f] removable · 10.0 MB · 40 entries inside 2 folders matching /srv/zzcache-* (kept)\")"
jt "U2 trim: a rejected trim glob is listed with its reason"           "$TMP/tidy.json" "[$TIDY_SEL][0] | contains(\"Invalid trim glob relative-*: \") and contains(\"(trims nothing).\")"
rm -f "$CRA"

# disk-pressure U3: an open disk spell shows a Needs-you card (title, first consumer) and one DISK line on the text board.
DNOW="$(date +%s)"
dbw "INSERT INTO observed_machine (host, disks, observed_at) VALUES ('dh', '[{\"path\":\"/\",\"total_kb\":1048576000,\"free_kb\":157286400}]', $DNOW)"
dbw "INSERT INTO episodes (project, subject, kind, state, started_at, episode_key, source, observed_at) VALUES ('$LBL', 'disk-pressure./', 'disk-pressure', 'low', $DNOW, '$DNOW', 'loop', $DNOW)"
dbw "INSERT INTO observed_disk_usage (key, label, size_kb, reclaimable_kb, read_at, observed_at) VALUES ('docker:build-cache', 'Docker build cache', 524288000, 503316480, $DNOW, $DNOW)"
dbw "INSERT INTO observed_disk_usage (key, label, size_kb, read_at, observed_at) VALUES ('du:/srv/cache', '/srv/cache', 1048576, $DNOW, $DNOW)"
dbw "INSERT INTO observed_alerts (project, id, doc, observed_at) VALUES ('$LBL', 'sweep-disk-pressure./-1', '{\"id\":\"sweep-disk-pressure./-1\",\"asker\":\"sweep\",\"title\":\"Disk / low: 150 GB free (15%)\",\"question\":\"Disk / low: 150 GB free (15%). Biggest consumers: 1. Docker build cache: 500 GB (480 GB reclaimable).\",\"since\":\"2026-11-20T09:00:00Z\"}', $DNOW)"
render "$LBL" --json > "$TMP/disk.json"
jt "disk U3: the Needs-you card carries the title"        "$TMP/disk.json" '.studio_alerts | map(select(.text | startswith("Disk / low: 150 GB free (15%)"))) | length == 1'
jt "disk U3: the card names Docker build cache first"     "$TMP/disk.json" '.studio_alerts[] | select(.text | startswith("Disk /")) | .text | test("1\\. Docker build cache: 500 GB")'
jt "disk U3: board.json lists the spell and its consumers" "$TMP/disk.json" '.disk | length == 1 and .[0].path == "/" and .[0].free_pct == 15 and (.[0].consumers[0] | startswith("Docker build cache: 500 GB"))'
has "disk U3: the text board's DISK line" "$(render "$LBL")" "DISK  ⚠ Disk / low: 150 GB free (15%) — Docker build cache: 500 GB (480 GB reclaimable)"
dbw "UPDATE episodes SET ended_at = $DNOW, state = 'closed' WHERE kind = 'disk-pressure'"
render "$LBL" --json > "$TMP/disk.json"
jt "disk U3: a closed spell leaves no disk field"         "$TMP/disk.json" 'has("disk") | not'
dbw "DELETE FROM observed_alerts WHERE id LIKE 'sweep-disk-pressure%'"

echo "board: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
