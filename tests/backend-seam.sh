#!/usr/bin/env bash
# Self-test for the backend seam (U9): no top-level bin script invokes orca
# directly, and the scripts that still drive the backend do it entirely through
# $BACKEND with the right call sequence (proven with a stub backend).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2; fi; }

# 1. Only the adapter may invoke `orca`. Top-level bin/*.sh must not call it
#    (an `orca ` command, space-separated; the adapter path `orca.sh` is not a call).
hits=0
for f in "$ROOT"/bin/*.sh; do
  if grep -vE '^[[:space:]]*#' "$f" | grep -qE 'orca[[:space:]]'; then hits=$((hits + 1)); fi
done
check "no direct orca call in top-level bin scripts" "0" "$hits"

# A test fake must override adapter discovery before the adapter can see the live host CLI.
for f in "$ROOT"/tests/*.sh; do
  grep -qE '(cat|printf|cp).*[/]orca([" ]|$)' "$f" || continue
  check "fake Orca is explicitly pinned: ${f##*/}" yes "$(grep -q 'DS_ORCA_CLI_BIN_DIR=' "$f" && echo yes || echo no)"
done
for f in "$ROOT"/tests/loop/*.ts; do
  grep -qE 'shim = join\(.*"orca"' "$f" || continue
  check "loop fake Orca is explicitly pinned: ${f##*/}" yes "$(grep -q 'DS_ORCA_CLI_BIN_DIR' "$f" && echo yes || echo no)"
done

# 2. Squad create/close are loop wishes in Bun since U158 (bin/loop/fulfil/squad.ts,
# tests/loop/squad-lifecycle.test.ts); the scripts only write the wish
# (tests/spawn-squad.sh, tests/close-squad.sh). The seam checks below therefore start
# with the scripts that still drive the backend directly.

tmp="$(mktemp -d)"
# shellcheck source=tests/seed-pick.sh
. "$ROOT/tests/seed-pick.sh"   # ds pick reads loop.db: imp re-imports the state files a case just wrote
# The temp state root links every project dir under state/ (the cases write overrides there).
export DS_STATE_ROOT="$tmp/pickroot"; mkdir -p "$DS_STATE_ROOT"
imp() {
  : # the temp state root already holds every project a case wrote (U253)
  rm -f "$DS_STATE_ROOT"/loop.db*; "$ROOT/bin/ds" import >/dev/null 2>&1
}
ar() { imp; "$ROOT/bin/commands/add-role.sh" "$@"; }
stub="$tmp/backend-stub.sh"
cat > "$stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
op="${1:-}"; [ "$#" -gt 0 ] && shift
echo "$op $*" >> "${STUB_LOG:?STUB_LOG unset}"
case "$op" in
  run-create)     echo "run_stub" ;;
  task-create)    echo "task_stub" ;;
  lead-start)     echo "wt_lead" ;;
  wt-create)      echo "wt_lead" ;;           # spawn creates the Lead's worktree with this op
  lead-worker-start) : ;;                      # starts the Lead's worker in an existing worktree
  role-start)     echo "wt_role_${7:-x}" ;;   # unique per worktree name (arg 7), like real orca
  repo-ensure)    : ;;
  adopt)          : ;;
  send)           : ;;
  send-worker)    : ;;
  reply)          : ;;
  ask)            echo '{"answer":"stub"}' ;;
  gate-create)    echo "gate_stub" ;;
  gate-resolve)   : ;;
  current)        echo "${STUB_CURRENT:-}" ;;
  attention)      if [ -n "${STUB_ATTENTION:-}" ]; then printf '%s\n' "$STUB_ATTENTION"; fi ;;
  activity)       if [ -n "${STUB_ACTIVITY:-}" ]; then printf '%b' "$STUB_ACTIVITY"; fi ;;
  inbox-wait)     if [ -n "${STUB_MSG:-}" ]; then printf '%s\n' "$STUB_MSG"; fi ;;
  worker-states)  if [ -n "${STUB_WSTATES:-}" ]; then printf '%b' "$STUB_WSTATES"; fi ;;
  worktree-rm)    : ;;
  worker-stop)    : ;;
  worker-start)   : ;;
  worker-resume)  [ "${STUB_RESUME_FAIL:-0}" = 1 ] && exit 1; : ;;
  project-list)   echo '{"result":{"projects":[]}}' ;;
  account-list)   printf 'claude\tdefault\tdefault\nmuse\tdefault\tdefault\n' ;;
  status)         echo reachable ;;
  claude-config-dir) : ;;                       # the default login: run with CLAUDE_CONFIG_DIR unset
  account-usage)  : ;;
  account-resets) : ;;
  limited)        : ;;
  inbox-wait-self) if [ -n "${STUB_MSG:-}" ]; then printf '%s\n' "$STUB_MSG"; fi ;;
  worktree-ensure) echo "wt_stub" ;;
  loop-terminals) [ -z "${STUB_TERMS_FAIL:-}" ] || exit 1; printf '%s\n' "${STUB_TERMS:-{\"result\":{\"terminals\":[]\}\}}" ;;
  studio-start)   [ -z "${STUB_STUDIO_FAIL:-}" ] || { echo "stub: claude never came up" >&2; exit 1; }
                  # STUB_HOOK_FILE: note whether the rewake hook is armed at the moment the Studio starts.
                  [ -z "${STUB_HOOK_FILE:-}" ] || { [ -f "$STUB_HOOK_FILE" ] && echo "hook armed" || echo "hook missing"; } >> "$STUB_LOG"
                  echo "term_studio" ;;
  gate-list)      echo 0 ;;
  ps)             if [ -n "${STUB_PS:-}" ]; then printf '%s' "$STUB_PS"; else echo '{"result":{"worktrees":[]}}'; fi ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$stub"


# add-role: a wish writer (U157) — the Lead no longer fans out workers itself, the loop
# dispatches. add-role.sh checks its args, writes the `ds request` member wish and returns
# without a backend call; only worker roles are allowed — never a second lead.
mkdir -p "$DS_STATE_ROOT/dummy/squads"
printf '{"home_repo":"path:/snap/here"}' > "$DS_STATE_ROOT/dummy/dispatcher.json"
printf '{"run_id":"run_x","lead_wt":"wt_lead","status":"running","units":[{"slug":"u2","status":"planned","tier":"hard"}]}' > "$DS_STATE_ROOT/dummy/squads/_arttopic.json"
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
adb() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$DS_STATE_ROOT/loop.db" "$1"; }
arlog="$tmp/ar.log"; : > "$arlog"
STUB_LOG="$arlog" BACKEND="$stub" ar dummy _arttopic builder u2 --spec "unit 2" >/dev/null 2>&1
check "add-role writes a wish, no backend call" "" "$(cat "$arlog")"
check "add-role wish is a requested running Builder" "running	1	u2	build	wanted" "$(adb "SELECT want, json_extract(want_payload, '$.request'), json_extract(want_payload, '$.unit'), phase, status FROM members WHERE suffix = 'u2'")"
: > "$arlog"
STUB_LOG="$arlog" BACKEND="$stub" ar dummy _arttopic thinker t2 --spec "a separate bug" >/dev/null 2>&1
check "add-role allows a second thinker (opt-in)" "thinker	running	1" "$(adb "SELECT role, want, json_extract(want_payload, '$.request') FROM members WHERE suffix = 't2'")"
check "add-role thinker: no backend call" "" "$(cat "$arlog")"
BACKEND="$stub" ar dummy _arttopic lead x >/dev/null 2>&1
check "add-role rejects a second lead" "2" "$?"
BACKEND="$stub" ar dummy _arttopic builder-standard x >/dev/null 2>&1
check "add-role refuses the builder-standard row as a role" "2" "$?"
BACKEND="$stub" ar dummy _arttopic builder u9 >/dev/null 2>&1
check "add-role refuses an unknown unit" "2" "$?"
# U4: a Builder's brief carves the unit's PR out of Orca's "don't post to GitHub"
# line, with or without an explicit --spec; other roles don't get it. The prompt is
# roleSpec (bin/loop/reconcilers/requests.ts), the one source for add-role.sh's prompt and the loop's
# role requests (bin/loop/reconcilers/requests.ts).
# shellcheck source=tests/lib/twins.sh
. "$ROOT/tests/lib/twins.sh"
spec() { ds_role_spec dummy "$1" _arttopic run_x "$DS_STATE_ROOT/dummy/squads/_arttopic.json" "${2:-}"; }
check "builder --spec gets the PR-in-scope sentence" "1" "$(spec builder "unit work" | grep -c "doesn't cover this unit's PR")"
check "builder default spec gets it too" "1" "$(spec builder | grep -c "doesn't cover this unit's PR")"
check "builder brief says worker_done comes after the PR" "1" "$(spec builder "unit work" | grep -c 'worker_done only after that')"
check "tester does not get the sentence" "0" "$(spec tester "test work" | grep -c "doesn't cover this unit's PR")"
# U2: every role SPEC (explicit or default, any role) carries the no-heartbeat line.
check "builder --spec says no heartbeats" "1" "$(spec builder "unit work" | grep -c 'Do not send heartbeats')"
check "builder default spec says no heartbeats" "1" "$(spec builder | grep -c 'Do not send heartbeats')"
check "tester --spec says no heartbeats" "1" "$(spec tester "test work" | grep -c 'Do not send heartbeats')"
rm -f "$DS_STATE_ROOT/dummy/squads/_arttopic.json" "$DS_STATE_ROOT/dummy/dispatcher.json"

