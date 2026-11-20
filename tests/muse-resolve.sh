#!/usr/bin/env bash
# muse-resolve — museResolve (bin/loop/capacity/pick.ts; ds_muse_resolve here is its twin): a muse family alias (the model id
# without its trailing -<version>) becomes the family's visible catalog row with
# the newest release_date. Exact ids, unknown aliases, and anything at all when
# the catalog is missing pass through unchanged.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/twins.sh
. "$ROOT/tests/lib/twins.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }

mkdir -p "$TMP/cat"
cat > "$TMP/cat/fx.json" <<'EOF'
{"rows":[
 {"model_id":"muse-spark-1.2","visibility":"visible","release_date":"2026-08-05",
  "reasoning_effort_variants":[{"tier":"low"}]},
 {"model_id":"muse-spark-1.3","visibility":"visible","release_date":"2026-09-02",
  "reasoning_effort_variants":[{"tier":"low"},{"tier":"max"}]},
 {"model_id":"muse-wonder-full-1.0","visibility":"visible","release_date":"2026-10-12",
  "reasoning_effort_variants":[{"tier":"low"}]},
 {"model_id":"muse-old-0.1","visibility":"hidden","release_date":"2026-01-01",
  "reasoning_effort_variants":[{"tier":"low"}]},
 {"model_id":"muse-ghost-2.0-contributor","visibility":"visible","release_date":"2026-11-01",
  "reasoning_effort_variants":[{"tier":"low"}]},
 {"model_id":null,"visibility":"visible","release_date":"2026-11-02",
  "reasoning_effort_variants":[{"tier":"low"}]}
]}
EOF
export MUSE_MODEL_CATALOG_DIR="$TMP/cat"

eq "spark alias resolves to the newer release_date" "$(ds_muse_resolve muse-spark)" "muse-spark-1.3"
eq "multi-word family resolves" "$(ds_muse_resolve muse-wonder-full)" "muse-wonder-full-1.0"
eq "exact id passes through" "$(ds_muse_resolve muse-spark-1.3)" "muse-spark-1.3"
eq "older exact id passes through too" "$(ds_muse_resolve muse-spark-1.2)" "muse-spark-1.2"
eq "hidden rows are ignored" "$(ds_muse_resolve muse-old)" "muse-old"
eq "contributor rows are ignored" "$(ds_muse_resolve muse-ghost)" "muse-ghost"
eq "unknown alias passes through" "$(ds_muse_resolve muse-nope)" "muse-nope"
eq "non-muse model passes through" "$(ds_muse_resolve opus)" "opus"

export MUSE_MODEL_CATALOG_DIR="$TMP/does-not-exist"
eq "missing catalog: alias passes through" "$(ds_muse_resolve muse-spark)" "muse-spark"
eq "missing catalog: exact id passes through" "$(ds_muse_resolve muse-spark-1.3)" "muse-spark-1.3"

mkdir -p "$TMP/emptycat"
export MUSE_MODEL_CATALOG_DIR="$TMP/emptycat"
eq "empty catalog: alias passes through" "$(ds_muse_resolve muse-spark)" "muse-spark"

printf 'not json{{{' > "$TMP/cat/bad.json"
export MUSE_MODEL_CATALOG_DIR="$TMP/cat"
eq "an unreadable catalog file is skipped" "$(ds_muse_resolve muse-spark)" "muse-spark-1.3"

echo "muse-resolve: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
