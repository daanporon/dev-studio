#!/usr/bin/env bash
# ci.sh — what .github/workflows/tests.yml runs on every PR: shellcheck as in AGENTS.md's Verify, then
# every tests/*.sh, found by a glob so that adding or deleting a test needs no edit here or in the
# workflow. Exits non-zero if anything fails. Needs bun, shellcheck, jq and git; no Orca, no live
# state, no secrets. A failing test's output is printed; a passing test prints one line.
#
# CI_JOBS=N (default 1: the host is already loaded; the workflow sets the runner's core count) runs up
# to N test scripts at once, and shellcheck over N slices of its files. The lines still come out one per
# test in name order, each as soon as it and every test before it have finished.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

JOBS="${CI_JOBS:-1}"
case "$JOBS" in '' | *[!0-9]*) JOBS=1 ;; esac
JOBS=$((10#$JOBS)) # base 10: 08 would be a bad octal number, and no shellcheck slice would run
[ "$JOBS" -ge 1 ] || JOBS=1

# A test that cannot run in CI, with the reason. Prefer making a test hermetic to adding a line here.
skip_reason() {
  case "$1" in
    ci) echo "this runner" ;;
    loop-proof) echo "live proof: starts real workers on real accounts and merges a real PR (tests/loop-proof.sh --run on the host)" ;;
    *) return 1 ;;
  esac
}

# A test that cannot run next to the others (a fixed port, a shared path), with the reason. It runs
# alone once every test before it has finished. Prefer making the test hermetic to adding a line here.
serial_reason() {
  case "$1" in
    *) return 1 ;;
  esac
}

# A runner has no git identity, and many tests commit in their temp repos.
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@localhost GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@localhost

OUT="$(mktemp -d)"
# No test scans the host's real session logs: an unset DS_TOKEN_DIR becomes an empty temp dir (bun tests
# get the same from tests/loop/preload-token-dir.ts).
if [ -z "${DS_TOKEN_DIR:-}" ]; then
  mkdir -p "$OUT/token-dir"
  export DS_TOKEN_DIR="$OUT/token-dir"
fi
# U284: one temp root for the run. Every job gets TMPDIR and XDG_RUNTIME_DIR pointed at $RUN_TMP/t (which the
# fixtures and tests/lib/hook-tree.sh use), under the fast runtime dir when there is one. It is removed when the run
# ends, on failure too; before that, anything a test left in it is listed and fails the run (guard below).
RUN_TMP="$(mktemp -d -p "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}" ds-ci-XXXXXX)"
mkdir -p "$RUN_TMP/t"
export TMPDIR="$RUN_TMP/t" XDG_RUNTIME_DIR="$RUN_TMP/t"
trap 'rm -rf "$OUT" "$RUN_TMP"' EXIT
# U253: a test that needs a state root makes one under this dir (tests/lib/state-root.sh), and the suite
# fails if the checkout's real state/ (entries, loop.db projects) gained anything while it ran.
mkdir -p "$OUT/state-base"
export DS_TEST_STATE_BASE="$OUT/state-base"
# shellcheck source=tests/lib/live-state-guard.sh
. "$ROOT/tests/lib/live-state-guard.sh"
live_state_snapshot "$ROOT/state" > "$OUT/live-before.txt"
start="$SECONDS"
failed=()

# job <id> <cmd...>: run it into $OUT/<id>.log, then write "<rc> <seconds>" to $OUT/<id>.res. A hang fails too.
job() {
  local id="$1" began="$SECONDS" rc=0
  shift
  DS_LOOP_JUNIT="$OUT/$id.junit.xml" timeout "${CI_TEST_TIMEOUT:-600}" "$@" > "$OUT/$id.log" 2>&1 < /dev/null || rc=$?
  echo "$rc $((SECONDS - began))" > "$OUT/$id.res.tmp" && mv "$OUT/$id.res.tmp" "$OUT/$id.res"
}