# up.sh brings up a per-project instance, worktree-only (no orchestration).
updisp="$DS_STATE_ROOT/testhome/dispatcher.json"
ulog="$tmp/up.log"; : > "$ulog"
STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "up ensures the studio worktree" "1" "$(grep -c '^worktree-ensure' "$ulog")"
check "up records studio_wt" "wt_stub" "$(jq -r '.studio_wt' "$updisp" 2>/dev/null)"
check "up records the project label" "testhome" "$(jq -r '.label' "$updisp" 2>/dev/null)"
check "up records studio_agent (U8)" "claude" "$(jq -r '.studio_agent' "$updisp" 2>/dev/null)"
check "up records studio_model from the studio row (U262; U267: claude sonnet)" "sonnet" "$(jq -r '.studio_model' "$updisp" 2>/dev/null)"
check "up makes no orchestration run-create" "0" "$(grep -c '^run-create' "$ulog")"
# a prior field in the instance state must survive an up re-run (merge, not clobber)
printf '%s' "$(jq '. + {kept:"yes"}' "$updisp")" > "$updisp"
: > "$ulog"; STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "up re-run preserves prior fields" "yes" "$(jq -r '.kept' "$updisp" 2>/dev/null)"
# name: selector is already registered -> no repo-ensure by path
check "up with a name: selector does not repo-ensure" "0" "$(grep -c '^repo-ensure' "$ulog")"
printf 'lead codex gpt-6.1-sol always low\n' > "$DS_STATE_ROOT/testhome/roles.conf"
observe_config
: > "$ulog"; STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "an override without a studio row: the default's studio row" "sonnet" "$(jq -r '.studio_model' "$updisp")"
printf 'lead codex gpt-6.1-sol always low\nstudio claude sonnet ondemand high\n' > "$DS_STATE_ROOT/testhome/roles.conf"
observe_config
: > "$ulog"; STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "a project's studio row wins: its model and effort" "1" "$(grep -c '^studio-start wt_stub - sonnet high ' "$ulog")"
printf 'studio codex gpt-6.1-sol ondemand low\n' > "$DS_STATE_ROOT/testhome/roles.conf"
observe_config
: > "$ulog"; STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "up still launches Claude when the studio row is Codex" "1" "$(grep -c '^studio-start wt_stub - - - ' "$ulog")"
check "up records the launched Studio agent, not the row's agent" "claude" "$(jq -r '.studio_agent' "$updisp")"
check "up does not assign a Codex model to the Claude Studio" "null" "$(jq -r '.studio_model' "$updisp")"
rm -f "$DS_STATE_ROOT/testhome/roles.conf"
observe_config

# U262: /ds-up starts the Studio through the loop's launch path. The worktree comes with no agent,
# then studio-start opens claude with the auto-compact window on the chosen account, and the handle
# lands in dispatcher.json for the loop. A Studio already running there is left alone.
: > "$ulog"; STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "up: the worktree comes with no agent" "1" "$(grep -c '^worktree-ensure name:testhome ds-testhome-studio  $' "$ulog")"
check "up: worktree-ensure, then studio-start" "worktree-ensure studio-start" "$(grep -oE '^(worktree-ensure|studio-start)' "$ulog" | tr '\n' ' ' | sed 's/ $//')"
check "up: studio-start on the default login with the studio window" "1" "$(grep -c '^studio-start wt_stub - sonnet - 200000 You are the Studio for project .testhome.' "$ulog")"
check "up records studio_handle" "term_studio" "$(jq -r '.studio_handle' "$updisp")"
check "up starts no worker" "0" "$(grep -cE '^(worker-start|role-start|lead-start)' "$ulog")"
printf 'auto_compact_studio 180000\n' > "$DS_STATE_ROOT/testhome/limits.conf"
observe_config
: > "$ulog"; STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome --account acctB >/dev/null 2>&1
check "up --account: studio-start on that account with the project's window" "1" "$(grep -c '^studio-start wt_stub acctB sonnet - 180000 ' "$ulog")"
rm -f "$DS_STATE_ROOT/testhome/limits.conf"
observe_config
# A live Studio (claude in the worktree, beside a ds-loop pane running codex and a shell): no launch.
terms='{"result":{"terminals":[
  {"handle":"term_live","worktreeId":"wt_stub","title":"claude","agentIdentity":"claude","connected":true,"writable":true},
  {"handle":"term_loop","worktreeId":"wt_stub","title":"ds-loop restart","agentIdentity":"codex","connected":true},
  {"handle":"term_sh","worktreeId":"wt_stub","title":"bash","agentIdentity":null,"connected":true}]}}'
: > "$ulog"; uout="$(STUB_TERMS="$terms" STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome 2>&1)"; urc=$?
check "up with a live Studio: ok" "0" "$urc"
check "up with a live Studio: no studio-start" "0" "$(grep -c '^studio-start' "$ulog")"
check "up with a live Studio: says it left it alone" "1" "$(grep -c 'already runs in wt_stub (term_live): left alone' <<<"$uout")"
check "up with a live Studio: the recorded handle is kept" "term_studio" "$(jq -r '.studio_handle' "$updisp")"
# Only the Studio's kind counts: a codex ds-loop pane, a shell, a claude in another worktree or a
# disconnected tab is no Studio, so up starts one.
terms='{"result":{"terminals":[
  {"handle":"term_loop","worktreeId":"wt_stub","title":"ds-loop morning-briefing","agentIdentity":"claude","connected":true},
  {"handle":"term_sh","worktreeId":"wt_stub","title":"bash","agentIdentity":null,"connected":true},
  {"handle":"term_old","worktreeId":"wt_stub","title":"claude","agentIdentity":"claude","connected":false},
  {"handle":"term_else","worktreeId":"wt_other","title":"claude","agentIdentity":"claude","connected":true}]}}'
