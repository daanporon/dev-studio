#!/usr/bin/env bash
# review-unit.sh — part of the review-unit suite (U233): limits, receipts, severity and Muse fallbacks. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"

# U197: -h/--help prints the usage and starts no review; any other leading dash
# is rejected before the project is read. None of these starts an engine or a
# state/<label>/ folder.
help_pre="$([ -e "$ROOT/state/--help" ] && echo present || echo absent)"
: > "$CLAUDE_LOG"
out="$("$RU" --help 2>"$TMP/help.err")"; rc=$?
check "--help exits 0" "0" "$rc"
has "--help prints the usage on stdout" "$out" 'usage: review-unit.sh <project>'
has "--help prints the short description on stdout" "$out" "run a Builder's code review on the review model"
check "--help prints nothing on stderr" "" "$(cat "$TMP/help.err")"
check "--help launches no reviewer" "" "$(cat "$CLAUDE_LOG")"
check "--help creates no state/--help folder" "$help_pre" "$([ -e "$ROOT/state/--help" ] && echo present || echo absent)"
: > "$CLAUDE_LOG"; out="$("$RU" -h 2>"$TMP/help.err")"; rc=$?
check "'-h' exits 0" "0" "$rc"
has "'-h' prints the usage on stdout" "$out" 'usage: review-unit.sh <project>'
check "'-h' launches no reviewer" "" "$(cat "$CLAUDE_LOG")"
: > "$CLAUDE_LOG"; out="$("$RU" acme --help 2>"$TMP/help.err")"; rc=$?
check "'acme --help' exits 0" "0" "$rc"
has "'acme --help' prints the usage on stdout" "$out" 'usage: review-unit.sh <project>'
check "'acme --help' launches no reviewer" "" "$(cat "$CLAUDE_LOG")"
check "'acme --help' creates no state folder" "$help_pre" "$([ -e "$ROOT/state/--help" ] && echo present || echo absent)"
full_pre="$([ -e "$ROOT/state/--full" ] && echo present || echo absent)"
: > "$CLAUDE_LOG"; out="$("$RU" --full x 2>"$TMP/help.err")"; rc=$?
check "a flag as the first argument exits 2" "2" "$rc"
has "a flag as the first argument names the project position" "$(cat "$TMP/help.err")" "the first argument is the project, got '--full'"
check "a flag as the first argument prints nothing on stdout" "" "$out"
check "a flag as the first argument launches no reviewer" "" "$(cat "$CLAUDE_LOG")"
check "a flag as the first argument creates no state folder" "$full_pre" "$([ -e "$ROOT/state/--full" ] && echo present || echo absent)"

# Default roster, no tier in any squad state: the unit counts as standard, so the
# review runs on builder-review-standard (sonnet, medium effort), report-only, no
# base: when no base-ref is given.
rm -f "$RFILE"
: > "$CLAUDE_LOG"; out="$(echo LEAK | run_ru "$LBL")"
check "prints the review's JSON verdict" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
has   "default review model is sonnet"      "$(args)" "--model sonnet "
has   "runs ce-code-review report-only"     "$(args)" "ce-code-review mode:agent"
lacks "a first review narrows no reviewer"  "$(args)" "Run only these reviewers"
lacks "no base: without a base-ref"         "$(args)" "base:"
has   "the standard row's effort is passed" "$(args)" "--effort medium"
has   "skips local settings (rewake hook)"  "$(args)" "--setting-sources user,project"
check "does not post as the Builder"        "handle:" "$(grep '^handle:' "$CLAUDE_LOG")"
check "stdin is closed, not inherited"      "stdin:" "$(grep '^stdin:' "$CLAUDE_LOG")"

# U229: the headless session gets the review role's skill list as one --settings JSON; a failing
# resolve starts it with every skill (no --settings) and says so.
printf '#!/bin/sh\n[ "$2" = review ] || exit 2\necho "{\\"dataviz\\":\\"off\\"}"\n' > "$TMP/resolve-ok"; chmod +x "$TMP/resolve-ok"
printf '#!/bin/sh\nexit 1\n' > "$TMP/resolve-bad"; chmod +x "$TMP/resolve-bad"
: > "$CLAUDE_LOG"; DS_SKILLS_RESOLVE="$TMP/resolve-ok" run_ru "$LBL" >/dev/null 2>&1 || true
has   "review role skill list: one --settings" "$(args)" '--settings {"skillOverrides":{"dataviz":"off"}}'
: > "$CLAUDE_LOG"; DS_SKILLS_RESOLVE="$TMP/resolve-bad" run_ru "$LBL" >/dev/null 2>"$TMP/ss-err" || true
lacks "failing resolve: no --settings"        "$(args)" "--settings"
has   "failing resolve: still ran the review" "$(args)" "ce-code-review mode:agent"
has   "failing resolve logs one line"         "$(cat "$TMP/ss-err")" "skill list unavailable"
printf '#!/bin/sh\n[ "$2" = review ] || exit 2\necho "{\\"skillOverrides\\":{\\"dataviz\\":\\"off\\"},\\"mcp\\":{},\\"deniedMcpServers\\":[{\\"serverName\\":\\"linear-server\\"}]}"\n' > "$TMP/resolve-mcp"; chmod +x "$TMP/resolve-mcp"
: > "$CLAUDE_LOG"; DS_SKILLS_RESOLVE="$TMP/resolve-mcp" run_ru "$LBL" >/dev/null 2>&1 || true
has   "review role MCP: deniedMcpServers in the one --settings" "$(args)" '--settings {"skillOverrides":{"dataviz":"off"},"deniedMcpServers":[{"serverName":"linear-server"}]}'
# review-unit-no-receipt U1: the plugins the review role has off ride in the same --settings as enabledPlugins;
# with the real resolver over the shipped skills.conf that is the context-mode plugin (its hooks stubbed long output).
printf '#!/bin/sh\n[ "$2" = review ] || exit 2\necho "{\\"skillOverrides\\":{},\\"mcp\\":{},\\"deniedMcpServers\\":[],\\"plugins\\":{\\"p@m\\":\\"off\\"},\\"enabledPlugins\\":{\\"p@m\\":false}}"\n' > "$TMP/resolve-plugin"; chmod +x "$TMP/resolve-plugin"
: > "$CLAUDE_LOG"; DS_SKILLS_RESOLVE="$TMP/resolve-plugin" run_ru "$LBL" >/dev/null 2>&1 || true
has   "review role plugins: enabledPlugins alone still make a --settings" "$(args)" '--settings {"enabledPlugins":{"p@m":false}}'
: > "$CLAUDE_LOG"; DS_SKILLS_RESOLVE="$ROOT/bin/ds skills resolve" run_ru "$LBL" >/dev/null 2>&1 || true
has   "review role plugins: the shipped rules turn context-mode off" "$(args)" '"enabledPlugins":{"context-mode@context-mode":false}'

