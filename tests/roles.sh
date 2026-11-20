#!/usr/bin/env bash
# roles.sh — the model catalog (`list --json` -> catalog) and the agent:model[:effort[:plan]] fallback column.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
RP="zzroles-$$"; TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$DS_STATE_ROOT/$RP"' EXIT
export BACKEND="$TMP/backend"; printf '#!/usr/bin/env bash\nexit 0\n' > "$BACKEND"; chmod +x "$BACKEND"
export CODEX_BIN="$TMP/no-codex"
export MUSE_MODEL_CATALOG_DIR="$TMP/emptycat"; mkdir -p "$TMP/emptycat"   # hermetic: no host muse rows

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
rj() { "$ROOT/bin/commands/roles.sh" list --json "$RP"; }
# A project's own roster rows (U256: rows in loop.db, read through the export; no file is written).
own() { "$ROOT/bin/ds" --state "$DS_STATE_ROOT" config export --project "$1" | awk '/^#== /{s=($2=="roles.conf");next} s&&NF'; }
col() { own "$RP" | awk -v r="$1" -v c="$2" '$1==r{print $c}'; }
import() { "$ROOT/bin/ds" --state "$DS_STATE_ROOT" config import --project "$1" --file "$2" "$3" >/dev/null; }

eq "catalog lists one entry per muse family"  "$(rj | jq -r '[.catalog[]|select(.agent=="muse" and .custom==false)|.model]|join(",")')" "muse-spark,muse-wonder,muse-wonder-full"
eq "family labels have no version"            "$(rj | jq -r '.catalog[]|select(.model=="muse-wonder-full")|.label')" "Muse · Wonder Full"
eq "catalog has the claude rows"              "$(rj | jq -r '[.catalog[]|select(.agent=="claude")|.model]|join(",")')" "fable,opus,sonnet"
eq "catalog rows carry efforts, not custom"   "$(rj | jq -r '.catalog[]|select(.model=="opus")|[.custom,(.efforts|length>0)]|join(",")')" "false,true"
eq "agents/models are gone"                   "$(rj | jq -r '[has("agents"),has("models")]|join(",")')" "false,false"
eq "the default roster's exact muse id is custom" "$(rj | jq -r '[.catalog[]|select(.custom)|.label]|join(",")')" "muse:muse-spark-1.3 (custom)"

# U256: set refuses a primary model outside the catalog; a row imported unchecked still lists it as custom.
rc=0; err="$("$ROOT/bin/commands/roles.sh" set "$RP" builder zed zed-1 2>&1 >/dev/null)" || rc=$?
eq "set refuses a model outside the catalog" "$rc:$err" "2:roles.sh: unknown model 'zed:zed-1' (not in the model catalog)"
printf 'builder zed zed-1 ondemand high claude:sonnet:low,quux:q9\n' > "$TMP/roles.conf"; import "$RP" roles.conf "$TMP/roles.conf"
eq "unknown pair a roster uses: custom row"   "$(rj | jq -r '[.catalog[]|select(.custom)|.label]|sort|join(",")')" "muse:muse-spark-1.3 (custom),quux:q9 (custom),zed:zed-1 (custom)"
eq "three-field fallback round-trips"         "$(col builder 6)" "claude:sonnet:low,quux:q9"
eq "...and --json returns it as written"      "$(rj | jq -r '.roles[]|select(.role=="builder")|.fallbacks')" "claude:sonnet:low,quux:q9"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" "claude:sonnet,muse:muse-spark-1.3:max" >/dev/null
eq "two- and three-field entries mix"         "$(col builder 6)" "claude:sonnet,muse:muse-spark-1.3:max"
eq "an exact muse id a roster uses is custom" "$(rj | jq -r '[.catalog[]|select(.custom)|.label]|join(",")')" "muse:muse-spark-1.3 (custom)"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" "claude:sonnet:low:Ultra" Max >/dev/null
eq "four-field fallback round-trips" "$(col builder 6)" "claude:sonnet:low:Ultra"
eq "primary plan round-trips" "$(rj | jq -r '.roles[]|select(.role=="builder")|.plan')" "Max"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" "claude:sonnet" >/dev/null
eq "omitting plan preserves it" "$(col builder 7)" "Max"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" "claude:sonnet" - >/dev/null
eq "explicit Any clears plan" "$(rj | jq -r '.roles[]|select(.role=="builder")|.plan')" ""
rc=0; "$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" "claude:sonnet:low:Ultra:x" >/dev/null 2>&1 || rc=$?
eq "five fields refused" "$rc" "2"