: > "$ulog"; STUB_TERMS="$terms" STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "up: no Studio among the worktree's terminals: starts one" "1" "$(grep -c '^studio-start' "$ulog")"
# An unreadable terminal list starts nothing (it may hide a live Studio) and fails.
: > "$ulog"; STUB_TERMS_FAIL=1 STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1; urc=$?
check "up: unreadable terminal list: exit non-zero" "1" "$([ "$urc" -ne 0 ] && echo 1 || echo 0)"
check "up: unreadable terminal list: no studio-start" "0" "$(grep -c '^studio-start' "$ulog")"
# A failed launch exits non-zero with a message and drops the old Studio's handle (studio-start closes its own tab).
check "up: before the failed launch a handle is recorded" "term_studio" "$(jq -r '.studio_handle' "$updisp")"
: > "$ulog"; uout="$(STUB_STUDIO_FAIL=1 STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome 2>&1)"; urc=$?
check "up: failed launch: exit non-zero" "1" "$([ "$urc" -ne 0 ] && echo 1 || echo 0)"
check "up: failed launch: says so" "1" "$(grep -c 'up: could not start the Studio in wt_stub' <<<"$uout")"
check "up: failed launch: no studio_handle" "null" "$(jq -r '.studio_handle' "$updisp")"
check "up: failed launch: studio_wt still recorded" "wt_stub" "$(jq -r '.studio_wt' "$updisp")"
# The rewake Stop hook is armed in the Studio's worktree before its session starts.
mkdir -p "$tmp/studiowt"
: > "$ulog"; STUB_HOOK_FILE="$tmp/studiowt/.claude/settings.local.json" STUB_PS="{\"result\":{\"worktrees\":[{\"worktreeId\":\"wt_stub\",\"path\":\"$tmp/studiowt\"}]}}" STUB_LOG="$ulog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:testhome >/dev/null 2>&1
check "up arms the Studio's rewake hook" "1" "$(jq -r '[.hooks.Stop[]?.hooks[]?.command | select(test("rewake"))] | length | if . > 0 then 1 else 0 end' "$tmp/studiowt/.claude/settings.local.json" 2>/dev/null)"
check "up arms the rewake before studio-start" "hook armed" "$(grep -E '^hook (armed|missing)$' "$ulog")"

# up <git-url> clones into repos/<label>/ (offline: a local .git-suffixed source),
# registers that path, and labels the instance from the URL basename.
src="$tmp/myapp.git"; git init -q "$src" && git -C "$src" commit -q --allow-empty -m init 2>/dev/null
clone="$(cd "$ROOT" && pwd -P)/repos/myapp"; rm -rf "$clone"
clog="$tmp/clone.log"; : > "$clog"
STUB_LOG="$clog" BACKEND="$stub" "$ROOT/bin/host/up.sh" "$src" >/dev/null 2>&1
check "up <url> clones the repo into repos/<label>/" "yes" "$([ -d "$clone/.git" ] && echo yes || echo no)"
check "up <url> registers the clone path" "1" "$(grep -c "^repo-ensure $clone\$" "$clog")"
check "up <url> labels worktrees from the URL basename" "1" "$(grep -c 'worktree-ensure .*ds-myapp-studio' "$clog")"
rm -rf "$clone" "$DS_STATE_ROOT/myapp"

# ~/.dev-studio is a symlink to the checkout, and Orca registers repos by their real path.
# up must use the real path, also when reconciling a home_repo saved under the symlink.
ln -s "$ROOT" "$tmp/dslink"
slog="$tmp/sym.log"; : > "$slog"
STUB_LOG="$slog" BACKEND="$stub" "$tmp/dslink/bin/host/up.sh" "$src" >/dev/null 2>&1
check "up via a symlinked root registers the real clone path" "1" "$(grep -c "^repo-ensure $clone\$" "$slog")"
printf '%s' "$(jq --arg h "path:$tmp/dslink/repos/myapp" '.home_repo = $h' "$DS_STATE_ROOT/myapp/dispatcher.json")" > "$DS_STATE_ROOT/myapp/dispatcher.json"
: > "$slog"; STUB_LOG="$slog" BACKEND="$stub" "$ROOT/bin/host/up.sh" name:myapp >/dev/null 2>&1
check "up reconciles a symlinked home_repo to the real path" "1" "$(grep -c "^worktree-ensure path:$clone " "$slog")"
check "up rewrites home_repo to the real path" "path:$clone" "$(jq -r '.home_repo' "$DS_STATE_ROOT/myapp/dispatcher.json" 2>/dev/null)"
rm -rf "$clone" "$DS_STATE_ROOT/myapp"

# a failed Studio create must fail up, not record an empty studio_wt.
fstub="$tmp/failstub.sh"
printf '#!/usr/bin/env bash\ncase "$1" in worktree-ensure) exit 0 ;; *) "%s" "$@" ;; esac\n' "$stub" > "$fstub"; chmod +x "$fstub"
STUB_LOG=/dev/null BACKEND="$fstub" "$ROOT/bin/host/up.sh" name:failhome >/dev/null 2>&1; frc=$?
check "up exits non-zero when the Studio create returns no id" "1" "$([ "$frc" -ne 0 ] && echo 1 || echo 0)"
check "up records no empty studio_wt" "" "$(jq -r '.studio_wt // empty' "$DS_STATE_ROOT/failhome/dispatcher.json" 2>/dev/null)"
rm -rf "$DS_STATE_ROOT/failhome"

# install.sh symlinks the ds-* commands (so a later pull updates them with no
# re-install) and points ~/.dev-studio at this checkout so they resolve scripts
# from any worktree. HOME is redirected so the test never touches the real home.
idir="$tmp/cmds"; fakehome="$tmp/home"; mkdir -p "$fakehome"
# install.sh's preflight needs claude/orca on PATH plus a reachable runtime and a
# login — stub all three so this stays hermetic (no live Orca, no host login).
# The required loop installs in a copied checkout with a fake crontab and systemctl.
install_root="$tmp/install-root"; mkdir -p "$install_root/.claude"
cp -r "$ROOT/bin" "$ROOT/systemd" "$ROOT/conventions" "$install_root/"
cp -r "$ROOT/.claude/commands" "$install_root/.claude/"
itools="$tmp/install-tools"; mkdir -p "$itools"
icron="$tmp/crontab"
printf '#!/usr/bin/env bash\nif [ "$1" = "-l" ]; then cat "%s" 2>/dev/null || exit 1; else cat >> "%s"; fi\n' "$icron" "$icron" > "$itools/crontab"; chmod +x "$itools/crontab"
printf '#!/usr/bin/env bash\nexit 0\n' > "$itools/claude"; chmod +x "$itools/claude"
printf '#!/usr/bin/env bash\nexit 0\n' > "$itools/orca"; chmod +x "$itools/orca"
printf '#!/usr/bin/env bash\nexit 1\n' > "$itools/systemctl"; chmod +x "$itools/systemctl"   # no systemd user session
ibackend="$tmp/install-backend.sh"
printf '#!/usr/bin/env bash\ncase "${1:-}" in status) echo reachable ;; account-list) printf "claude\\ta1\\tt@e.com\\n" ;; esac\n' > "$ibackend"; chmod +x "$ibackend"
DS_ORCA_CLI_BIN_DIR="$itools" HOME="$fakehome" PATH="$itools:$PATH" BACKEND="$ibackend" "$install_root/bin/host/install.sh" "$idir" >/dev/null 2>&1
check "install writes only the loop watchdog" "1" "$(grep -cF "$install_root/bin/loop/loop.sh --ensure" "$icron" 2>/dev/null)"
# Expect exactly as many links as there are command sources (not a magic number —
# adding a command shouldn't break this test).
src_cmds="$(find "$ROOT/.claude/commands" -name 'ds-*.md' 2>/dev/null | wc -l | tr -d ' ')"
check "install links all ds- commands" "$src_cmds" "$(find "$idir" -name 'ds-*.md' 2>/dev/null | wc -l | tr -d ' ')"
check "installed command is a symlink (pull-to-update)" "yes" "$([ -L "$idir/ds-board.md" ] && echo yes || echo no)"
check "command resolves scripts via the dev-studio home" "yes" "$(grep -q '[~]/.dev-studio/bin/board/board.sh' "$idir/ds-board.md" && echo yes || echo no)"
check "dev-studio home points at the isolated checkout" "$install_root" "$(readlink "$fakehome/.dev-studio")"