# report <name> <id>: one line on a pass, the whole output on a failure.
report() {
  local name="$1" rc secs
  read -r rc secs < "$OUT/$2.res"
  if [ "$rc" = 0 ]; then
    printf 'ok    %-26s %ss\n' "$name" "$secs"
  else
    printf 'FAIL  %-26s %ss (exit %s)\n' "$name" "$secs" "$rc"
    cat "$OUT/$2.log"
    failed+=("$name")
  fi
}

# Run shellcheck over JOBS slices of its files at once, reported as the one `shellcheck` line. -x: a
# slice may not hold a sourced file (tests/lib/*.sh), so it follows
# the source= directives that the one-call run follows because those files are inputs there.
sc_files=(bin/*/*.sh bin/backend/*.sh bin/ds tests/*.sh tests/lib/*.sh)
sc_began="$SECONDS"
for ((k = 0; k < JOBS; k++)); do
  slice=()
  for ((f = k; f < ${#sc_files[@]}; f += JOBS)); do slice+=("${sc_files[f]}"); done
  [ "${#slice[@]}" = 0 ] || job "sc$k" shellcheck -x "${slice[@]}" &
done
wait
sc_rc=0
: > "$OUT/sc.log"
[ -e "$OUT/sc0.res" ] || { sc_rc=lost; echo "shellcheck: no slice ran" >> "$OUT/sc.log"; }
for ((k = 0; k < JOBS && k < ${#sc_files[@]}; k++)); do
  # A slice that left no result was lost (its job died): that fails, never passes.
  if [ -e "$OUT/sc$k.res" ]; then read -r rc _ < "$OUT/sc$k.res"; else rc=lost; echo "shellcheck slice $k: no result (job lost)" >> "$OUT/sc.log"; fi
  [ "$rc" = 0 ] || sc_rc="$rc"
  cat "$OUT/sc$k.log" >> "$OUT/sc.log" 2> /dev/null
done
echo "$sc_rc $((SECONDS - sc_began))" > "$OUT/sc.res"
report shellcheck sc

# The loop suite (tests/loop.sh) runs as JOBS shards (tests/loop.sh --shard K/N), each its own job in the
# pool, so one bun process no longer holds the run's last 12 minutes. Each shard is listed as `loop K/N`.
names=() cmds=()
for t in tests/*.sh; do
  n="$(basename "$t" .sh)"
  if [ "$n" = loop ] && ! skip_reason "$n" > /dev/null; then
    for ((k = 1; k <= JOBS; k++)); do names+=("loop $k/$JOBS"); cmds+=("tests/loop.sh --shard $k/$JOBS"); done
  else
    names+=("$n"); cmds+=("tests/$n.sh")
  fi
done
skips=()
next=0

# Longest first: the loop shards and the slowest shell tests start before the rest, so the run does not end
# on one long job that started late. The lines still come out in name order. A name not in tests/ is ignored.
slow_first="loop board squad-state install-per-agent"
order=()
for w in $slow_first; do
  for i in "${!names[@]}"; do [ "${names[i]%% *}" = "$w" ] && order+=("$i"); done
done
for i in "${!names[@]}"; do
  case " ${order[*]} " in *" $i "*) ;; *) order+=("$i") ;; esac
done

# flush: print every finished (or skipped) test from `next` on, in name order, up to the first unfinished.
flush() {
  while [ "$next" -lt "${#names[@]}" ]; do
    if [ -n "${skips[next]:-}" ]; then
      printf 'skip  %-26s %s\n' "${names[next]}" "${skips[next]}"
    elif [ -e "$OUT/$next.res" ]; then
      report "${names[next]}" "$next"
    else
      return 0
    fi
    next=$((next + 1))
  done
}

for i in "${order[@]}"; do
  name="${names[i]}"
  if reason="$(skip_reason "${name%% *}")"; then
    skips[i]="$reason"
    flush
    continue
  fi
  if serial_reason "${name%% *}" > /dev/null; then
    wait
    flush
    # shellcheck disable=SC2086 # the command is words with no spaces inside
    job "$i" bash ${cmds[i]}
    flush
    continue
  fi
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do
    wait -n
    flush
  done
  # shellcheck disable=SC2086 # the command is words with no spaces inside
  job "$i" bash ${cmds[i]} &
  flush
done
wait
flush
# Every job has ended, so a test still unprinted left no result (its job died): fail it, never pass it.
while [ "$next" -lt "${#names[@]}" ]; do
  printf 'FAIL  %-26s no result (job lost)\n' "${names[next]}"
  cat "$OUT/$next.log" 2> /dev/null
  failed+=("${names[next]}")
  next=$((next + 1))
  flush
done

# Guard: a loop test file over CI_SLOW_FILE_S (30) or one test over CI_SLOW_TEST_S (5) is named, so the next
# slow test is caught when it is added. A warning, not a failure: a loaded host makes any test slower.
for x in "$OUT"/*.junit.xml; do
  [ -e "$x" ] || continue
  awk -v ft="${CI_SLOW_FILE_S:-30}" -v tt="${CI_SLOW_TEST_S:-5}" '
    function attr(l, k,   m) { if (match(l, " " k "=\"[^\"]*\"")) { m = substr(l, RSTART + length(k) + 3, RLENGTH - length(k) - 4); return m } return "" }
    /<testsuite / { f = attr($0, "file"); if (f != "" && attr($0, "name") == f && attr($0, "time") + 0 > ft) printf "warn  slow loop test file: %s %.0fs (limit %ss)\n", f, attr($0, "time"), ft }
    /<testcase / { if (attr($0, "time") + 0 > tt) printf "warn  slow loop test: %s: %s %.1fs (limit %ss)\n", attr($0, "file"), attr($0, "name"), attr($0, "time"), tt }
  ' "$x"
done

# Guard (U253): the live state/ gained nothing while the suite ran.
live_state_snapshot "$ROOT/state" > "$OUT/live-after.txt"
leaks="$(live_state_leaks "$OUT/live-before.txt" "$OUT/live-after.txt")"
if [ -n "$leaks" ]; then
  printf 'FAIL  %-26s the suite wrote to the live state (%s/state):\n%s\n' live-state "$ROOT" "$leaks"
  failed+=("live-state")
else
  printf 'ok    %-26s state/ unchanged\n' live-state
fi

# Guard (U284): a test removes the temp dirs it makes; what is left in the run's temp root is named by prefix.
left="$(find "$RUN_TMP/t" -mindepth 1 -maxdepth 1 -printf '%f\n' 2> /dev/null | sed -E 's/[-.]?[A-Za-z0-9]{6,}$//; s/-$//' | sort | uniq -c | sort -rn | awk '{ printf "  %s x%s\n", $2, $1 }')"
[ -z "$left" ] || left="$left
  e.g. $(find "$RUN_TMP/t" -mindepth 1 -maxdepth 1 -printf '%f ' 2> /dev/null | cut -c1-300)"
  for d in $(find "$RUN_TMP/t" -mindepth 1 -maxdepth 1 -type d 2> /dev/null | head -3); do
    left="$left
  contents of $(basename "$d"):
$(find "$d" 2> /dev/null | head -12 | sed 's/^/    /')"
  done
if [ -n "$left" ]; then
  printf 'FAIL  %-26s tests left temp dirs behind (by prefix):\n%s\n' temp-dirs "$left"
  failed+=("temp-dirs")
else
  printf 'ok    %-26s no temp dirs left behind\n' temp-dirs
fi

echo "ci: $((SECONDS - start))s, ${#failed[@]} failed"
[ "${#failed[@]}" = 0 ] || { printf 'ci: failed: %s\n' "${failed[*]}"; exit 1; }
