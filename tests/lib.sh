#!/usr/bin/env bash
# Shared test helpers. Tests stop processes ONLY through stop_own — never pkill/killall: a broad
# kill takes down the live boards on the host (guarded by tests/no-broad-kill.sh).
#
# When EXECUTED directly, this also runs the suite for pr_health (prHealthLine in bin/lib/lib.ts) against
# tests/fixtures/pr-health/*.json — the same fixtures tests/finish-unit.sh uses.

# stop_own <pid>: stop one process this test started (TERM, then wait for it). Never a pattern.
stop_own() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# Sourced by other tests for stop_own — the pr_health suite below runs only when
# this file is executed directly.
if [ "${BASH_SOURCE[0]:-}" != "${0:-}" ]; then
  # shellcheck disable=SC2317  # sourced by other tests: return lands there; exit covers a failed return
  return 0 2>/dev/null || exit 0
fi

# pr_health <owner/repo> <pr> -> "<verdict>\t<reasons>" from one stubbed `gh api
# graphql` call (GH_HEALTH holds the GraphQL response). Every verdict, every reason,
# required-only judging, zero checks, and the unknown paths.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/twins.sh
. "$ROOT/tests/lib/twins.sh"   # pr_health and ds_limit run their TypeScript twins (U274)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export STUB_DIR="$TMP" DS_GH="$TMP/gh" GH_HEALTH='' GH_FAIL=0
unset GH
cat > "$TMP/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_DIR/gh-calls"
if [ "${1:-}" = api ] && [ "${2:-}" = graphql ]; then
  [ "${GH_FAIL:-0}" = 1 ] && exit 1
  printf '%s' "${GH_HEALTH:-}"
fi
STUB
chmod +x "$TMP/gh"

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
run_raw() { # run_raw <graphql-response> — the plan's caller form, under set -e
  GH_HEALTH="$1"; export GH_HEALTH
  : > "$TMP/gh-calls"
  if out="$(pr_health "acme/widgets" "7")"; then rc=0; else rc="$?"; fi
}
run_ph() { run_raw "$(cat "$ROOT/tests/fixtures/pr-health/$1")"; }

TAB="$(printf '\t')"