# roles.sh: list reads the repo default; set writes a per-project override that
# spawn-squad then reads (gitignored, repo default untouched).
check "roles list shows the default roster" "10" "$("$ROOT/bin/commands/roles.sh" list | grep -cE '^(lead|thinker|thinker-deep|builder|builder-standard|builder-review|builder-review-standard|reviewer|tester|researcher) ')"
check "builder-standard is the sonnet ondemand tier" "sonnet ondemand" "$("$ROOT/bin/commands/roles.sh" list | awk '$1=="builder-standard"{print $3, $4}')"
check "builder-review is an opus elevate row" "opus elevate" "$("$ROOT/bin/commands/roles.sh" list | awk '$1=="builder-review"{print $3, $4}')"
check "builder-review-standard is a sonnet elevate medium row" "sonnet elevate medium" "$("$ROOT/bin/commands/roles.sh" list | awk '$1=="builder-review-standard"{print $3, $4, $5}')"
check "thinker defaults to opus" "opus always" "$("$ROOT/bin/commands/roles.sh" list | awk '$1=="thinker"{print $3, $4}')"
check "thinker-deep is a non-spawning elevate row" "fable elevate" "$("$ROOT/bin/commands/roles.sh" list | awk '$1=="thinker-deep"{print $3, $4}')"
check "fallback roster thinker is opus" "opus" "$(awk '$1=="thinker"{print $3}' "$ROOT/conventions/roles.conf")" 
# A project's own roster rows (U256: loop.db rows, read through the export).
ownroles() { "$ROOT/bin/ds" --state "$DS_STATE_ROOT" config export --project _rolestest | awk '/^#== /{s=($2=="roles.conf");next} s&&NF'; }
"$ROOT/bin/commands/roles.sh" set _rolestest thinker claude fable always >/dev/null 2>&1
check "roles set creates a per-project override" "yes" "$(ownroles | grep -q '^thinker ' && echo yes || echo no)"
check "override records the new thinker model" "fable" "$(ownroles | grep -E '^thinker ' | awk '{print $3}')"
check "repo default is untouched" "opus" "$(grep -E '^thinker ' "$ROOT/conventions/roles.conf" | awk '{print $3}')"
"$ROOT/bin/commands/roles.sh" set _rolestest thinker-deep claude opus elevate >/dev/null 2>&1
check "roles set accepts the elevate spawn kind" "opus elevate" "$(ownroles | grep -E '^thinker-deep ' | awk '{print $3, $4}')"
"$ROOT/bin/commands/roles.sh" set _rolestest thinker-deep claude opus sometimes >/dev/null 2>&1
check "roles set rejects an unknown spawn kind" "2" "$?"
"$ROOT/bin/commands/roles.sh" set _rolestest thinker-deep claude fable >/dev/null 2>&1
check "roles set without a spawn kind keeps the row's kind" "fable elevate" "$(ownroles | grep -E '^thinker-deep ' | awk '{print $3, $4}')"
"$ROOT/bin/commands/roles.sh" rm _rolestest thinker >/dev/null 2>&1
check "roles rm drops the role from the override" "0" "$(ownroles | grep -cE '^thinker ' || true)"
printf 'lead claude fable always\n' > "$DS_STATE_ROOT/_rolestest.roles"
"$ROOT/bin/ds" --state "$DS_STATE_ROOT" config import --project _rolestest --file roles.conf "$DS_STATE_ROOT/_rolestest.roles" >/dev/null
"$ROOT/bin/commands/roles.sh" set _rolestest builder-standard claude opus >/dev/null 2>&1
check "roles set on an override lacking the row takes the default's kind" "opus ondemand" "$(ownroles | grep -E '^builder-standard ' | awk '{print $3, $4}')"
rm -rf "$DS_STATE_ROOT/_rolestest" "$DS_STATE_ROOT/_rolestest.roles"

# The board reads loop.db alone: `bdb <label> <seed>` imports state/<label> into a scratch
# state root and adds the Orca rows of tests/board-db.ts's seed; `brd` renders from it.
bdb(){ rm -rf "$tmp/bdb"; mkdir -p "$tmp/bdb"; cp -a "$DS_STATE_ROOT/$1" "$tmp/bdb/$1"
  DS_STATE_ROOT="$tmp/bdb" "$ROOT/bin/ds" import >/dev/null 2>&1; printf '%s' "$2" | DS_STATE_ROOT="$tmp/bdb" bun "$ROOT/tests/board-db.ts" - "$1" >/dev/null 2>&1; }
brd(){ DS_STATE_ROOT="$tmp/bdb" "$ROOT/bin/board/board.sh" "$@" 2>/dev/null; }

# board shows live worker states, so a stale `done` with a working worker is flagged.
mkdir -p "$DS_STATE_ROOT/dummy/squads"
printf '{"status":"done","type":"feature","autonomy":"checkpoints","task_id":"t","run_id":"","lfg_assumptions":[],"waiting_on_you":[],"worktrees":["wtA","wtB"]}' > "$DS_STATE_ROOT/dummy/squads/stale.json"
bdb dummy '{"workers":[["wtA","working","a"],["wtB","idle","b"]]}'
check "board flags a done squad with an active worker" "1" "$(brd dummy | grep -c 'still-active')"
bdb dummy '{"workers":[["wtA","idle","a"],["wtB","idle","b"]]}'
check "board shows no false alarm when the done squad is idle" "0" "$(brd dummy | grep -c 'still-active')"
rm -f "$DS_STATE_ROOT/dummy/squads/stale.json"

# board surfaces a live "waiting for input" worker (backstop) even with no enqueued
# question, and excludes the studio/dispatcher (no role segment).
mkdir -p "$DS_STATE_ROOT/dummy/squads"
printf '{"status":"running","type":"feature","autonomy":"checkpoints","task_id":"t","run_id":"","lfg_assumptions":[],"waiting_on_you":[]}' > "$DS_STATE_ROOT/dummy/squads/wt.json"
bdb dummy '{"workers":[["wtT","waiting","ds-dummy-thinker-wt"],["wtS","waiting","ds-dummy-studio"]]}'
check "board shows a live waiting worker" "1" "$(brd dummy | grep -c 'ds-dummy-thinker-wt')"
check "board live backstop excludes the studio" "0" "$(brd dummy | grep -c 'ds-dummy-studio')"
rm -f "$DS_STATE_ROOT/dummy/squads/wt.json"

# the Tester's dev env location is recorded in state (Lead writes it) and shown on
# the board, so other roles/the operator use that env instead of starting their own.
mkdir -p "$DS_STATE_ROOT/_envseam/squads"
printf '{"status":"running","type":"testing","autonomy":"lfg","task_id":"t","run_id":"","lfg_assumptions":[],"waiting_on_you":[]}' > "$DS_STATE_ROOT/_envseam/squads/smoke.json"
"$ROOT/bin/role/squad-state.sh" "$DS_STATE_ROOT/_envseam/squads/smoke.json" set-devenv "http://10.0.0.5:3000 (slot 2)" >/dev/null
check "set-devenv records the env location" "http://10.0.0.5:3000 (slot 2)" "$(jq -r '.devenv' "$DS_STATE_ROOT/_envseam/squads/smoke.json")"
bdb _envseam '{}'
check "text board shows the dev env" "1" "$(brd _envseam | grep -c 'dev env: http://10.0.0.5:3000')"
check "json board carries the dev env url" "http://10.0.0.5:3000" "$(brd _envseam --json | jq -r '.squads[0].devenv.url')"
rm -rf "$DS_STATE_ROOT/_envseam"

# board --topic scopes to a single squad (used when run inside a squad).
mkdir -p "$DS_STATE_ROOT/_scopeseam/squads"
for t in alpha beta; do printf '{"status":"running","type":"feature","autonomy":"checkpoints","task_id":"t","run_id":"","lfg_assumptions":[],"waiting_on_you":[]}' > "$DS_STATE_ROOT/_scopeseam/squads/$t.json"; done
bdb _scopeseam '{}'
check "board shows all squads by default" "2" "$(brd _scopeseam | grep -cE '^▣ (alpha|beta) ')"
check "board --topic scopes to one squad" "1" "$(brd _scopeseam --topic alpha | grep -cE '^▣ (alpha|beta) ')"
rm -rf "$DS_STATE_ROOT/_scopeseam"