# The clean run above stamped a receipt for HEAD: sha, epoch, base, finding count, engine.
check "a clean run writes the receipt" "present" "$([ -f "$RFILE" ] && echo present || echo absent)"
check "the receipt stamps HEAD's sha" "$(head_sha)" "$(cut -f1 "$RFILE")"
check "the receipt has 6 tab fields" "6" "$(awk -F'\t' '{print NF; exit}' "$RFILE")"
check "the receipt names the claude engine" "claude:sonnet" "$(cut -f5 "$RFILE")"
check "no base-ref records -" "-" "$(cut -f3 "$RFILE")"
check "no findings records count 0" "0" "$(cut -f4 "$RFILE")"
case "$(cut -f2 "$RFILE")" in *[!0-9]*|"") fail=$((fail+1)); echo "FAIL: the receipt epoch is not numeric [$(cut -f2 "$RFILE")]" >&2;; *) pass=$((pass+1));; esac

: > "$CLAUDE_LOG"; run_ru "$LBL" origin/main >/dev/null
has "base-ref becomes base:<ref>" "$(args)" "ce-code-review mode:agent base:origin/main"
check "the base-ref is recorded" "origin/main" "$(cut -f3 "$RFILE")"

# Severity policy partitions complete, proof-bearing reports without changing receipt fields.
split_report='{"status":"complete","actionable_findings":[{"title":"normal P2","severity":"P2","file":"src/plain.ts","line":4},{"title":"normal P1","severity":"P1","file":"src/plain.ts","line":7},{"title":"risky P2","severity":"P2","file":"contracts/token.sol","line":9},{"title":"missing severity","file":"src/plain.ts"},{"title":"unknown severity","severity":"urgent","file":"src/plain.ts"}]}'
split_run() {
  out="$(STUB_OUT="$split_report" run_ru "$LBL" origin/main 2>"$TMP/split.err")"
  split_dir="$(jq -r '.artifact_path' <<<"$out")"
}
split_titles() { jq -c 'map(.title)' "$split_dir/$1-findings.json" 2>/dev/null || true; }
split_run
check "default P1 blocks P1 and unknown severities" '["normal P1","missing severity","unknown severity"]' "$(split_titles blocking)"
check "default P1 notes P2" '["normal P2","risky P2"]' "$(split_titles noted)"
has "blocking count and severities on stderr" "$(cat "$TMP/split.err")" 'review-unit: blocking 3 (P1,unknown)'
has "noted count on stderr" "$(cat "$TMP/split.err")" 'review-unit: noted 2'
has "partition paths on stderr" "$(cat "$TMP/split.err")" "$split_dir/noted-findings.json"
check "split receipt still counts all actionable findings" '5' "$(cut -f4 "$RFILE")"
check "split receipt remains six fields with proof" '6:proof=1' "$(awk -F'\t' '{print NF ":" $6}' "$RFILE")"
DS_LIMIT_REVIEW_RISK_PATHS='auth/*,contracts/*.sol' split_run
check "risky P2 blocks with comma globs" '["normal P1","risky P2","missing severity","unknown severity"]' "$(split_titles blocking)"
check "only ordinary P2 noted when risky" '["normal P2"]' "$(split_titles noted)"
DS_LIMIT_REVIEW_BLOCK_SEVERITY=P2 split_run
check "project can block ordinary P2" '[]' "$(split_titles noted)"
DS_LIMIT_REVIEW_BLOCK_SEVERITY=P0 DS_LIMIT_REVIEW_BLOCK_SEVERITY_RISKY=P3 DS_LIMIT_REVIEW_RISK_PATHS='contracts/*' split_run
check "ordinary and risky thresholds independent" '["risky P2","missing severity","unknown severity"]' "$(split_titles blocking)"
for setting in 'REVIEW_BLOCK_SEVERITY=oops' 'REVIEW_BLOCK_SEVERITY_RISKY=P4' 'REVIEW_RISK_PATHS=auth/*,,contracts/*' 'REVIEW_RISK_PATHS=has space'; do
  key="${setting%%=*}"; value="${setting#*=}"; rc=0; : > "$CLAUDE_LOG"
  (export "DS_LIMIT_$key=$value"; run_ru "$LBL") >"$TMP/bad.out" 2>"$TMP/bad.err" || rc=$?
  check "invalid $key refuses before review" 2 "$rc"
  check "invalid $key launches no reviewer" '' "$(cat "$CLAUDE_LOG")"
  has "invalid $key names key" "$(cat "$TMP/bad.err")" "${key,,}"
