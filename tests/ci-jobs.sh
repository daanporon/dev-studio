#!/usr/bin/env bash
# ci-jobs.sh — U62: tests/ci.sh with CI_JOBS=2 runs two test scripts at the same time, still prints
# their lines in name order, and prints a failing script's output; CI_JOBS unset runs them one at a
# time. A test named in serial_reason runs alone. Runs the real ci.sh in a temp root whose tests/ holds
# stubs, and a stub shellcheck on PATH that records how many slices it was called with.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/root/tests" "$TMP/root/bin/backend" "$TMP/root/bin/role" "$TMP/path"
cp "$ROOT/tests/ci.sh" "$TMP/root/tests/ci.sh"
mkdir -p "$TMP/root/tests/lib"; cp "$ROOT/tests/lib/live-state-guard.sh" "$TMP/root/tests/lib/"
touch "$TMP/root/bin/ds" "$TMP/root/bin/role/x.sh" "$TMP/root/bin/role/y.sh"
printf '#!/usr/bin/env bash\necho "$*" >> "%s/sc.calls"\n' "$TMP" > "$TMP/path/shellcheck"
chmod +x "$TMP/path/shellcheck"

# a and b each wait up to 5 s for the other to start: they pass only when run at the same time.
# a finishes last, so its line must still come first. d fails with output (named to sort after ci in any locale).
for pair in a:b b:a; do
  me="${pair%%:*}" other="${pair##*:}"
  cat > "$TMP/root/tests/$me.sh" <<EOF
#!/usr/bin/env bash
touch "$TMP/$me.started"
for _ in \$(seq 50); do [ -e "$TMP/$other.started" ] && break; sleep 0.1; done
[ -e "$TMP/$other.started" ] || { echo "$me: $other never started next to me"; exit 1; }
[ "$me" = a ] && sleep 1
exit 0
EOF
done
printf '#!/usr/bin/env bash\necho "d-says-boom"\nexit 3\n' > "$TMP/root/tests/d.sh"

fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; printf '%s\n' "$2"; fail=1; }