# board --json carries question text verbatim (the page escapes it when rendering) and a malformed
# `since` doesn't break the render — its age is just unknown.
mkdir -p "$DS_STATE_ROOT/_htmlseam/squads"
printf '{"status":"waiting-on-you","type":"feature","autonomy":"checkpoints","task_id":"task_h","run_id":"","lfg_assumptions":[],"waiting_on_you":[{"id":"g","asker":"lead","blocking":true,"question":"ship <b>x</b>?","since":"n"}]}' > "$DS_STATE_ROOT/_htmlseam/squads/t.json"
bdb _htmlseam '{}'
hj="$(brd _htmlseam --json)"
check "board --json keeps question text raw" "ship <b>x</b>?" "$(printf '%s' "$hj" | jq -r '.needs_you[0].text')"
check "board --json: unparseable since -> null age" "null" "$(printf '%s' "$hj" | jq -r '.needs_you[0].age_min')"
rm -rf "$DS_STATE_ROOT/_htmlseam"

# notify-squads writes a reload wish on each started squad's roster (no backend send) and
# skips a not-yet-started squad (no run_id).
mkdir -p "$DS_STATE_ROOT/dummy/squads"
printf '{"run_id":"run_a","status":"running","members":[{"role":"lead","suffix":"","wt":"wt_a"}]}' > "$DS_STATE_ROOT/dummy/squads/_n1.json"
printf '{"status":"running","members":[{"role":"lead","suffix":"","wt":"wt_b"}]}'                  > "$DS_STATE_ROOT/dummy/squads/_n2.json"
imp >/dev/null 2>&1
nlog="$tmp/notify.log"; : > "$nlog"
STUB_LOG="$nlog" BACKEND="$stub" "$ROOT/bin/commands/notify-squads.sh" dummy >/dev/null 2>&1
check "notify-squads makes no backend call" "" "$(cat "$nlog")"
check "notify-squads writes a reload wish on the started squad's roster" "notify-squads" "$(adb "SELECT reload_by FROM members WHERE squad = '_n1'")"
check "notify-squads skips the squad with no run yet" "" "$(adb "SELECT reload_by FROM members WHERE squad = '_n2'")"
rm -f "$DS_STATE_ROOT/dummy/squads/_n1.json" "$DS_STATE_ROOT/dummy/squads/_n2.json"

# orch.sh is the agents' entry point — a thin passthrough to $BACKEND, so the roles
# never name orca. A `send` routes straight through to the backend op.
orlog="$tmp/orch.log"; : > "$orlog"
STUB_LOG="$orlog" BACKEND="$stub" "$ROOT/bin/role/orch.sh" send run_o "subj" "body" >/dev/null 2>&1
check "orch.sh routes an op through the backend" "1" "$(grep -c '^send run_o subj body' "$orlog")"

# watch.sh: a Lead/Thinker's coordination tick — all backend, no raw orca. It must
# report a recorded worker that is GONE from worker-states (dead/removed).
printf '{"run_id":"run_w","status":"running","worktrees":["wtOK","wtGONE"]}' > "$DS_STATE_ROOT/dummy/squads/_watch.json"
mkdir -p "$DS_STATE_ROOT/dummy/squads"
wout="$(STUB_LOG=/dev/null STUB_WSTATES='wtOK\tworking\tds-dummy-builder-a-_watch\n' BACKEND="$stub" "$ROOT/bin/lib/watch.sh" dummy _watch 10 2>/dev/null)"
check "watch reports a present worker's state" "1" "$(printf '%s' "$wout" | grep -c 'working')"
check "watch flags a recorded worker that is gone" "1" "$(printf '%s' "$wout" | grep -cE 'GONE[[:space:]]+wtGONE')"
# A Builder that sits (unit dispatched, agent not working) is flagged by how long it has
# sat, from the backend's state-start time (ms) — not from commits. 15m nudge, 45m look/restart.
now_ms=$(( $(date +%s) * 1000 ))
printf '{"run_id":"run_s","status":"running","units":[{"slug":"u1","builder_wt":"wtSit","status":"dispatched"},{"slug":"u2","builder_wt":"wtOld","status":"dispatched"},{"slug":"u3","builder_wt":"wtBusy","status":"dispatched"},{"slug":"u4","builder_wt":"wtFresh","status":"dispatched"},{"slug":"u5","builder_wt":"wtDone","status":"done"}]}' > "$DS_STATE_ROOT/dummy/squads/_sit.json"
sws="wtSit\tidle\tb1\t$((now_ms - 20*60000))\tShould I open the PR now?\nwtOld\twaiting\tb2\t$((now_ms - 50*60000))\t\nwtBusy\tworking\tb3\t$((now_ms - 90*60000))\t\nwtFresh\tidle\tb4\t$((now_ms - 5*60000))\t\nwtDone\tidle\tb5\t$((now_ms - 90*60000))\t\n"
sout="$(STUB_LOG=/dev/null STUB_WSTATES="$sws" BACKEND="$stub" "$ROOT/bin/lib/watch.sh" dummy _sit 10 2>/dev/null)"
check "watch flags a Builder sitting 15m+ for a nudge" "1" "$(printf '%s\n' "$sout" | grep '⏸ sitting' | grep -c 'wtSit.*nudge it')"
check "watch shows what a sitting Builder last said" "1" "$(printf '%s\n' "$sout" | grep -c 'Should I open the PR now?')"
check "watch escalates a Builder sitting 45m+ to look/restart" "1" "$(printf '%s\n' "$sout" | grep '⏸ sitting' | grep -c 'wtOld.*restart')"
check "watch never flags a working, fresh, or done Builder" "0" "$(printf '%s\n' "$sout" | grep '⏸ sitting' | grep -cE 'wtBusy|wtFresh|wtDone')"
rm -f "$DS_STATE_ROOT/dummy/squads/_sit.json"
# A Thinker that asked something in chat and stopped (idle, last said a question) with nothing
# on the board is flagged ❓ unasked — the silent-skip failure. A queued question clears it.
printf '{"run_id":"run_q","status":"running","members":[{"role":"thinker","suffix":"","wt":"wtTh"},{"role":"builder","suffix":"b","wt":"wtBu"},{"role":"builder","suffix":"c","wt":"wtBi"}],"waiting_on_you":[]}' > "$DS_STATE_ROOT/dummy/squads/_unasked.json"
uws="wtTh\tidle\tth\t$now_ms\tShould we drop U14 or defer it?\nwtBu\tworking\tbu\t$now_ms\tShall I go?\nwtBi\tidle\tbi\t$now_ms\tWant me to open a PR too?\n"
uout="$(STUB_LOG=/dev/null STUB_WSTATES="$uws" BACKEND="$stub" "$ROOT/bin/lib/watch.sh" dummy _unasked 10 2>/dev/null)"
check "watch flags an idle Thinker whose question never reached the board" "1" "$(printf '%s\n' "$uout" | grep '❓ unasked' | grep -c 'wtTh')"
check "watch ignores a Builder's question (it routes to its Thinker, and Builders end turns on '?')" "0" "$(printf '%s\n' "$uout" | grep '❓ unasked' | grep -c 'wtBi')"
check "watch ignores a WORKING member's question" "0" "$(printf '%s\n' "$uout" | grep '❓ unasked' | grep -c 'wtBu')"
jq '.waiting_on_you=[{"id":"qb","asker":"builder-b","blocking":true,"question":"x","since":"2026-01-01T00:00:00Z"}]' "$DS_STATE_ROOT/dummy/squads/_unasked.json" > "$tmp/u.json" && mv "$tmp/u.json" "$DS_STATE_ROOT/dummy/squads/_unasked.json"
uout="$(STUB_LOG=/dev/null STUB_WSTATES="$uws" BACKEND="$stub" "$ROOT/bin/lib/watch.sh" dummy _unasked 10 2>/dev/null)"
check "another role's queued question does not hide the Thinker's unasked one" "1" "$(printf '%s\n' "$uout" | grep '❓ unasked' | grep -c 'wtTh')"
jq '.waiting_on_you=[{"id":"q","asker":"thinker","blocking":true,"question":"x","since":"2026-01-01T00:00:00Z"}]' "$DS_STATE_ROOT/dummy/squads/_unasked.json" > "$tmp/u.json" && mv "$tmp/u.json" "$DS_STATE_ROOT/dummy/squads/_unasked.json"
uout="$(STUB_LOG=/dev/null STUB_WSTATES="$uws" BACKEND="$stub" "$ROOT/bin/lib/watch.sh" dummy _unasked 10 2>/dev/null)"
check "a question already on the board clears the ❓ unasked flag" "0" "$(printf '%s\n' "$uout" | grep -c '❓ unasked')"
rm -f "$DS_STATE_ROOT/dummy/squads/_unasked.json"
# No top-level bin script (incl. watch.sh) calls orca directly — covered by check #1 above.
rm -f "$DS_STATE_ROOT/dummy/squads/_watch.json"

