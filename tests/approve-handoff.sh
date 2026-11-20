#!/usr/bin/env bash
# approve-handoff.sh — a Thinker approves its plan and hands it to the Lead with one call.
# A plan register-plan refuses must stop before anything in the real state changes; a good
# plan ends approved, running, and handed off. orch.sh is stubbed (ORCH), the backend too.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/stub" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
STUB
chmod +x "$TMP/stub"
export STUB_LOG="$TMP/log" BACKEND="$TMP/stub" ORCH="$TMP/stub"
A="$ROOT/bin/role/approve-handoff.sh"
pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want $3, got $2)" >&2; fi; }

mkstate() { printf '{"run_id":"run_1","status":"waiting-on-you","waiting_on_you":[{"id":"plan-x","asker":"thinker","blocking":true,"question":"Approve?"}],"approved_plans":[],"units":[]}' > "$1"; }
goodplan() { printf '# T\n\n- U1 -- alpha work -- deps: none -- Tier: standard\n- U2 -- beta work -- deps: U1 -- Tier: hard\n' > "$1"; }

# Usage errors refuse without touching anything.
"$A" 2>/dev/null; eq "no args -> 2" "$?" "2"
"$A" a b 2>/dev/null; eq "two args -> 2" "$?" "2"
"$A" "$TMP/nope.json" "$TMP/nope-plan.md" wt 2>/dev/null; eq "missing state -> 1" "$?" "1"
mkstate "$TMP/s0.json"; "$A" "$TMP/s0.json" "$TMP/nope-plan.md" wt 2>/dev/null; eq "missing plan -> 1" "$?" "1"

# Happy path: approved, question resolved, running, handed off.
mkstate "$TMP/sq.json"; goodplan "$TMP/sq-x-plan.md"; : > "$STUB_LOG"
out="$("$A" "$TMP/sq.json" "$TMP/sq-x-plan.md" 'leadwt::/tmp/x' 2>&1)"; rc=$?
eq "happy path exits 0" "$rc" "0"
eq "plan is approved" "$(jq -r '.approved_plans[0]' "$TMP/sq.json")" "$TMP/sq-x-plan.md"
eq "approval question resolved" "$(jq -r '.waiting_on_you | length' "$TMP/sq.json")" "0"
eq "squad back to running" "$(jq -r .status "$TMP/sq.json")" "running"
eq "one handoff sent" "$(grep -c '^send-worker leadwt::/tmp/x handoff' "$STUB_LOG")" "1"
eq "handoff carries report-path" "$(grep -c "report-path=$TMP/sq-x-plan.md" "$STUB_LOG")" "1"
eq "caller told the unit count" "$(printf '%s' "$out" | grep -c '2 units')" "1"
eq "handoff says approved for this squad" "$(grep -c 'The operator approved this plan for squad sq on .* (it is in approved_plans). It widens the squad.s framing: build it.' "$STUB_LOG")" "1"
eq "framing gains one dated line" "$(jq -r .framing "$TMP/sq.json" | grep -c ': operator approved sq-x-plan.md; the squad builds it')" "1"
eq "dry-run wrote no units to real state" "$(jq -r '.units | length' "$TMP/sq.json")" "0"