for fx in "$ROOT"/tests/fixtures/pr-health/*.json; do
  if jq -e . "$fx" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: fixture $fx is not valid JSON" >&2; fi
done

# --- one call, carrying owner/name/number ------------------------------------------------
run_ph ready.json
eq "ready exits 0" "$rc" "0"
eq "ready prints an empty reason list" "$out" "ready$TAB"
eq "exactly one graphql call" "$(wc -l < "$TMP/gh-calls" | tr -d ' ')" "1"
has "the call carries the owner" "$(cat "$TMP/gh-calls")" "owner=acme"
has "the call carries the repo name" "$(cat "$TMP/gh-calls")" "name=widgets"
has "the call carries the PR number" "$(cat "$TMP/gh-calls")" "number=7"
has "the query selects reviewThreads" "$(cat "$TMP/gh-calls")" "reviewThreads"
has "the query selects isRequired" "$(cat "$TMP/gh-calls")" "isRequired"

# --- blocked: one reason each ----------------------------------------------------------------
run_ph failing-check.json
eq "failing required CheckRun exits 0" "$rc" "0"
eq "failing required CheckRun blocks" "$out" "blocked${TAB}checks-failing"
run_ph status-failing.json
eq "failing required StatusContext blocks" "$out" "blocked${TAB}checks-failing"
run_ph threads.json
eq "unresolved threads block with their count" "$out" "blocked${TAB}threads:2"
run_ph conflicting.json
eq "a conflict blocks" "$out" "blocked${TAB}conflicting"
run_ph behind.json
eq "a behind base blocks" "$out" "blocked${TAB}behind"
run_ph draft.json
eq "a draft blocks" "$out" "blocked${TAB}draft"
run_ph changes-requested.json
eq "changes requested blocks" "$out" "blocked${TAB}changes-requested"

# --- waiting vs blocked ----------------------------------------------------------------------
run_ph checks-running.json
eq "running checks exit 0" "$rc" "0"
eq "running checks wait" "$out" "waiting${TAB}checks-running"
run_ph mergeable-unknown.json
eq "mergeable UNKNOWN alone waits" "$out" "waiting${TAB}mergeable-unknown"
run_ph unknown-plus-threads.json
eq "UNKNOWN plus a thread blocks, fixed order" "$out" "blocked${TAB}mergeable-unknown,threads:1"
run_ph multi.json
eq "combined problems block in fixed order" "$out" "blocked${TAB}draft,conflicting,behind,checks-failing,checks-running,threads:2,changes-requested"

# --- merged / closed ---------------------------------------------------------------------------
run_ph merged.json
eq "merged exits 0" "$rc" "0"
eq "merged prints no reasons" "$out" "merged$TAB"
run_ph closed.json
eq "closed exits 0" "$rc" "0"
eq "closed prints no reasons" "$out" "closed$TAB"

# --- check judging -------------------------------------------------------------------------------
run_ph required-only.json
eq "a failing non-required check with green required is ready" "$out" "ready$TAB"
run_ph zero-checks.json
eq "zero checks is ready" "$out" "ready$TAB"

# --- the base branch's required contexts --------------------------------------------------------
run_ph required-only.json
has "the query reads the base's rulesets" "$(cat "$TMP/gh-calls")" "baseRef{rules"
has "the query reads classic protection via refUpdateRule" "$(cat "$TMP/gh-calls")" "refUpdateRule{requiredStatusCheckContexts}"
has "the query selects check-run names" "$(cat "$TMP/gh-calls")" "CheckRun{name"
has "the query selects status contexts" "$(cat "$TMP/gh-calls")" "StatusContext{context"
run_ph required-missing.json
eq "a required context never posted waits, named" "$out" "waiting${TAB}required:manual-gate"
run_ph required-pending.json
eq "a required context present but pending is checks-running only" "$out" "waiting${TAB}checks-running"
run_ph required-all-green.json
eq "every required context green (rules + classic, CheckRun + StatusContext) is ready" "$out" "ready$TAB"
run_ph no-rules.json
eq "a base with no rules or protection is judged as before" "$out" "ready$TAB"
run_ph required-missing-comma.json
eq "missing names are deduped, sorted, and commas become ;" "$out" "waiting${TAB}required:a-gate,required:test (ubuntu-latest; 20)"
run_ph required-classic-threads.json
eq "a classic-protection miss sits before mergeable-unknown; threads still block" "$out" "blocked${TAB}required:Secret scan,mergeable-unknown,threads:1"

# --- the project's expected checks (a third argument, the label) --------------------------------
export DS_STATE_ROOT="$TMP/state"
mkdir -p "$TMP/state/proj" "$TMP/state/two" "$TMP/state/plain"
echo "expected_checks tests" > "$TMP/state/proj/limits.conf"
echo "expected_checks tests,lint" > "$TMP/state/two/limits.conf"
run_exp() { # run_exp <fixture> [<label>]: the same stub, with the label as the third argument
  GH_HEALTH="$(cat "$ROOT/tests/fixtures/pr-health/$1")"; export GH_HEALTH
  if out="$(pr_health "acme/widgets" "7" "${2:-proj}")"; then rc=0; else rc="$?"; fi
}
run_exp zero-checks.json
eq "zero checks with the setting waits on it" "$out" "waiting${TAB}required:tests"
run_exp expected-other-only.json
eq "another check green, the expected one absent, waits" "$out" "waiting${TAB}required:tests"
run_exp expected-skipped.json
eq "an expected check only skipped waits" "$out" "waiting${TAB}required:tests"
run_exp expected-neutral.json
eq "an expected check only neutral waits" "$out" "waiting${TAB}required:tests"
run_exp expected-pending.json
eq "an expected check pending keeps its own reason" "$out" "waiting${TAB}checks-running"
run_exp expected-failing.json
eq "an expected check failing keeps its own reason" "$out" "blocked${TAB}checks-failing"
run_exp expected-pending-other-required.json
eq "pending is judged even when another check is the required one" "$out" "waiting${TAB}checks-running"
run_exp expected-failing-other-required.json
eq "failing is judged even when another check is the required one" "$out" "blocked${TAB}checks-failing"
run_exp expected-green.json
eq "an expected check green is ready" "$out" "ready$TAB"
run_exp expected-status-green.json
eq "an expected status context green is ready" "$out" "ready$TAB"
run_exp expected-skip-and-green.json
eq "a skipped run beside a green one is ready" "$out" "ready$TAB"
run_exp expected-cancelled-then-green.json
eq "a run cancelled by a newer green one is history" "$out" "ready$TAB"
run_exp expected-green-then-failing.json
eq "the newest run failing blocks over an older green" "$out" "blocked${TAB}checks-failing"
run_exp expected-failing-then-pending.json
eq "a newer pending run replaces an older failure" "$out" "waiting${TAB}checks-running"
run_exp expected-failing-then-skipped.json
eq "a newer skip does not hide a failure" "$out" "blocked${TAB}checks-failing"
run_exp expected-green.json two
eq "a list: the absent one is named" "$out" "waiting${TAB}required:lint"
run_exp zero-checks.json two
eq "a list: both named, sorted" "$out" "waiting${TAB}required:lint,required:tests"
run_exp required-missing.json
eq "joined with the base's required contexts, sorted" "$out" "waiting${TAB}required:manual-gate,required:tests"
run_exp threads.json
eq "other reasons still block" "$out" "blocked${TAB}required:tests,threads:2"
run_exp merged.json
eq "merged is not judged" "$out" "merged$TAB"
# Unset: a label with no override reads the default `-`, no label reads nothing at all.
run_exp zero-checks.json plain
eq "unset setting: zero checks is ready" "$out" "ready$TAB"
run_exp expected-skipped.json plain
eq "unset setting: skipped is ready" "$out" "ready$TAB"
eq "unset setting: the limit reads -" "$(ds_limit plain expected_checks)" "-"
run_ph zero-checks.json
eq "two arguments: zero checks is still ready" "$out" "ready$TAB"
run_ph expected-skipped.json
eq "two arguments: skipped is still ready" "$out" "ready$TAB"
out="$(DS_LIMIT_EXPECTED_CHECKS=tests pr_health acme/widgets 7)"
eq "two arguments ignore the setting, even from the env" "$out" "ready$TAB"
run_ph expected-cancelled-then-green.json
eq "two arguments: every run still judged" "$out" "blocked${TAB}checks-failing"
run_ph zero-checks.json
out="$(DS_LIMIT_EXPECTED_CHECKS=lint pr_health acme/widgets 7 plain)"
eq "the env var names the checks for a label" "$out" "waiting${TAB}required:lint"
unset DS_STATE_ROOT

# --- unknown: gh or jq failed ----------------------------------------------------------------------
run_ph pr-null.json
eq "a null PR exits 1" "$rc" "1"
eq "a null PR prints unknown" "$out" "unknown$TAB"
run_raw '{not json'
eq "invalid JSON exits 1" "$rc" "1"
eq "invalid JSON prints unknown" "$out" "unknown$TAB"
run_raw ''
eq "an empty response exits 1" "$rc" "1"
eq "an empty response prints unknown" "$out" "unknown$TAB"
GH_FAIL=1 run_ph ready.json
eq "a failed gh call exits 1" "$rc" "1"
eq "a failed gh call prints unknown" "$out" "unknown$TAB"

echo "lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