# restart-role's self-guard reads the stub backend's `current`; its restart is a wish.
export ORCA_TERMINAL_HANDLE="term_test"
# restart-role self-guard: a worker can't restart its own worktree (would kill it).
printf '{"run_id":"run_r","status":"running","worktrees":["wtMe"]}' > "$DS_STATE_ROOT/dummy/squads/_rr.json"
printf 'lead claude fable always\n' > "$DS_STATE_ROOT/dummy/roles.conf"
STUB_LOG="$tmp/rr.log" STUB_CURRENT=wtMe BACKEND="$stub" "$ROOT/bin/commands/restart-role.sh" dummy _rr lead --wt wtMe >/dev/null 2>&1
check "restart-role refuses to restart itself" "1" "$?"
# The restart's real picker reads a private store, with the member and roster in it.
rr_state="$tmp/restart-state"; mkdir -p "$rr_state/dummy/squads"
printf '{"run_id":"run_r","status":"running","worktrees":["wtMe"],"members":[{"role":"lead","suffix":"","wt":"wtMe"}]}' > "$rr_state/dummy/squads/_rr.json"
RR_SOURCE="$ROOT" DS_STATE_ROOT="$rr_state" bun -e '
  const {open}=await import(process.env.RR_SOURCE+"/bin/loop/core/store.ts"); const s=open();
  s.upsert("members",{project:"dummy",squad:"_rr",wt:"wtMe"},{role:"lead",suffix:"",status:"running",observed_at:1,updated_at:1});
  s.upsert("config",{project:"dummy",file:"roles.conf",key:"lead"},{value:"claude fable always",observed_at:1}); s.close();'
# but it restarts a DIFFERENT worktree fine (current != target): a wish, no backend start (U153).
DS_STATE_ROOT="$rr_state" STUB_LOG="$tmp/rr2.log" STUB_CURRENT=wt_other BACKEND="$stub" "$ROOT/bin/commands/restart-role.sh" dummy _rr lead --wt wtMe >/dev/null 2>&1
check "restart-role restarts a worktree that isn't you" "0" "$?"
check "restart-role writes the restart wish and starts nothing itself" "now/restart-role:0" "$(RR_SOURCE="$ROOT" DS_STATE_ROOT="$rr_state" bun -e '
  const {open}=await import(process.env.RR_SOURCE+"/bin/loop/core/store.ts"); const s=open();
  const m=s.db.query("SELECT restart_mode, restart_by FROM members WHERE wt=?").get("wtMe"); s.close();
  console.log(m ? `${m.restart_mode}/${m.restart_by}` : "none");' 2>/dev/null):$(grep -c '^worker-start' "$tmp/rr2.log" 2>/dev/null || true)"
# --resume is accepted and ignored since U158: restart-role writes the same restart
# wish and starts nothing itself (checked above); a suspended squad comes back with
# suspend-squad.sh --resume.

# install-skills.sh --check reads each Claude account's config dir through the seam
# (status, account-list, claude-config-dir — never orca), and the op is in the contract.
cstub="$tmp/ce-claude"; mkdir -p "$cstub"
# shellcheck disable=SC2016 # a literal, not an expansion
printf '#!/usr/bin/env bash\n[ "$1 $2 ${3:-}" = "plugin list --json" ] && echo "[]"\nexit 0\n' > "$cstub/claude"; chmod +x "$cstub/claude"
celog="$tmp/ce-check.log"; : > "$celog"
# The check reads ~/.claude from disk (no claude call): run it under an empty HOME, never the host's.
cehome="$tmp/ce-home"; mkdir -p "$cehome"
ceout="$(HOME="$cehome" STUB_LOG="$celog" BACKEND="$stub" PATH="$cstub:$PATH" "$ROOT/bin/host/install-skills.sh" --check 2>&1 || true)"
check "install --check asks the backend for each Claude account's config dir" "1" "$(grep -c '^claude-config-dir default$' "$celog")"
check "install --check lists accounts through the backend" "1" "$(grep -c '^account-list' "$celog")"
check "install --check names the account in its verdict" "yes" "$(grep -qF 'claude[default]: compound-engineering is not installed' <<<"$ceout" && echo yes || echo no)"
# shellcheck disable=SC2016 # a literal, not an expansion
check "conventions/backend.md documents claude-config-dir" "1" "$(grep -c '^| `claude-config-dir` |' "$ROOT/conventions/backend.md")"

# U97: the adapter's fresh-start guard (a default-login claude starts in its own tab, U9). A fake `orca` on PATH: worker-start into a worktree with
# an idle old agent closes it, then starts; a busy one refuses `agent_busy` (exit 3) and starts
# nothing; a `ds-loop` pane and a plain shell are kept; a failed close refuses the start.
u97d="$tmp/u97"; mkdir -p "$u97d/bin"
cat > "$u97d/bin/orca" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "${U97_LOG:?}"
case "$1 ${2:-}" in
  "terminal list")
    jq -Rs 'split("\n") | map(select(. != "") | split("\t") | {handle: .[0], worktreeId: .[1], agentIdentity: (if .[2]=="agent" then "claude" else null end), connected: true, writable: true, orphaned: false, title: .[3], lastOutputAt: 100}) | {result:{terminals:.}}' "$U97_TERMS" ;;
  "worktree ps")
    jq -n --arg w "${U97_WT:-wt_dup}" --arg s "${U97_STATE:-waiting}" '{result:{worktrees:[{worktreeId:$w, agents:[{state:$s}]}]}}' ;;
  "terminal close")
    [ -z "${U97_CLOSE_FAIL:-}" ] || exit 1
    [ -z "${U97_CLOSE_STUCK:-}" ] || { echo '{"result":{"ok":true}}'; exit 0; }
    t=""; while [ $# -gt 0 ]; do [ "$1" = --terminal ] && t="$2"; shift; done
    awk -F'\t' -v t="$t" '$1 != t' "$U97_TERMS" > "$U97_TERMS.new"; mv "$U97_TERMS.new" "$U97_TERMS"; echo '{"result":{"ok":true}}' ;;
  "terminal create") echo '{"result":{"terminal":{"handle":"tab_new"}}}' ;;
  "terminal wait") echo '{"result":{"ok":true}}' ;;
  "orchestration worker-start") echo '{"result":{"dispatchId":"ctx_1"}}' ;;
  "orchestration request-show") jq -n --arg s "${U97_RS:-absent}" '{result:{state:$s}}' ;;
  *) echo '{"result":{}}' ;;