# Relative plan and state paths: the handoff still carries an absolute report-path.
mkdir "$TMP/rel"; mkstate "$TMP/rel/sq.json"; goodplan "$TMP/rel/sq-x-plan.md"; : > "$STUB_LOG"
(cd "$TMP/rel" && "$A" sq.json sq-x-plan.md 'leadwt::/tmp/x' >/dev/null 2>&1); eq "relative paths exit 0" "$?" "0"
RABS="$(cd "$TMP/rel" && pwd -P)/sq-x-plan.md"
eq "relative plan: report-path is absolute" "$(grep -c "report-path=$RABS\$" "$STUB_LOG")" "1"
eq "relative plan: no relative report-path" "$(grep -c 'report-path=[^/]' "$STUB_LOG")" "0"
case "$(jq -r '.approved_plans[0]' "$TMP/rel/sq.json")" in /*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: approved_plans[0] not absolute" >&2;; esac

# Refusal: a plan register-plan rejects stops before anything changes.
mkstate "$TMP/r.json"; cp "$TMP/r.json" "$TMP/r-before.json"
printf '# T\n\n- U1 -- alpha work -- deps: none\n' > "$TMP/r-x-plan.md"; : > "$STUB_LOG"
"$A" "$TMP/r.json" "$TMP/r-x-plan.md" 'leadwt::/tmp/x' >/dev/null 2>&1; eq "bad plan -> 1" "$?" "1"
cmp -s "$TMP/r-before.json" "$TMP/r.json"; eq "refused plan leaves state byte-identical" "$?" "0"
eq "refused plan leaves framing alone" "$(jq -r '.framing // "none"' "$TMP/r.json")" "none"
eq "refused plan sends no handoff" "$(grep -c '^send-worker' "$STUB_LOG")" "0"

# Idempotent re-run: no duplicate approval, handoff re-sent.
mkstate "$TMP/i.json"; goodplan "$TMP/i-x-plan.md"; : > "$STUB_LOG"
"$A" "$TMP/i.json" "$TMP/i-x-plan.md" 'leadwt::/tmp/x' >/dev/null 2>&1
out="$("$A" "$TMP/i.json" "$TMP/i-x-plan.md" 'leadwt::/tmp/x' 2>&1)"; eq "re-run exits 0" "$?" "0"
eq "framing not duplicated on re-run" "$(jq -r .framing "$TMP/i.json" | grep -o 'operator approved' | wc -l | tr -d ' ')" "1"
eq "approval not duplicated" "$(jq -r '.approved_plans | length' "$TMP/i.json")" "1"
eq "handoff re-sent" "$(grep -c '^send-worker' "$STUB_LOG")" "2"
eq "re-run claims no resolve" "$(printf '%s' "$out" | grep -c "no open 'plan-x' question to resolve")" "1"

# A question asked under a different id stays open, loudly: approval still records and the
# handoff still goes, but nothing claims the question was resolved.
printf '{"run_id":"run_1","status":"waiting-on-you","waiting_on_you":[{"id":"plan-other","asker":"thinker","blocking":true,"question":"Approve?"}],"approved_plans":[],"units":[]}' > "$TMP/m.json"
goodplan "$TMP/m-x-plan.md"; : > "$STUB_LOG"
out="$("$A" "$TMP/m.json" "$TMP/m-x-plan.md" 'leadwt::/tmp/x' 2>&1)"; eq "mismatched id still exits 0" "$?" "0"
eq "plan approved despite mismatch" "$(jq -r '.approved_plans | length' "$TMP/m.json")" "1"
eq "other question left open" "$(jq -r '.waiting_on_you[0].id' "$TMP/m.json")" "plan-other"
eq "squad still waiting" "$(jq -r .status "$TMP/m.json")" "waiting-on-you"
eq "mismatch warns" "$(printf '%s' "$out" | grep -c "warning: no open question 'plan-x'")" "1"
eq "handoff sent despite mismatch" "$(grep -c '^send-worker' "$STUB_LOG")" "1"
eq "handoff claims no resolve" "$(grep -c "no open 'plan-x' question to resolve" "$STUB_LOG")" "1"

# lfg never asked, so a missing question is silent.
printf '{"run_id":"run_1","status":"running","autonomy":"lfg","waiting_on_you":[],"approved_plans":[],"units":[]}' > "$TMP/l.json"
goodplan "$TMP/l-x-plan.md"
out="$("$A" "$TMP/l.json" "$TMP/l-x-plan.md" 'leadwt::/tmp/x' 2>&1)"; eq "lfg exits 0" "$?" "0"
eq "lfg warns nothing" "$(printf '%s' "$out" | grep -c 'warning:')" "0"
eq "lfg records approval" "$(jq -r '.approved_plans | length' "$TMP/l.json")" "1"

# Another open question survives with the squad still waiting.
printf '{"run_id":"run_1","status":"waiting-on-you","waiting_on_you":[{"id":"plan-x","asker":"thinker","blocking":true,"question":"Approve?"},{"id":"q-builder","asker":"builder-u1","blocking":true,"question":"Which API?"}],"approved_plans":[],"units":[]}' > "$TMP/w.json"
goodplan "$TMP/w-x-plan.md"
"$A" "$TMP/w.json" "$TMP/w-x-plan.md" 'leadwt::/tmp/x' >/dev/null 2>&1; eq "second question exits 0" "$?" "0"
eq "approval question cleared" "$(jq -r '[.waiting_on_you[] | select(.id == "plan-x")] | length' "$TMP/w.json")" "0"
eq "other question kept" "$(jq -r '[.waiting_on_you[] | select(.id == "q-builder")] | length' "$TMP/w.json")" "1"
eq "squad still waiting on the other question" "$(jq -r .status "$TMP/w.json")" "waiting-on-you"

# U3 (thinker-start-triage): re-approving a plan after a resume leaves its "revalidate after resume"
# holds for the Lead's register-plan (squad-state.sh 7o(h)), so nothing goes on the old deps.
goodplan "$TMP/v-x-plan.md"
jq -n --arg p "$TMP/v-x-plan.md" '{run_id:"run_1",status:"running",waiting_on_you:[],approved_plans:[$p],units:[
  {slug:"u1-alpha",status:"planned",plan:$p,plan_unit:"U1",deps:[],hold:true,hold_reason:"revalidate after resume"}]}' > "$TMP/v.json"
"$A" "$TMP/v.json" "$TMP/v-x-plan.md" 'leadwt::/tmp/x' >/dev/null 2>&1; eq "revalidated plan exits 0" "$?" "0"
eq "the hold waits for register-plan" "$(jq -r '.units[0] | "\(.hold) \(.hold_reason)"' "$TMP/v.json")" "true revalidate after resume"
eq "approval marks it revalidated" "$(jq -r '.units[0].revalidated' "$TMP/v.json")" "true"

echo "approve-handoff: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
