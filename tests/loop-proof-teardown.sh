#!/usr/bin/env bash
# loop-proof-teardown.sh — U50: tests/loop-proof.sh's teardown retries a failed delete of its base
# branch once, and reports a branch still there after that. Runs the real proof script with a fake
# git and a fake orca under a temp HOME: the fake orca refuses the proof's terminal, so the run stops
# just after the base branch is pushed and goes through the real teardown. Nothing real is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
good() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "  FAIL: $1" >&2; }

STUB="$TMP/stub"; mkdir -p "$STUB" "$TMP/dev-studio/.git"
export GIT_LOG="$TMP/git.log" GIT_REMOTE="$TMP/remote" FAIL_DELETES_FILE="$TMP/fail-deletes" COMMON_DIR="$TMP/dev-studio/.git"

# Fake git: the remote is one file of branch names. A delete fails while FAIL_DELETES_FILE counts above 0.
cat > "$STUB/git" <<'FAKE'
#!/usr/bin/env bash
[ "${1:-}" != -C ] || shift 2
printf '%s\n' "$*" >> "$GIT_LOG"
case "$*" in
  rev-parse*) echo "$COMMON_DIR" ;;
  "push -q origin "*) printf '%s\n' "${4#*:refs/heads/}" >> "$GIT_REMOTE" ;;
  "push origin --delete "*)
    n="$(cat "$FAIL_DELETES_FILE")"
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAIL_DELETES_FILE"; exit 1; fi
    grep -vxF "$4" "$GIT_REMOTE" > "$GIT_REMOTE.new" || true
    mv "$GIT_REMOTE.new" "$GIT_REMOTE" ;;
  "ls-remote"*) sed 's|^|0000\trefs/heads/|' "$GIT_REMOTE" ;;
esac
exit 0
FAKE
# Fake orca: reachable, no accounts, and every other call (the proof's terminal among them) refused.
cat > "$STUB/orca" <<'FAKE'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "status "*) echo '{"ok":true,"result":{"runtime":{"reachable":true,"state":"ready"}}}' ;;
  "account "*) echo '{"ok":true,"result":{"claude":{"accounts":[]}}}' ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$STUB/git" "$STUB/orca"
export DS_ORCA_CLI_BIN_DIR="$STUB"
# Only checked for by the proof, and never run before this stop.
for t in gh curl; do printf '#!/bin/sh\nexit 0\n' > "$STUB/$t"; chmod +x "$STUB/$t"; done

# run_proof <failed deletes>: rc in $rc, output in $out. The push in the proof happens, the terminal does not.
run_proof() {
  : > "$GIT_LOG"; : > "$GIT_REMOTE"; echo "$1" > "$FAIL_DELETES_FILE"
  rc=0
  out="$(
    env -u CLAUDE_CONFIG_DIR -u ORCA_USER_DATA_PATH -u XDG_CONFIG_HOME -u BACKEND \
      HOME="$TMP/home" TMPDIR="$TMP" PATH="$STUB:$PATH" ORCA_WORKTREE_ID=wt-test DS_PROOF_RETRY_S=0 \
      bash "$ROOT/tests/loop-proof.sh" --run 2>&1
  )" || rc=$?
}
deletes() { grep -c '^push origin --delete loop-proof-base-' "$GIT_LOG" || true; }

mkdir -p "$TMP/home"

# The delete works: one call, nothing left.
run_proof 0
if grep -q '^push -q origin ' "$GIT_LOG"; then good; else bad "the proof should reach its base push: $out"; fi
if [ "$(deletes)" = 1 ]; then good; else bad "a delete that works should run once, ran $(deletes): $(cat "$GIT_LOG")"; fi
if grep -qF 'nothing left behind' <<<"$out"; then good; else bad "a clean teardown should say so: $out"; fi

# The first delete fails: a second try, nothing left.
run_proof 1
if [ "$(deletes)" = 2 ]; then good; else bad "a failed delete should be tried again, ran $(deletes): $(cat "$GIT_LOG")"; fi
if grep -qF 'nothing left behind' <<<"$out" && ! grep -qF 'teardown left behind:' <<<"$out"; then good; else bad "a delete that works on the retry should leave nothing: $out"; fi

# Both fail: no third try, and the branch is reported, which fails the run.
run_proof 2
if [ "$(deletes)" = 2 ]; then good; else bad "the retry should be the last try, ran $(deletes): $(cat "$GIT_LOG")"; fi
if grep -qF 'FAIL: teardown left behind:' <<<"$out" && grep -qF 'refs/heads/loop-proof-base-' <<<"$out"; then good; else bad "a branch still there should be reported: $out"; fi
if [ "$rc" -ne 0 ]; then good; else bad "a branch left behind should fail the run"; fi

echo "loop-proof-teardown: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