esac
FAKE
chmod +x "$u97d/bin/orca"
u97run() { # [env assignments...] -- runs the adapter's worker-start (Bun, U226) against the fake orca
  env -i DS_ORCA_CLI_BIN_DIR="$u97d/bin" PATH="$u97d/bin:${bun%/*}:/usr/bin:/bin" HOME="$tmp" U97_LOG="$u97d/log" U97_TERMS="$u97d/terms" U97_WT=wt_dup \
    DS_ORCA_DATA="$u97d/data" DS_CLAUDE_HOME="$u97d/claude-home" "$@" "$ROOT/bin/backend/orca.sh" worker-start run_1 wt_dup spec claude opus
}
printf 'term_old\twt_dup\tagent\tclaude\nterm_shell\twt_dup\tshell\tbash\nterm_loop\twt_dup\tshell\tds-loop demo\n' > "$u97d/terms"; : > "$u97d/log"
u97run >/dev/null 2>&1; check "U97: worker-start with an idle old agent succeeds" "0" "$?"
check "U97: the idle old agent is closed before the start" "1" "$(grep -c 'terminal close --terminal term_old' "$u97d/log")"
check "U97: the start then happens" "1" "$(grep -c 'orchestration worker-start' "$u97d/log")"
check "U97: a plain shell and the ds-loop pane are kept" "term_shell term_loop" "$(cut -f1 "$u97d/terms" | paste -sd' ' -)"
printf 'term_old\twt_dup\tagent\tclaude\n' > "$u97d/terms"; : > "$u97d/log"
u97run U97_STATE=working >/dev/null 2>"$u97d/err"; check "U97: a busy old agent refuses with exit 3" "3" "$?"
check "U97: the busy refusal says agent_busy" "1" "$(grep -c 'agent_busy' "$u97d/err")"
check "U97: a busy old agent starts nothing and closes nothing" "0" "$(grep -cE 'orchestration worker-start|terminal close' "$u97d/log")"
# U21c: DS_START_OLD_GONE (the loop's fresh walk found no agent) reads Orca's `working` as stale: close, then start.
printf 'term_old\twt_dup\tagent\tclaude\n' > "$u97d/terms"; : > "$u97d/log"
u97run U97_STATE=working DS_START_OLD_GONE=1 >/dev/null 2>&1; check "U21c: a stale working agent with the flag starts" "0" "$?"
check "U21c: the flag closes the old agent" "1" "$(grep -c 'terminal close --terminal term_old' "$u97d/log")"
check "U21c: the flag then starts" "1" "$(grep -c 'orchestration worker-start' "$u97d/log")"
check "U21c: the flag skips the busy read" "0" "$(grep -c 'worktree ps' "$u97d/log")"
printf 'term_old\twt_dup\tagent\tclaude\n' > "$u97d/terms"; : > "$u97d/log"
u97run U97_CLOSE_FAIL=1 >/dev/null 2>&1; check "U97: a failed close refuses the start" "1" "$?"
check "U97: a failed close starts nothing" "0" "$(grep -c 'orchestration worker-start' "$u97d/log")"
# Cancellation must see close failures so it can retry and raise a failure card. terminal-close-worktree
# runs in Bun too (U225).
env -i DS_ORCA_CLI_BIN_DIR="$u97d/bin" PATH="$u97d/bin:${bun%/*}:/usr/bin:/bin" HOME="$tmp" U97_LOG="$u97d/log" U97_TERMS="$u97d/terms" U97_CLOSE_FAIL=1 \
  "$ROOT/bin/backend/orca.sh" terminal-close-worktree id:wt_dup --strict >/dev/null 2>&1
check "strict terminal close propagates an Orca failure" "1" "$?"
env -i DS_ORCA_CLI_BIN_DIR="$u97d/bin" PATH="$u97d/bin:${bun%/*}:/usr/bin:/bin" HOME="$tmp" U97_LOG="$u97d/log" U97_TERMS="$u97d/terms" U97_CLOSE_FAIL=1 \
  "$ROOT/bin/backend/orca.sh" terminal-close-worktree id:wt_dup >/dev/null 2>&1
check "ordinary terminal close remains best-effort" "0" "$?"
# A replay under a retry id whose first attempt landed owns that session: the guard defers, so it
# neither closes the worker the first attempt started nor refuses on it.
printf 'term_old\twt_dup\tagent\tclaude\n' > "$u97d/terms"; : > "$u97d/log"
u97run DS_ORCA_RETRY_REQUEST=rq_1 U97_RS=completed >/dev/null 2>&1; check "U97: a landed replay start succeeds" "0" "$?"
check "U97: a landed replay closes nothing" "0" "$(grep -c 'terminal close' "$u97d/log")"
check "U97: a landed replay reaches the start" "1" "$(grep -c 'orchestration worker-start' "$u97d/log")"
printf 'term_old\twt_dup\tagent\tclaude\n' > "$u97d/terms"; : > "$u97d/log"
u97run U97_CLOSE_STUCK=1 >/dev/null 2>"$u97d/err"; check "U97: an agent still live after its close refuses the start" "1" "$?"
check "U97: the still-live refusal says so" "1" "$(grep -c 'still live' "$u97d/err")"
check "U97: a still-live agent starts nothing" "0" "$(grep -c 'orchestration worker-start' "$u97d/log")"

# U55: agent-accounts reads each live top-level claude's account from a /proc (here a fake one):
# a managed profile home = its id, no CLAUDE_CONFIG_DIR = system; a claude under a claude, a temp
# config dir and other processes are left out.
fp="$tmp/proc"; od="$tmp/orca-data"
proc() { # <pid> <comm> <ppid> <cwd> [env]
  mkdir -p "$fp/$1"; printf '%s\n' "$2" > "$fp/$1/comm"; printf '%s (%s) S %s 1 1\n' "$1" "$2" "$3" > "$fp/$1/stat"
  printf '%s\0PATH=/bin\0' "${5:-HOME=/h}" > "$fp/$1/environ"; ln -s "$4" "$fp/$1/cwd"
}
proc 100 claude 1 /w/a "CLAUDE_CONFIG_DIR=$od/claude-profiles/acc1/home"
proc 101 claude 100 /w/a
proc 102 bash 1 /w/b
proc 103 claude 102 /w/b
proc 104 claude 1 /w/c "CLAUDE_CONFIG_DIR=/tmp/cfg"
proc 105 node 1 /w/d
proc 106 claude 1 /w/e "CLAUDE_CONFIG_DIR=$tmp/home/.claude/"
check "agent-accounts: top-level claudes with a known account" "$(printf '/w/a\tmain\tclaude\t-\tacc1\t-\t100\t-\t-\n/w/b\tmain\tclaude\t-\tsystem\t-\t103\t-\t-\n/w/e\tmain\tclaude\t-\tsystem\t-\t106\t-\t-')" \
  "$(DS_PROC="$fp" DS_ORCA_DATA="$od" DS_CLAUDE_HOME="$tmp/home/.claude" "$ROOT/bin/backend/orca.sh" agent-accounts | sort)"
# U90: a worker shows every agent it runs. A muse Builder's review-unit `claude -p` prints its own
# main line plus a sub line with its model and account on the same worktree; a sub without a
# --model flag reports "-". U98: a `claude -p` is a sub line even under the member's own claude
# (203) or detached (209: review-unit.sh runs detached); a claude without -p under another
# claude (208) stays skipped, as before.
fp90="$tmp/proc90"
proc90() { # <pid> <comm> <ppid> <cwd> [env] [cmdline with \0 escapes]
  mkdir -p "$fp90/$1"; printf '%s\n' "$2" > "$fp90/$1/comm"; printf '%s (%s) S %s 1 1\n' "$1" "$2" "$3" > "$fp90/$1/stat"
  printf '%b\0PATH=/bin\0' "${5:-HOME=/h}" > "$fp90/$1/environ"; ln -s "$4" "$fp90/$1/cwd"
  if [ -n "${6:-}" ]; then printf '%b' "$6" > "$fp90/$1/cmdline"; else printf 'AGENT\0' > "$fp90/$1/cmdline"; fi
}
proc90 200 muse 1 /w/m
proc90 201 "claude" 200 /w/m "CLAUDE_CONFIG_DIR=$od/claude-profiles/acc9/home" 'claude\0--model\0opus\0-p\0review\0'
proc90 202 claude 1 /w/c "CLAUDE_CONFIG_DIR=$tmp/home/.claude/"
proc90 203 claude 202 /w/c "CLAUDE_CONFIG_DIR=$tmp/home/.claude/" 'claude\0-p\0'
check "agent-accounts: claude -p under a claude is a sub line, the member stays main" "$(printf '/w/c\tmain\tclaude\t-\tsystem\t-\t202\t-\t-\n/w/c\tsub\tclaude\t-\tsystem\n/w/m\tmain\tmuse\t-\tdefault\t-\t200\t-\t-\n/w/m\tsub\tclaude\topus\tacc9')" \
  "$(DS_PROC="$fp90" DS_ORCA_DATA="$od" DS_CLAUDE_HOME="$tmp/home/.claude" "$ROOT/bin/backend/orca.sh" agent-accounts | sort)"
