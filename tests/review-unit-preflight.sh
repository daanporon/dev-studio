#!/usr/bin/env bash
# review-unit-preflight.sh — part of the review-unit suite (U233): the plugin preflight and the base-ref handling. The suite is split so no one CI job nears
# CI_TEST_TIMEOUT on a loaded host; the stubs and helpers are in tests/lib/review-unit-prelude.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/review-unit-prelude.sh"

# --- Preflight: the ce-code-review skill must exist on disk for this config dir -----------------
# `claude plugin list --json` reports an installPath that can dangle while still "enabled".
rm -f "$RFILE"; printf 'lead claude sonnet always\n' > "$SD/roles.conf"
TOP="$(git -C "$TMP/repo" rev-parse --show-toplevel)"
GONE="$TMP/plug/gone"
mkdir -p "$TMP/home/.claude"
broken_json() { printf '[{"id":"compound-engineering@compound-engineering-plugin","scope":"user","enabled":true,"installPath":"%s"}]' "$GONE"; }

: > "$CLAUDE_LOG"; : > "$CLAUDE_PLUGIN_LOG"
run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "a healthy skill runs the review and exits 0" "0" "$rc"
check "the healthy probe ran once"                   "1" "$(grep -c plugin-list "$CLAUDE_PLUGIN_LOG")"
check "the healthy run wrote the receipt"            "present" "$([ -f "$RFILE" ] && echo present || echo absent)"

rm -f "$RFILE"; : > "$CLAUDE_LOG"
out="$(PLUG_JSON="$(broken_json)" HOME="$TMP/home" run_ru "$LBL" 2>"$TMP/err")"; rc=$?
check "a dangling installPath exits 3"               "3" "$rc"
check "a dangling installPath starts no review"      "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "a dangling installPath prints no report"      "" "$out"
check "a dangling installPath writes no receipt"     "absent" "$([ -e "$RFILE" ] && echo present || echo absent)"
has   "stderr names the broken path"                 "$(cat "$TMP/err")" "$GONE"
has   "stderr names the scope"                       "$(cat "$TMP/err")" "(user scope)"
has   "stderr names the config dir"                  "$(cat "$TMP/err")" "config dir: $TMP/home/.claude"
has   "stderr prints the repair command"             "$(cat "$TMP/err")" "claude plugin uninstall compound-engineering@compound-engineering-plugin --scope user"
has   "the repair runs with the owner config dir"    "$(cat "$TMP/err")" "env -u CLAUDE_CONFIG_DIR claude plugin install"

# A preflight failure also retains the unusable historical row.
printf 'deadbeef\t1\t-\t0\n' > "$RFILE"
PLUG_JSON="$(broken_json)" run_ru "$LBL" >/dev/null 2>&1
check "a preflight failure preserves a legacy receipt"  "deadbeef" "$(cut -f1 "$RFILE")"

# A dangling project-scope entry is repaired with that scope, from the project dir.
PLUG_JSON='[{"id":"compound-engineering@compound-engineering-plugin","scope":"project","enabled":true,"projectPath":"'"$TOP"'","installPath":"'"$GONE"'"}]' \
  run_ru "$LBL" >/dev/null 2>"$TMP/err"
has "a project-scope repair keeps the scope"        "$(cat "$TMP/err")" "cd $TOP && "
has "a project-scope repair uses --scope project"   "$(cat "$TMP/err")" "plugin install compound-engineering@compound-engineering-plugin --scope project"

# A managed profile whose plugins/ is a symlink: say so, and repair from the owner dir.
mkdir -p "$TMP/owner/plugins" "$TMP/prof"; ln -s "$TMP/owner/plugins" "$TMP/prof/plugins"
PLUG_JSON="$(broken_json)" CLAUDE_CONFIG_DIR="$TMP/prof" run_ru "$LBL" >/dev/null 2>"$TMP/err"
has "a symlinked plugins dir is named"               "$(cat "$TMP/err")" "$TMP/prof/plugins is a symlink to $TMP/owner/plugins"
has "the repair targets the owner config dir"        "$(cat "$TMP/err")" "env CLAUDE_CONFIG_DIR=$TMP/owner claude plugin install"

