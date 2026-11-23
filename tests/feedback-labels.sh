#!/usr/bin/env bash
# feedback-labels.sh — the label script of the feedback-labels workflow (ds-feedback-github-issues U3):
# a body with the loop's marker line gets ds-feedback, area:<a> and kind:<k>; no marker, a malformed one
# or two get none; the script never prints the body; an event file is read like a body.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
S="$ROOT/.github/scripts/feedback-labels.mjs"
NODE="$(command -v node || command -v bun)"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
body(){ printf '%s' "$2" > "$TMP/$1.md"; "$NODE" "$S" --body "$TMP/$1.md"; }
nl=$'\n'

eq "marker → three labels" "$(body ok "The retry backoff is lost on restart.${nl}${nl}<!-- ds-feedback v1 area:loop kind:bug -->${nl}<!-- ds-key:fd:0123abcd -->${nl}")" \
  "ds-feedback${nl}area:loop${nl}kind:bug"
eq "dashes and digits" "$(body dash "x${nl}<!-- ds-feedback v1 area:board-ui kind:idea2 -->")" "ds-feedback${nl}area:board-ui${nl}kind:idea2"
eq "CRLF body" "$(body crlf $'x\r\n<!-- ds-feedback v1 area:loop kind:bug -->\r\n')" "ds-feedback${nl}area:loop${nl}kind:bug"
eq "no marker → none" "$(body none "A plain issue someone opened.${nl}")" ""
eq "empty body → none" "$(body empty "")" ""
eq "upper case → none" "$(body upper "<!-- ds-feedback v1 area:Loop kind:bug -->")" ""
eq "unknown version → none" "$(body v2 "<!-- ds-feedback v2 area:loop kind:bug -->")" ""
eq "missing kind → none" "$(body nokind "<!-- ds-feedback v1 area:loop -->")" ""
eq "extra words → none" "$(body extra "<!-- ds-feedback v1 area:loop kind:bug label:x -->")" ""
eq "shell in a word → none" "$(body shell "<!-- ds-feedback v1 area:\$(id) kind:bug -->")" ""
eq "long word → none" "$(body long "<!-- ds-feedback v1 area:$(printf 'a%.0s' {1..33}) kind:bug -->")" ""
eq "marker inside a line → none" "$(body inline "see <!-- ds-feedback v1 area:loop kind:bug --> here")" ""
eq "two markers → none" "$(body two "<!-- ds-feedback v1 area:loop kind:bug -->${nl}<!-- ds-feedback v1 area:board kind:idea -->")" ""
eq "a second, malformed claim → none" "$(body twobad "<!-- ds-feedback v1 area:loop kind:bug -->${nl}ds-feedback v1 area:x")" ""

# The body is never printed: a secret-looking line next to a good marker stays out of the output.
out="$(body secret "token ghp_PLANTED_VALUE_123${nl}<!-- ds-feedback v1 area:loop kind:bug -->")"
if grep -q PLANTED <<<"$out"; then fail=$((fail+1)); echo "  FAIL: the body reached the output" >&2; else pass=$((pass+1)); fi

# The event file, as the workflow passes it; an issue with no body; an unreadable input exits 2.
printf '{"issue":{"number":7,"body":"x\\n<!-- ds-feedback v1 area:loop kind:bug -->"}}' > "$TMP/event.json"
eq "event file" "$("$NODE" "$S" "$TMP/event.json")" "ds-feedback${nl}area:loop${nl}kind:bug"
printf '{"issue":{"number":8,"body":null}}' > "$TMP/null.json"
eq "null body → none" "$("$NODE" "$S" "$TMP/null.json")" ""
printf 'not json' > "$TMP/bad.json"
set +e; "$NODE" "$S" "$TMP/bad.json" >/dev/null 2>&1; r=$?; "$NODE" "$S" "$TMP/missing.json" >/dev/null 2>&1; r2=$?; set -e
eq "bad event exits 2" "$r" "2"
eq "missing input exits 2" "$r2" "2"

# The marker the loop writes is the one the script reads (bin/loop/feedback/post.ts).
if command -v bun >/dev/null; then
  m="$(cd "$ROOT" && bun -e 'import { finalText } from "./bin/loop/feedback/post.ts"; console.log(finalText({ kind: "issue", key: "fd:1", title: "t", body: "b", area: "board-ui", label: "bug" }).body)')"
  eq "the loop's marker labels" "$(body loop "$m")" "ds-feedback${nl}area:board-ui${nl}kind:bug"
fi

echo "feedback-labels: $pass passed, $fail failed"
[ "$fail" = 0 ]