done

# A project override changes the model and effort.
# U267: a project roster overrides per role, so each one below sets builder-review-standard to its
# builder-review row too (sed), or an untiered unit would review on the default's standard row.
mkdir -p "$SD"; printf 'lead claude sonnet always\nbuilder-review claude fable elevate high\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
: > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null
has "override model is used"   "$(args)" "--model fable "
has "override effort is used"  "$(args)" "--effort high"

# An unsupported agent is refused before anything runs.
printf 'builder-review quux gpt elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
: > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "unsupported review agent exits 2" "2" "$rc"
check "claude never called"             "0" "$(grep -c '^args:' "$CLAUDE_LOG")"

# Codex uses the host provider config and isolates its final report from progress.
printf 'builder-review codex gpt-6.1-sol elevate high muse:muse-spark-1.3:max\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
: > "$CLAUDE_LOG"; : > "$CODEX_LOG"
out="$(run_ru "$LBL" origin/main 2>"$TMP/err")"; rc=$?
check "Codex primary writes a receipt" "0" "$rc"
check "Codex prints only its final report" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "Codex receipt names its model" "codex:gpt-6.1-sol" "$(cut -f5 "$RFILE")"
has "Codex gets the selected model" "$(cat "$CODEX_LOG")" "--model gpt-6.1-sol"
has "Codex gets the selected effort" "$(cat "$CODEX_LOG")" "model_reasoning_effort=high"
has "Codex uses the same automation permissions as the other review engines" "$(cat "$CODEX_LOG")" "--dangerously-bypass-approvals-and-sandbox"
lacks "Codex keeps its configured provider" "$(cat "$CODEX_LOG")" "model_provider="
has "Codex receives the review prompt" "$(cat "$CODEX_LOG")" "ce-code-review skill with arguments: mode:agent base:origin/main"
check "Codex cannot message as its Builder" "handle:" "$(grep '^handle:' "$CODEX_LOG")"
check "Claude never runs for a Codex primary" "0" "$(grep -c '^args:' "$CLAUDE_LOG")"

# U108: Codex's run goes to ds-review.log in the git dir, not to stderr; only a failure shows its tail.
CLOG="$(dirname "$RFILE")/ds-review.log"
rm -f "$RFILE"; : > "$MUSE_LOG"
out="$(CODEX_LONG=300 run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a successful Codex run with a long log still passes" "0" "$rc"
check "a successful Codex run prints none of its log to stderr" "" "$(grep -c 'codex log line\|Codex progress' "$TMP/err" | grep -v '^0$')"
has "the Codex log is kept as ds-review.log" "$(cat "$CLOG")" "codex log line 300"
rm -f "$RFILE"
out="$(CODEX_LONG=300 CODEX_OUT='not a report' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
has "a failed Codex run prints the log tail" "$(cat "$TMP/err")" "codex log line 300"
lacks "a failed Codex run prints only the last 40 lines" "$(cat "$TMP/err")" "codex log line 200"
has "a failed Codex run names the log path" "$(cat "$TMP/err")" "$CLOG"
rm -f "$RFILE"; CODEX_LONG=5 run_ru "$LBL" >/dev/null 2>&1
check "the log is replaced each run" "0" "$(grep -c 'codex log line 300$' "$CLOG")"
# Review prose that talks about limits, even quoting Codex's message mid-line, is no limit.
rm -f "$RFILE"; : > "$MUSE_LOG"
out="$(CODEX_OUT='not a report' CODEX_EXIT=1 CODEX_ERR="$(printf 'the retry logic handles a usage limit and a weekly limit reached\nwe saw ERROR: usage_limit_reached in the fixture\nreport: You'"'"'ve hit your usage limit is quoted here')" MUSE_SKILLS='ce-code-review enabled on' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "limit prose in a Codex log does not start the fallback" "0" "$(grep -c '^args:' "$MUSE_LOG")"
rm -f "$RFILE"; : > "$MUSE_LOG"
out="$(CODEX_OUT='not a report' CODEX_EXIT=1 CODEX_ERR='ERROR: usage_limit_reached' MUSE_SKILLS='ce-code-review enabled on' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a real ERROR: limit line starts the fallback" "1" "$(grep -c '^args:' "$MUSE_LOG")"
rm -f "$RFILE"; : > "$MUSE_LOG"
out="$(CODEX_OUT='not a report' CODEX_EXIT=1 CODEX_ERR="ERROR: You've hit your usage limit. Upgrade to Pro or try again later." MUSE_SKILLS='ce-code-review enabled on' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "Codex's prefixed usage-limit message starts the fallback" "1" "$(grep -c '^args:' "$MUSE_LOG")"
check "Codex's prefixed usage-limit fallback completes" "0" "$rc"
rm -f "$RFILE"
rm -f "$RFILE"
out="$(CODEX_OUT='limit response' CODEX_ERR='ERROR: usage_limit_reached' CODEX_EXIT=1 MUSE_SKILLS='ce-code-review enabled on' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "Codex limit falls back to Muse" "0" "$rc"
check "Codex fallback receipt names Muse" "muse:muse-spark-1.3" "$(cut -f5 "$RFILE")"
has "fallback has its own effort" "$(cat "$MUSE_LOG")" "--reasoning-effort max"
rm -f "$RFILE"
out="$(CODEX_OUT='not a report' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "Codex without a report writes no receipt" "4" "$rc"
rm -f "$RFILE"
out="$(CODEX_DIRTY=1 run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "Codex mutation writes no receipt" "4" "$rc"
rm -f "$TMP/repo/dirtied-by-codex.txt"
printf 'builder-review claude opus elevate - codex:gpt-6.1-sol:high,muse:muse-spark-1.3\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
: > "$CODEX_LOG"; : > "$MUSE_LOG"
out="$(STUB_OUT="You've hit your limit" STUB_EXIT=1 MUSE_SKILLS='ce-code-review enabled on' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "Claude limit uses Codex before later Muse fallback" "0" "$rc"
check "Codex fallback receipt names Codex" "codex:gpt-6.1-sol" "$(cut -f5 "$RFILE")"
check "later Muse fallback was not used" "0" "$(grep -c '^args:' "$MUSE_LOG")"