run_ci() { # <CI_JOBS or ""> -> $out, $rc
  rm -f "$TMP"/*.started "$TMP/sc.calls"
  rc=0
  out="$(env -u GITHUB_BASE_REF -u CI_JOBS ${1:+CI_JOBS=$1} PATH="$TMP/path:$PATH" bash "$TMP/root/tests/ci.sh" 2>&1)" || rc=$?
}

run_ci 2
lines="$(grep -E "^(ok|FAIL|skip) " <<< "$out" | grep -v " live-state \| temp-dirs " | awk '{print $1, $2}' | tr '\n' ' ')"
[ "$lines" = "ok shellcheck ok a ok b skip ci FAIL d " ] && ok "CI_JOBS=2: a and b ran at the same time, lines in name order" || bad "CI_JOBS=2: lines were: $lines" "$out"
grep -qx 'd-says-boom' <<< "$out" && grep -A1 '^FAIL  d ' <<< "$out" | grep -qx 'd-says-boom' \
  && ok "CI_JOBS=2: the failing script's output follows its line" || bad "CI_JOBS=2: no output under d's FAIL line" "$out"
[ "$rc" = 1 ] && grep -q '^ci: failed: d$' <<< "$out" && ok "CI_JOBS=2: exits 1 naming d" || bad "CI_JOBS=2: rc=$rc" "$out"
[ "$(wc -l < "$TMP/sc.calls")" = 2 ] && ok "CI_JOBS=2: shellcheck ran over 2 slices" || bad "CI_JOBS=2: shellcheck calls:" "$(cat "$TMP/sc.calls")"

run_ci ""
grep -q '^FAIL  a ' <<< "$out" && grep -q 'a: b never started next to me' <<< "$out" \
  && ok "CI_JOBS unset: one at a time (a waited for b in vain)" || bad "CI_JOBS unset: a did not run alone" "$out"
[ "$(wc -l < "$TMP/sc.calls")" = 1 ] && ok "CI_JOBS unset: shellcheck ran once" || bad "CI_JOBS unset: shellcheck calls:" "$(cat "$TMP/sc.calls")"

# A leading zero is base 10, not a bad octal that would run no shellcheck slice.
run_ci 08
[ "$(wc -l < "$TMP/sc.calls" 2> /dev/null || echo 0)" = 8 ] && ok "CI_JOBS=08: shellcheck ran over 8 slices" || bad "CI_JOBS=08: shellcheck calls:" "$out"

# Mark b serial in the copy: with CI_JOBS=2 it then waits for a to finish, so a (waiting for b) fails.
sed -i 's/^serial_reason() {$/&\n  [ "$1" = b ] \&\& { echo "test"; return 0; }/' "$TMP/root/tests/ci.sh"
run_ci 2
grep -q '^FAIL  a ' <<< "$out" && grep -q 'a: b never started next to me' <<< "$out" && grep -q '^ok    b ' <<< "$out" \
  && ok "CI_JOBS=2: a serial test runs alone" || bad "CI_JOBS=2: serial b ran next to a" "$out"

# A job that dies before writing its result fails, and every test after it is still reported.
sed -i '/^  \[ "\$1" = b \] /d' "$TMP/root/tests/ci.sh"
rm "$TMP/root/tests/a.sh" "$TMP/root/tests/b.sh"
printf '#!/usr/bin/env bash\nkill -9 "$(ps -o ppid= -p "$PPID" | tr -d " ")"\n' > "$TMP/root/tests/a.sh"
for j in 1 2; do
  run_ci "$j"
  grep -q '^FAIL  a  .*no result (job lost)' <<< "$out" && grep -q '^FAIL  d ' <<< "$out" && [ "$rc" = 1 ] \
    && grep -q '^ci: failed: a d$' <<< "$out" \
    && ok "CI_JOBS=$j: a killed job fails, later tests still reported" || bad "CI_JOBS=$j: lost job not failed (rc=$rc)" "$out"
done

# U284: the run's temp root is checked at the end. A test that leaves a dir in TMPDIR fails the run, named by
# prefix; the run's root is gone afterwards; a run that leaves nothing reports `ok temp-dirs`.
rm -f "$TMP/root/tests/a.sh" "$TMP/root/tests/d.sh"
printf '#!/usr/bin/env bash\nmkdir "$TMPDIR/zzclean-AbCdEf" "$TMPDIR/pause-lifecycle-GhIjKl" "$TMPDIR/pause-lifecycle-MnOpQr"\n' > "$TMP/root/tests/e.sh"
mkdir -p "$TMP/rt"
rc=0; out="$(env -u CI_JOBS XDG_RUNTIME_DIR="$TMP/rt" PATH="$TMP/path:$PATH" bash "$TMP/root/tests/ci.sh" 2>&1)" || rc=$?
{ [ "$rc" = 1 ] && grep -q '^FAIL  temp-dirs ' <<< "$out" && grep -q 'zzclean x1' <<< "$out" && grep -q 'pause-lifecycle x2' <<< "$out" \
  && grep -q '^ci: failed: .*temp-dirs' <<< "$out"; } \
  && ok "temp dirs: a test that leaves dirs fails the run and they are named" || bad "temp dirs: leak not caught (rc=$rc)" "$out"
[ -z "$(ls "$TMP/rt")" ] && ok "temp dirs: the run's temp root is removed after a failing run" || bad "temp dirs: left in the run root: $(ls "$TMP/rt")" "$out"
rm "$TMP/root/tests/e.sh"
rc=0; out="$(env -u CI_JOBS XDG_RUNTIME_DIR="$TMP/rt" PATH="$TMP/path:$PATH" bash "$TMP/root/tests/ci.sh" 2>&1)" || rc=$?
{ [ "$rc" = 0 ] && grep -q '^ok    temp-dirs ' <<< "$out"; } \
  && ok "temp dirs: a clean run passes the guard" || bad "temp dirs: clean run (rc=$rc)" "$out"

exit "$fail"