mkdir -p "$TMP/musecat"
cat > "$TMP/musecat/fx.json" <<'EOF'
{"rows":[
 {"model_id":null,"visibility":"visible","is_default":false,
  "reasoning_effort_variants":[{"tier":"low"}]},
 {"model_id":"muse-wonder-9.9","visibility":"visible","is_default":false,
  "reasoning_effort_variants":[{"tier":"max"},{"tier":"low"}]},
 {"model_id":"muse-spark-1.3","visibility":"visible","is_default":false,
  "reasoning_effort_variants":[{"tier":"low"}]},
 {"model_id":"muse-old-0.1","visibility":"hidden","is_default":false,
  "reasoning_effort_variants":[{"tier":"low"}]},
 {"model_id":"muse-wonder-9.9-contributor","visibility":"visible","is_default":false,
  "reasoning_effort_variants":[{"tier":"low"}]}
]}
EOF
export MUSE_MODEL_CATALOG_DIR="$TMP/musecat"
eq "muse family merges in, efforts in canonical order" "$(rj | jq -r '.catalog[]|select(.model=="muse-wonder")|[.agent,.label,(.efforts|join(",")),.custom]|join("|")')" "muse|Muse · Wonder|low,max|false"
eq "live catalog wins on a clash (resolved efforts)" "$(rj | jq -r '.catalog[]|select(.model=="muse-spark")|[.agent,.label,(.efforts|join(",")),.custom]|join("|")')" "muse|Muse · Spark|low|false"
eq "hidden, contributor and versioned ids never shown (except custom)" "$(rj | jq '[.catalog[]|select(.agent=="muse" and .custom==false and (.model=="muse-old-0.1" or (.model|contains("contributor")) or (.model|test("-[0-9]"))))]|length')" "0"
export MUSE_MODEL_CATALOG_DIR="$TMP/does-not-exist"
eq "missing muse catalog: models.conf muse aliases are the fallback" "$(rj | jq -r '[.catalog[]|select(.agent=="muse" and .custom==false)|.model]|join(",")')" "muse-spark,muse-wonder,muse-wonder-full"
export MUSE_MODEL_CATALOG_DIR="$TMP/emptycat"

printf 'claude | opus | Opus Only | -\n' > "$TMP/models.conf"; import "$RP" models.conf "$TMP/models.conf"
eq "per-project models.conf replaces the catalog" "$(rj | jq -c '[.catalog[]|[.label,.efforts,.custom]]')" '[["Opus Only",[],false],["claude:fable (custom)",[],true],["claude:sonnet (custom)",[],true],["muse:muse-spark-1.3 (custom)",[],true]]'
export MUSE_MODEL_CATALOG_DIR="$TMP/musecat"
eq "muse rows still merge under a per-project override" "$(rj | jq -r '[.catalog[]|select(.custom==false)|.model]|sort|join(",")')" "muse-spark,muse-wonder,opus"
printf 'not json{{{' > "$TMP/musecat/bad.json"
eq "an unreadable catalog file is skipped" "$(rj | jq -r '[.catalog[]|select(.custom==false)|.model]|sort|join(",")')" "muse-spark,muse-wonder,opus"