# U134: a Muse quota error moves the review on to the next fallback; any other Muse failure stays
# a failure. MUSE_429 is the real line muse 1.4.14 wrote to stderr (exit 1, empty stdout) on 2026-11-07.
MUSE_429='agent loop failed: model failed: API error 429 [request_id=c86ddfaf-bf1a-4ce9-82a5-d46b1a13bcb7]: Subscription quota exhausted. Your usage window resets at 2026-11-09T00:00:00Z. (rate_limit_error)'
CLAUDE_LIM="You've hit your limit"
MUSE_ON='ce-code-review enabled on'
printf 'builder-review claude opus elevate - muse:muse-spark-1.3,codex:gpt-6.1-sol:medium\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
# muse_then_codex VAR=value… — Claude limited, then one review with those settings exported.
muse_then_codex() {
  rm -f "$RFILE"; : > "$CODEX_LOG"; : > "$MUSE_LOG"
  # shellcheck disable=SC2163 # "$@" holds VAR=value pairs, exported as given
  out="$(export STUB_OUT="$CLAUDE_LIM" STUB_EXIT=1 MUSE_SKILLS="$MUSE_ON" "$@"; run_ru "$LBL" 2>"$TMP/err")"; rc=$?
}
receipt_state() { [ -e "$RFILE" ] && echo present || echo absent; }
muse_then_codex MUSE_ERR="$MUSE_429"
check "a Muse quota error moves the review to Codex" "0" "$rc"
check "Muse ran once before Codex" "1" "$(grep -c '^args:' "$MUSE_LOG")"
check "Codex ran once after the Muse quota error" "1" "$(grep -c '^args:' "$CODEX_LOG")"
has "Codex keeps its roster effort" "$(cat "$CODEX_LOG")" "model_reasoning_effort=medium"
has "the retry log names Muse's matched error line" "$(cat "$TMP/err")" "headless muse is limited (matched: \"agent loop failed: model failed: API error 429"
has "Muse's error stays visible" "$(cat "$TMP/err")" "Subscription quota exhausted"
check "the receipt names Codex" "codex:gpt-6.1-sol" "$(cut -f5 "$RFILE")"
check "the Codex receipt carries proof" "proof=1" "$(cut -f6 "$RFILE")"
muse_then_codex MUSE_OUT="muse blew up" MUSE_EXIT=1
check "an ordinary Muse failure never reaches Codex" "0" "$(grep -c '^args:' "$CODEX_LOG")"
check "an ordinary Muse failure exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "an ordinary Muse failure writes no receipt" "absent" "$(receipt_state)"
muse_then_codex MUSE_OUT="partial review: the client logs API error 429 [request_id=x]: quota (rate_limit_error) and retries" MUSE_EXIT=1
check "Muse partial text quoting a 429 mid-line never reaches Codex" "0" "$(grep -c '^args:' "$CODEX_LOG")"
check "Muse partial text quoting a 429 writes no receipt" "absent" "$(receipt_state)"
muse_then_codex MUSE_ERR="tool output: agent loop failed: model failed: API error 429 (rate_limit_error)"
check "an unanchored 429 line on Muse's stderr never reaches Codex" "0" "$(grep -c '^args:' "$CODEX_LOG")"
muse_then_codex MUSE_OUT="partial review: the session hit your 5-hour limit and resets at 3pm" MUSE_EXIT=1
check "Muse limit prose never reaches Codex" "0" "$(grep -c '^args:' "$CODEX_LOG")"
check "Muse limit prose exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
muse_then_codex MUSE_ERR="agent loop failed: model failed: you hit your 5-hour limit, resets at 3pm"
check "a Muse error line without a 429 never reaches Codex" "0" "$(grep -c '^args:' "$CODEX_LOG")"
muse_then_codex MUSE_OUT="{\"status\":\"complete\",\"actionable_findings\":[{\"title\":\"handle $MUSE_429\"}]}" MUSE_EXIT=0
check "a complete Muse report quoting the error passes" "0" "$rc"
check "a complete Muse report quoting the error gets a Muse receipt" "muse:muse-spark-1.3" "$(cut -f5 "$RFILE")"
check "a complete Muse report quoting the error never reaches Codex" "0" "$(grep -c '^args:' "$CODEX_LOG")"
mkdir -p "$TMP/nocodex"
for stub in "$TMP"/*; do [ -f "$stub" ] && [ -x "$stub" ] && [ "${stub##*/}" != codex ] && ln -sf "$stub" "$TMP/nocodex/"; done
NOCODEX_PATH="$TMP/nocodex"
IFS=: read -r -a path_dirs <<< "$PATH"
for d in "${path_dirs[@]}"; do [ -x "$d/codex" ] || NOCODEX_PATH="$NOCODEX_PATH:$d"; done
muse_then_codex PATH="$NOCODEX_PATH" MUSE_ERR="$MUSE_429"
check "Muse limited with no codex binary exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "Muse limited with no codex binary writes no receipt" "absent" "$(receipt_state)"
has "Muse limited with no codex binary shows Muse's error" "$(cat "$TMP/err")" "Subscription quota exhausted"
muse_then_codex MUSE_ERR="$MUSE_429" CODEX_OUT='not a report' CODEX_ERR='ERROR: usage_limit_reached' CODEX_EXIT=1
check "Muse and Codex both limited: Muse ran once" "1" "$(grep -c '^args:' "$MUSE_LOG")"
check "Muse and Codex both limited: Codex ran once" "1" "$(grep -c '^args:' "$CODEX_LOG")"
check "Muse and Codex both limited exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "Muse and Codex both limited writes no receipt" "absent" "$(receipt_state)"
muse_then_codex MUSE_ERR="$MUSE_429" PROOF_CASE=missing-finish
check "Muse limited and Codex without valid proof: Codex ran" "1" "$(grep -c '^args:' "$CODEX_LOG")"
check "Muse limited and Codex without valid proof exits non-zero" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "Muse limited and Codex without valid proof writes no receipt" "absent" "$(receipt_state)"

