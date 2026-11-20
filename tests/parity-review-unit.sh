#!/usr/bin/env bash
# parity-review-unit.sh — the TypeScript review-unit (U228) decides what the shell version decided:
# the same run kind (full, delta, carried), the same review row and model for a hard and a standard
# unit, the same exit codes, receipts and log lines, and the U219 swapped-stage proof. The shell side
# is the tree at PARITY_BASE (default 96c870d, the last commit with the shell version), unpacked with
# git archive. The engines are the stubs of tests/lib/review-unit-prelude.sh, taken from it unchanged.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PARITY_BASE:-96c870d}"
# Bun reads every parent directory of its cwd when it starts, so on a host whose /tmp holds a million
# entries each Bun start in a /tmp repo costs a second; the per-user runtime dir is small.
TMP="$(mktemp -d -p "$( [ -d "${XDG_RUNTIME_DIR:-}" ] && [ -w "$XDG_RUNTIME_DIR" ] && echo "$XDG_RUNTIME_DIR" || echo "${TMPDIR:-/tmp}")")"
trap 'rm -rf "$TMP"' EXIT

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-review-unit: $BASE is not in this clone — skipped"; echo "parity-review-unit: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old" "$TMP/new"
git -C "$ROOT" archive "$BASE" bin conventions roles | tar -x -C "$TMP/old"
cp -r "$ROOT/bin" "$ROOT/conventions" "$ROOT/roles" "$TMP/new/"
# U282: review-leaf is new behaviour the shell version never had (tests/review-unit.sh covers it); compare the rest.
sed -i "/^review-leaf /d" "$TMP/new/conventions/roles.conf"

# The engine stubs, the run-folder fixture and the hermetic home of tests/review-unit.sh.
SUITE="$ROOT/tests/lib/review-unit-prelude.sh"   # U233: the stubs moved out of tests/review-unit.sh into the shared prelude
eval "$(awk '/^cat > "\$TMP\/claude"/{on=1} on{print} /^chmod \+x "\$TMP\/review-fixture"/{exit}' "$SUITE")"
eval "$(awk '/^export REVIEW_FIXTURES=/{print} /^# No muse model catalog/{on=1} on{print} /^export HOME="\$FH"/{exit}' "$SUITE")"
mkdir -p "$REVIEW_FIXTURES"
unset DS_STATE_ROOT
# The review role's skill list (U229): a fixed one for both trees, so each run passes the same --settings.
printf '#!/bin/sh\n[ "$2" = review ] || exit 2\necho "{\\"dataviz\\":\\"off\\"}"\n' > "$TMP/resolve-ok"; printf '#!/bin/sh\nexit 1\n' > "$TMP/resolve-bad"
chmod +x "$TMP/resolve-ok" "$TMP/resolve-bad"; export DS_SKILLS_RESOLVE="$TMP/resolve-ok"
export GIT_AUTHOR_DATE="2026-11-01T10:00:00Z" GIT_COMMITTER_DATE="2026-11-01T10:00:00Z"   # the same shas in both trees