# Not installed at all (no enabled entry, or only another project's entry) -> exit 3, install-only repair.
: > "$CLAUDE_LOG"
PLUG_JSON='[]' run_ru "$LBL" >/dev/null 2>"$TMP/err"; rc=$?
check "not installed exits 3"                        "3" "$rc"
check "not installed starts no review"               "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
has   "not installed says so"                        "$(cat "$TMP/err")" "is not installed"
lacks "not installed prints an install-only repair"  "$(cat "$TMP/err")" "uninstall"
PLUG_JSON='[{"id":"compound-engineering@compound-engineering-plugin","scope":"project","enabled":true,"projectPath":"/elsewhere","installPath":"'"$PLUG_HEALTHY"'"}]' \
  run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "another project's entry does not apply"       "3" "$rc"
PLUG_JSON='[{"id":"compound-engineering@compound-engineering-plugin","scope":"user","enabled":false,"installPath":"'"$PLUG_HEALTHY"'"}]' \
  run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "a disabled entry does not apply"              "3" "$rc"

# The most specific scope wins: a healthy project entry beats a dangling user entry.
rm -f "$RFILE"
PLUG_JSON='[{"id":"compound-engineering@compound-engineering-plugin","scope":"user","enabled":true,"installPath":"'"$GONE"'"},{"id":"compound-engineering@compound-engineering-plugin","scope":"project","enabled":true,"projectPath":"'"$TOP"'","installPath":"'"$PLUG_HEALTHY"'"}]' \
  run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "a healthy project entry wins over a dangling user one" "0" "$rc"
# ...and a dangling project entry is not rescued by a healthy user one.
PLUG_JSON='[{"id":"compound-engineering@compound-engineering-plugin","scope":"user","enabled":true,"installPath":"'"$PLUG_HEALTHY"'"},{"id":"compound-engineering@compound-engineering-plugin","scope":"project","enabled":true,"projectPath":"'"$TOP"'","installPath":"'"$GONE"'"}]' \
  run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "a dangling project entry wins over a healthy user one" "3" "$rc"

# An unknown probe (list fails / not JSON) never blocks the review; it warns.
rm -f "$RFILE"; : > "$CLAUDE_LOG"
PLUG_FAIL=1 run_ru "$LBL" >/dev/null 2>"$TMP/err"; rc=$?
check "a failed listing still runs the review"       "0" "$rc"
check "a failed listing still writes the receipt"    "present" "$([ -f "$RFILE" ] && echo present || echo absent)"
has   "a failed listing warns"                       "$(cat "$TMP/err")" "couldn't verify the ce-code-review skill"
rm -f "$RFILE"
PLUG_JSON='not json' run_ru "$LBL" >/dev/null 2>"$TMP/err"; rc=$?
check "a non-JSON listing still runs the review"     "0" "$rc"

# The muse fallback is for limits only: exit 3 never tries it.
printf 'builder-review claude opus elevate - muse:muse-spark-1.3\n' > "$SD/roles.conf"
: > "$MUSE_LOG"
PLUG_JSON="$(broken_json)" MUSE_SKILLS="$CE_ROW" run_ru "$LBL" >/dev/null 2>&1; rc=$?
check "exit 3 does not try the muse fallback"        "0" "$(grep -c '^args:' "$MUSE_LOG")"

# --- Full vs delta re-reviews ------------------------------------------------------------------
# A second repo with a base branch `main` (the base-ref) and a unit branch `feat` on top.
R2="$TMP/repo2"; RF2="$R2/.git/ds-review"
g2() { git -C "$R2" -c user.email=t@t -c user.name=t "$@"; }
run2() { (cd "$R2" && clear_last_run && "$RU" "$@") 2>&1; }
git init -q -b main "$R2"; echo base > "$R2/base.txt"; echo unit > "$R2/unit.txt"
g2 add -A; g2 commit -q -m base; echo one > "$R2/unit.txt"; g2 checkout -q -b feat; g2 commit -q -am "unit v1"
rm -f "$RF2"; : > "$CLAUDE_LOG"
o="$(run2 "$LBL" main)"
has   "no receipt: a full review"                 "$o" "review-unit: full review"
lacks "no receipt: not a delta"                   "$o" "delta review"
has   "no receipt: reviews against the base"      "$(args)" "mode:agent base:main"
first="$(g2 rev-parse HEAD)"
check "the full review stamps HEAD"               "$first" "$(cut -f1 "$RF2")"