proc90 204 codex 1 /w/x '' 'codex\0worker\0'
proc90 205 claude 204 /w/x '' 'claude\0-p\0'
proc90 206 muse 1 /w/y '' 'muse\0worker\0'
proc90 207 claude 206 /w/y '' 'claude\0--model=sonnet\0-p\0'
proc90 208 claude 202 /w/c "CLAUDE_CONFIG_DIR=$tmp/home/.claude/" 'claude\0worker\0'
proc90 209 claude 1 /w/z "CLAUDE_CONFIG_DIR=$tmp/home/.claude/" 'claude\0-p\0review\0'
check "agent-accounts: a model-less sub reports -, a claude without -p under a claude stays skipped" "$(printf '/w/c\tmain\tclaude\t-\tsystem\t-\t202\t-\t-\n/w/c\tsub\tclaude\t-\tsystem\n/w/m\tmain\tmuse\t-\tdefault\t-\t200\t-\t-\n/w/m\tsub\tclaude\topus\tacc9\n/w/x\tmain\tcodex\t-\tdefault\t-\t204\t-\t-\n/w/x\tsub\tclaude\t-\tsystem\n/w/y\tmain\tmuse\t-\tdefault\t-\t206\t-\t-\n/w/y\tsub\tclaude\tsonnet\tsystem\n/w/z\tsub\tclaude\t-\tsystem')" \
  "$(DS_PROC="$fp90" DS_ORCA_DATA="$od" DS_CLAUDE_HOME="$tmp/home/.claude" "$ROOT/bin/backend/orca.sh" agent-accounts | sort)"
proc90 210 claude 206 /w/y2 '' 'claude\0--model\0opus\0--effort\0xhigh\0-p\0'
proc90 211 muse 1 /w/y2 '' 'muse\0worker\0'
check "agent-accounts: a sub's --effort is a sixth field (U105), left off when it has none" "$(printf '/w/y2\tsub\tclaude\topus\tsystem\txhigh')" \
  "$(DS_PROC="$fp90" DS_ORCA_DATA="$od" DS_CLAUDE_HOME="$tmp/home/.claude" "$ROOT/bin/backend/orca.sh" agent-accounts | grep '^/w/y2' | grep sub)"
# U21e: `muse <subcommand>` (usage, skills, ...) is a helper: a sub line beside the member's own muse; a muse
# with a prompt (or a second muse main) stays a main.
proc90 220 muse 1 /w/u21 '' 'muse\0'
proc90 221 muse 220 /w/u21 '' 'muse\0usage\0--json\0'
proc90 222 muse 1 /w/u21 '' 'muse\0skills\0list\0'
proc90 223 muse 1 /w/u21z '' 'muse\0fix the bug\0'
proc90 224 muse 1 /w/u21z '' 'muse\0'
check "agent-accounts: muse <subcommand> is a sub line, a muse with a prompt is a main (U21e)" \
  "$(printf '/w/u21\tmain\tmuse\t-\tdefault\t-\t220\t-\t-\n/w/u21\tsub\tmuse\t-\tdefault\n/w/u21\tsub\tmuse\t-\tdefault\n/w/u21z\tmain\tmuse\t-\tdefault\t-\t223\t-\t-\n/w/u21z\tmain\tmuse\t-\tdefault\t-\t224\t-\t-')" \
  "$(DS_PROC="$fp90" DS_ORCA_DATA="$od" DS_CLAUDE_HOME="$tmp/home/.claude" "$ROOT/bin/backend/orca.sh" agent-accounts | grep '^/w/u21' | sort)"
# U149: a main line carries its --model and --effort flags, pid, start (boot time + stat field 22 in
# clock ticks) and RSS (stat field 24 in pages, as kB); a stat without those fields, or a process
# table without btime, reads "-" (the lines above).
proc90 212 claude 1 /w/q "CLAUDE_CONFIG_DIR=$tmp/home/.claude/" 'claude\0--model\0opus\0--effort=high\0'
printf '212 (claude) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 50000 1000 2048\n' > "$fp90/212/stat"
printf 'cpu 0 0 0\nbtime 1790000000\n' > "$fp90/stat"
check "agent-accounts: a main line's model, effort, pid, start and RSS (U149)" \
  "$(printf '/w/q\tmain\tclaude\topus\tsystem\thigh\t212\t%s\t%s' $((1790000000 + 50000 / $(getconf CLK_TCK))) $((2048 * $(getconf PAGESIZE) / 1024)))" \
  "$(DS_PROC="$fp90" DS_ORCA_DATA="$od" DS_CLAUDE_HOME="$tmp/home/.claude" "$ROOT/bin/backend/orca.sh" agent-accounts | grep '^/w/q')"
# shellcheck disable=SC2016 # a literal, not an expansion
check "conventions/backend.md documents agent-accounts" "1" "$(grep -c '^| `agent-accounts` |' "$ROOT/conventions/backend.md")"
# account-free-resets U1: account-resets is in the contract, and Orca's adapter answers it from the usage
# cache alone (no provider call): one line per account-list account, Muse not_reported, no sidecar unknown.
# shellcheck disable=SC2016 # a literal, not an expansion
check "conventions/backend.md documents account-resets" "1" "$(grep -c '^| `account-resets` |' "$ROOT/conventions/backend.md")"
# A fake Orca that is not running (every call fails), so account-list is the system login alone and
# nothing here reaches the host's real orca (on a host whose bun sits beside it in PATH) or needs one
# (a CI runner has none).
noorca="$tmp/noorca"; mkdir -p "$noorca/bin"; printf '#!/bin/sh\nexit 1\n' > "$noorca/bin/orca"; chmod +x "$noorca/bin/orca"
check "account-resets: muse not_reported, codex and a never-fetched claude unknown" \
  "$(printf 'claude\tsystem\t{"state":"unknown"}\nmuse\tdefault\t{"state":"not_reported"}\ncodex\tdefault\t{"state":"unknown"}')" \
  "$(env -i DS_ORCA_CLI_BIN_DIR="$noorca/bin" PATH="${bun%/*}:/usr/bin:/bin" HOME="$tmp" DS_ORCA_DATA="$tmp/no-orca-data" DS_CLAUDE_HOME="$tmp/no-claude" DS_USAGE_CACHE="$tmp/usage-cache" \
    "$ROOT/bin/backend/orca.sh" account-resets 2>/dev/null)"
# account-free-resets U4: account-reset-use is in the contract; it answers one outcome line, and an agent
# with no free resets or a bad id is refused before any provider call (no login here, so none could run).
# shellcheck disable=SC2016 # a literal, not an expansion
check "conventions/backend.md documents account-reset-use" "1" "$(grep -c '^| `account-reset-use` |' "$ROOT/conventions/backend.md")"
seamuse() { env -i DS_ORCA_CLI_BIN_DIR="$noorca/bin" PATH="${bun%/*}:/usr/bin:/bin" HOME="$tmp" DS_ORCA_DATA="$tmp/no-orca-data" DS_CLAUDE_HOME="$tmp/no-claude" DS_USAGE_CACHE="$tmp/usage-cache" \
  "$ROOT/bin/backend/orca.sh" account-reset-use "$@" 2>/dev/null; }
check "account-reset-use: muse has no free resets" "$(printf 'failed\tmuse has no free resets')" "$(seamuse muse default g1 k1)"
check "account-reset-use: a bad grant id is refused" "$(printf 'failed\tbad grant id')" "$(seamuse claude system 'g 1' k1)"
check "account-reset-use: no login token is a failed outcome, exit 0" "$(printf 'failed\tno login token\n0')" "$(seamuse claude system g1 k1; echo $?)"
check "account-reset-use: wrong arity is a usage error" "2" "$(seamuse claude system g1 >/dev/null; echo $?)"

rm -rf "$DS_STATE_ROOT/dummy" "$DS_STATE_ROOT/testhome" "$tmp"

echo "backend-seam: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
