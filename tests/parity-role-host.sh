#!/usr/bin/env bash
# parity-role-host.sh — the ported orch.sh, set-orca-depth.sh, wrap-hooks.sh and codex-models.sh (U272) give
# what the shell versions gave: the same output, exit code and files written on the same inputs. The shell side is
# the tree at PARITY_BASE (default 3c71af0d, the last commit with the shell bodies), unpacked with git archive; the
# port side is this checkout. Hermetic: a fake backend, phone book, systemctl and codex on a temp state root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PARITY_BASE:-3c71af0d}"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$DS_STATE_PARENT"' EXIT
pass=0; fail=0

if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-role-host: $BASE is not in this clone — skipped"; echo "parity-role-host: 0 passed, 0 failed"; exit 0
fi
mkdir "$TMP/old"; git -C "$ROOT" archive "$BASE" bin conventions | tar -x -C "$TMP/old"
S="$DS_STATE_ROOT"
unset DS_LOOP_CHILD DS_WHO

# fakes: a backend that logs its argv and answers by FAKE_ASK, a phone book, systemctl, codex
mkdir -p "$TMP/fake/bin"
cat > "$TMP/fake/backend" <<'F'
#!/usr/bin/env bash
printf 'backend %s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  ask) case "${FAKE_ASK:-open}" in
         open) echo '{"ok":true,"result":{"answer":"use the store"}}' ;;
         closed) echo '{"ok":false,"error":{"code":"dispatch_inactive","message":"ask requires an active supervised Dispatch."}}'
                 echo "orca adapter: ask failed for run $2 (see error above)" >&2; exit 1 ;;
         other) echo '{"ok":false,"error":{"code":"run_not_found","message":"no such run"}}'; exit 1 ;;
       esac ;;
  send) echo "msg_fake" ;;
  reply) echo "replied $*"; exit 7 ;;
  set-nested-depth) echo "depth set to $2"; exit "${FAKE_SET_RC:-0}" ;;
  preflight) printf 'claude\tacct1\tx\t%s\n' "$FAKE_CFG" ;;
  *) echo '{}' ;;
esac
F
cat > "$TMP/fake/directory" <<'F'
#!/usr/bin/env bash
printf 'dir %s\n' "$*" >> "$FAKE_LOG"
[ "$1" = reach ] && [ "$3" = lead ] && { printf 'run\trun:run_%s\trun_%s\twtl\n' "$2" "$2"; exit 0; }
exit 2
F
cat > "$TMP/fake/bin/systemctl" <<'F'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$FAKE_LOG"
case "$2" in list-units) [ -z "${FAKE_UNIT:-}" ] || echo "  ${FAKE_UNIT} loaded active running Orca" ;; esac
exit 0
F
cat > "$TMP/fake/codex" <<'F'
#!/usr/bin/env bash
printf '%s' "$FAKE_CATALOG"
exit "${FAKE_CODEX_RC:-0}"
F
chmod +x "$TMP/fake/backend" "$TMP/fake/directory" "$TMP/fake/bin/systemctl" "$TMP/fake/codex"

# one run in a tree: stdout + stderr + exit code, then the log and any extra files, trees' paths made generic
runin() { # <tree> <script> <args…>   (stdin from $IN, default none)
  local tree="$1" script="$2" rc=0 out side=new; shift 2
  [ "$tree" = "$TMP/old" ] && side=old
  : > "$TMP/log-$side"
  out="$(cd "$TMP" && env -u ORCA_TERMINAL_HANDLE FAKE_LOG="$TMP/log-$side" BACKEND="$TMP/fake/backend" DIRECTORY="$TMP/fake/directory" \
    DS_STATE_ROOT="$S" CODEX_BIN="${CODEX_BIN:-$TMP/fake/codex}" XDG_CONFIG_HOME="$TMP/cfg-$side" PATH="$TMP/fake/bin:$PATH" ORCA_TERMINAL_HANDLE=term_x \
    "$tree/$script" "$@" 2>&1 <<<"${IN:-}")" || rc=$?
  printf '%s\n[rc=%s]\n--log--\n%s\n' "$out" "$rc" "$(cat "$TMP/log-$side")" | sed "s|$tree|TREE|g; s|$TMP/cfg-$side|CFG|g; s|$TMP/work-$side|WORK|g; s|$TMP/fake|FAKE|g"
}
check() { # <name> <script> <args…>
  local name="$1" script="$2"; shift 2
  local o n
  o="$(runin "$TMP/old" "$script" "$@")"; n="$(runin "$ROOT" "$script" "$@")"
  if [ "$o" = "$n" ]; then pass=$((pass + 1)); echo "ok   $name"
  else fail=$((fail + 1)); echo "FAIL $name"; diff <(printf '%s\n' "$o") <(printf '%s\n' "$n") | head -10; fi
}