echo two > "$R2/unit.txt"; g2 commit -q -am "fix"
: > "$CLAUDE_LOG"; o="$(run2 "$LBL" main)"
has   "after a fix commit: a delta review"        "$o" "review-unit: delta (correctness) review (since ${first:0:12}, from ds-review)"
has   "the delta asks for correctness only"       "$(args)" "Run only these reviewers: correctness."
has   "the delta reviews receipt..HEAD only"      "$(args)" "mode:agent base:$first"
lacks "the delta is not against the base"         "$(args)" "base:main"
has   "the delta tells the reviewer its scope"    "$(args)" "DELTA re-review"
check "the delta stamps a fresh receipt for HEAD" "$(g2 rev-parse HEAD)" "$(cut -f1 "$RF2")"
check "the delta receipt keeps the 6-field format" "6" "$(awk -F'\t' '{print NF; exit}' "$RF2")"
check "the delta receipt keeps the base-ref"      "main" "$(cut -f3 "$RF2")"

# Keyword hits no longer widen a delta: user input, a retry, INSERT/lock, a migration file, a route
# and an eval line each stay correctness only.
for kw in 'validate user input on login|auth.txt' 'retry with backoff on timeout|retry.txt' \
  'INSERT (a) lock the queue|db.txt' 'add users table|db/migrate/001_add_users.rb' "app.get('/health')|routes.js" 'eval "$cmd"|run.sh'; do
  mkdir -p "$R2/$(dirname "${kw#*|}")"; echo "${kw%|*}" > "$R2/${kw#*|}"; g2 add -A; g2 commit -q -m "delta ${kw#*|}"
  : > "$CLAUDE_LOG"; o="$(run2 "$LBL" main)"
  has   "keyword delta ${kw#*|}: correctness only" "$o" "review-unit: delta (correctness) review"
  has   "keyword delta ${kw#*|}: prompt narrows"   "$(args)" "Run only these reviewers: correctness."
done

: > "$CLAUDE_LOG"; o="$(run2 "$LBL" main)"
has   "an unchanged HEAD: a full review"          "$o" "review-unit: full review"

# A different base-ref than the receipt's is a full review.
: > "$CLAUDE_LOG"; o="$(run2 "$LBL")"
has   "a changed base-ref: a full review"         "$o" "review-unit: full review"

# A rebase onto a base that only moved: the unit's own patch is unchanged (same patch-id),
# so the earlier review is carried — no engine runs — and the receipt is re-stamped for HEAD.
run2 "$LBL" main >/dev/null
pre="$(g2 rev-parse HEAD)"
pre_count="$(cut -f4 "$RF2")"; pre_engine="$(cut -f5 "$RF2")"
g2 checkout -q main; echo more > "$R2/other.txt"; g2 add -A; g2 commit -q -m "base moves"; g2 checkout -q feat
g2 rebase -q main
: > "$CLAUDE_LOG"; o="$(run2 "$LBL" main)"
has   "a base-only rebase: a carried review"      "$o" "review-unit: carried review from ${pre:0:12}"
check "a carried rebase runs no engine"           "0" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "the carried receipt stamps HEAD"           "$(g2 rev-parse HEAD)" "$(cut -f1 "$RF2")"
check "the carried receipt keeps the 6 fields"    "6" "$(awk -F'\t' '{print NF; exit}' "$RF2")"
check "the carried receipt keeps the base-ref"    "main" "$(cut -f3 "$RF2")"
check "the carried receipt keeps the count"       "$pre_count" "$(cut -f4 "$RF2")"
check "the carried receipt names the engine"      "$pre_engine" "$(cut -f5 "$RF2")"
# finish-unit.sh accepts a receipt whose sha is an ancestor of HEAD; the carried sha is HEAD.
check "finish-unit.sh accepts the carried sha"    "0" "$(git -C "$R2" merge-base --is-ancestor "$(cut -f1 "$RF2")" HEAD >/dev/null 2>&1; echo $?)"

# A rebase that changes the unit's own code (a conflict resolved differently) is a full review.
pre="$(g2 rev-parse HEAD)"
g2 checkout -q main; echo base-edit > "$R2/unit.txt"; g2 commit -q -am "base edits unit.txt"; g2 checkout -q feat
g2 rebase main >/dev/null 2>&1 || true
for _ in 1 2 3; do
  [ -d "$R2/.git/rebase-merge" ] || break
  echo resolved > "$R2/unit.txt"; g2 add -A; GIT_EDITOR=true g2 rebase --continue >/dev/null 2>&1 || true
done
check "fixture: the rebase finished"              "feat" "$(g2 rev-parse --abbrev-ref HEAD)"
: > "$CLAUDE_LOG"; o="$(run2 "$LBL" main)"
has   "a code-changing rebase: a full review"     "$o" "review-unit: full review"
has   "...and says why"                           "$o" "rebase changed the unit's own code"
has   "...against the base"                       "$(args)" "mode:agent base:main"

# A whitespace-only rewrite is not "unchanged": the verbatim patch-id differs, so a full review.
run2 "$LBL" main >/dev/null; g2 checkout -q main; echo m2 > "$R2/m2.txt"; g2 add -A; g2 commit -q -m "base moves again"; g2 checkout -q feat
g2 rebase -q main; printf '%s \n' "$(cat "$R2/unit.txt")" > "$R2/unit.txt"; g2 commit -q -am "whitespace"
g2 reset -q --soft HEAD~1; g2 commit -q --amend --no-edit
: > "$CLAUDE_LOG"; o="$(run2 "$LBL" main 2>&1)"
has   "a whitespace-only rewrite is a full review" "$o" "rebase changed the unit's own code"

# A carried rebase with a dirty tree is a full review: uncommitted changes were never reviewed.
g2 checkout -q main; echo m3 > "$R2/m3.txt"; g2 add -A; g2 commit -q -m "base moves a third time"; g2 checkout -q feat
g2 rebase -q main; echo dirty > "$R2/uncommitted.txt"
: > "$CLAUDE_LOG"; o="$(run2 "$LBL" main 2>&1)"; rc=$?
has   "a dirty carried rebase is a full review"   "$o" "rebase kept the unit's patch but the tree is dirty"
check "a dirty carried rebase runs the engine"   "1" "$(grep -c '^args:' "$CLAUDE_LOG")"
check "a dirty carried rebase exits 4, no receipt" "4" "$rc"
check "a dirty carried rebase writes no receipt" "absent" "$([ -e "$RF2" ] && echo present || echo absent)"
rm -f "$R2/uncommitted.txt"

# An unreadable receipt is a full review too.
printf 'notasha\t1\tmain\t0\tclaude:opus\n' > "$RF2"; echo three >> "$R2/unit.txt"; g2 commit -q -am "more"
o="$(run2 "$LBL" main)"
has   "an unreadable receipt: a full review"      "$o" "review-unit: full review"


# --- ds-review-base: a run with no receipt still moves the delta base only if it reported -------
R3="$TMP/repo3"; RF3="$R3/.git/ds-review"; RB3="$R3/.git/ds-review-base"
g3() { git -C "$R3" -c user.email=t@t -c user.name=t "$@"; }
run3() { (cd "$R3" && clear_last_run && "$RU" "$@") 2>&1; }
git init -q -b main "$R3"; echo base > "$R3/base.txt"; echo unit > "$R3/unit.txt"
g3 add -A; g3 commit -q -m base; g3 checkout -q -b feat; echo one > "$R3/unit.txt"; g3 commit -q -am "unit v1"
v1="$(g3 rev-parse HEAD)"
: > "$CLAUDE_LOG"; o="$(run3 "$LBL" main)"
has   "base: a first run is full"                 "$o" "review-unit: full review (no usable previous review"
check "base: the clean run writes ds-review-base" "$v1" "$(cut -f1 "$RB3")"
check "base: the base is the receipt fields plus a clean flag and proof" "7" "$(awk -F'\t' '{print NF; exit}' "$RB3")"

# A dirty run reports but leaves no receipt; the base moves to its sha and the next clean run is a delta from it.
echo two > "$R3/unit.txt"; g3 commit -q -am "v2"; v2="$(g3 rev-parse HEAD)"; echo wip > "$R3/wip.txt"
o="$(run3 "$LBL" main)"; rc=$?
check "base: a dirty run exits 4"                 "4" "$rc"
check "base: a dirty run leaves no receipt"       "absent" "$([ -e "$RF3" ] && echo present || echo absent)"
check "base: a dirty run moves the base"          "$v2" "$(cut -f1 "$RB3")"
rm -f "$R3/wip.txt"; echo three > "$R3/unit.txt"; g3 commit -q -am "v3"; v3="$(g3 rev-parse HEAD)"
: > "$CLAUDE_LOG"; o="$(run3 "$LBL" main)"
has   "base: the next run is a delta from the dirty run" "$o" "delta (correctness) review (since ${v2:0:12}, from ds-review-base)"
has   "base: the delta reviews base..HEAD"         "$(args)" "mode:agent base:$v2"
check "base: the delta writes a receipt for HEAD" "$v3" "$(cut -f1 "$RF3")"
check "base: ...and moves the base"               "$v3" "$(cut -f1 "$RB3")"
check "base: finish-unit accepts the receipt"     "0" "$(git -C "$R3" merge-base --is-ancestor "$(cut -f1 "$RF3")" HEAD >/dev/null 2>&1; echo $?)"

# An engine failure and an empty report leave the base where it was; the next run deltas from it.
rm -f "$RF3"; echo four > "$R3/unit.txt"; g3 commit -q -am "v4"; v4="$(g3 rev-parse HEAD)"
STUB_EXIT=1 run3 "$LBL" main >/dev/null || true
check "base: a failed engine keeps the base"      "$v3" "$(cut -f1 "$RB3")"
STUB_OUT="no report here" run3 "$LBL" main >/dev/null
check "base: an empty report keeps the base"      "$v3" "$(cut -f1 "$RB3")"
check "base: those runs leave no receipt"         "absent" "$([ -e "$RF3" ] && echo present || echo absent)"
: > "$CLAUDE_LOG"; o="$(run3 "$LBL" main)"
has   "base: the next run is a delta from the earlier sha" "$o" "since ${v3:0:12}, from ds-review-base"
check "base: ...and stamps $v4"                   "$v4" "$(cut -f1 "$RF3")"

# A changed base-ref is still a full review, from the base file too.
rm -f "$RF3"; echo five > "$R3/unit.txt"; g3 commit -q -am "v5"
o="$(run3 "$LBL")"
has   "base: a changed base-ref is full"          "$o" "base-ref changed since the previous review"

# A rebase that changes the unit's code, with only a base file, is full.
run3 "$LBL" main >/dev/null; rm -f "$RF3"
g3 checkout -q main; echo base-edit > "$R3/unit.txt"; g3 commit -q -am "base edits unit"; g3 checkout -q feat
g3 rebase main >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6; do
  [ -d "$R3/.git/rebase-merge" ] || break
  echo resolved > "$R3/unit.txt"; g3 add -A; GIT_EDITOR=true g3 rebase --continue >/dev/null 2>&1 || true
done
o="$(run3 "$LBL" main)"
has   "base: a code-changing rebase is full"      "$o" "rebase changed the unit's own code"


# A dirty-run base is never carried: discard the edit, rebase onto a moved base, and the review is full.
R4="$TMP/repo4"; RF4="$R4/.git/ds-review"; RB4="$R4/.git/ds-review-base"
g4() { git -C "$R4" -c user.email=t@t -c user.name=t "$@"; }
run4() { (cd "$R4" && clear_last_run && "$RU" "$@") 2>&1; }
git init -q -b main "$R4"; echo base > "$R4/base.txt"; echo unit > "$R4/unit.txt"
g4 add -A; g4 commit -q -m base; g4 checkout -q -b feat; echo one > "$R4/unit.txt"; g4 commit -q -am "unit v1"
echo wip > "$R4/wip.txt"; run4 "$LBL" main >/dev/null || true; rm -f "$R4/wip.txt"
check "dirty base: flagged unclean"               "0" "$(cut -f6 "$RB4")"
g4 checkout -q main; echo m > "$R4/m.txt"; g4 add -A; g4 commit -q -m "base moves"; g4 checkout -q feat; g4 rebase -q main
: > "$CLAUDE_LOG"; o="$(run4 "$LBL" main)"
has   "dirty base: a base-only rebase is full"    "$o" "saw uncommitted changes"
check "dirty base: the engine ran"                "1" "$(grep -c '^args:' "$CLAUDE_LOG")"

# A carried review moves the base: a later failed run deltas from the carried HEAD.
g4 checkout -q main; echo m2 > "$R4/m2.txt"; g4 add -A; g4 commit -q -m "base moves again"; g4 checkout -q feat; g4 rebase -q main
o="$(run4 "$LBL" main)"
has   "carried base: a carried review"            "$o" "carried review"
carried="$(g4 rev-parse HEAD)"
check "carried base: the base follows"            "$carried" "$(cut -f1 "$RB4")"
echo two > "$R4/unit.txt"; g4 commit -q -am v2; rm -f "$RF4"
STUB_EXIT=1 run4 "$LBL" main >/dev/null || true
o="$(run4 "$LBL" main)"
has   "carried base: a delta from the carried sha" "$o" "since ${carried:0:12}, from ds-review-base"

# Proof is project agnostic: no dev-studio or ACME files, with a different base branch.
echo "review-unit-preflight: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
