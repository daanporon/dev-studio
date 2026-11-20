#!/usr/bin/env bash
# Lint + self-test: a text check in a shell test must not pipe a variable into `grep -q`.
#
# Under `set -o pipefail`, `printf '%s' "$x" | grep -q needle` can fail on a MATCH: grep -q
# exits on its first hit, printf is still writing (a haystack past the pipe buffer, or a slow
# reader), dies of SIGPIPE, and the pipeline reports 141. A `has` helper then calls a match a
# miss, only sometimes (U217: tests/limits.sh went red 1 run in a few). The fix is a here-string:
# grep -qF -- "$needle" <<<"$haystack".
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "  FAIL: $*" >&2; }

# The rule: any tests/*.sh that uses pipefail and pipes printf/echo into grep -q.
RULE='(printf|echo)[^|]*\|[[:space:]]*grep[[:space:]]+-[a-zA-Z]*q'
lint() { # lint <file>...: print offending lines; exit 0 when there are none
  local f hits=0
  for f in "$@"; do
    grep -q pipefail "$f" || continue
    # comment lines may name the pattern
    if grep -nE "$RULE" "$f" | grep -vE '^[0-9]+:[[:space:]]*#' | sed "s|^|$f:|" | grep .; then hits=1; fi
  done
  return "$hits"
}

# 1. the repo's tests are clean
# (this file quotes the pattern in its own fixtures, so it is not scanned)
repo=(); for f in tests/*.sh; do [ "$f" = tests/no-pipe-grep-q.sh ] || repo+=("$f"); done
if out=$(lint "${repo[@]}" 2>&1); then ok
else bad "printf/echo | grep -q under pipefail; use grep -qF -- \"\$needle\" <<<\"\$haystack\" (SIGPIPE makes a match fail):"$'\n'"$out"; fi

# 2. the lint rejects a planted offender
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf '%s\n' 'set -uo pipefail' 'x=abc' "printf '%s' \"\$x\" | grep -q y" > "$T/planted.sh"
if lint "$T/planted.sh" >/dev/null 2>&1; then bad "lint accepted a planted printf | grep -q"; else ok; fi
printf '%s\n' 'set -uo pipefail' 'x=abc' 'grep -q y <<<"$x"' > "$T/clean.sh"
if lint "$T/clean.sh" >/dev/null 2>&1; then ok; else bad "lint rejected the here-string form"; fi
printf '%s\n' 'x=abc' "printf '%s' \"\$x\" | grep -q y" > "$T/nopipefail.sh"
if lint "$T/nopipefail.sh" >/dev/null 2>&1; then ok; else bad "lint flagged a file without pipefail"; fi

# 3. the here-string helper never fails a match, whatever the size (needle on the first line)
has() { grep -qF -- "$2" <<<"$1"; }
lacks() { ! grep -qF -- "$2" <<<"$1"; }
hay=$(printf 'needle-first\n'; head -c 200000 /dev/zero | tr '\0' 'x')
miss=$(head -c 200000 /dev/zero | tr '\0' 'x')
n=0
for _ in $(seq 50); do has "$hay" needle-first && n=$((n+1)); done
if [ "$n" -eq 50 ]; then ok; else bad "here-string has() passed $n/50 on a large haystack"; fi
if has "$miss" needle-first; then bad "has() passed a haystack without the needle"; else ok; fi
if lacks "$miss" needle-first; then ok; else bad "lacks() failed on no match"; fi
if lacks "$hay" needle-first; then bad "lacks() passed on a match"; else ok; fi

echo "no-pipe-grep-q: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