LBL="zzpr_$$"
ROSTER='builder-review claude opus elevate high codex:gpt-5
builder-review-standard claude sonnet elevate medium codex:gpt-5
'
# One tree's run of every scenario, as lines that hold no clock, run folder or tree path.
scenarios() { # <tree root> <work dir>
  local w="$2" ru="$1/bin/review/review-unit.sh" sd="$1/state/$LBL" r o rc
  mkdir -p "$sd/squads" "$w"; printf '%s' "$ROSTER" > "$sd/roles.conf"
  bun "$ROOT/tests/lib/observe-config.ts" "$1/state" "$LBL=$sd"   # U257: the new tree reads the roster as rows
  export CLAUDE_LOG="$w/claude-log" CODEX_LOG="$w/codex-log" MUSE_LOG="$w/muse-log" CLAUDE_PLUGIN_LOG="$w/plugin-log"
  g() { git -C "$r" -c user.email=t@t -c user.name=t "$@"; }
  step() { # <name> <args…>: run review-unit in $r, record its exit, output, receipts and engine call
    local name="$1"; shift; : > "$CLAUDE_LOG"; : > "$CODEX_LOG"
    rc=0; o="$(cd "$r" && rm -f .git/ds-review-last-run .git/ds-review-stop && "$ru" "$@" 2>&1)" || rc=$?
    printf '== %s rc=%s\n%s\n' "$name" "$rc" "$o"
    printf 'receipt: %s\n' "$(cut -f1,3- "$r/.git/ds-review" 2>/dev/null || echo none)"
    printf 'base: %s\n' "$(cut -f1,3- "$r/.git/ds-review-base" 2>/dev/null || echo none)"
    printf 'log: %s\n' "$(tail -1 "$r/.git/ds-review-log" 2>/dev/null | cut -f2- || echo none)"
    grep -h '^args:' "$CLAUDE_LOG" "$CODEX_LOG" 2>/dev/null || true
  }
  tier() { printf '{"topic":"t","units":[{"slug":"u1","tier":"%s","builder_wt":"x::%s"}]}\n' "$1" "$(cd "$r" && pwd -P)" > "$sd/squads/t.json"; }

  # A unit branch on a base: full, a fix commit's delta, an unchanged HEAD, a base-only rebase carried,
  # a later failed run, then its delta from the carried base.
  r="$w/repo"; git init -q -b main "$r"; echo base > "$r/base.txt"; echo unit > "$r/unit.txt"
  g add -A; g commit -q -m base; g checkout -q -b feat; echo one > "$r/unit.txt"; g commit -q -am "unit v1"
  tier standard; step "standard full" "$LBL" main
  echo two > "$r/unit.txt"; g commit -q -am fix
  step "standard delta" "$LBL" main
  step "unchanged head" "$LBL" main
  g checkout -q main; echo more > "$r/other.txt"; g add -A; g commit -q -m "base moves"; g checkout -q feat; g rebase -q main
  step "carried" "$LBL" main
  echo three > "$r/unit.txt"; g commit -q -am v3; rm -f "$r/.git/ds-review"
  STUB_EXIT=1 step "failed run" "$LBL" main
  step "delta from the carried base" "$LBL" main
  tier hard; echo four > "$r/unit.txt"; g commit -q -am v4
  step "hard delta" "$LBL" main
  step "hard full" "$LBL" main --full "parity"
  echo wip > "$r/wip.txt"; step "dirty tree" "$LBL" main; rm -f "$r/wip.txt"
  DS_SKILLS_RESOLVE="$TMP/resolve-bad" step "failing skill resolve" "$LBL" main --full "parity"

  # U219: a merge stage logged end then start still earns the receipt; any other swap does not.
  r="$w/proof"; git init -q -b trunk "$r"; echo base > "$r/file"; g add file; g commit -q -m base
  g checkout -q -b feature; echo unit >> "$r/file"; g commit -q -am unit; tier standard
  PROOF_CASE=swap-merge PROOF_BASE_REF=trunk step "swapped merge" "$LBL" trunk
  echo more >> "$r/file"; g commit -q -am more
  # U250: "swap start only" (an end-only merge) is now accepted when the folder holds the output; the shell refused it, so no parity here (tests/review-unit-proof-run.sh covers it).
  #   PROOF_CASE=swap-start-only PROOF_BASE_REF=trunk step "swap start only" "$LBL" trunk --full "parity"
}
norm() { # <tree root> <work dir>
  sed -E -e "s#$2#W#g; s#$1#TREE#g; s#$TMP#TMP#g" \
    -e 's#run-[A-Za-z0-9_]+#run-X#g; s#[0-9]{8}-[0-9]{6}-[0-9a-f]{8}#run-X#g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}(\.[0-9]+)?(Z|[+-][0-9:]{5})?/T/g' \
    -e 's/(^|[^0-9])1[0-9]{9}([^0-9]|$)/\1EPOCH\2/g; s/[0-9]+s\b/Ns/g'
}
scenarios "$TMP/old" "$TMP/wo" > "$TMP/old.out" 2>&1 || true
scenarios "$TMP/new" "$TMP/wn" > "$TMP/new.out" 2>&1 || true
norm "$TMP/old" "$TMP/wo" < "$TMP/old.out" > "$TMP/old.norm"
norm "$TMP/new" "$TMP/wn" < "$TMP/new.out" > "$TMP/new.norm"
[ -z "${PARITY_DUMP:-}" ] || cp "$TMP/old.norm" "$TMP/new.norm" "$PARITY_DUMP/"

pass=0; fail=0
while read -r name; do
  if diff <(awk -v n="$name" '/^== /{on=(substr($0,4)~("^"n" rc="))} on' "$TMP/old.norm") \
          <(awk -v n="$name" '/^== /{on=(substr($0,4)~("^"n" rc="))} on' "$TMP/new.norm") > "$TMP/d"; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); echo "  FAIL: $name" >&2; cut -c1-200 "$TMP/d" | head -12 >&2
  fi
done < <(sed -n 's/^== \(.*\) rc=.*/\1/p' "$TMP/old.norm" | sort -u)
# Every scenario ran, and the decisions are the ones the shell is known for.
for want in "== standard full rc=0" "== carried rc=0" "== swapped merge rc=0"; do
  if grep -qF "$want" "$TMP/new.norm"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: missing [$want]" >&2; fi
done
for want in "full review" "delta (correctness) review" "carried review from" "from ds-review-base" "end/start swapped" "--model opus" "--model sonnet" '--settings {"skillOverrides":{"dataviz":"off"}}' "skill list unavailable"; do
  if grep -qF -- "$want" "$TMP/new.norm"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: no [$want] in the port's runs" >&2; fi
done
echo "parity-review-unit: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