# Codex catalog is bundled in the CLI: no inference or provider override is needed.
cat > "$TMP/codex" <<'STUB'
#!/usr/bin/env bash
[ "$*" = "debug models --bundled" ] || exit 2
cat "$CODEX_FIXTURE"
STUB
chmod +x "$TMP/codex"
export CODEX_BIN="$TMP/codex" CODEX_FIXTURE="$TMP/codex.json"
cat > "$CODEX_FIXTURE" <<'EOF'
{"models":[
 {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","supported_reasoning_levels":[{"effort":"ultra"},{"effort":"low"}]},
 {"slug":"future-model","display_name":"Future Model","visibility":"list","supported_reasoning_levels":[{"effort":"medium"}]},
 {"slug":"hidden-model","visibility":"hide","supported_reasoning_levels":[]}
]}
EOF
eq "Codex merges even under a project catalog override" "$(rj | jq -r '.catalog[]|select(.model=="future-model")|[.agent,.label,(.efforts|join(",")),.custom]|join("|")')" "codex|Codex · Future Model|medium|false"
eq "Codex reports its supported efforts" "$(rj | jq -r '.catalog[]|select(.model=="gpt-6.1-sol")|.efforts|join(",")')" "low,ultra"
eq "hidden Codex models stay out of the picker" "$(rj | jq '[.catalog[]|select(.model=="hidden-model")]|length')" "0"
printf 'not json' > "$CODEX_FIXTURE"
eq "a broken Codex catalog leaves the project choices usable" "$(rj | jq '[.catalog[]|select(.model=="future-model")]|length')" "0"
export CODEX_BIN="$TMP/no-codex"

# --- set keeps the row order (S3): replace in place, append only when new ---
order() { own "$RP" | awk '{print $1}' | tr '\n' ','; }
before="$(order)"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude sonnet "" low >/dev/null
eq "set on a middle role keeps the line order" "$(order)" "$before"
"$ROOT/bin/commands/roles.sh" set "$RP" builder claude opus "" "" "claude:sonnet" >/dev/null
eq "set again keeps the line order" "$(order)" "$before"
"$ROOT/bin/commands/roles.sh" set "$RP" tester claude sonnet ondemand >/dev/null
eq "a role new to the project is appended" "$(order)" "${before}tester,"
rc=0; "$ROOT/bin/commands/roles.sh" set "$RP" schematics claude opus ondemand >/dev/null 2>&1 || rc=$?
eq "a role in no roster is refused (U256)" "$rc" "2"

# U260: the Studio has its own roster row (the default shows it; a project override wins)
SP="zzroles-studio-$$"; trap 'rm -rf "$TMP" "$DS_STATE_ROOT/$RP" "$DS_STATE_ROOT/$SP"' EXIT
eq "studio row in the default roster (U267: claude sonnet)" "$("$ROOT/bin/commands/roles.sh" list "$SP" | awk '$1=="studio"{print $2,$3}')" "claude sonnet"
"$ROOT/bin/commands/roles.sh" set "$SP" studio claude opus >/dev/null
eq "a project override of the studio row wins" "$("$ROOT/bin/commands/roles.sh" list "$SP" | awk '$1=="studio"{print $2,$3}')" "claude opus"

# U267: a project roster overrides per role; the default fills every role it lacks.
OP="zzroles-one-$$"; trap 'rm -rf "$TMP" "$DS_STATE_ROOT/$RP" "$DS_STATE_ROOT/$SP" "$DS_STATE_ROOT/$OP"' EXIT
"$ROOT/bin/commands/roles.sh" set "$OP" tester claude sonnet >/dev/null
eq "set on a project with no roster writes one row" "$(own "$OP" | awk '{print $1}' | tr '\n' ,)" "tester,"
eq "...whose omitted spawn is the default row's" "$(own "$OP" | awk '$1=="tester"{print $4}')" "ondemand"
eq "...and no roles.conf file" "$(test -e "$DS_STATE_ROOT/$OP/roles.conf" && echo file || echo none)" "none"
eq "list shows every default role, the set one overridden" "$("$ROOT/bin/commands/roles.sh" list "$OP" | awk 'NR>3{print $1}' | tr '\n' ,)" "$(awk '!/^[[:space:]]*(#|$)/{print $1}' "$ROOT/conventions/roles.conf" | tr '\n' ,)"
eq "a role the project lacks shows the default row" "$("$ROOT/bin/commands/roles.sh" list "$OP" | awk '$1=="studio"{print $2,$3}')" "claude sonnet"
eq "--json: the set role is an override, the rest default" "$("$ROOT/bin/commands/roles.sh" list --json "$OP" | jq -r '[.roles[]|select(.source=="override")|.role]|join(",")')" "tester"
"$ROOT/bin/commands/roles.sh" reset "$OP" tester >/dev/null
eq "reset drops the project's row" "$(own "$OP" | grep -c '^tester' || true)" "0"
eq "...and the role runs the default again" "$("$ROOT/bin/commands/roles.sh" list "$OP" | awk '$1=="tester"{print $2,$3}')" "$(awk '$1=="tester"{print $2,$3}' "$ROOT/conventions/roles.conf")"

echo "roles: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