# U267: an override without the review rows runs the default's (this untiered unit: builder-review-standard).
printf 'lead claude sonnet always\n' > "$SD/roles.conf"
: > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null
has "missing row runs the default's row" "$(args)" "--model $(awk '$1=="builder-review-standard"{print $3}' "$ROOT/conventions/roles.conf") "

# U282: a review-leaf row names the model for the merge, report and validator steps; the reviewers
# stay on the review row. No row, no leaf line.
printf 'builder-review claude opus elevate\nreview-leaf claude sonnet elevate - claude:opus\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
: > "$CLAUDE_LOG"; run_ru "$LBL" >/dev/null
has   "leaf row: the preamble names the leaf model" "$(args)" 'Run the merge, report and validator subagents on model `sonnet`'
has   "leaf row: reviewers stay on the review model" "$(args)" "--model opus "
has   "leaf row: the log line has leaf=sonnet" "$(tail -1 "$(dirname "$RFILE")/ds-review-log")" "leaf=sonnet"
printf 'builder-review codex gpt-6.1-sol elevate high\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
: > "$CODEX_LOG"; run_ru "$LBL" origin/main >/dev/null 2>&1
lacks "a Codex review names no leaf model" "$(cat "$CODEX_LOG")" "validator subagents"
printf 'lead claude sonnet always\n' > "$SD/roles.conf"

# claude's failure propagates and writes no receipt.
rm -f "$RFILE"
STUB_EXIT=1 run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "a failing review exits non-zero" "1" "$rc"
check "a failing review writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"

# The finding count comes from the JSON; non-JSON output records ?.
rm -f "$RFILE"
STUB_OUT='{"status":"complete","actionable_findings":[{},{"x":1}]}' run_ru "$LBL" >/dev/null
check "two findings record count 2" "2" "$(cut -f4 "$RFILE")"
out="$(STUB_OUT='{"status":"complete","actionable_findings":[{},{"x":1}]}' run_ru "$LBL")"
check "stdout still carries the JSON" '{"status":"complete","actionable_findings":[{},{"x":1}]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
rm -f "$RFILE"
: > "$CLAUDE_LOG"
out="$(STUB_OUT='not json at all' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "non-JSON output now exits 4 (no receipt)"        "4" "$rc"
has   "non-JSON output still prints"          "$out" "not json at all"
check "non-JSON output writes no receipt"    "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
check "non-JSON output retries the reviewer once" "2" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "non-JSON output names the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD"

# U162: the skill's background reviewers can end the first turn; the report comes in a later turn.
rm -f "$RFILE"
out="$(STUB_FIRST_TURN='Correctness and security are still reviewing. I will collect them when they report back.' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a report in a later turn gets a receipt" "0" "$rc"
check "a report in a later turn is the output" "complete" "$(jq -r .status <<<"$out")"
check "a report in a later turn writes the receipt" "present" "$(receipt_state)"
rm -f "$RFILE"
out="$(STUB_TRAILING_TURN='All done, the report is above.' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a report followed by closing prose still gets a receipt" "0" "$rc"
rm -f "$RFILE"
: > "$CLAUDE_LOG"
out="$(STUB_OUT='still reviewing, nothing yet' STUB_FIRST_TURN='working on it' run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a stream of prose only exits 4" "4" "$rc"
has   "a stream of prose only names the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD"
check "a stream of prose only retries the reviewer once" "2" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "a stream of prose only prints the last text" "$out" "still reviewing, nothing yet"
check "a stream of prose only writes no receipt" "absent" "$(receipt_state)"

# A dirty worktree gets the review but no receipt, plus the warning.
rm -f "$RFILE"
echo dirty > "$TMP/repo/uncommitted.txt"
out="$(run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a dirty tree now exits 4 (no receipt)" "4" "$rc"
check "a dirty tree still prints the JSON" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "a dirty tree writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has "a dirty tree warns" "$(cat "$TMP/err")" "review-unit: uncommitted changes — reviewed, but no receipt written; commit and re-run"
rm -f "$TMP/repo/uncommitted.txt"

LIMIT_MSG="You've hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)"
CE_ROW="$(printf 'ce-code-review\tuser\ton\tdesc\tpath')"
OTHER_ROW="$(printf 'composio-cli\tuser\ton\tdesc\tpath')"
printf 'builder-review claude opus elevate - muse:muse-spark-1.3\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"