# ---- orch.sh ----
mkdir -p "$S/fx/squads"
printf '%s' '{"topic":"t1","run_id":"run_t1","lead_wt":"wtl","units":[]}' > "$S/fx/squads/t1.json"
O=bin/role/orch.sh
check "orch: no args"                  $O
check "orch: --help"                   $O --help
check "orch: help"                     $O help
check "orch: lifecycle op"             $O adopt run_t1
check "orch: lifecycle studio-start"   $O studio-start x
check "orch: send passthrough"         $O send run_t1 "a subject" "a body"
check "orch: reply passthrough, rc 7"  $O reply msg_1 run_t1 "an answer"
check "orch: gate-create passthrough"  $O gate-create task_1 "ok?"
FAKE_ASK=open check "orch: ask open dispatch"  $O ask run_t1 "Which store?"
export FAKE_ASK=closed
check "orch: ask closed, falls back"   $O ask run_t1 "Which store?"
check "orch: ask closed, unknown run"  $O ask run_none "Which store?"
check "orch: ask closed, odd run id"   $O ask 'run t1' "Which store?"
check "orch: ask closed, 2 args"       $O ask run_t1
export FAKE_ASK=other
check "orch: ask other refusal"        $O ask run_t1 "Which store?"
unset FAKE_ASK

# ---- set-orca-depth.sh ----
D=bin/host/set-orca-depth.sh
for s in old new; do mkdir -p "$TMP/cfg-$s/orca/profiles/p1"; printf '{"settings":{"nestedWorkerMaxDepth":2}}' > "$TMP/cfg-$s/orca/profiles/p1/orca-data.json"; done
check "depth: bad arg"                 $D abc
check "depth: plain, default 5"        $D
check "depth: plain, 3"                $D 3
FAKE_SET_RC=4 check "depth: plain, backend fails" $D 6
check "depth: --auto already set"      $D 2 --auto
check "depth: --auto, no service"      $D 5 --auto
export FAKE_UNIT=orca-serve.service
IN=n check "depth: --auto, declined"   $D 5 --auto
IN=y check "depth: --auto, confirmed"  $D 5 --auto
check "depth: --auto --yes"            $D 5 --auto --yes
FAKE_SET_RC=3 check "depth: --auto, set fails" $D 5 --auto --yes
unset FAKE_UNIT