rm -f "$RFILE"
: > "$CLAUDE_LOG"; : > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a limit failure falls back and exits 0" "0" "$rc"
check "the fallback prints the review JSON" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
has   "muse exec ran in the worktree"         "$(grep '^args:' "$MUSE_LOG" | tail -1)" "--workspace $TMP/repo"
has   "muse ran ce-code-review report-only"   "$(grep '^args:' "$MUSE_LOG" | tail -1)" "ce-code-review skill with arguments: mode:agent"
lacks "muse gets no base: without a base-ref" "$(grep '^args:' "$MUSE_LOG" | tail -1)" "base:"
check "muse does not post as the Builder"     "handle:" "$(grep '^handle:' "$MUSE_LOG")"
check "muse stdin is closed, not inherited"   "stdin:" "$(grep '^stdin:' "$MUSE_LOG")"
has   "the limit retry is announced"          "$(cat "$TMP/err")" "review-unit: headless claude is limited (matched: "
has   "the retry names the muse model"        "$(cat "$TMP/err")" "retrying the review via muse with ce-code-review on muse-spark-1.3"
has   "muse exec runs on the roster model"    "$(grep '^args:' "$MUSE_LOG" | tail -1)" "--model muse-spark-1.3 "
check "the fallback run stamps the receipt"   "present" "$([ -f "$RFILE" ] && echo present || echo absent)"
check "the fallback receipt names muse"       "muse:muse-spark-1.3" "$(cut -f5 "$RFILE")"
check "claude was tried first"                "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "muse exec ran exactly once"            "1" "$(grep -c '^args:' "$MUSE_LOG")"

# A family alias on the row resolves to the newest catalog release before muse runs.
mkdir -p "$TMP/catalog"
printf '{"rows":[{"model_id":"muse-spark-1.2","visibility":"visible","release_date":"2026-08-05"},{"model_id":"muse-spark-1.3","visibility":"visible","release_date":"2026-09-02"}]}' > "$TMP/catalog/fx.json"
printf 'builder-review claude opus elevate - muse:muse-spark\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
rm -f "$RFILE"
: > "$MUSE_LOG"
STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" MUSE_MODEL_CATALOG_DIR="$TMP/catalog" run_ru "$LBL" >/dev/null 2>&1
has   "an alias row runs muse on the resolved id" "$(grep '^args:' "$MUSE_LOG" | tail -1)" "--model muse-spark-1.3 "
check "an alias row's receipt names the resolved id" "muse:muse-spark-1.3" "$(cut -f5 "$RFILE")"
printf 'builder-review claude opus elevate - muse:muse-spark-1.3\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"

rm -f "$RFILE"
: > "$MUSE_LOG"
STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" origin/main >/dev/null 2>&1
has   "base-ref reaches the muse prompt" "$(grep '^args:' "$MUSE_LOG" | tail -1)" "base:origin/main"
check "the base-ref is recorded"         "origin/main" "$(cut -f3 "$RFILE")"

printf 'builder-review claude opus elevate\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
rm -f "$RFILE"
: > "$CLAUDE_LOG"; : > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "no fallback: a limit failure exits non-zero" "1" "$rc"
check "muse is never called"                        "0" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
check "no receipt without a review"                 "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "the limit text still reaches stdout"         "$out" "$LIMIT_MSG"

printf 'builder-review claude opus elevate - muse:muse-spark-1.3\n' | sed '/^builder-review /{p;s//builder-review-standard /;}' > "$SD/roles.conf"
rm -f "$RFILE"
: > "$MUSE_LOG"
STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$OTHER_ROW" run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "no skill: a limit failure exits non-zero" "1" "$rc"
check "muse exec is never called"                "0" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
check "no receipt without a review"              "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"

rm -f "$RFILE"
: > "$MUSE_LOG"
STUB_OUT="boom: something broke" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "a non-limit failure exits non-zero" "1" "$rc"
check "muse is never called"               "0" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
check "no receipt on failure"              "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"

rm -f "$RFILE"
: > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_OUT="muse blew up" MUSE_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>/dev/null)"; rc=$?
check "a failing fallback exits non-zero" "1" "$rc"
check "the fallback error reaches stdout" "muse blew up" "$out"
check "no receipt on fallback failure"    "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"

rm -f "$RFILE"
echo dirty > "$TMP/repo/uncommitted.txt"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a dirty fallback tree now exits 4 (no receipt)"         "4" "$rc"
check "a dirty fallback tree still prints the JSON" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "a dirty fallback tree writes no receipt"     "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "a dirty fallback tree warns"                 "$(cat "$TMP/err")" "review-unit: uncommitted changes — reviewed, but no receipt written; commit and re-run"
rm -f "$TMP/repo/uncommitted.txt"

# Review JSON that merely mentions limits is content, not a limit announcement.
rm -f "$RFILE"
: > "$MUSE_LOG"
STUB_OUT='{"status":"complete","actionable_findings":[{"title":"handle the hit your weekly limit error"}]}' STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "limit words inside review JSON exit non-zero" "1" "$rc"
check "muse is never called for content"             "0" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
check "no receipt without a review"                  "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"

# A large skill listing still routes: the probe captures before matching, no SIGPIPE race.
rm -f "$RFILE"
: > "$MUSE_LOG"
BIG_SKILLS="$(printf '%s\n%s' "$CE_ROW" "$(yes 'padding-row user on desc path' | head -n 3000)")"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$BIG_SKILLS" run_ru "$LBL" 2>/dev/null)"; rc=$?
check "a large listing still falls back"       "0" "$rc"
check "the fallback still prints the JSON"     '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "the fallback run stamps the receipt"    "present" "$([ -f "$RFILE" ] && echo present || echo absent)"

# A disabled ce-code-review is not usable: no fallback run.
rm -f "$RFILE"
: > "$MUSE_LOG"
OFF_ROW="$(printf 'ce-code-review\tuser\toff\tdesc\tpath')"
STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$OFF_ROW" run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "a disabled skill exits non-zero" "1" "$rc"
check "muse exec is never called"       "0" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
check "no receipt without a review"     "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"

# A fallback run that dirties the tree gets the review but no receipt, plus the warning.
rm -f "$RFILE"
: > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_DIRTY=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a mutating fallback now exits 4 (no receipt)"         "4" "$rc"
check "a mutating fallback still prints the JSON" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "a mutating fallback writes no receipt"     "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "a mutating fallback warns"                 "$(cat "$TMP/err")" "review-unit: uncommitted changes — reviewed, but no receipt written; commit and re-run"
rm -f "$TMP/repo/dirtied-by-muse.txt"

# Claude's own diagnostics survive the retry: they are shown before the fallback runs.
rm -f "$RFILE"
: > "$MUSE_LOG"
STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 STUB_ERR="claude-diagnostic-marker" MUSE_SKILLS="$CE_ROW" run_ru "$LBL" >/dev/null 2>"$TMP/err"
has "claude stderr survives the retry" "$(cat "$TMP/err")" "claude-diagnostic-marker"
has "the retry is still announced"     "$(cat "$TMP/err")" "retrying the review via muse"

# Only a real limit notice routes: a bare "limit" needs a qualifier or "your", and must end
# at a word boundary. Each of these is an ordinary claude failure — no muse, no receipt.
# (Each fails if the qualifier is made optional again or the word boundary is dropped.)
for NOTICE in "tool result exceeded the size limit" "diff exceeded the file limit" "context window limit exceeded" "reached the max-turns limit" "the rate limiter was exceeded (HTTP 429 from upstream)"; do
  rm -f "$RFILE"
  : > "$MUSE_LOG"
  STUB_OUT="$NOTICE" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" >/dev/null 2>&1; rc=$?
  check "a non-limit failure exits non-zero [$NOTICE]" "1" "$rc"
  check "muse is never called [$NOTICE]"               "0" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
  check "no receipt [$NOTICE]"                         "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
done

# A partial review that only quotes the 429 strings is not a limit: no colon-free 429 or
# bare rate_limit_error routes (that text is Muse's own error, never claude's).
for NOTICE in "Partial review: bin/review/review-unit.sh:57 now matches rate_limit_error" "Partial review: the stub prints API error 429"; do
  rm -f "$RFILE"
  : > "$MUSE_LOG"
  STUB_OUT="$NOTICE" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" >/dev/null 2>&1; rc=$?
  check "a partial review exits non-zero [$NOTICE]" "1" "$rc"
  check "muse is never called [$NOTICE]"            "0" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
done

# The real notices still route, and the retry line names the text that matched.
for NOTICE in "You've hit your limit - resets 3pm|hit your limit" "You've hit your limit · resets 3pm|hit your limit" "You've hit your weekly limit · resets 8pm|hit your weekly limit" "You've hit your Opus limit · resets 8pm|hit your Opus limit" 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}|API Error: 429'; do
  MATCH="${NOTICE#*|}"; NOTICE="${NOTICE%%|*}"
  rm -f "$RFILE"
  : > "$MUSE_LOG"
  STUB_OUT="$NOTICE" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" >/dev/null 2>"$TMP/err"; rc=$?
  check "a limit notice routes via muse [$NOTICE]" "0" "$rc"
  check "muse exec ran [$NOTICE]"                  "1" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
  has   "the retry names the matched text [$NOTICE]" "$(cat "$TMP/err")" "(matched: \"$MATCH"
done

# Every catalogued limit shape routes: 5-hour, Opus, and Claude's 429 notice (bin/backend/orca.sh LIMIT_RE).
for NOTICE in "5-hour limit reached ∙ resets 3pm" "You've hit your Opus limit · resets Oct 31, 8pm" "API Error: 429"; do
  rm -f "$RFILE"
  : > "$MUSE_LOG"
  out="$(STUB_OUT="$NOTICE" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>/dev/null)"; rc=$?
  check "notice routes via muse [$NOTICE]" "0" "$rc"
  check "the fallback prints the JSON [$NOTICE]" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
  check "muse exec ran [$NOTICE]" "1" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"
done

# A fallback that exits 0 without a review report stamps no receipt.
rm -f "$RFILE"
: > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_OUT="a prose summary, not the report" MUSE_EXIT=0 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a report-less fallback now exits 4 (no receipt)"     "4" "$rc"
has   "the prose reaches stdout"                  "$out" "a prose summary, not the report"
check "a report-less fallback writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
check "a report-less fallback retries the reviewer once" "2" "$(grep -c '^args:' "$MUSE_LOG")"
has   "a report-less fallback names the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD"

# status.showUntrackedFiles=no must not blind the guards: a mutating fallback still gets no receipt.
rm -f "$RFILE"
: > "$MUSE_LOG"
git -C "$TMP/repo" config status.showUntrackedFiles no
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_DIRTY=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a blinded mutating fallback now exits 4 (no receipt)"         "4" "$rc"
check "a blinded mutating fallback still prints the JSON" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "a blinded mutating fallback writes no receipt"     "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "a blinded mutating fallback warns"                 "$(cat "$TMP/err")" "review-unit: uncommitted changes — reviewed, but no receipt written; commit and re-run"
git -C "$TMP/repo" config --unset status.showUntrackedFiles
rm -f "$TMP/repo/dirtied-by-muse.txt"

# The unqualified catalogued notice routes too.
rm -f "$RFILE"
: > "$MUSE_LOG"
out="$(STUB_OUT="You've hit your limit - resets 3pm" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>/dev/null)"; rc=$?
check "an unqualified notice routes via muse" "0" "$rc"
check "the fallback prints the JSON"         '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "muse exec ran"                        "1" "$(grep -c '^args:' "$MUSE_LOG" 2>/dev/null || true)"