# ---- wrap-hooks.sh ----
W=bin/host/wrap-hooks.sh
GATED='{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"/x/bin/ds hook-gate gh-axi -- gh-axi"},{"type":"command","command":"keep-me --a -- b"}]},{"hooks":[{"type":"command","command":"/y/ds hook-gate lavish-axi -- lavish-axi"}]}]},"theme":"dark","n":[1,{"k":null}],"s":"é ü"}'
PLAIN='{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"gh-axi"}]}]}}'
mkcfg() { # <side> : acct1 gated, acct2 plain, acct3 gated with an exact backup, acct4 bad json, acct5 no file
  local s="$1" d="$TMP/accts-$1"
  rm -rf "$d"; mkdir -p "$d"/{sys,a1,a2,a3,a4,a5}
  printf '%s' "$GATED" > "$d/sys/settings.json"
  printf '%s' "$GATED" > "$d/a1/settings.json"; chmod 640 "$d/a1/settings.json"
  printf '%s' "$PLAIN" > "$d/a2/settings.json"
  printf '%s' "$GATED" > "$d/a3/settings.json"; printf '{"b":1,\n "hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"gh-axi"},{"type":"command","command":"keep-me --a -- b"}]},{"hooks":[{"type":"command","command":"lavish-axi"}]}]},"theme":"dark","n":[1,{"k":null}],"s":"é ü"}' > "$d/a3/settings.json.ds-hooks-backup"
  printf '%s' '{bad' > "$d/a4/settings.json"
}
wrapped() { # <side> <script mode args…> : fresh configs, run, print the outcome and every file
  local s="$1" tree d rc=0; shift
  [ "$s" = old ] && tree="$TMP/old" || tree="$ROOT"
  mkcfg "$s"; d="$TMP/accts-$s"
  { env CLAUDE_SYSTEM_DIR="$d/sys" HOME="$TMP/home" DS_WRAP_ACCOUNTS="$(printf 'a1\t%s\na2\t%s\na3\t%s\na4\t%s\na5\t%s\na1\t%s' "$d/a1" "$d/a2" "$d/a3" "$d/a4" "$d/a5" "$d/a1")" \
      "$tree/$W" "$@" 2>&1 || echo "[rc=$?]"; } | sed "s|$d|ACCTS|g"
  for f in sys/settings.json a1/settings.json a2/settings.json a3/settings.json a3/settings.json.ds-hooks-backup a4/settings.json; do
    printf '%s: ' "$f"; { [ -f "$d/$f" ] && { stat -c %a "$d/$f"; cat "$d/$f"; echo; } || echo gone; }
  done
}
wcheck() { # <name> <args…>
  local name="$1"; shift
  local o n; o="$(wrapped old "$@")"; n="$(wrapped new "$@")"
  if [ "$o" = "$n" ]; then pass=$((pass + 1)); echo "ok   $name"
  else fail=$((fail + 1)); echo "FAIL $name"; diff <(printf '%s\n' "$o") <(printf '%s\n' "$n") | head -10; fi
}
mkdir -p "$TMP/home"
wcheck "wrap: --check"      --check
wcheck "wrap: default"
wcheck "wrap: --unwrap"     --unwrap
wcheck "wrap: bad flag"     --nope
# own accounts read from the backend's preflight (no DS_WRAP_ACCOUNTS)
for s in old new; do
  mkcfg "$s"
  d="$TMP/accts-$s"; [ "$s" = old ] && tree="$TMP/old" || tree="$ROOT"
  { env -u DS_WRAP_ACCOUNTS CLAUDE_SYSTEM_DIR="$d/sys" HOME="$TMP/home" BACKEND="$TMP/fake/backend" FAKE_CFG="$d/a1" FAKE_LOG="$TMP/log-$s" "$tree/$W" --check 2>&1 || echo "[rc=$?]"; } | sed "s|$d|ACCTS|g" > "$TMP/pf-$s"
done
if cmp -s "$TMP/pf-old" "$TMP/pf-new"; then pass=$((pass + 1)); echo "ok   wrap: accounts from preflight"; else fail=$((fail + 1)); echo "FAIL wrap: accounts from preflight"; diff "$TMP/pf-old" "$TMP/pf-new" | head; fi

# ---- codex-models.sh ----
C=bin/lib/codex-models.sh
CAT='{"models":[{"slug":"gpt-5","display_name":"GPT 5","visibility":"list","supported_reasoning_levels":[{"effort":"high"},{"effort":"low"},{"effort":"turbo"},{"effort":"medium"}]},{"slug":"hidden","visibility":"hide"},{"slug":"bad slug","visibility":"list"},{"slug":"nameless","visibility":"list"},{"slug":"empty-name","display_name":"","visibility":"list","supported_reasoning_levels":null},{"slug":"xé","visibility":"list"},{"slug":7,"visibility":"list"}]}'
FAKE_CATALOG="$CAT" check "codex: a catalog"               $C
FAKE_CATALOG='{"models":[]}' check "codex: no models"        $C
FAKE_CATALOG='{}' check "codex: no models key"               $C
FAKE_CATALOG='not json' check "codex: malformed"             $C
FAKE_CATALOG="$CAT" FAKE_CODEX_RC=1 check "codex: cli fails" $C
FAKE_CATALOG="$CAT" CODEX_BIN=/nonexistent/codex check "codex: no cli" $C
FAKE_CATALOG='{"models":[{"slug":"a","display_name":3,"visibility":"list"}]}' check "codex: non-string name" $C

echo "parity-role-host: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