# A non-complete report from the fallback stamps no receipt.
rm -f "$RFILE"
: > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_OUT='{"status":"incomplete","actionable_findings":[]}' MUSE_EXIT=0 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a non-complete report now exits 4 (no receipt)"     "4" "$rc"
has   "the report reaches stdout"               "$out" '{"status":"incomplete","actionable_findings":[]}'
check "a non-complete report writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
check "a non-complete report retries the reviewer once" "2" "$(grep -c '^args:' "$MUSE_LOG")"
has   "a non-complete report names the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD"

# A commit landing mid-review withholds the receipt with the moved-HEAD warning.
rm -f "$RFILE"
: > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_COMMIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a mid-review commit now exits 4 (no receipt)"         "4" "$rc"
check "a mid-review commit still prints the JSON" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "a mid-review commit writes no receipt"     "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "a mid-review commit names the cause"       "$(cat "$TMP/err")" "review-unit: HEAD changed during the review — no receipt written; re-run review-unit.sh"

# A failed replacement retains a legacy receipt for history; finish-unit refuses it.
printf 'deadbeef\t1\t-\t0\n' > "$RFILE"
echo dirty > "$TMP/repo/uncommitted.txt"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a legacy receipt stays unchanged" "deadbeef" "$(cut -f1 "$RFILE")"
rm -f "$RFILE"
rm -f "$TMP/repo/uncommitted.txt"

# A stream of several JSON values is not one review report, even ending complete.
rm -f "$RFILE"
: > "$MUSE_LOG"
TWO_JSON="$(printf '{"status":"running"}\n{"status":"complete","actionable_findings":[]}')"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_OUT="$TWO_JSON" MUSE_EXIT=0 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a multi-object stream now exits 4 (no receipt)"     "4" "$rc"
check "a multi-object stream writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
check "a multi-object stream retries the reviewer once" "2" "$(grep -c '^args:' "$MUSE_LOG")"
has   "a multi-object stream names the skipped skill" "$(cat "$TMP/err")" "reviewer answered without running ce-code-review (no run folder for HEAD"

# A cache file the reviewer writes under an ignored directory never ships: the receipt stands.
printf 'node_modules/\n' > "$TMP/repo/.gitignore"
git -C "$TMP/repo" -c user.email=t@t -c user.name=t add .gitignore >/dev/null
git -C "$TMP/repo" -c user.email=t@t -c user.name=t commit -q -m "ignore fixture files" >/dev/null
rm -f "$RFILE"
: > "$MUSE_LOG"
out="$(STUB_OUT="$LIMIT_MSG" STUB_EXIT=1 MUSE_IGNORED=1 MUSE_SKILLS="$CE_ROW" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "an ignored cache write still exits 0"         "0" "$rc"
check "an ignored cache write still prints the JSON" '{"status":"complete","actionable_findings":[]}' "$(jq -c '{status,actionable_findings}' <<<"$out")"
check "an ignored cache write keeps the receipt"     "$(head_sha)" "$(cut -f1 "$RFILE" 2>/dev/null)"
lacks "an ignored cache write does not warn"         "$(cat "$TMP/err")" "no receipt written"

# A receipt the reviewer wrote itself never survives a run that stamps nothing.
rm -rf "$RFILE" "$TMP/repo/node_modules"
out="$(STUB_RECEIPT=1 STUB_OUT="a prose summary" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a self-written receipt on prose now exits 4 (no receipt)" "4" "$rc"
check "a self-written receipt on prose is removed"    "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
STUB_RECEIPT=1 STUB_EXIT=1 STUB_OUT="boom" run_ru "$LBL" >/dev/null 2>&1
check "a self-written receipt on failure is removed"  "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
echo dirty > "$TMP/repo/uncommitted.txt"
STUB_RECEIPT=1 run_ru "$LBL" >/dev/null 2>&1
check "a self-written receipt on a dirty tree is removed" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
rm -f "$TMP/repo/uncommitted.txt"

# The report's .scope.head_sha must name the stamped sha (an abbreviation is fine).
H="$(head_sha)"
rm -f "$RFILE"
out="$(STUB_OUT="{\"status\":\"complete\",\"scope\":{\"head_sha\":\"0123456789abcdef0123456789abcdef01234567\"},\"actionable_findings\":[]}" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a report for another sha now exits 4 (no receipt)"     "4" "$rc"
check "a report for another sha writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "a report for another sha says so"           "$(cat "$TMP/err")" "scope.head_sha is missing or does not match HEAD $H"
STUB_OUT="{\"status\":\"complete\",\"scope\":{\"head_sha\":\"$H\"},\"actionable_findings\":[]}" run_ru "$LBL" >/dev/null 2>&1
check "a report for HEAD stamps the receipt" "$H" "$(cut -f1 "$RFILE" 2>/dev/null)"
rm -f "$RFILE"
STUB_OUT="{\"status\":\"complete\",\"scope\":{\"head_sha\":\"${H:0:7}\"},\"actionable_findings\":[]}" run_ru "$LBL" >/dev/null 2>&1
check "an abbreviated HEAD sha stamps the receipt" "$H" "$(cut -f1 "$RFILE" 2>/dev/null)"
rm -f "$RFILE"
STUB_OUT="{\"status\":\"complete\",\"scope\":{\"head_sha\":\"${H:0:3}\"},\"actionable_findings\":[]}" run_ru "$LBL" >/dev/null 2>&1
check "a too-short sha writes no receipt" "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"


echo "review-unit: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
