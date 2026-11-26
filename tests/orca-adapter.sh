#!/usr/bin/env bash
# orca-adapter.sh — exercise bin/backend/orca.sh against a FAKE `orca` on PATH.
#
# The other suites never run the adapter (they stub $BACKEND), so every jq mapping,
# the host-merge, reuse/archived logic, and the new ops went unverified. This puts a
# canned-JSON `orca` shim on PATH and asserts each op's stdout/stderr and the exact
# `orca` subcommands the adapter issued (logged to $ORCA_LOG). The fixtures mirror the
# shapes marked (confirm@host) in the adapter; if the host's real shape differs, change
# a fixture here and the adapter together.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="$ROOT/bin/backend/orca.sh"
SHIMP="PATH=$ROOT/bin/hooks/path-gates:\$PATH"   # U235: every role claude starts with the hook shims first on PATH

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export ORCA_LOG="$TMP/orca.log"
: > "$ORCA_LOG"
export DS_STATE_ROOT="$TMP/state"
# Every worker start links the managed accounts' projects (U39): never the real accounts' from a test.
export DS_ORCA_DATA="$TMP/orcadata" DS_CLAUDE_HOME="$TMP/claude-home"

# The role's skill list (U229): a stub for `ds skills resolve` — SO_OUT is what it prints, SO_FAIL makes it fail.
cat > "$TMP/resolve" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SO_LOG:-/dev/null}"
[ -z "${SO_FAIL:-}" ] || { echo boom >&2; exit 1; }
printf '%s\n' "${SO_OUT:-{\}}"
STUB
chmod +x "$TMP/resolve"; export DS_SKILLS_RESOLVE="$TMP/resolve"

# --- the fake orca -----------------------------------------------------------
cat > "$TMP/orca" <<'FAKE'
#!/usr/bin/env bash
# Fake orca: logs its argv, returns canned JSON per subcommand. Fixtures come from
# env (ORCA_PS_PRIMARY / ORCA_PS_REMOTE / ORCA_AUTO_LIST); "--host" in argv selects
# the remote ps fixture so the host-merge path is exercised.
printf '%s\n' "$*" >> "$ORCA_LOG"
sub="$1 ${2:-}"
# FAKE_WT_DIR: a small live Orca, for two runs of the adapter at once (U38). Worktrees are real
# entries, a create sleeps FAKE_WT_SLEEP and adds -2 to a taken name, and a worker-start keeps a
# retry id's input: the same id with other input is request_mismatch, the same input is the one
# start again. A run with FAKE_WS_AFTER waits for that file before it reaches the worker start;
# FAKE_WS_MARK is touched once it has been through. FAKE_WS_REFUSE: Orca refuses the start and keeps
# no receipt, FAKE_RS_FAIL: request-show has no answer. tabs holds "<handle>\t<worktreeId>" lines;
# FAKE_WT_SHELL: a new worktree opens with a shell tab, FAKE_WS_TAB: a start opens an agent tab in its
# worktree before it answers (so a refused one leaves it, as Orca did on the host; U59).
# FAKE_TC_PAUSE: a pause lands as the tab opens (U118): this file is touched, and the fake `bun`
# in fence() refuses from then on. FAKE_TW_CRASH: the first wait for a tab's TUI kills the whole run.
if [ -n "${FAKE_WT_DIR:-}" ]; then
  arg() { local want="$1"; shift; while [ "$#" -gt 1 ]; do [ "$1" = "$want" ] && { printf '%s' "$2"; return; }; shift; done; }
  case "$sub" in
    "worktree ps")
      [ -z "${FAKE_PS_FAIL:-}" ] || exit 1
      find "$FAKE_WT_DIR/wts" -mindepth 1 -maxdepth 2 -name .wt -printf '%h\n' \
        | sed "s|^$FAKE_WT_DIR/wts/||" \
        | jq -Rs 'split("\n") | map(select(. != "") | {worktreeId: ("wt:" + .), displayName: ., isArchived: false, agents: []}) | {result: {worktrees: .}}'
      exit 0 ;;
    "worktree create")
      sleep "${FAKE_WT_SLEEP:-0}"
      n="$(arg --name "$@")"; t="$n"; i=1
      mkdir -p "$(dirname "$FAKE_WT_DIR/wts/$n")"
      until mkdir "$FAKE_WT_DIR/wts/$t" 2>/dev/null; do i=$((i + 1)); t="$n-$i"; done
      : > "$FAKE_WT_DIR/wts/$t/.wt"
      [ -z "${FAKE_WT_SHELL:-}" ] || printf 'tab_%s\twt:%s\n' "$(mktemp -u XXXXXX)" "$t" >> "$FAKE_WT_DIR/tabs"
      printf '{"result":{"worktree":{"id":"wt:%s"}}}\n' "$t"
      exit 0 ;;
    "terminal create")
      w="$(arg --worktree "$@")"; t="tab_$(mktemp -u XXXXXX)"; printf '%s\t%s\n' "$t" "${w#id:}" >> "$FAKE_WT_DIR/tabs"
      [ -z "${FAKE_TC_PAUSE:-}" ] || : > "$FAKE_TC_PAUSE"
      printf '{"result":{"terminal":{"handle":"%s"}}}\n' "$t"
      exit 0 ;;
    "terminal wait")
      [ -z "${FAKE_TUI_FAIL:-}" ] || exit 1
      if [ -n "${FAKE_TW_CRASH:-}" ] && [ ! -e "$FAKE_TW_CRASH" ]; then
        : > "$FAKE_TW_CRASH"; kill -KILL -- "-$(ps -o pgid= -p $$ | tr -d ' ')"
      fi
      echo '{"result":{"ok":true}}'
      exit 0 ;;
    "terminal list")
      [ -z "${FAKE_TL_FAIL:-}" ] || exit 1
      jq -Rs 'split("\n") | map(select(. != "") | split("\t") | {handle: .[0], worktreeId: (.[1] // null), connected: true}) | {result: {terminals: .}}' "$FAKE_WT_DIR/tabs"
      exit 0 ;;
    "orchestration worker-start")
      if [ -n "${FAKE_WS_AFTER:-}" ]; then until [ -e "$FAKE_WS_AFTER" ]; do sleep 0.05; done; fi
      if [ -n "${FAKE_WS_TAB:-}" ]; then w="$(arg --worktree "$@")"; printf 'tab_%s\t%s\n' "$(mktemp -u XXXXXX)" "${w#id:}" >> "$FAKE_WT_DIR/tabs"; fi
      [ -z "${FAKE_WS_REFUSE:-}" ] || { echo '{"ok":false,"error":{"code":"runtime_busy","message":"long-poll capacity reached"}}'; exit 1; }
      id="$(arg --retry-request "$@")"; input="$(printf '%s\n' "$@" | grep -vxF -e "--retry-request" -e "$id")"
      r="$FAKE_WT_DIR/req/$id"
      if mkdir "$r" 2>/dev/null; then
        printf '%s' "$input" > "$r/input"; { arg --worktree "$@"; echo; } >> "$FAKE_WT_DIR/workers"
      elif [ "$(cat "$r/input")" != "$input" ]; then
        echo '{"ok":false,"error":{"code":"request_mismatch","message":"Mutation request was already used with different input."}}'
        exit 1
      fi
      [ -z "${FAKE_WS_MARK:-}" ] || : > "$FAKE_WS_MARK"
      echo '{"result":{"dispatchId":"ctx_one"}}'
      exit 0 ;;
    "orchestration request-show")
      [ -z "${FAKE_RS_FAIL:-}" ] || exit 1
      if [ -n "${FAKE_RS_STATE:-}" ]; then s="$FAKE_RS_STATE"
      elif [ -d "$FAKE_WT_DIR/req/$(arg --request "$@")" ]; then s=completed; else s=absent; fi
      jq -n --arg s "$s" '{result: {state: $s}}'
      exit 0 ;;
    "terminal close")
      t="$(arg --terminal "$@")"; awk -F'\t' -v t="$t" '$1 != t' "$FAKE_WT_DIR/tabs" > "$FAKE_WT_DIR/tabs.new" || true
      mv "$FAKE_WT_DIR/tabs.new" "$FAKE_WT_DIR/tabs"
      exit 0 ;;
  esac
fi
# The fixtures below are the FULL records. Like the live CLI (Orca 1.4.246+), an
# `orchestration ... --json` call WITHOUT --full gets the compact view instead (see
# compact() at the bottom), which drops the fields the adapter parses — so a call that
# loses its --full fails the suite.
emit() {
case "$sub" in
  "worktree ps")
    [ -z "${ORCA_PS_PRIMARY_FILE:-}" ] || { cat "$ORCA_PS_PRIMARY_FILE"; exit 0; }
    # NB: no `${VAR:-{…}}` default here — a `}` inside the default closes the
    # parameter expansion early and corrupts the JSON. Tests set these before use.
    if grep -q 'saved:env1' <<<"$*"; then
      printf '%s' "${ORCA_PS_REMOTE:-$EMPTY_PS}"
    else
      printf '%s' "${ORCA_PS_PRIMARY:-$EMPTY_PS}"
    fi ;;
  "worktree create")  if [ -n "${ORCA_WT_OUT:-}" ]; then echo "$ORCA_WT_OUT"; else echo '{"result":{"worktree":{"id":"wt_new"}}}'; fi ;;
  # ORCA_WT_OUT / ORCA_WT_RC: what worktree show / list (and create, when set) answer (U8b's wt-* verbs).
  "worktree show"|"worktree list") echo "${ORCA_WT_OUT:-{\"result\":{\}\}}"; exit "${ORCA_WT_RC:-0}" ;;
  "worktree current") echo '{"result":{"worktree":{"id":"wt_self"}}}' ;;
  "worktree rm")      echo '{"result":{}}' ;;
  "repo add")         echo '{"result":{}}' ;;
  # ORCA_CREATE_OUT overrides a create's output, to model the compact (non --full) shapes.
  "orchestration run-create")
    if [ -n "${ORCA_CREATE_OUT:-}" ]; then echo "$ORCA_CREATE_OUT"; else echo '{"result":{"run":{"id":"run_123"}}}'; fi ;;
  "orchestration task-create")
    if [ -n "${ORCA_CREATE_OUT:-}" ]; then echo "$ORCA_CREATE_OUT"; else echo '{"result":{"task":{"id":"task_123"}}}'; fi ;;
  "orchestration run-use")
    # ORCA_RUNUSE_FAIL: the JSON error an older CLI printed on stdout for an unknown flag (U54).
    if [ -n "${ORCA_RUNUSE_FAIL:-}" ]; then
      echo '{"id":"local","ok":false,"error":{"code":"invalid_argument","message":"Unknown flag --full for command: orchestration run-use"}}'
      exit 1
    fi
    echo '{"result":{}}' ;;
  "orchestration request-show") printf '%s' "${ORCA_REQUEST_SHOW:-{\"result\":{\"state\":\"absent\"\}\}}" ;;
  "orchestration send")
    # ORCA_SEND_FAIL="code|message" models a refused send (exit 1, ok:false) like the live
    # CLI's terminal_not_found / dispatch_run_mismatch.
    if [ -n "${ORCA_SEND_FAIL:-}" ]; then
      printf '{"id":"req_1","ok":false,"error":{"code":"%s","message":"%s"}}' "${ORCA_SEND_FAIL%%|*}" "${ORCA_SEND_FAIL#*|}"
      exit "${ORCA_SEND_FAIL_RC:-1}"
    fi
    [ -n "${ORCA_SEND_STDERR:-}" ] && printf '%s\n' "$ORCA_SEND_STDERR" >&2
    printf '%s' "${ORCA_SEND_OUT:-$EMPTY_RESULT}" ;;
  "orchestration run-show")     echo '{"result":{"run":{"id":"run_own","coordinator_handle":"tab_live"}}}' ;;
  "orchestration inbox")
    echo '{"result":{"messages":[{"id":"m1","run_id":"run_1","to_handle":"run:run_1","read":0,"type":"status","created_at":"2026-10-16T10:00:00Z"},{"id":"m2","run_id":"run_1","to_handle":"run:run_1","read":1,"created_at":"2026-10-16T10:01:00Z"},{"id":"m3","run_id":"run_1","to_handle":"run:run_1","read":0,"type":"heartbeat","created_at":"2026-10-16T10:02:00Z"},{"id":"m4","run_id":"run_2","to_handle":"run:run_2","read":0,"created_at":"2026-10-16T10:03:00Z"},{"id":"m5","run_id":"run_1","to_handle":"term_x","read":0,"created_at":"2026-10-16T10:04:00Z"}]}}' ;;
  "orchestration reply")        echo '{"result":{}}' ;;
  "orchestration ask")          echo '{"result":{"answer":"yes"}}' ;;
  "orchestration gate-create")
    if [ -n "${ORCA_CREATE_OUT:-}" ]; then echo "$ORCA_CREATE_OUT"; else echo '{"result":{"gate":{"id":"gate_1"}}}'; fi ;;
  "orchestration gate-resolve") echo '{"result":{}}' ;;
  "orchestration gate-list")    echo '{"result":{"gates":[{},{}]}}' ;;
  "orchestration worker-list")
    # The run-reclaim path filters server-side by --terminal-state and paginates. Model that:
    # reclaimable spans TWO pages (cursor c1) to exercise the loop; retained is one page.
    if grep -q -- '--terminal-state reclaimable' <<<"$*"; then
      # Two pages (cursor c1). Page 2 includes ctx_ret_noop, whose release is a no-op (retained,
      # processAction none) — collected+attempted but must NOT be counted as freed.
      if grep -q -- '--cursor c1' <<<"$*"; then
        echo '{"result":{"workers":[{"dispatchId":"ctx_r3"},{"dispatchId":"ctx_ret_noop"}],"page":{"hasMore":false}}}'
      else
        echo '{"result":{"workers":[{"dispatchId":"ctx_r1"},{"dispatchId":"ctx_r2"}],"page":{"hasMore":true,"nextCursor":"c1"}}}'
      fi
    elif grep -q -- '--terminal-state retained' <<<"$*"; then
      echo '{"result":{"workers":[{"dispatchId":"ctx_ret1"}],"page":{"hasMore":false}}}'
    elif grep -q -- '--terminal-state release_unknown' <<<"$*"; then
      echo '{"result":{"workers":[{"dispatchId":"ctx_unk1"},{"dispatchId":"ctx_unk2"}],"page":{"hasMore":false}}}'
    elif grep -q -- '--terminal-state' <<<"$*"; then
      echo '{"result":{"workers":[],"page":{"hasMore":false}}}'
    else
    [ "${FAKE_WL_FAIL:-}" != garbled ] || { echo '{"result":{}}'; exit 0; }
    [ -z "${FAKE_WL_FAIL:-}" ] || exit 1
    if [ -n "${FAKE_WL_INJECTED:-}" ]; then   # U216: an injected (unsupervised) dispatch has resource null, worktree in projection
      echo '{"result":{"workers":[
        {"dispatchId":"ctx_inj_open","dispatchStatus":"dispatched","terminalState":"active","agentTerminalHandle":"term_inj","resource":null,"projection":{"workspace":{"id":"repo1::/p/rebound","kind":"folder_or_worktree"}}},
        {"dispatchId":"ctx_sup_old","dispatchStatus":"failed","terminalState":"retained","agentTerminalHandle":"term_sup","resource":{"worktreeId":"repo1::/p/rebound"},"projection":{"workspace":{"id":"repo1::/p/rebound"}}},
        {"dispatchId":"ctx_inj_done","dispatchStatus":"completed","terminalState":"retained","agentTerminalHandle":"term_injd","resource":null,"projection":{"workspace":{"id":"repo1::/p/newest"}}},
        {"dispatchId":"ctx_sup_older","dispatchStatus":"completed","terminalState":"retained","agentTerminalHandle":"term_supo","resource":{"worktreeId":"repo1::/p/newest"}},
        {"dispatchId":"ctx_nowt","dispatchStatus":"dispatched","agentTerminalHandle":"term_none","resource":null,"projection":{}}],"page":{"hasMore":false}}}'
      exit 0
    fi
    if [ -n "${FAKE_WL_REPORTED:-}" ]; then   # U215: the reported column
      echo '{"result":{"workers":[
        {"dispatchId":"ctx_done","dispatchStatus":"completed","agentTerminalHandle":"term_done","resource":{"worktreeId":"repo1::/p/done"}},
        {"dispatchId":"ctx_failrep","dispatchStatus":"failed","agentTerminalHandle":"term_fr","resource":{"worktreeId":"repo1::/p/failrep"}},
        {"dispatchId":"ctx_failcrash","dispatchStatus":"failed","agentTerminalHandle":"term_fc","resource":{"worktreeId":"repo1::/p/failcrash"}},
        {"dispatchId":"ctx_openold","dispatchStatus":"dispatched","agentTerminalHandle":"term_o","resource":{"worktreeId":"repo1::/p/open"}},
        {"dispatchId":"ctx_openfailed","dispatchStatus":"failed","agentTerminalHandle":"term_o","resource":{"worktreeId":"repo1::/p/open"}}]}}'
      exit 0
    fi
    if [ -n "${ORCA_PAUSE_WORKERS_FILE:-}" ]; then
      if [ -n "${ORCA_PAUSE_WORKERS_PAGE2:-}" ] && grep -q -- '--cursor pause2' <<<"$*"; then cat "$ORCA_PAUSE_WORKERS_PAGE2"
      else cat "$ORCA_PAUSE_WORKERS_FILE"; fi
      exit 0
    fi
    echo '{"result":{"workers":[
      {"dispatchId":"ctx_old","dispatchStatus":"completed","terminalState":"reclaimable","agentTerminalHandle":"term_old","resource":{"worktreeId":"repo1::/p/lead"}},
      {"dispatchId":"ctx_live","dispatchStatus":"dispatched","terminalState":"active","agentTerminalHandle":"term_live","resource":{"worktreeId":"repo1::/p/lead"}},
      {"dispatchId":"ctx_sibling","dispatchStatus":"dispatched","resource":{"worktreeId":"repo1::/p/tester"}},
      {"dispatchId":"ctx_idle","dispatchStatus":"dispatched","resource":{"worktreeId":"repo1::/p/idle"}},
      {"dispatchId":"ctx_orphan","dispatchStatus":"dispatched","resource":{"worktreeId":"repo1::/p/orphan"}},
      {"dispatchId":"ctx_flaky","dispatchStatus":"dispatched","resource":{"worktreeId":"repo1::/p/flaky"}},
      {"dispatchId":"ctx_dupNew","terminalState":"active","agentTerminalHandle":"term_dupNew","resource":{"worktreeId":"repo1::/p/dup"}},
      {"dispatchId":"ctx_ret","terminalState":"retained","agentTerminalHandle":"term_ret","resource":{"worktreeId":"repo1::/p/ret"}},
      {"dispatchId":"ctx_rel1","terminalState":"released","agentTerminalHandle":"term_rel1","resource":{"worktreeId":"repo1::/p/ret"}},
      {"dispatchId":"ctx_rel2","terminalState":"released","agentTerminalHandle":"term_rel2","resource":{"worktreeId":"repo1::/p/ret"}},
      {"dispatchId":"ctx_dupOld","terminalState":"active","agentTerminalHandle":"term_dupOld","resource":{"worktreeId":"repo1::/p/dup"}}]}}'
    fi ;;
  "terminal switch")  echo '{"result":{"ok":true}}' ;;
  "terminal create")  [ -z "${FAKE_TC_FAIL:-}" ] || { echo '{"ok":false}'; echo "orca: worktree is not ready" >&2; exit 1; }
                      echo '{"result":{"terminal":{"handle":"tab_new"}}}' ;;
  "terminal wait")    [ -z "${FAKE_TUI_FAIL:-}" ] || { echo "orca: wait timed out" >&2; exit 1; }; echo '{"result":{"ok":true}}' ;;
  "status --json")     printf '%s' "${ORCA_STATUS:-$STATUS_OK}" ;;
  "terminal close")
    if [ -n "${ORCA_PAUSE_TABS_FILE:-}" ]; then
      h=""; for ((i=1; i<=$#; i++)); do [ "${!i}" != --terminal ] || { j=$((i + 1)); h="${!j}"; }; done
      jq --arg h "$h" '.result.terminals |= map(select(.handle != $h))' "$ORCA_PAUSE_TABS_FILE" > "$ORCA_PAUSE_TABS_FILE.new"
      mv "$ORCA_PAUSE_TABS_FILE.new" "$ORCA_PAUSE_TABS_FILE"
    fi
    echo '{"result":{"ok":true}}' ;;
  "terminal send")    printf '{"ok":true,"result":{"send":{"accepted":true,"prompt":{"stages":%s}}}}' "${ORCA_SEND_STAGES:-[\"input_accepted\",\"turn_started\"]}" ;;
  "terminal read")    if [ -n "${ORCA_SCREEN:-}" ]; then printf '%s' "$ORCA_SCREEN" | jq -Rs '{ok:true,result:{terminal:{tail:split("\n")}}}'; else echo '{"ok":true,"result":{"terminal":{"tail":["⏺ done","  ⎿  5-hour limit reached ∙ resets 3pm","❯"]}}}'; fi ;;
  "terminal list")
    [ -z "${FAKE_TL_FAIL:-}" ] || exit 1
    [ -z "${ORCA_PAUSE_TABS_FILE:-}" ] || { cat "$ORCA_PAUSE_TABS_FILE"; exit 0; }
    [ -z "${ORCA_TERM_PANES:-}" ] || { printf '%s' "$ORCA_TERM_PANES"; exit 0; }
    if [ -n "${ORCA_TERM_CONNECTED:-}" ]; then
      printf '%s' "$ORCA_TERM_CONNECTED" | jq -Rc 'split(",") | {result:{terminals:map({handle:., connected:true})}}'; exit 0
    fi
    # Per-worktree (close-squad): two tabs on /p/lead. Host-wide: a mix of orphaned + live, so the
    # orphaned sweep closes ONLY the orphaned ones and never the operator's connected terminal.
    if grep -q -- '--worktree' <<<"$*"; then
      echo '{"result":{"terminals":[{"handle":"tab_l1","worktreeId":"repo1::/p/lead","orphaned":false},{"handle":"tab_l2","worktreeId":"repo1::/p/lead","orphaned":false}]}}'
    else
      printf '%s' "{\"result\":{\"totalCount\":3,\"terminals\":[{\"handle\":\"tab_dead1\",\"orphaned\":true},{\"handle\":\"tab_live\",\"orphaned\":false,\"connected\":true,\"worktreeId\":\"repo1::/p/lead\",\"lastOutputAt\":100},{\"handle\":\"tab_l3\",\"orphaned\":false,\"connected\":true,\"writable\":true,\"agentIdentity\":\"claude\",\"worktreeId\":\"repo1::/p/lead\",\"lastOutputAt\":${ORCA_ACT_MS:-250}},{\"handle\":\"tab_dead2\",\"orphaned\":true},{\"handle\":\"tab_studio\",\"orphaned\":false,\"connected\":true,\"worktreePath\":\"/p/ds-foo-lead-bar\"}]}}"
    fi ;;
  "orchestration worker-stop")
    # Real orca rejects --from on worker-stop; mirror that so the adapter can't regress.
    if grep -q -- '--from' <<<"$*"; then
      echo 'error: Unknown flag --from for command: orchestration worker-stop' >&2; exit 1
    fi
    # An idle/retained dispatch can't be stopped — orca returns ok:false dispatch_inactive.
    if grep -q 'ctx_idle' <<<"$*"; then
      echo '{"result":{"ok":false,"code":"dispatch_inactive","msg":"cannot stop from stop_unknown"}}'
    # An ORPHANED dispatch (dead terminal, stale record) fails with no/unknown code.
    elif grep -q 'ctx_orphan' <<<"$*"; then
      echo '{"result":{"ok":false,"msg":"dispatch context not reachable"}}'
    # A CLI hiccup (timeout/auth): no JSON at all, non-zero exit. The adapter must NOT read this
    # as a negative verdict (and must not abandon).
    elif grep -q 'ctx_flaky' <<<"$*"; then
      echo 'error: could not reach runtime' >&2; exit 1
    else
      echo '{"result":{"ok":true}}'
    fi ;;
  "orchestration worker-release")
    [ -z "${FAKE_RELEASE_FAIL:-}" ] || { echo 'release unavailable' >&2; exit 1; }
    [ -z "${ORCA_RELEASE_OUT:-}" ] || { printf '%s' "$ORCA_RELEASE_OUT"; exit 0; }
    # U150: the dispatch named in ORCA_RELEASE_UNKNOWN answers release_unknown (its terminal is gone).
    [ -z "${ORCA_RELEASE_UNKNOWN:-}" ] || ! grep -q -- "--dispatch $ORCA_RELEASE_UNKNOWN" <<<"$*" || {
      echo '{"ok":false,"error":{"code":"release_unknown","message":"recorded terminal no longer resolves"}}'; exit 1; }
    # A real close reports processAction != "none"; a user-takeover/no-terminal retained reports
    # processAction "none" (ok:true no-op). ctx_ret_noop models the latter so the count excludes it.
    if grep -q 'ctx_ret_noop' <<<"$*"; then
      echo '{"ok":true,"result":{"state":"retained","reason":"user_takeover","processAction":"none"}}'
    else
      echo '{"ok":true,"result":{"state":"released","processAction":"close"}}'
    fi ;;
  "orchestration worker-abandon")
    [ -z "${FAKE_ABANDON_REFUSE:-}" ] || { echo '{"ok":false,"result":{"ok":false}}'; exit 0; }
    echo '{"result":{"ok":true}}' ;;
  "orchestration dispatch")
    [ -z "${FAKE_DISPATCH_FAIL:-}" ] || { echo '{"ok":false,"error":{"code":"task_not_startable","message":"task is not startable"}}'; exit 1; }
    [ -z "${FAKE_DISPATCH_NOID:-}" ] || { echo '{"ok":true,"result":{}}'; exit 0; }
    echo '{"ok":true,"result":{"dispatch":{"id":"ctx_new","taskId":"task_new","status":"dispatched"},"injected":true}}' ;;
  "orchestration task-list")
    [ -z "${FAKE_TASKLIST_FAIL:-}" ] || exit 1
    echo '{"result":{"tasks":[{"id":"task_squad","spec":"umbrella"},{"id":"task_lead","spec":"You are the Lead.\nRead the plan."}]}}' ;;
  "orchestration worker-show")
    case "$*" in
      *ctx_failrep*) echo '{"result":{"dispatch":{"lastFailure":"{\"provenance\":\"worker_report\",\"outcome\":\"failed\"}"}}}'; exit 0 ;;
      *ctx_cferr*) exit 1 ;;
      *ctx_failcrash*) echo '{"result":{"dispatch":{"lastFailure":"{\"provenance\":\"process_stopped\"}"}}}'; exit 0 ;;
    esac
    printf '%s' "${ORCA_WORKER_SHOW:-$WORKER_SHOW_SELF}" ;;
  "orchestration worker-start")
    # consumer_fenced: permanent (non-coordinator). runtime_busy: transient — fail FAKE_WS_FAIL
    # times (counted in FAKE_WS_COUNTER) then succeed, so the adapter's backoff/retry is exercised.
    if [ -n "${FAKE_WS_FENCE:-}" ]; then
      echo '{"result":{"ok":false,"code":"consumer_fenced"}}' >&2; exit 1
    fi
    # FAKE_WS_UNOBSERVED: a start whose turn was not yet observed. The live CLI exits 1 for it with
    # --full and 0 in the concise view (worker-start --help).
    if [ -n "${FAKE_WS_UNOBSERVED:-}" ]; then
      echo '{"ok":true,"result":{"dispatchId":"ctx_slow","state":"starting"}}'
      case " $* " in *" --full "*) exit 1 ;; esac
      exit 0
    fi
    n="$(cat "${FAKE_WS_COUNTER:-/dev/null}" 2>/dev/null)"; [ -n "$n" ] || n=0
    if [ "$n" -lt "${FAKE_WS_FAIL:-0}" ]; then
      echo $((n + 1)) > "$FAKE_WS_COUNTER"
      echo '{"ok":false,"code":"runtime_busy","msg":"long-poll capacity reached; retry with backoff"}' >&2
      exit 1
    fi
    echo '{"result":{"ok":true}}' ;;
  "orchestration check")
    if grep -q 'del_bad' <<<"$*"; then
      echo 'keepalive ping' >&2
      echo 'error: unknown delivery del_bad' >&2
      exit 1
    fi
    # Mirror the live CLI: --peek and --unread together is rejected ("choose at most one read
    # mode"). So a peek verb that sent both would fail here — pinning the P1 fix.
    if grep -q -- '--peek' <<<"$*" && grep -q -- '--unread' <<<"$*"; then
      echo '{"ok":false,"error":{"code":"invalid_argument","message":"Choose at most one message read mode"}}'; exit 1
    fi
    # worker-done's self-lookup (the only `check --terminal` caller): the envelope carries
    # the dispatch even with zero unread (host-confirmed, docs/orca-notes.md).
    if grep -q -- '--terminal' <<<"$*"; then
      printf '%s' "${ORCA_CHECK_SELF:-$CHECK_SELF}"
    else
      echo '{"ok":true,"result":{"messages":[{"subject":"hi"}],"deliveryId":"del_1"}}'
    fi ;;
  "automations list")   printf '%s' "${ORCA_AUTO_LIST:-$EMPTY_AUTO}" ;;
  "automations create") echo '{"result":{"automation":{"id":"auto_new"}}}' ;;
  "automations remove") echo '{"result":{}}' ;;
  *) echo '{"result":{}}' ;;
esac
}
# compact <subcommand> — the live CLI's concise view of a full record (mirrors its field
# mappers for the commands the adapter parses; others pass through unchanged).
compact() {
  jq -c --arg s "$1" '
    def c:
      if   $s == "run-create" or $s == "run-show" or $s == "run-use" then
        (if .run then {runId: .run.id, objective: .run.objective} else . end)
      elif $s == "task-create" then (if .task then {taskId: .task.id, status: .task.status} else . end)
      elif $s == "gate-create" or $s == "gate-resolve" then
        (if .gate then {gateId: .gate.id, taskId: .gate.task_id, status: .gate.status} else . end)
      elif $s == "gate-list" then {gates: [.gates[]? | {id, taskId: .task_id, status}], runId}
      elif $s == "worker-list" then
        {workers: [.workers[]? | {dispatchId, taskId, state: .workerState, terminal: .agentTerminalHandle,
                                  terminalState, workspace: .resource.worktreeId}],
         nextCursor: (if .page.hasMore then .page.nextCursor else null end)}
      elif $s == "worker-show" then
        {dispatchId: .dispatch.id, taskId: .dispatch.taskId, runId: .dispatch.runId, state: .worker.state}
      elif $s == "send" then
        (if .message then {messageId: .message.id}
         elif .messages then {messageIds: [.messages[].id]} else . end)
      elif $s == "inbox" then
        {messages: [.messages[]? | {id, type, to: .to_handle, handled: (.read == 1)}]}
      elif $s == "check" then {messages: [.messages[]? | {id, type, subject}]}
      else . end;
    if (.result | type) == "object" then .result |= c else . end'
}
if [ "$1" = orchestration ] && grep -q -- '--json' <<<"$*" && ! grep -q -- '--full' <<<"$*"; then
  out="$(emit "$@")" && rc=0 || rc=$?
  if printf '%s' "$out" | jq -e . >/dev/null 2>&1; then printf '%s\n' "$out" | compact "$2"; else printf '%s' "$out"; fi
  exit "$rc"
fi
emit "$@"
FAKE
chmod +x "$TMP/orca"
export DS_ORCA_CLI_BIN_DIR="$TMP"
export PATH="$TMP:$PATH"
export EMPTY_PS='{"result":{"worktrees":[]}}'
export EMPTY_RESULT='{"result":{}}'
export EMPTY_AUTO='{"result":{"automations":[]}}'
export CHECK_SELF='{"ok":true,"result":{"runId":"run_1","dispatchId":"ctx_self","messages":[],"count":0}}'
export WORKER_SHOW_SELF='{"result":{"dispatch":{"id":"ctx_self","runId":"run_1","taskId":"task_self","assigneeHandle":"term_self","status":"dispatched"}}}'
export STATUS_OK='{"ok":true,"result":{"runtime":{"reachable":true,"state":"ready"}}}'

# --- tiny assert harness -----------------------------------------------------
pass=0; fail=0
ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); echo "  FAIL: $1" >&2; }
eq()   { if [ "$2" = "$3" ]; then ok; else bad "$1: want [$3] got [$2]"; fi; }
has()  { if grep -qF -- "$3" <<<"$2"; then ok; else bad "$1: [$2] missing [$3]"; fi; }
hasnt(){ if grep -qF -- "$3" <<<"$2"; then bad "$1: [$2] should not contain [$3]"; else ok; fi; }

run() { : > "$ORCA_LOG"; "$ADAPTER" "$@"; }

# --- entity_id extraction ----------------------------------------------------
eq "run-create id"  "$(run run-create 'obj')"               "run_123"
eq "task-create id" "$(run task-create run_1 spec title)"   "task_123"
eq "gate-create id" "$(run gate-create task_1 'ok?')"       "gate_1"
# Orca 1.4.246 (2026-11-02) prints a COMPACT result for --json unless --full is passed: the id
# moved from .result.run.id to .result.runId (etc.). Both shapes must yield the entity id — and
# a compact gate (which also carries its taskId) and task (whose envelope may name its runId)
# must yield THEIR OWN id, not the parent's.
eq "run-create id (compact)"  "$(ORCA_CREATE_OUT='{"ok":true,"result":{"runId":"run_57ffe13540e9","objective":"squad: x"}}' run run-create 'obj')" "run_57ffe13540e9"
eq "task-create id (compact)" "$(ORCA_CREATE_OUT='{"ok":true,"result":{"taskId":"task_9","runId":"run_1","status":"ready"}}' run task-create run_1 spec title)" "task_9"
# Every orchestration --json call must ask for --full (the compact view drops what we parse).
# The fake compacts without it; check that, and that the adapter source never forgets it.
eq "fake compacts without --full" "$(orca orchestration run-show --id r --json | jq -c .result)" '{"runId":"run_own","objective":null}'
# worker-start is the one exception: --full fails a start that is still coming up (below).
eq "every orchestration --json call passes --full" \
  "$(grep -nE 'orca orchestration|_wl\+=\(--terminal-state' "$ADAPTER" | grep -- '--json' | grep -v -- '--json --full' | grep -v 'orca orchestration worker-start' || true)" ""
FAKE_WS_UNOBSERVED=1 DS_WORKER_START_RETRIES=1 "$ADAPTER" worker-start run_1 wtX spec claude opus >/dev/null 2>&1 && ws_rc=0 || ws_rc=$?
eq "worker-start: a start not yet observed is not a failure" "$ws_rc" "0"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus >/dev/null 2>&1 || true
hasnt "worker-start asks for the concise view" "$(grep 'worker-start' "$ORCA_LOG")" "--full"
eq "gate-create id (compact)" "$(ORCA_CREATE_OUT='{"ok":true,"result":{"gateId":"gate_9","taskId":"task_1","status":"pending"}}' run gate-create task_1 'ok?')" "gate_9"
eq "gate-list count" "$(run gate-list run_1)"               "2"

# --- adopt binds the coordinator seat with a PLAIN run-use (so the Lead can start
# workers). --takeover-legacy is invalid on this build (host-confirmed) and must NOT be
# sent — it errored, leaving the Lead fenced. Assert the plain bind and no legacy flag.
run adopt run_x >/dev/null 2>&1
has "adopt binds the coordinator seat"      "$(cat "$ORCA_LOG")" "run-use --id run_x"
hasnt "adopt sends no --takeover-legacy"    "$(cat "$ORCA_LOG")" "--takeover-legacy"
# Orca's error is JSON on stdout: adopt carries its message to stderr, so the loop's event says why.
ORCA_RUNUSE_FAIL=1 "$ADAPTER" adopt run_x >/dev/null 2>"$TMP/err" && r=0 || r=$?
eq "adopt: a refused run-use exits non-zero" "$r" "1"
has "adopt: stderr carries Orca's JSON error" "$(cat "$TMP/err")" "invalid_argument: Unknown flag --full for command: orchestration run-use"

# --- the loop's sender (U11): it runs with no ORCA_* and names its terminal in DS_ORCA_FROM,
# and a worker-start carries the request id it stored first (DS_ORCA_RETRY_REQUEST).
: > "$ORCA_LOG"; env -u ORCA_TERMINAL_HANDLE DS_ORCA_FROM=term_loop "$ADAPTER" adopt run_x >/dev/null 2>&1
has "adopt from the loop's sender"           "$(cat "$ORCA_LOG")" "run-use --id run_x --from term_loop"
: > "$ORCA_LOG"; DS_ORCA_FROM=term_loop DS_ORCA_RETRY_REQUEST=rq_1 DS_WORKER_START_RETRIES=1 "$ADAPTER" worker-start run_1 wtX spec claude opus >/dev/null 2>&1 || true
has "worker-start carries the retry id"      "$(cat "$ORCA_LOG")" "--from term_loop --retry-request rq_1"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus >/dev/null 2>&1 || true
hasnt "no retry id unless the loop sets one" "$(cat "$ORCA_LOG")" "--retry-request"
: > "$ORCA_LOG"; DS_ORCA_FROM=term_loop DS_ORCA_RETRY_REQUEST=rq_2 "$ADAPTER" task-create run_1 spec title task_sq >/dev/null 2>&1
has "task-create carries the retry id (a replayed rebind makes one task)" "$(cat "$ORCA_LOG")" "--parent task_sq --from term_loop --retry-request rq_2"
panes='{"result":{"terminals":[{"handle":"tab_other","tabId":"t9","leafId":"l9"},{"handle":"tab_new","tabId":"t1","leafId":"l1"}]}}'
eq "terminal-create: handle and pane key"    "$(ORCA_TERM_PANES="$panes" run terminal-create wt_1 'ds-loop demo')" "$(printf 'tab_new\tt1:l1')"
has "terminal-create in the worktree"        "$(cat "$ORCA_LOG")" "terminal create --worktree id:wt_1 --title ds-loop demo"
eq "terminal-create: pane not listed yet"    "$(ORCA_TERM_PANES='{"result":{"terminals":[]}}' run terminal-create wt_1 t)" "$(printf 'tab_new\t')"
eq "terminal-find: the pane's live handle"   "$(ORCA_TERM_PANES="$panes" run terminal-find t1:l1)" "tab_new"
eq "terminal-find: a gone pane is empty"     "$(ORCA_TERM_PANES="$panes" run terminal-find t5:l5)" ""
eq "request-show: completed with dispatch"   "$(ORCA_REQUEST_SHOW='{"result":{"state":"completed","dispatchId":"ctx_9"}}' run request-show rq_1)" "$(printf 'completed\tctx_9')"
eq "request-show: absent"                    "$(run request-show rq_2)" "$(printf 'absent\t')"

# --- current: by THIS terminal first (cwd-independent), else by cwd -------------
# `orca worktree current` resolves the CURRENT DIRECTORY, so an agent that cd'd to ~/.dev-studio
# got "" and every self-guard (close-squad, close-role, restart-role) silently passed.
eq "current resolves by terminal handle" "$(ORCA_TERMINAL_HANDLE=tab_live run current)" "repo1::/p/lead"
eq "run-coordinator names the terminal that holds the Run" "$(run run-coordinator run_own)" "tab_live"
eq "current falls back to cwd without a handle" "$(env -u ORCA_TERMINAL_HANDLE "$ADAPTER" current)" "wt_self"

# --- send vs send-worker addressing -----------------------------------------
run send run_9 subj body >/dev/null; has "send -> run:" "$(cat "$ORCA_LOG")" "--to run:run_9"
run send-worker wt_7 subj body >/dev/null; has "send-worker -> @worktree:" "$(cat "$ORCA_LOG")" "--to @worktree:wt_7"
# Orca resolves @worktree: only inside the sender's own Run; aimed outside, it silently files
# the message under run:<own run> (its Lead reads it). send-worker must fail loudly then —
# except when the target IS that Run's coordinator (a Thinker answering its Lead).
sent(){ printf '{"result":{"messages":[{"id":"msg_1","to_handle":"%s"}]}}' "$1"; }
ORCA_SEND_OUT="$(sent term_target)" run send-worker wt_7 s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "send-worker delivered to a terminal -> ok" "$r" "0"
has "delivered send prints a receipt" "$(cat "$TMP/out")" "delivered to term_target (msg_1)"
# Ids are <repo-id>::<path>, and every worktree of one repo shares the repo-id — so only the
# full id tells the Lead's worktree apart from the Studio's (the first check compared repo-ids).
ORCA_SEND_OUT="$(sent run:run_own)" run send-worker "repo1::/p/studio" s b >/dev/null 2>"$TMP/err" && r=0 || r=$?
eq "send-worker rerouted to own Run -> exit 3" "$r" "3"
has "rerouted send says why + what to do" "$(cat "$TMP/err")" "ask-operator.sh"
ORCA_SEND_OUT="$(sent run:run_own)" run send-worker "repo1::/p/lead" s b >/dev/null 2>&1 && r=0 || r=$?
eq "send-worker to own Lead (the coordinator) -> ok" "$r" "0"
ORCA_SEND_OUT="$(sent run:run_own)" run send-worker "repo1::/p/builder-u7" s b >/dev/null 2>&1 && r=0 || r=$?
eq "a done Builder (no live dispatch, rerouted) -> exit 3" "$r" "3"

# --- host-merge: a remote worker must NOT be reported GONE -------------------
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_lead","displayName":"ds-x-lead-t","agents":[{"state":"working"}]}],"hostScope":{"omittedHostSelectors":[{"selector":"--host saved:env1"}]}}}'
export ORCA_PS_REMOTE='{"result":{"worktrees":[{"worktreeId":"wt_remote","displayName":"ds-x-builder-r","agents":[{"state":"working"}]}]}}'
states="$(run worker-states)"
has "worker-states local"  "$states" "wt_lead"
has "worker-states remote" "$states" "wt_remote"
has "remote is working not gone" "$states" "wt_remote	working"
# state mapping precedence
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wA","displayName":"a","agents":[{"state":"waiting"}]},{"worktreeId":"wB","displayName":"b","agents":[{"state":"done"}]},{"worktreeId":"wC","displayName":"c","agents":[]}]}}'
export ORCA_PS_REMOTE='{"result":{"worktrees":[]}}'
states="$(run worker-states)"
has "waiting maps"  "$states" "wA	waiting"
has "done maps"     "$states" "wB	done"
has "no-agent=idle" "$states" "wC	idle"
has "attention lists waiting" "$(run attention)" "a"
# a long last message keeps its END (where a closing question sits), not its start
long="$(printf 'x%.0s' $(seq 1 300))Ship it?"
export ORCA_PS_PRIMARY="{\"result\":{\"worktrees\":[{\"worktreeId\":\"wL\",\"displayName\":\"l\",\"agents\":[{\"state\":\"idle\",\"lastAssistantMessage\":\"$long\"}]}]}}"
states="$(run worker-states)"
has "long last message keeps the closing question" "$states" "Ship it?"
eq "long last message stays bounded" "$(printf '%s' "$states" | cut -f5 | wc -c | tr -d ' ')" "204"

# --- wt_create reuse excludes archived (via worktree-ensure) -----------------
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_old","displayName":"ds-x-lead-reuse","isArchived":true,"agents":[]}]}}'
export ORCA_PS_REMOTE='{"result":{"worktrees":[]}}'
eq "archived not reused -> creates new" "$(run worktree-ensure name:repo ds-x-lead-reuse claude 'p')" "wt_new"
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_live","displayName":"ds-x-lead-reuse","isArchived":false,"agents":[]}]}}'
eq "live worktree reused" "$(run worktree-ensure name:repo ds-x-lead-reuse claude 'p')" "wt_live"
# The up.sh duplication bug: a path: repo where the worktree's .path (its workspace dir)
# differs from the repo selector must STILL reuse by displayName — not fork a new "-2".
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_studio","displayName":"ds-acme-studio","isArchived":false,"path":"/home/x/orca/workspaces/acme/ds-acme-studio","agents":[]}]}}'
eq "reuse by name even when worktree path != repo selector" "$(run worktree-ensure path:/home/x/dev/repos/acme ds-acme-studio claude 'p')" "wt_studio"

# --- worker-stop resolves the LIVE dispatch for THIS worktree, stops BY it ----------
# Siblings share the repo-uuid half of the compound id (repo1::…), so a resolver that
# keyed on the uuid alone would match them all and grab the wrong (first) dispatch.
# Must match the FULL id, skip the completed dispatch, and never touch the sibling.
run worker-stop run_1 "repo1::/p/lead" >/dev/null 2>&1
has "worker-stop picks this worktree's live dispatch" "$(cat "$ORCA_LOG")" "worker-stop --dispatch ctx_live"
hasnt "worker-stop skips the completed dispatch" "$(cat "$ORCA_LOG")" "ctx_old"
hasnt "worker-stop never matches a sibling worktree" "$(cat "$ORCA_LOG")" "ctx_sibling"
hasnt "worker-stop never passes --worktree" "$(cat "$ORCA_LOG")" "worker-stop --worktree"
# worker-stop must NOT append --from even when running inside a terminal (orca rejects
# it). With a handle set, the stop must still succeed and carry no --from.
: > "$ORCA_LOG"
ORCA_TERMINAL_HANDLE=term_abc "$ADAPTER" worker-stop run_1 "repo1::/p/lead" >/dev/null 2>&1
eq "worker-stop succeeds inside a terminal (no --from)" "$?" "0"
hasnt "worker-stop call carries no --from" "$(grep 'worker-stop' "$ORCA_LOG")" "--from"

# An idle/retained worker still lists as dispatched but can't be stopped — restart must
# treat dispatch_inactive as a no-op (nothing running to fence) and succeed, so it can
# then start a fresh dispatch. Here repo1::/p/idle's live dispatch is ctx_idle.
"$ADAPTER" worker-stop run_1 "repo1::/p/idle" >/dev/null 2>&1
eq "worker-stop tolerates an already-inactive dispatch" "$?" "0"

# An ORPHANED dispatch (terminal dead, Orca still has it on record) fails worker-stop with
# no/unknown code. restart must treat that as already-stopped (nothing live to duplicate) and
# succeed, so /ds-update isn't blocked forever. repo1::/p/orphan's live dispatch is ctx_orphan.
: > "$ORCA_LOG"; "$ADAPTER" worker-stop run_1 "repo1::/p/orphan" >/dev/null 2>&1
eq "worker-stop tolerates an orphaned dispatch (no code)" "$?" "0"
# ...and ABANDONS the orphan so it settles and its slot can be released (else it leaks retained).
has "worker-stop abandons the orphaned dispatch" "$(cat "$ORCA_LOG")" "worker-abandon --dispatch ctx_orphan"
# An inactive/stop_unknown dispatch (a definite ok:false verdict) is ALSO abandoned, so its slot
# becomes releasable — a restart is replacing it anyway.
: > "$ORCA_LOG"; "$ADAPTER" worker-stop run_1 "repo1::/p/idle" >/dev/null 2>&1
has "worker-stop abandons an inactive/stop_unknown dispatch" "$(cat "$ORCA_LOG")" "worker-abandon --dispatch ctx_idle"
# But a CLI hiccup (no JSON, no verdict) must NOT abandon — fencing on a transient error would
# kill a possibly-healthy worker. repo1::/p/flaky's worker-stop returns empty.
: > "$ORCA_LOG"; "$ADAPTER" worker-stop run_1 "repo1::/p/flaky" >/dev/null 2>&1
hasnt "worker-stop never abandons on an empty (no-verdict) result" "$(cat "$ORCA_LOG")" "worker-abandon"

# --- worker-release / worker-reclaim / worker-abandon free leaked long-poll slots ----
# worker-release frees a worktree's SETTLED dispatch (the leak fix). repo1::/p/lead has a
# settled ctx_old + a live ctx_live; it releases ctx_old (the live one is a safe no-op).
: > "$ORCA_LOG"; "$ADAPTER" worker-release run_1 "repo1::/p/lead" >/dev/null 2>&1
has "worker-release releases the settled dispatch" "$(cat "$ORCA_LOG")" "worker-release --dispatch ctx_old"

# worker-reclaim sweeps RECLAIMABLE only (the closeable leak), server-side filtered + PAGINATED
# (offset cursor) so it reaches a backlog deeper than one 100-row page. It counts only GENUINE
# closes: pages carry r1,r2 | r3,ret_noop — ret_noop releases as a retained no-op (processAction
# none), so it's attempted but NOT counted -> 3 freed.
: > "$ORCA_LOG"; reclaimed="$("$ADAPTER" worker-reclaim run_1 2>/dev/null || true)"
eq "worker-reclaim counts only genuine closes (no-op excluded)" "$reclaimed" "3"
has "worker-reclaim filters reclaimable server-side" "$(cat "$ORCA_LOG")" "worker-list --run run_1 --terminal-state reclaimable"
has "worker-reclaim follows the page cursor"        "$(cat "$ORCA_LOG")" "--cursor c1"
has "worker-reclaim released a page-2 dispatch"     "$(cat "$ORCA_LOG")" "worker-release --dispatch ctx_r3"
has "worker-reclaim still ATTEMPTS the no-op row"   "$(cat "$ORCA_LOG")" "worker-release --dispatch ctx_ret_noop"
# retained is NOT swept — it's never our leak (no-terminal or protected/user-takeover).
hasnt "worker-reclaim does NOT sweep retained"      "$(cat "$ORCA_LOG")" "--terminal-state retained"

# With NO run, worker-reclaim sweeps the WHOLE host (reaches closed/orphaned runs) — same filter,
# no --run on the worker-list calls.
: > "$ORCA_LOG"; hostwide="$("$ADAPTER" worker-reclaim 2>/dev/null || true)"
eq "host-wide worker-reclaim still counts genuine closes" "$hostwide" "3"
hasnt "host-wide worker-reclaim passes no --run" "$(grep 'worker-list' "$ORCA_LOG")" "--run"
# Cursor safety: the reclaimable cursor page (p2) is fetched BEFORE any release, i.e. we collect
# all pages before releasing (releasing mid-pagination shifts the offset cursor).
cursor_line="$(grep -n -- '--cursor c1' "$ORCA_LOG" | head -1 | cut -d: -f1)"
first_rel="$(grep -n 'worker-release' "$ORCA_LOG" | head -1 | cut -d: -f1)"
if [ "${first_rel:-0}" -gt "${cursor_line:-0}" ]; then ok; else bad "worker-reclaim released before finishing reclaimable pagination (rel@$first_rel, cursor@$cursor_line)"; fi

# worker-abandon fences a worktree's dispatch (for the uncertain/stop_unknown case).
: > "$ORCA_LOG"; "$ADAPTER" worker-abandon run_1 "repo1::/p/orphan" >/dev/null 2>&1
has "worker-abandon fences the worktree's dispatch" "$(cat "$ORCA_LOG")" "worker-abandon --dispatch ctx_orphan"

# worker-resolve-unknown unsticks release_unknown dispatches: abandon THEN release each.
: > "$ORCA_LOG"; cleared="$("$ADAPTER" worker-resolve-unknown 2>/dev/null || true)"
eq "resolve-unknown clears both stuck dispatches" "$cleared" "2"
has "resolve-unknown abandons first" "$(cat "$ORCA_LOG")" "worker-abandon --dispatch ctx_unk1"
has "resolve-unknown then releases"  "$(cat "$ORCA_LOG")" "worker-release --dispatch ctx_unk1"
ab="$(grep -n 'worker-abandon --dispatch ctx_unk1' "$ORCA_LOG" | head -1 | cut -d: -f1)"
rl="$(grep -n 'worker-release --dispatch ctx_unk1' "$ORCA_LOG" | head -1 | cut -d: -f1)"
if [ "${ab:-9}" -lt "${rl:-0}" ]; then ok; else bad "resolve-unknown must abandon before release"; fi

# terminal-close-worktree closes EVERY tab on the worktree in ONE native call (the tab-leak fix).
: > "$ORCA_LOG"; "$ADAPTER" terminal-close-worktree "id:repo1::/p/lead" >/dev/null 2>&1
has "terminal-close-worktree closes all tabs in one native call" "$(cat "$ORCA_LOG")" "terminal close --worktree id:repo1::/p/lead --all"

# terminal-reap-orphaned closes ONLY orphaned tabs host-wide — never the live/connected one.
: > "$ORCA_LOG"; reaped="$("$ADAPTER" terminal-reap-orphaned 2>/dev/null || true)"
eq "terminal-reap-orphaned closes only orphaned tabs" "$reaped" "2"
has "terminal-reap-orphaned closes a dead tab"  "$(cat "$ORCA_LOG")" "terminal close --terminal tab_dead1"
hasnt "terminal-reap-orphaned never closes the live tab" "$(cat "$ORCA_LOG")" "tab_live"

# inbox-peek is a NON-BLOCKING, non-consuming read: `--peek` alone (NOT --peek --unread, which the
# CLI rejects), and NO --wait (so it holds no long-poll slot). Must surface the message.
: > "$ORCA_LOG"; peeked="$("$ADAPTER" inbox-peek run_1 2>/dev/null || true)"
eq "inbox-peek surfaces the waiting message" "$(printf '%s' "$peeked" | jq -r '.result.messages[0].subject // "none"')" "hi"
has "inbox-peek uses --peek"                 "$(cat "$ORCA_LOG")" "orchestration check --run run_1 --peek"
hasnt "inbox-peek does NOT pass --unread"    "$(cat "$ORCA_LOG")" "--unread"
hasnt "inbox-peek does NOT block (--wait)"   "$(cat "$ORCA_LOG")" "--wait"
: > "$ORCA_LOG"; "$ADAPTER" inbox-peek-self >/dev/null 2>&1
has "inbox-peek-self uses --peek, no --run"  "$(cat "$ORCA_LOG")" "orchestration check --peek"
hasnt "inbox-peek-self does NOT pass --unread" "$(cat "$ORCA_LOG")" "--unread"

# capacity reports a live-resource count (terminals) — not a long-poll gauge (push-on-idle wake
# means agents hold ~0 long-polls at rest, so terminal count no longer maps to the 16 cap).
# No prefix -> machine-wide totalCount.
eq "capacity reports the terminal count + label" "$("$ADAPTER" capacity 2>/dev/null || true)" "$(printf '3\tterminals')"
# With a name-prefix -> scoped to THIS studio: join worktree ps (displayName startswith prefix -> path)
# against terminals' worktreePath. Only tab_studio (/p/ds-foo-lead-bar) belongs to ds-foo- => count 1.
eq "capacity scopes to the studio prefix" \
  "$(ORCA_PS_PRIMARY='{"result":{"worktrees":[{"displayName":"ds-foo-lead-bar","path":"/p/ds-foo-lead-bar"},{"displayName":"main","path":"/p/main"}]}}' "$ADAPTER" capacity "ds-foo-" 2>/dev/null || true)" \
  "$(printf '1\tterminals')"

# worker-detail enriches/ acts via the LIVE terminal handle per worktree, keyed on
# terminalState=="active" (NOT dispatch status — the two are separate accounting).
det="$("$ADAPTER" worker-detail run_1 2>/dev/null || true)"
has "worker-detail gives the active terminal handle" "$det" "repo1::/p/lead	term_live"
hasnt "worker-detail skips the reclaimable (dead) terminal" "$det" "term_old"
hasnt "worker-detail skips a worker with no terminalState" "$det" "repo1::/p/tester"

# terminal-switch focuses by handle.
: > "$ORCA_LOG"; "$ADAPTER" terminal-switch term_live >/dev/null 2>&1
has "terminal-switch calls orca by handle" "$(cat "$ORCA_LOG")" "terminal switch --terminal term_live"

# terminal-reap keeps each worktree's OWNER (newest active) and closes the rest.
# /p/lead: one active (term_live) + one dead (term_old) -> keep term_live, close term_old.
: > "$ORCA_LOG"; reaped="$(ORCA_TERM_CONNECTED=term_live "$ADAPTER" terminal-reap run_1 "repo1::/p/lead" 2>/dev/null || true)"
eq "terminal-reap reports one closed (lead)" "$reaped" "1"
has "terminal-reap closes the dead handle" "$(cat "$ORCA_LOG")" "terminal close --terminal term_old"
hasnt "terminal-reap keeps the live owner" "$(cat "$ORCA_LOG")" "term_live"

# /p/dup: TWO live terminals -> keep the newest (term_dupNew), close the older (term_dupOld).
: > "$ORCA_LOG"; reaped="$(ORCA_TERM_CONNECTED=term_dupNew,term_dupOld "$ADAPTER" terminal-reap run_1 "repo1::/p/dup" 2>/dev/null || true)"
eq "terminal-reap closes the stray duplicate live" "$reaped" "1"
has "terminal-reap closes the older live duplicate" "$(cat "$ORCA_LOG")" "terminal close --terminal term_dupOld"
hasnt "terminal-reap keeps the newest live owner" "$(cat "$ORCA_LOG")" "term_dupNew"

# A worker launched with --terminal is `retained`, never `active`: liveness comes from the terminal
# list. Newest entry (term_ret) is connected, older handles are released -> close ONLY the older.
export ORCA_TERM_CONNECTED="term_ret"
: > "$ORCA_LOG"; reaped="$("$ADAPTER" terminal-reap run_1 "repo1::/p/ret" 2>/dev/null || true)"
eq "terminal-reap closes exactly the older released handles" "$reaped" "2"
has "terminal-reap closes released handle 1" "$(cat "$ORCA_LOG")" "terminal close --terminal term_rel1"
has "terminal-reap closes released handle 2" "$(cat "$ORCA_LOG")" "terminal close --terminal term_rel2"
hasnt "terminal-reap never closes the retained connected owner" "$(cat "$ORCA_LOG")" "terminal close --terminal term_ret"
unset ORCA_TERM_CONNECTED

# An unusable terminal list is "unknown": close nothing (never the live owner).
: > "$ORCA_LOG"; reaped="$(FAKE_TL_FAIL=1 "$ADAPTER" terminal-reap run_1 "repo1::/p/ret" 2>/dev/null || true)"
eq "terminal-reap closes nothing when terminal list fails" "$reaped" "0"
hasnt "terminal-reap issues no close on a failed list" "$(cat "$ORCA_LOG")" "terminal close"

# --- worker-start retries transient runtime_busy, fails fast on consumer_fenced ----
# No real waiting in the test: zero the backoff. Count starts via the ORCA_LOG lines.
export DS_WORKER_START_BACKOFF=0
export FAKE_WS_COUNTER="$TMP/ws_n"

# Transient: fail twice with runtime_busy, then succeed. The adapter should retry and win.
: > "$ORCA_LOG"; rm -f "$FAKE_WS_COUNTER"; rc=0
FAKE_WS_FAIL=2 "$ADAPTER" lead-worker-start run_1 task_1 wt_1 ds-agent sonnet >/dev/null 2>&1 || rc=$?
eq "worker-start retries runtime_busy to success" "$rc" "0"
eq "worker-start tried 3 times (2 busy + 1 ok)" "$(grep -c 'orchestration worker-start' "$ORCA_LOG")" "3"

# Permanent: consumer_fenced must NOT be retried — exactly one attempt, then fail.
: > "$ORCA_LOG"; rc=0
FAKE_WS_FENCE=1 "$ADAPTER" lead-worker-start run_1 task_1 wt_1 ds-agent sonnet >/dev/null 2>&1 || rc=$?
eq "worker-start fails on consumer_fenced"        "$rc" "1"
eq "worker-start does NOT retry consumer_fenced"  "$(grep -c 'orchestration worker-start' "$ORCA_LOG")" "1"

# Exhaustion: runtime_busy past the retry cap fails (not an infinite loop).
: > "$ORCA_LOG"; rm -f "$FAKE_WS_COUNTER"; rc=0
DS_WORKER_START_RETRIES=3 FAKE_WS_FAIL=99 "$ADAPTER" lead-worker-start run_1 task_1 wt_1 ds-agent sonnet >/dev/null 2>&1 || rc=$?
eq "worker-start gives up after the retry cap"    "$rc" "1"
eq "worker-start stops at the cap (3 tries)"      "$(grep -c 'orchestration worker-start' "$ORCA_LOG")" "3"
unset DS_WORKER_START_BACKOFF FAKE_WS_COUNTER

# terminal-activity: the newest output time per worktree (the sweep's "hung" signal).
eq "terminal-activity: max lastOutputAt per worktree" "$("$ADAPTER" terminal-activity 2>/dev/null || true)" "$(printf 'repo1::/p/lead\t250')"

# inbox-unread: unread real messages to the Run, read from the unfenced host-wide inbox listing.
eq "inbox-unread: only unread, non-heartbeat, to this Run" "$("$ADAPTER" inbox-unread run_1 2>/dev/null || true)" "$(printf '1792144800\tm1')"
# inbox-unread-all: the same filter for every Run and worker, from one host-wide read.
eq "inbox-unread-all: every unread non-heartbeat message, with its handle and Run" "$("$ADAPTER" inbox-unread-all 2>/dev/null || true)" \
  "$(printf 'run:run_1\trun_1\t1792144800\tm1\nrun:run_2\trun_2\t1792144980\tm4\nterm_x\trun_1\t1792145040\tm5')"

# poke-terminal (U75): types into a handle only when it is a live AGENT terminal; a plain shell tab
# (no agentIdentity) is refused with nothing sent.
: > "$ORCA_LOG"; rc=0; "$ADAPTER" poke-terminal tab_l3 "not delivered" >/dev/null 2>&1 || rc=$?
eq  "poke-terminal: live agent terminal -> exit 0"  "$rc" "0"
has "poke-terminal: sends the text + Enter"        "$(cat "$ORCA_LOG")" "terminal send --terminal tab_l3 --text not delivered --enter"
: > "$ORCA_LOG"; rc=0; "$ADAPTER" poke-terminal tab_studio "x" >/dev/null 2>&1 || rc=$?
eq  "poke-terminal: a shell tab -> exit 1"         "$rc" "1"
hasnt "poke-terminal: a shell tab gets nothing"    "$(cat "$ORCA_LOG")" "terminal send"
rc=0; "$ADAPTER" poke-terminal tab_nope "x" >/dev/null 2>&1 || rc=$?
eq  "poke-terminal: unknown handle -> exit 1"      "$rc" "1"

# poke: types into the worktree's live AGENT terminal (not a plain shell tab), Enter included,
# and reports whether the agent actually started a turn (0) or only got the text (3).
: > "$ORCA_LOG"; rc=0; "$ADAPTER" poke repo1::/p/lead "check your inbox" >/dev/null 2>&1 || rc=$?
eq  "poke: turn started -> exit 0"            "$rc" "0"
has "poke: sends to the agent terminal"       "$(cat "$ORCA_LOG")" "terminal send --terminal tab_l3 --text check your inbox --enter"
rc=0; ORCA_SEND_STAGES='["input_accepted"]' "$ADAPTER" poke repo1::/p/lead "x" >/dev/null 2>&1 || rc=$?
eq  "poke: accepted but no turn -> exit 3"    "$rc" "3"
rc=0; "$ADAPTER" poke repo1::/p/nobody "x" >/dev/null 2>&1 || rc=$?
eq  "poke: no agent terminal -> exit 1"       "$rc" "1"
# keys: types into the same AGENT terminal with NO Enter (a digit picks a live picker's option).
: > "$ORCA_LOG"; rc=0; "$ADAPTER" keys repo1::/p/lead "2" >/dev/null 2>&1 || rc=$?
eq  "keys: sent -> exit 0"                    "$rc" "0"
has "keys: sends to the agent terminal"       "$(cat "$ORCA_LOG")" "terminal send --terminal tab_l3 --text 2"
eq  "keys: no Enter"                          "$(grep -c -- '--enter' "$ORCA_LOG" || true)" "0"
: > "$ORCA_LOG"; "$ADAPTER" keys repo1::/p/lead "teal" enter >/dev/null 2>&1 || true
eq  "keys enter: text, then Enter as its own send" "$(grep -c 'terminal send' "$ORCA_LOG")" "2"
has "keys enter: the Enter send"              "$(tail -n1 "$ORCA_LOG")" "terminal send --terminal tab_l3 --enter"
rc=0; "$ADAPTER" keys repo1::/p/nobody "1" >/dev/null 2>&1 || rc=$?
eq  "keys: no agent terminal -> exit 1"       "$rc" "1"
# focus: switch the UI to a worktree's live AGENT terminal — the same one poke types into.
: > "$ORCA_LOG"; rc=0; "$ADAPTER" focus repo1::/p/lead >/dev/null 2>&1 || rc=$?
eq  "focus: found -> exit 0"                  "$rc" "0"
has "focus: switches to the agent terminal"   "$(cat "$ORCA_LOG")" "terminal switch --terminal tab_l3"
rc=0; "$ADAPTER" focus repo1::/p/nobody >/dev/null 2>&1 || rc=$?
eq  "focus: no agent terminal -> exit 1"      "$rc" "1"
# screen-tail: the rendered bottom of the agent's screen (where a usage-limit notice shows).
has "screen-tail: rendered tail lines"        "$("$ADAPTER" screen-tail repo1::/p/lead 2>/dev/null || true)" "5-hour limit reached ∙ resets 3pm"
has "screen-tail: reads the rendered screen"  "$(cat "$ORCA_LOG")" "terminal read --terminal tab_l3 --screen"
# U261: a terminal handle is read as itself (the adopted Studio's), no worktree lookup picks another terminal.
: > "$ORCA_LOG"; "$ADAPTER" screen-tail term_studio1 >/dev/null 2>&1 || true
has "screen-tail: a handle reads that terminal" "$(cat "$ORCA_LOG")" "terminal read --terminal term_studio1 --screen"
hasnt "screen-tail: a handle lists no terminals" "$(cat "$ORCA_LOG")" "terminal list"

# status: `reachable` when the runtime answers and reports reachable (install.sh's preflight).
: > "$ORCA_LOG"; st="$(run status 2>/dev/null || true)"
eq  "status: reachable runtime prints reachable" "$st" "reachable"
has "status: probes orca status --json" "$(cat "$ORCA_LOG")" "status --json"
export ORCA_STATUS='{"ok":true,"result":{"runtime":{"reachable":false,"state":"down"}}}'
rc=0; run status >/dev/null 2>&1 || rc=$?
eq  "status: unreachable runtime -> exit 1" "$rc" "1"
export ORCA_STATUS='{"ok":false}'; rc=0; run status >/dev/null 2>&1 || rc=$?
eq  "status: failed call -> exit 1" "$rc" "1"
unset ORCA_STATUS

# account-list: TSV, the first line per agent is its default login. Orca can't be read -> the system login only.
al="$("$ADAPTER" account-list 2>/dev/null || true)"
eq  "account-list: unreadable -> claude's only account is the system login" "$(printf '%s\n' "$al" | awk -F'\t' '$1=="claude"{print $2}')" "system"
eq  "account-list: muse and codex are 'default'"  "$(printf '%s\n' "$al" | awk -F'\t' '$1!="claude"{printf "%s:%s ", $1,$2}')" "muse:default codex:default "
eq  "account-list: three TSV columns"             "$(printf '%s\n' "$al" | awk -F'\t' 'NF!=3' | wc -l | tr -d ' ')" "0"

# account-usage: per Claude account, the usage endpoint with that home's OAuth token (a fake curl on
# PATH plays the endpoint: FAKE_USAGE_CODE + FAKE_USAGE_BODY). Failures -> `-`; cached per account.
cat > "$TMP/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"; cat >> "$CURL_LOG"   # argv, then the -K - config from stdin
printf '%s\n%s' "${FAKE_USAGE_BODY:-}" "${FAKE_USAGE_CODE:-200}"
FAKE
chmod +x "$TMP/curl"
# A fake `muse` on PATH (FAKE_MUSE_OUT / FAKE_MUSE_RC; default: exit 1, so the Claude cases see no muse row).
cat > "$TMP/muse" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MUSE_LOG"; pwd -P > "${MUSE_LOG}.cwd"
printf '%s' "${FAKE_MUSE_OUT:-}"; exit "${FAKE_MUSE_RC:-1}"
FAKE
chmod +x "$TMP/muse"; export MUSE_LOG="$TMP/muse.log"
# A fake `codex app-server` on PATH (account-free-resets U2), so no test reaches the host's real codex: it
# logs argv, cwd and each JSON-RPC line it reads, answers `initialize` (plus a notification and a stderr
# warning), then answers the rate-limits read with FAKE_CODEX_OUT as its result. FAKE_CODEX_MODE: exit
# (exit 1 at once, the default), error (a JSON-RPC error to the read), hang (never answers; its pid in
# $CODEX_LOG.pid).
cat > "$TMP/codex" <<'FAKE'
#!/usr/bin/env bash
printf 'argv %s\ncwd %s\nhome %s\n' "$*" "$PWD" "${CODEX_HOME:-}" >> "$CODEX_LOG"
echo "WARNING: bubblewrap not found" >&2
mode="${FAKE_CODEX_MODE:-exit}"
[ "$mode" = exit ] && exit 1
while IFS= read -r l; do
  printf '%s\n' "$l" >> "$CODEX_LOG"
  case "$l" in
    *'"id":1,'*) echo '{"id":1,"result":{"userAgent":"fake"}}'; echo '{"method":"configWarning","params":{"summary":"no bubblewrap"}}' ;;
    *'"id":2,'*) case "$mode" in
        error) echo '{"id":2,"error":{"code":-32600,"message":"not logged in"}}' ;;
        hang) echo "$$" > "$CODEX_LOG.pid"; exec sleep 30 ;;
        *) printf '{"id":2,"result":%s}\n' "$FAKE_CODEX_OUT" ;;
      esac ;;
  esac
done
FAKE
chmod +x "$TMP/codex"; export CODEX_LOG="$TMP/codex.log"
export CURL_LOG="$TMP/curl.log" DS_CLAUDE_HOME="$TMP/claude-home" DS_USAGE_CACHE="$TMP/usage-cache"
mkdir -p "$DS_CLAUDE_HOME"
creds() { printf '{"claudeAiOauth":{"accessToken":"tok-secret","expiresAt":%s}}' "$1" > "$DS_CLAUDE_HOME/.credentials.json"; }
usage() { rm -rf "$DS_USAGE_CACHE"; : > "$CURL_LOG"; "$ADAPTER" account-usage 2>/dev/null || true; }
creds $(( ($(date +%s) + 3600) * 1000 ))
export FAKE_USAGE_BODY='{"five_hour":{"utilization":72.4,"resets_at":"2030-01-01T15:00:00.123+00:00"},"seven_day":{"utilization":41,"resets_at":1900000000}}'
eq  "account-usage: ok -> percentages + reset epochs" "$(usage)" "$(printf 'claude\tsystem\t72\t1893510000\t41\t1900000000')"
has "account-usage: calls the usage endpoint"     "$(cat "$CURL_LOG")" "https://api.anthropic.com/api/oauth/usage"
has "account-usage: sends the oauth beta header"  "$(cat "$CURL_LOG")" "anthropic-beta: oauth-2025-04-20"
has "account-usage: token goes in on stdin"       "$(tail -n1 "$CURL_LOG")" 'header = "Authorization: Bearer tok-secret"'
hasnt "account-usage: token never in argv"        "$(head -n1 "$CURL_LOG")" "tok-secret"
: > "$CURL_LOG"; again="$("$ADAPTER" account-usage 2>/dev/null || true)"
eq  "account-usage: cached -> same row"           "$again" "$(printf 'claude\tsystem\t72\t1893510000\t41\t1900000000')"
eq  "account-usage: cached -> no second call"     "$(wc -c < "$CURL_LOG" | tr -d ' ')" "0"
printf '97\t%s\t40\t1900000000' "$(( $(date +%s) - 5 ))" > "$DS_USAGE_CACHE/claude-system.tsv"; : > "$CURL_LOG"
eq  "account-usage: cached window reset since -> refetched" "$("$ADAPTER" account-usage 2>/dev/null || true)" "$(printf 'claude\tsystem\t72\t1893510000\t41\t1900000000')"
: > "$CURL_LOG"; touch -d '10 minutes ago' "$DS_USAGE_CACHE/claude-system.tsv"; "$ADAPTER" account-usage >/dev/null 2>&1 || true
has "account-usage: stale cache -> calls again"   "$(cat "$CURL_LOG")" "oauth/usage"
got="$(FAKE_USAGE_CODE=429 FAKE_USAGE_BODY='{"error":"rate_limited"}' usage)"
eq  "account-usage: 429 -> unknown, not exhausted" "$got" "$(printf 'claude\tsystem\t-\t-\t-\t-')"
: > "$CURL_LOG"; "$ADAPTER" account-usage >/dev/null 2>&1 || true
eq  "account-usage: a failure is cached too"      "$(wc -c < "$CURL_LOG" | tr -d ' ')" "0"
got="$(FAKE_USAGE_BODY='{"seven_day":{"utilization":10}}' usage)"
eq  "account-usage: missing window -> -"          "$got" "$(printf 'claude\tsystem\t-\t-\t10\t-')"
got="$(FAKE_USAGE_BODY='not json' usage)"
eq  "account-usage: bad body -> unknown"          "$got" "$(printf 'claude\tsystem\t-\t-\t-\t-')"
creds $(( ($(date +%s) - 60) * 1000 ))
eq  "account-usage: expired token -> unknown, noted expired" "$(usage)" "$(printf 'claude\tsystem\t-\t-\t-\t-\texpired')"
eq  "account-usage: expired token -> no call"     "$(wc -c < "$CURL_LOG" | tr -d ' ')" "0"
creds $(( ($(date +%s) + 3600) * 1000 )); cp "$DS_CLAUDE_HOME/.credentials.json" "$TMP/creds.before"
got="$(FAKE_USAGE_CODE=401 FAKE_USAGE_BODY='{"error":"OAuth access token has expired"}' usage)"
eq  "account-usage: HTTP 401 on an unexpired token -> noted refused, not expired" "$got" "$(printf 'claude\tsystem\t-\t-\t-\t-\trefused')"
eq  "account-usage: 401 never touches the credentials file" "$(cmp -s "$TMP/creds.before" "$DS_CLAUDE_HOME/.credentials.json" && echo same)" "same"
hasnt "account-usage: 401 sends no POST (no refresh/prompt)" "$(cat "$CURL_LOG")" "POST"
: > "$CURL_LOG"; "$ADAPTER" account-usage >/dev/null 2>&1 || true
eq  "account-usage: expired is cached too"        "$(wc -c < "$CURL_LOG" | tr -d ' ')" "0"
eq  "account-usage: refused is cached too (short TTL)" "$(wc -c < "$CURL_LOG" | tr -d ' ')" "0"
touch -d '2 minutes ago' "$DS_USAGE_CACHE/claude-system.tsv"; : > "$CURL_LOG"; "$ADAPTER" account-usage >/dev/null 2>&1 || true
has "account-usage: refused is retried after DS_USAGE_FAIL_TTL_S (60s), not 300s" "$(cat "$CURL_LOG")" "oauth/usage"
printf '{"claudeAiOauth":{"accessToken":"tok-secret"}}' > "$DS_CLAUDE_HOME/.credentials.json"
got="$(FAKE_USAGE_CODE=401 FAKE_USAGE_BODY='{}' usage)"
eq  "account-usage: HTTP 401 with no expiresAt stays expired" "$got" "$(printf 'claude\tsystem\t-\t-\t-\t-\texpired')"
creds $(( ($(date +%s) + 3600) * 1000 ))
# a good answer, then a refusal: the good figures stay, with the note and when they were good
usage >/dev/null; got="$(FAKE_USAGE_BODY='{"five_hour":{"utilization":45,"resets_at":1900000000},"seven_day":{"utilization":20,"resets_at":1900000000}}' usage)"
eq  "account-usage: 200 -> figures" "$got" "$(printf 'claude\tsystem\t45\t1900000000\t20\t1900000000')"
good_at="$(stat -c %Y "$DS_USAGE_CACHE/claude-system.tsv")"
touch -d '10 minutes ago' "$DS_USAGE_CACHE/claude-system.tsv"; good_at="$(stat -c %Y "$DS_USAGE_CACHE/claude-system.tsv")"
got="$(FAKE_USAGE_CODE=401 FAKE_USAGE_BODY='{}' "$ADAPTER" account-usage 2>/dev/null || true)"
eq  "account-usage: a 401 after a good answer keeps the figures, noted refused@<time>" "$(printf '%s\n' "$got" | grep '^claude	system	')" "$(printf 'claude\tsystem\t45\t1900000000\t20\t1900000000\trefused@%s' "$good_at")"
touch -d '2 minutes ago' "$DS_USAGE_CACHE/claude-system.tsv"   # a stale row is short-TTL: retried
got="$(FAKE_USAGE_CODE=429 FAKE_USAGE_BODY='{}' "$ADAPTER" account-usage 2>/dev/null || true)"
eq  "account-usage: a 429 after that keeps the same figures and their time" "$(printf '%s\n' "$got" | grep '^claude	system	')" "$(printf 'claude\tsystem\t45\t1900000000\t20\t1900000000\tstale@%s' "$good_at")"
printf '45\t%s\t20\t1900000000' "$(( $(date +%s) - 5 ))" > "$DS_USAGE_CACHE/claude-system.tsv"; touch -d '2 minutes ago' "$DS_USAGE_CACHE/claude-system.tsv"
got="$(FAKE_USAGE_CODE=401 FAKE_USAGE_BODY='{}' "$ADAPTER" account-usage 2>/dev/null || true)"
has "account-usage: a window reset since the good figures is blanked" "$(printf '%s\n' "$got" | grep '^claude	system	')" "$(printf -- '-\t-\t20\t1900000000\trefused@')"
got="$(FAKE_USAGE_CODE=200 FAKE_USAGE_BODY='{"five_hour":{"utilization":10,"resets_at":1900000000}}' usage)"
eq  "account-usage: 200 -> no expired note"       "$got" "$(printf 'claude\tsystem\t10\t1900000000\t-\t-')"
# An ended login (credentials file: loginEnded, or both tokens empty) is its own row, read before the cache:
# no usage call, no stale figures; a token again (even with a fresh cached ended row) fetches at once.
usage_keep() { : > "$CURL_LOG"; "$ADAPTER" account-usage 2>/dev/null || true; }
WANT_ENDED="$(printf 'claude\tsystem\t-\t-\t-\t-\tlogin ended · default config')"
usage >/dev/null; : > "$CURL_LOG"
printf '{"claudeAiOauth":{"accessToken":"tok-secret","refreshToken":"ref-secret","loginEnded":"time_limit"}}' > "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-usage: loginEnded -> login ended row, no stale figures" "$(usage_keep)" "$WANT_ENDED"
eq  "account-usage: loginEnded -> no usage request" "$(cat "$CURL_LOG")" ""
has "account-usage: the cache holds the ended row" "$(cat "$DS_USAGE_CACHE/claude-system.tsv")" "login ended"
printf '{"claudeAiOauth":{"accessToken":"","refreshToken":""}}' > "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-usage: empty tokens -> login ended" "$(usage)" "$WANT_ENDED"
eq  "account-usage: empty tokens -> no usage request" "$(cat "$CURL_LOG")" ""
creds $(( ($(date +%s) + 3600) * 1000 ))
got="$(usage_keep)"
eq  "account-usage: a token again with a fresh cached ended row -> fetched now" "$got" "$(printf 'claude\tsystem\t72\t1893510000\t41\t1900000000')"
has "account-usage: a token again -> the endpoint was called" "$(cat "$CURL_LOG")" "https://api.anthropic.com/api/oauth/usage"
printf '{"claudeAiOauth":{"accessToken":"t","refreshToken":""}}' > "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-usage: an access token and no refresh token is not ended" "$(usage | cut -f1,2)" "$(printf 'claude\tsystem')"
has "account-usage: ... and the endpoint was called" "$(cat "$CURL_LOG")" "oauth/usage"
printf '{"other":1}' > "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-usage: no claudeAiOauth -> unknown, not ended" "$(usage | grep -c 'login ended')" "0"
printf 'not json' > "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-usage: an unreadable file -> not ended" "$(usage | grep -c 'login ended')" "0"
rm -f "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-usage: a missing file -> not ended" "$(usage | grep -c 'login ended')" "0"

rm -f "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-usage: missing token -> unknown"     "$(usage)" "$(printf 'claude\tsystem\t-\t-\t-\t-')"
eq  "account-usage: missing token -> no call"     "$(wc -c < "$CURL_LOG" | tr -d ' ')" "0"
unset FAKE_USAGE_BODY

# account-usage, Muse row: from `muse usage --json`; any failure -> no muse row (unknown, never exhausted).
MUSE_OK='{"allowance":{"tier":"Muse Code Power Usage","window":{"usedPercent":25,"resetsAtMs":1893041361000},"weekly":{"usedPercent":8,"resetsAtMs":1893577600000},"asOfMs":1793031896262,"source":"mint"},"hint":null,"reason":null,"schemaVersion":1}'
musedo() { rm -rf "$DS_USAGE_CACHE"; : > "$MUSE_LOG"; "$ADAPTER" account-usage 2>"$TMP/muse.err" | awk -F'\t' '$1=="muse"'; }
export FAKE_MUSE_RC=0 FAKE_MUSE_OUT="$MUSE_OK"
eq  "account-usage muse: ok -> row with pcts + reset epoch s" "$(musedo)" "$(printf 'muse\tdefault\t25\t1893041361\t8\t1893577600')"
has "account-usage muse: runs 'muse usage --json'"  "$(cat "$MUSE_LOG")" "usage --json"
eq  "account-usage muse: runs in the usage cache folder, not its caller's (U21e)" "$(cat "$MUSE_LOG.cwd")" "$(cd "$DS_USAGE_CACHE" && pwd -P)"
: > "$MUSE_LOG"; "$ADAPTER" account-usage >/dev/null 2>&1 || true
eq  "account-usage muse: cached -> no second call"  "$(wc -c < "$MUSE_LOG" | tr -d ' ')" "0"
FAKE_MUSE_RC=1 eq "account-usage muse: exit 1 -> no row"  "$(FAKE_MUSE_RC=1 musedo)" ""
has "account-usage muse: failure -> one stderr line" "$(cat "$TMP/muse.err")" "muse usage unavailable"
eq  "account-usage muse: server_sent_no_usage -> dash numbers + note" \
    "$(FAKE_MUSE_OUT='{"allowance":null,"hint":"new window","reason":"server_sent_no_usage","schemaVersion":1}' musedo)" "$(printf 'muse\tdefault\t-\t-\t-\t-\tno usage yet in this window')"
eq  "account-usage muse: other reason (null allowance) -> no row" \
    "$(FAKE_MUSE_OUT='{"allowance":null,"reason":"network_error","schemaVersion":1}' musedo)" ""
eq  "account-usage muse: no_allowance -> dash numbers + the generic out-of-credits note (U2)" \
    "$(FAKE_MUSE_OUT='{"allowance":null,"reason":"no_allowance","schemaVersion":1}' musedo)" "$(printf 'muse\tdefault\t-\t-\t-\t-\tout of credits')"
eq  "account-usage muse: bad JSON -> no row"        "$(FAKE_MUSE_OUT='not json' musedo)" ""
eq  "account-usage muse: reason set -> no row"      "$(FAKE_MUSE_OUT="${MUSE_OK/\"reason\":null/\"reason\":\"not_logged_in\"}" musedo)" ""
eq  "account-usage muse: schemaVersion 2 -> no row" "$(FAKE_MUSE_OUT="${MUSE_OK/\"schemaVersion\":1/\"schemaVersion\":2}" musedo)" ""
eq  "account-usage muse: a muse failure keeps the claude rows" \
    "$(FAKE_MUSE_RC=1 bash -c 'rm -rf "$DS_USAGE_CACHE"; "$0" account-usage 2>/dev/null | awk -F"\t" "\$1==\"claude\"" | wc -l | tr -d " "' "$ADAPTER")" "1"
mkdir -p "$TMP/nomuse"; mv "$TMP/muse" "$TMP/nomuse/muse"
eq  "account-usage muse: no muse on PATH -> no row" "$(PATH="$(printf '%s' "$PATH" | tr ':' '\n' | while read -r d; do [ -x "$d/muse" ] || printf '%s:' "$d"; done)" musedo)" ""
mv "$TMP/nomuse/muse" "$TMP/muse"
unset FAKE_MUSE_OUT FAKE_MUSE_RC

# account-resets (account-free-resets U1): the usage call carries cedar_ember=1 + the CLI User-Agent;
# each fetched answer writes claude-<id>.resets.json, and account-resets prints one JSON per account.
creds $(( ($(date +%s) + 3600) * 1000 ))
WIN='"five_hour":{"utilization":72.4,"resets_at":"2030-01-01T15:00:00.123+00:00"},"seven_day":{"utilization":41,"resets_at":1900000000}'
G1='{"id":"full-reset-2611","label":"One full limit reset (November 2026)","resets_total":1,"resets_left":1,"ends_at":"2026-12-10T22:00:00+00:00","clears":["five_hour","seven_day","seven_day_overage_included"],"usable_now":true,"paused":false}'
G2='{"id":"launch-2610-fable","label":"New model launch · one Fable reset","resets_total":1,"resets_left":1,"ends_at":"2027-03-09T07:59:00+00:00","clears":["seven_day_overage_included","seven_day_opus","mystery_window"],"usable_now":true,"paused":true}'
CE_OK="{$WIN,\"cedar_ember\":{\"eligible\":true,\"ineligible_reason\":null,\"grants\":[$G1,$G2]}}"
ROW_OK="$(printf 'claude\tsystem\t72\t1893510000\t41\t1900000000')"
resets() { "$ADAPTER" account-resets 2>/dev/null | awk -F'\t' '$1=="claude" && $2=="system"'; }   # the system row
rjq() { resets | cut -f3 | jq -c "$1"; }   # a jq filter over the system row's JSON   # a jq filter over the system row's JSON
got="$(FAKE_USAGE_BODY="$CE_OK" usage)"
eq  "account-resets: a body with grants leaves the usage row as it is" "$got" "$ROW_OK"
has "account-resets: the usage call asks for the grants" "$(cat "$CURL_LOG")" "oauth/usage?cedar_ember=1&skip_spend=1"
has "account-resets: the usage call presents the CLI User-Agent" "$(head -n1 "$CURL_LOG")" "User-Agent: claude-cli/"
hasnt "account-resets: the old User-Agent is gone" "$(head -n1 "$CURL_LOG")" "claude-code/2.1.0"
eq  "account-resets: three tab columns, the third one JSON" "$(resets | awk -F'\t' '{print NF}')" "3"
eq  "account-resets: two grants -> reported, count 2" "$(rjq '[.state, .count, (.grants | length)]')" '["reported",2,2]'
eq  "account-resets: a grant's id, label, left/total and use-by epoch" "$(rjq '.grants[0] | [.id, .label, .left, .total, .use_by]')" '["full-reset-2611","One full limit reset (November 2026)",1,1,1796940000]'
eq  "account-resets: clears map to the generic refills" "$(rjq '.grants[0].refills')" '["session","weekly","weekly_model"]'
eq  "account-resets: model windows fold into one weekly_model, an unknown window keeps its word" "$(rjq '.grants[1].refills')" '["weekly_model","mystery_window"]'
eq  "account-resets: usable_now true, a paused grant is not usable now" "$(rjq '[.grants[].usable_now]')" '[true,false]'
eq  "account-resets: a non-ASCII label survives" "$(rjq '.grants[1].label')" '"New model launch · one Fable reset"'
eq  "account-resets: Muse reads not_reported" "$("$ADAPTER" account-resets 2>/dev/null | awk -F'\t' '$1=="muse"{print $3}')" '{"state":"not_reported"}'
eq  "account-resets: Codex reads unknown (its read failed, no sidecar)" "$("$ADAPTER" account-resets 2>/dev/null | awk -F'\t' '$1=="codex"{print $3}')" '{"state":"unknown"}'
eq  "account-resets: one line per account-list account" "$("$ADAPTER" account-resets 2>/dev/null | cut -f1,2 | paste -sd' ' -)" "$("$ADAPTER" account-list 2>/dev/null | cut -f1,2 | paste -sd' ' -)"
: > "$CURL_LOG"; "$ADAPTER" account-resets >/dev/null 2>&1
eq  "account-resets: calls no provider" "$(wc -c < "$CURL_LOG" | tr -d ' ')" "0"
# A cached usage row leaves the sidecar alone; a failed fetch (401, 429) keeps the last one.
FAKE_USAGE_BODY="{$WIN}" "$ADAPTER" account-usage >/dev/null 2>&1
eq  "account-resets: a cached usage row leaves the sidecar as it is" "$(rjq '.state')" '"reported"'
touch -d '10 minutes ago' "$DS_USAGE_CACHE/claude-system.tsv"
FAKE_USAGE_CODE=401 FAKE_USAGE_BODY='{}' "$ADAPTER" account-usage >/dev/null 2>&1
eq  "account-resets: a 401 keeps the last sidecar" "$(rjq '[.state, .count]')" '["reported",2]'
touch -d '10 minutes ago' "$DS_USAGE_CACHE/claude-system.tsv"
FAKE_USAGE_CODE=429 FAKE_USAGE_BODY='{}' "$ADAPTER" account-usage >/dev/null 2>&1
eq  "account-resets: a 429 keeps the last sidecar" "$(rjq '[.state, .count]')" '["reported",2]'
# Unknown, never 0: ineligible (a stale User-Agent pin answers `surface`), absent, malformed.
got="$(FAKE_USAGE_BODY="{$WIN,\"cedar_ember\":{\"eligible\":false,\"ineligible_reason\":\"surface\",\"grants\":[]}}" usage)"
eq  "account-resets: eligible:false keeps the usage row" "$got" "$ROW_OK"
eq  "account-resets: eligible:false surface -> unknown with that reason" "$(rjq '[.state, .reason, .count]')" '["unknown","surface",null]'
got="$(FAKE_USAGE_BODY="{$WIN}" usage)"
eq  "account-resets: no cedar_ember -> the usage row byte for byte" "$got" "$ROW_OK"
eq  "account-resets: no cedar_ember -> unknown" "$(rjq '.state')" '"unknown"'
got="$(FAKE_USAGE_BODY="{$WIN,\"cedar_ember\":{\"eligible\":true,\"grants\":{\"id\":\"x\"}}}" usage)"
eq  "account-resets: grants not a list keeps the usage row" "$got" "$ROW_OK"
eq  "account-resets: grants not a list -> unknown, malformed" "$(rjq '[.state, .reason]')" '["unknown","malformed"]'
got="$(FAKE_USAGE_BODY="{$WIN,\"cedar_ember\":{\"eligible\":true,\"grants\":[{\"label\":\"no id\"}]}}" usage)"
eq  "account-resets: a grant with no id -> unknown, malformed" "$(rjq '[.state, .reason]')" '["unknown","malformed"]'
got="$(FAKE_USAGE_BODY="{$WIN,\"cedar_ember\":{\"eligible\":true,\"grants\":[]}}" usage)"
eq  "account-resets: an empty grant list -> reported, count 0" "$(rjq '[.state, .count, .grants]')" '["reported",0,[]]'
rm -rf "$DS_USAGE_CACHE"
eq  "account-resets: no sidecar yet -> unknown" "$(resets | cut -f3)" '{"state":"unknown"}'
mkdir -p "$DS_USAGE_CACHE"; printf 'not json' > "$DS_USAGE_CACHE/claude-system.resets.json"
eq  "account-resets: an unreadable sidecar -> unknown" "$(resets | cut -f3)" '{"state":"unknown"}'
printf '{"state":"plenty"}' > "$DS_USAGE_CACHE/claude-system.resets.json"
eq  "account-resets: a sidecar with an unknown state -> unknown" "$(resets | cut -f3)" '{"state":"unknown"}'
: > "$CURL_LOG"; DS_CLAUDE_CLI_UA='claude-cli/9.9.9 (external, cli)' FAKE_USAGE_BODY="$CE_OK" usage >/dev/null
has "account-resets: DS_CLAUDE_CLI_UA replaces the pinned User-Agent" "$(head -n1 "$CURL_LOG")" "User-Agent: claude-cli/9.9.9 (external, cli)"
rm -rf "$DS_USAGE_CACHE"

# account-usage, Codex row (account-free-resets U2): one `codex app-server` JSON-RPC read, cached like the
# Claude rows; a window of up to 300 minutes is the session column, a longer one the weekly column. The
# same answer writes codex-default.resets.json for account-resets. Any failure: no row, resets unknown.
creds $(( ($(date +%s) + 3600) * 1000 )); export FAKE_USAGE_BODY="{$WIN}"
codexdo() { rm -rf "$DS_USAGE_CACHE"; : > "$CODEX_LOG"; "$ADAPTER" account-usage 2>"$TMP/codex.err" | awk -F'\t' '$1=="codex"'; }
cxres() { "$ADAPTER" account-resets 2>/dev/null | awk -F'\t' '$1=="codex"{print $3}'; }
cxjq() { cxres | jq -c "$1"; }
CX_W='"rateLimits":{"limitId":"codex","primary":{"usedPercent":12,"windowDurationMins":300,"resetsAt":1900000000},"secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1900500000},"credits":{"hasCredits":false,"unlimited":false,"balance":null},"planType":"plus"}'
CX_C1='{"id":"rc_1","title":"One free reset","description":"Launch gift","grantedAt":1790000000,"expiresAt":1796940000,"resetType":"codexRateLimits","status":"available"}'
CX_C2='{"id":"rc_2","title":null,"description":null,"grantedAt":1790000000,"expiresAt":null,"resetType":"futureType","status":"redeeming"}'
export FAKE_CODEX_MODE=ok FAKE_CODEX_OUT="{$CX_W,\"rateLimitResetCredits\":{\"availableCount\":2,\"credits\":[$CX_C1,$CX_C2]}}"
eq  "account-usage codex: a 300-min and a 10080-min window fill session and weekly" "$(codexdo)" "$(printf 'codex\tdefault\t12\t1900000000\t40\t1900500000')"
has "account-usage codex: runs 'codex app-server'" "$(cat "$CODEX_LOG")" "argv app-server"
has "account-usage codex: its cwd is the usage cache dir, never a role worktree" "$(cat "$CODEX_LOG")" "cwd $DS_USAGE_CACHE"
eq  "account-usage codex: initialize, initialized, then account/rateLimits/read" \
    "$(grep '^{' "$CODEX_LOG" | jq -r '.method' | paste -sd' ' -)" "initialize initialized account/rateLimits/read"
hasnt "account-usage codex: the app-server's stderr is dropped" "$(cat "$TMP/codex.err")" "bubblewrap"
eq  "account-usage codex: the Claude row is unchanged" "$("$ADAPTER" account-usage 2>/dev/null | awk -F'\t' '$1=="claude"')" "$ROW_OK"
: > "$CODEX_LOG"; "$ADAPTER" account-usage >/dev/null 2>&1
eq  "account-usage codex: a second call inside the TTL spawns no process" "$(wc -c < "$CODEX_LOG" | tr -d ' ')" "0"
eq  "account-resets codex: two credits -> reported, count 2" "$(cxjq '[.state, .count, (.grants | length)]')" '["reported",2,2]'
eq  "account-resets codex: a credit's id, label, left/total and use-by" "$(cxjq '.grants[0] | [.id, .label, .left, .total, .use_by]')" '["rc_1","One free reset",1,1,1796940000]'
eq  "account-resets codex: codexRateLimits refills both windows, an unknown type keeps its word" "$(cxjq '[.grants[].refills]')" '[["session","weekly"],["futureType"]]'
eq  "account-resets codex: available is usable now, redeeming is not; no expiry -> no use-by" "$(cxjq '[.grants[].usable_now, .grants[1].use_by, .grants[1].label]')" '[true,false,null,"rc_2"]'
got="$(FAKE_CODEX_OUT='{"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":43200,"resetsAt":1796564344},"secondary":null},"rateLimitResetCredits":{"availableCount":0,"credits":[]}}' codexdo)"
eq  "account-usage codex: one 43200-min window fills weekly only" "$got" "$(printf 'codex\tdefault\t-\t-\t100\t1796564344')"
eq  "account-resets codex: availableCount 0 -> reported, count 0" "$(cxjq '[.state, .count, .grants]')" '["reported",0,[]]'
FAKE_CODEX_OUT="{$CX_W,\"rateLimitResetCredits\":{\"availableCount\":3,\"credits\":null}}" codexdo >/dev/null
eq  "account-resets codex: credits null with a count -> that count, an empty list" "$(cxjq '[.state, .count, .grants]')" '["reported",3,[]]'
FAKE_CODEX_OUT="{$CX_W,\"rateLimitResetCredits\":null}" codexdo >/dev/null
eq  "account-resets codex: no rateLimitResetCredits -> unknown" "$(cxjq '.state')" '"unknown"'
FAKE_CODEX_OUT="{$CX_W,\"rateLimitResetCredits\":{\"availableCount\":1,\"credits\":[{\"title\":\"no id\"}]}}" codexdo >/dev/null
eq  "account-resets codex: a credit with no id -> unknown, malformed" "$(cxjq '[.state, .reason]')" '["unknown","malformed"]'
# Failures: no row (`-` in accounts.tsv), resets unknown, and the call returns.
for m in exit error; do
  eq  "account-usage codex: $m -> no codex row" "$(FAKE_CODEX_MODE=$m codexdo)" ""
  eq  "account-resets codex: $m -> unknown" "$(cxjq '.state')" '"unknown"'
  eq  "account-usage codex: $m keeps the claude row" "$(FAKE_CODEX_MODE=$m "$ADAPTER" account-usage 2>/dev/null | awk -F'\t' '$1=="claude"')" "$ROW_OK"
done
has "account-usage codex: a failure -> one stderr line" "$(FAKE_CODEX_MODE=error codexdo >/dev/null; cat "$TMP/codex.err")" "codex usage unavailable"
rm -f "$CODEX_LOG.pid"; t0=$(date +%s)
got="$(DS_CODEX_USAGE_TIMEOUT_S=2 FAKE_CODEX_MODE=hang codexdo)"; t1=$(date +%s)
eq  "account-usage codex: a hang past the timeout -> no codex row" "$got" ""
eq  "account-usage codex: a hang returns within the timeout plus a margin" "$(( t1 - t0 <= 6 ))" "1"
eq  "account-resets codex: a hang -> unknown" "$(cxjq '.state')" '"unknown"'
sleep 1; hpid="$(cat "$CODEX_LOG.pid" 2>/dev/null || echo none)"
eq  "account-usage codex: the hung app-server is killed" "$(kill -0 "$hpid" 2>/dev/null && echo alive || echo gone)" "gone"
mkdir -p "$TMP/nocodex"; mv "$TMP/codex" "$TMP/nocodex/codex"
eq  "account-usage codex: no codex on PATH -> no row" "$(PATH="$(printf '%s' "$PATH" | tr ':' '\n' | while read -r d; do [ -x "$d/codex" ] || printf '%s:' "$d"; done)" codexdo)" ""
eq  "account-resets codex: no codex on PATH -> unknown" "$(cxjq '.state')" '"unknown"'
mv "$TMP/nocodex/codex" "$TMP/codex"
# A failed read after a good one keeps the good figures (noted stale@<time>) and the last resets.
codexdo >/dev/null; touch -d '10 minutes ago' "$DS_USAGE_CACHE/codex-default.tsv"; good_at="$(stat -c %Y "$DS_USAGE_CACHE/codex-default.tsv")"
got="$(FAKE_CODEX_MODE=error "$ADAPTER" account-usage 2>/dev/null | awk -F'\t' '$1=="codex"')"
eq  "account-usage codex: a failure after a good read keeps the figures, noted stale@<time>" "$got" "$(printf 'codex\tdefault\t12\t1900000000\t40\t1900500000\tstale@%s' "$good_at")"
eq  "account-resets codex: a failure after a good read keeps the last resets" "$(cxjq '[.state, .count]')" '["reported",2]'
touch -d '2 minutes ago' "$DS_USAGE_CACHE/codex-default.tsv"; : > "$CODEX_LOG"; "$ADAPTER" account-usage >/dev/null 2>&1
has "account-usage codex: a stale row is retried after DS_USAGE_FAIL_TTL_S" "$(cat "$CODEX_LOG")" "argv app-server"
# Each account is read from its own folder (issue #125 U2): a dev-studio Claude account's token, and a second
# Codex account's app-server under its CODEX_HOME with its own cache file. No orca CLI is needed.
mkdir -p "$TMP/ds-claude" "$TMP/ds-codex" "$TMP/nocli"
cp "$DS_CLAUDE_HOME/.credentials.json" "$TMP/ds-claude/"; rm "$DS_CLAUDE_HOME/.credentials.json"
bun "$ROOT/tests/lib/accounts-table.ts" "$DS_STATE_ROOT" \
  claude dsA "A" ds "$TMP/ds-claude" 0 codex default "codex" system - 1 codex work "Work" ds "$TMP/ds-codex" 0
: > "$ORCA_LOG"; : > "$CODEX_LOG"; rm -rf "$DS_USAGE_CACHE"
got="$(DS_ORCA_CLI_BIN_DIR="$TMP/nocli" "$ADAPTER" account-usage 2>/dev/null || true)"
eq  "account-usage: a ds Claude account's own credentials file" "$(printf '%s\n' "$got" | awk -F'\t' '$2=="dsA"{print $3}')" "72"
eq  "account-usage: one row per Codex account" "$(printf '%s\n' "$got" | awk -F'\t' '$1=="codex"{printf "%s ", $2}')" "default work "
has "account-usage codex: the second account's app-server runs under its folder" "$(cat "$CODEX_LOG")" "home $TMP/ds-codex"
eq  "account-usage codex: each account has its own cache files" "$(cd "$DS_USAGE_CACHE" && printf '%s ' codex-*)" "codex-default.resets.json codex-default.tsv codex-work.resets.json codex-work.tsv "
eq  "account-usage: Orca is not asked" "$(cat "$ORCA_LOG")" ""
eq  "account-resets: a row for each Codex account" "$(DS_ORCA_CLI_BIN_DIR="$TMP/nocli" "$ADAPTER" account-resets 2>/dev/null | awk -F'\t' '$1=="codex"{printf "%s ", $2}')" "default work "
cp "$TMP/ds-claude/.credentials.json" "$DS_CLAUDE_HOME/"
bun "$ROOT/tests/lib/accounts-table.ts" "$DS_STATE_ROOT"
unset FAKE_CODEX_MODE FAKE_CODEX_OUT FAKE_USAGE_BODY
rm -rf "$DS_USAGE_CACHE"

# account-reset-use (account-free-resets U4): one redeem of a free reset, played by the fake curl (Claude)
# and the fake codex app-server; no test reaches a real provider. HOME is the temp dir, so the host's own
# ~/.claude.json is never read. "<outcome>\t<detail>" exit 0 on an answer, exit 1 and no line on none.
ruse() { HOME="$TMP" "$ADAPTER" account-reset-use "$@" 2>"$TMP/ruse.err"; }
seedcache() { mkdir -p "$DS_USAGE_CACHE"; printf '1\t2\t3\t4' > "$DS_USAGE_CACHE/$1.tsv"; printf '{"state":"reported"}' > "$DS_USAGE_CACHE/$1.resets.json"; }
cached() { [ -f "$DS_USAGE_CACHE/$1.tsv" ] && [ -f "$DS_USAGE_CACHE/$1.resets.json" ] && echo kept || echo dropped; }
creds $(( ($(date +%s) + 3600) * 1000 ))
printf '{"oauthAccount":{"organizationUuid":"org-1234"}}' > "$DS_CLAUDE_HOME/.claude.json"
: > "$CURL_LOG"; seedcache claude-system
rc=0; got="$(FAKE_USAGE_BODY='{"result":"reset","reason":null,"resets_left":0,"cleared":["five_hour"]}' ruse claude system full-reset-2611 key-abc)" || rc=$?
eq  "account-reset-use claude: reset -> used, resets left" "$got" "$(printf 'used\tresets left 0')"
eq  "account-reset-use claude: an answer exits 0" "$rc" "0"
has "account-reset-use claude: POSTs to the org's reset_rate_limits" "$(head -n1 "$CURL_LOG")" "-X POST"
has "account-reset-use claude: the org's endpoint" "$(cat "$CURL_LOG")" "https://api.anthropic.com/api/organizations/org-1234/reset_rate_limits"
has "account-reset-use claude: body names the program, grant and the key as request_id" "$(head -n1 "$CURL_LOG")" '{"program":"cedar_ember","grant_id":"full-reset-2611","request_id":"key-abc"}'
has "account-reset-use claude: presents the CLI User-Agent" "$(head -n1 "$CURL_LOG")" "User-Agent: claude-cli/"
has "account-reset-use claude: token on stdin" "$(tail -n1 "$CURL_LOG")" 'header = "Authorization: Bearer tok-secret"'
hasnt "account-reset-use claude: token never in argv" "$(sed '$d' "$CURL_LOG")" "tok-secret"
eq  "account-reset-use claude: used drops the account's usage and resets caches" "$(cached claude-system)" "dropped"
for pair in already_used:already_used unavailable:no_grant not_limited:nothing_to_reset; do
  seedcache claude-system
  got="$(FAKE_USAGE_BODY="{\"result\":\"${pair%%:*}\",\"reason\":\"why\"}" ruse claude system g1 k1)"
  eq  "account-reset-use claude: ${pair%%:*} -> ${pair#*:}" "$got" "$(printf '%s\twhy' "${pair#*:}")"
done
eq  "account-reset-use claude: nothing_to_reset keeps the caches" "$(cached claude-system)" "kept"
got="$(FAKE_USAGE_BODY='{"result":"cooldown","reason":"cooldown"}' ruse claude system g1 k1)"
eq  "account-reset-use claude: another result -> failed with its words" "$got" "$(printf 'failed\tcooldown: cooldown')"
seedcache claude-system
rc=0; got="$(FAKE_USAGE_CODE=403 FAKE_USAGE_BODY='{"error":"forbidden"}' ruse claude system g1 k1)" || rc=$?
eq  "account-reset-use claude: HTTP 403 -> failed with the code and body" "$got" "$(printf 'failed\tHTTP 403: {"error":"forbidden"}')"
eq  "account-reset-use claude: HTTP 403 exits 0 (an answer)" "$rc" "0"
eq  "account-reset-use claude: a failure keeps the caches" "$(cached claude-system)" "kept"
got="$(FAKE_USAGE_CODE=500 FAKE_USAGE_BODY='oops' ruse claude system g1 k1)"
eq  "account-reset-use claude: HTTP 500 -> failed" "$got" "$(printf 'failed\tHTTP 500: oops')"
got="$(FAKE_USAGE_BODY='not json' ruse claude system g1 k1)"
eq  "account-reset-use claude: an unreadable 200 -> failed" "$got" "$(printf 'failed\tunreadable answer: not json')"
rc=0; got="$(FAKE_USAGE_CODE=xyz FAKE_USAGE_BODY='' ruse claude system g1 k1)" || rc=$?
eq  "account-reset-use claude: no answer -> no outcome line" "$got" ""
eq  "account-reset-use claude: no answer exits 1" "$rc" "1"
has "account-reset-use claude: no answer says retry with the same key" "$(cat "$TMP/ruse.err")" "retry with the same key"
: > "$CURL_LOG"; rm -f "$DS_CLAUDE_HOME/.claude.json"
eq  "account-reset-use claude: no organization -> failed, no call" "$(ruse claude system g1 k1)$(wc -c < "$CURL_LOG" | tr -d ' ')" "$(printf 'failed\tno organization in .claude.json0')"
printf '{"oauthAccount":{"organizationUuid":"org-1234"}}' > "$DS_CLAUDE_HOME/.claude.json"
creds $(( ($(date +%s) - 60) * 1000 ))
eq  "account-reset-use claude: expired login -> failed, no call" "$(ruse claude system g1 k1)$(wc -c < "$CURL_LOG" | tr -d ' ')" "$(printf 'failed\tlogin expired0')"
rm -f "$DS_CLAUDE_HOME/.credentials.json"
eq  "account-reset-use claude: no token -> failed, no call" "$(ruse claude system g1 k1)$(wc -c < "$CURL_LOG" | tr -d ' ')" "$(printf 'failed\tno login token0')"
creds $(( ($(date +%s) + 3600) * 1000 ))
eq  "account-reset-use: a bad key is refused before any call" "$(ruse claude system g1 'k 1')$(wc -c < "$CURL_LOG" | tr -d ' ')" "$(printf 'failed\tbad key0')"
eq  "account-reset-use: a bad account id is refused" "$(ruse claude '../x' g1 k1)" "$(printf 'failed\tbad account id')"
eq  "account-reset-use: muse has none" "$(ruse muse default g1 k1)" "$(printf 'failed\tmuse has no free resets')"
rc=0; ruse claude system g1 >/dev/null || rc=$?; eq "account-reset-use: wrong arity exits 2" "$rc" "2"
# Codex: account/rateLimitResetCredit/consume with the credit id and the key as idempotencyKey.
export FAKE_CODEX_MODE=ok
: > "$CODEX_LOG"; seedcache codex-default
got="$(FAKE_CODEX_OUT='{"outcome":"reset"}' ruse codex default rc_1 key-xyz)"
eq  "account-reset-use codex: reset -> used" "$got" "$(printf 'used\t')"
eq  "account-reset-use codex: initialize, initialized, then the consume call" "$(grep '^{' "$CODEX_LOG" | jq -r '.method' | paste -sd' ' -)" "initialize initialized account/rateLimitResetCredit/consume"
eq  "account-reset-use codex: the credit id and the key" "$(grep '"id":2' "$CODEX_LOG" | jq -c '.params')" '{"creditId":"rc_1","idempotencyKey":"key-xyz"}'
eq  "account-reset-use codex: used drops the caches" "$(cached codex-default)" "dropped"
for pair in nothingToReset:nothing_to_reset noCredit:no_grant alreadyRedeemed:already_used; do
  got="$(FAKE_CODEX_OUT="{\"outcome\":\"${pair%%:*}\"}" ruse codex default rc_1 k1)"
  eq  "account-reset-use codex: ${pair%%:*} -> ${pair#*:}" "$got" "$(printf '%s\t' "${pair#*:}")"
done
eq  "account-reset-use codex: an unknown outcome -> failed" "$(FAKE_CODEX_OUT='{"outcome":"maybe"}' ruse codex default rc_1 k1)" "$(printf 'failed\tunexpected outcome "maybe"')"
eq  "account-reset-use codex: a JSON-RPC error -> failed with its message" "$(FAKE_CODEX_MODE=error ruse codex default rc_1 k1)" "$(printf 'failed\tnot logged in')"
rc=0; got="$(FAKE_CODEX_MODE="exit" ruse codex default rc_1 k1)" || rc=$?
eq  "account-reset-use codex: no answer -> exit 1, no line" "$got:$rc" ":1"
unset FAKE_CODEX_MODE
rm -rf "$DS_USAGE_CACHE" "$DS_CLAUDE_HOME/.claude.json"

# limited: idle/done SILENT_MIN+ with a limit notice on screen -> "<wt>\t<reset epoch|->\t<notice>".
LN=1792144800; since=$(( (LN - 900) * 1000 ))
lps() { printf '{"result":{"worktrees":[{"worktreeId":"repo1::/p/lead","displayName":"l","agents":[{"state":"%s","stateStartedAt":%s}]}]}}' "$1" "$2"; }
want_reset="$(date -d "$(date -d "@$((LN - 900))" +%F) 15:00" +%s)"; [ "$want_reset" -gt $((LN - 900)) ] || want_reset=$((want_reset + 86400))
# U107: the worker's agent comes from agent-accounts' source ($DS_PROC). lim_as <agent|none> makes the
# worker's worktree /p/lead run that agent; none = no agent process there (an unknown agent).
LP="$TMP/limproc"
lim_as() {
  rm -rf "$LP"; mkdir -p "$LP"
  [ "$1" = none ] && return 0
  mkdir -p "$LP/501"; printf '%s\n' "$1" > "$LP/501/comm"; printf '501 (%s) S 1 1 1\n' "$1" > "$LP/501/stat"; ln -s /p/lead "$LP/501/cwd"
  [ "$1" != claude ] || : > "$LP/501/environ"
}
lim_as none
lim() { DS_PROC="$LP" ORCA_PS_PRIMARY="$(lps "$1" "$2")" DS_NOW=$LN "$ADAPTER" limited 2>/dev/null || true; }
eq  "limited: idle 15 min + notice -> row with parsed reset" "$(lim idle $since)" "$(printf 'repo1::/p/lead\t%s\t5-hour limit reached ∙ resets 3pm' "$want_reset")"
ORCA_SCREEN="$(cat "$ROOT/tests/fixtures/loop/screens/muse-limit.txt")"; export ORCA_SCREEN
eq "U107: a Muse notice on an unknown-agent worker -> nothing" "$(lim idle $since)" ""
lim_as claude
eq "U107: a Muse notice quoted on a claude worker -> nothing" "$(lim idle $since)" ""
lim_as codex
eq "U107: a Muse notice on a codex worker -> nothing" "$(lim idle $since)" ""
# U149: agent-accounts' two line shapes: the main's long line (here a stat without start or RSS
# fields, so "-") and a sub line for a `claude -p` beside it; limited still finds the main's agent.
mkdir -p "$LP/502"; printf 'claude\n' > "$LP/502/comm"; printf '502 (claude) S 501 1 1\n' > "$LP/502/stat"; ln -s /p/lead/sub "$LP/502/cwd"
: > "$LP/502/environ"; printf 'claude\0--model\0sonnet\0-p\0' > "$LP/502/cmdline"
eq "U149: agent-accounts prints a main line and a sub line" "$(DS_PROC="$LP" "$ADAPTER" agent-accounts | sort)" \
  "$(printf '/p/lead\tmain\tcodex\t-\tdefault\t-\t501\t-\t-\n/p/lead/sub\tsub\tclaude\tsonnet\tsystem')"
eq "U149: a sub line beside a codex main leaves it a codex worker" "$(lim idle $since)" ""
# U152: a Muse Builder runs as its versioned binary, and review-unit.sh's `codex exec` runs under it
# (and detached): the muse is the worktree's main, each codex exec a sub line, never a main.
MP="$TMP/museproc"; rm -rf "$MP"; mkdir -p "$MP/601" "$MP/602" "$MP/603" "$MP/604"
printf 'muse-bin-1.4.14\n' > "$MP/601/comm"; printf '601 (muse-bin-1.4.14) S 1 1 1\n' > "$MP/601/stat"; ln -s /p/b29 "$MP/601/cwd"; printf 'muse\0' > "$MP/601/cmdline"
printf 'bash\n' > "$MP/602/comm"; printf '602 (bash) S 601 1 1\n' > "$MP/602/stat"; ln -s /p/b29 "$MP/602/cwd"
printf 'codex\n' > "$MP/603/comm"; printf '603 (codex) S 602 1 1\n' > "$MP/603/stat"; ln -s /p/b29 "$MP/603/cwd"; printf 'codex\0exec\0--model\0gpt-5\0' > "$MP/603/cmdline"
printf 'codex\n' > "$MP/604/comm"; printf '604 (codex) S 1 1 1\n' > "$MP/604/stat"; ln -s /p/b7 "$MP/604/cwd"; printf 'codex\0exec\0review\0' > "$MP/604/cmdline"
eq "U152: a Muse main with a codex exec under it and one detached -> one main, two subs" "$(DS_PROC="$MP" "$ADAPTER" agent-accounts | sort)" \
  "$(printf '/p/b29\tmain\tmuse\t-\tdefault\t-\t601\t-\t-\n/p/b29\tsub\tcodex\tgpt-5\tdefault\n/p/b7\tsub\tcodex\t-\tdefault')"
lim_as muse
eq "limited: Muse wrapped notice -> Nov 9 at 1am in host zone" "$(lim idle $since | cut -f2)" "$(date -d '2026-11-09 01:00' +%s)"
ORCA_SCREEN="Example: $ORCA_SCREEN"; export ORCA_SCREEN
eq "limited: Muse notice quoted in prose -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN=$'FAIL: rate limit exceeded in test_gas\nError: gas limit exceeded\n❯' ; export ORCA_SCREEN
eq  "limited: 'rate limit exceeded' in output is not a limit" "$(lim idle $since)" ""
ORCA_SCREEN=$'❯ dev-studio sweep: you went quiet with unread messages. Check your inbox now.' ; export ORCA_SCREEN
eq  "limited: the sweep's own poke text is not a limit"      "$(lim idle $since)" ""
lim_as claude
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\n• dev-studio loop: you went quiet with unread messages.'; export ORCA_SCREEN
eq  "limited: loop poke after a notice leaves the limit visible" "$(lim idle $since)" "$(printf 'repo1::/p/lead\t%s\t5-hour limit reached ∙ resets 3pm' "$want_reset")"
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\n● Reviewed dev-studio loop: wake text.'; export ORCA_SCREEN
eq  "limited: assistant entry mentioning the loop clears the notice" "$(lim idle $since)" ""
ORCA_SCREEN=$'  ⎿  Claude usage limit reached. Try again later.' ; export ORCA_SCREEN
eq  "limited: no clock time -> reset '-'"         "$(lim idle $since | cut -f2)" "-"
lim_as none
ORCA_SCREEN="■ You've hit your usage limit. Try again later."; export ORCA_SCREEN
eq "U107: a Codex notice on an unknown-agent worker -> nothing" "$(lim idle $since)" ""
lim_as claude
eq "U107: a Codex notice quoted on a claude worker -> nothing" "$(lim idle $since)" ""
lim_as muse
eq "U107: a Codex notice on a muse worker -> nothing" "$(lim idle $since)" ""
lim_as codex
eq "Codex usage limit has unknown reset" "$(lim idle $since)" "$(printf 'repo1::/p/lead\t-\t%s' "You've hit your usage limit. Try again later.")"
ORCA_SCREEN='■ unexpected status 429 Too Many Requests'; export ORCA_SCREEN
eq "Codex Azure 429 is limited" "$(lim idle $since | cut -f1)" "repo1::/p/lead"
ORCA_SCREEN=$'■ unexpected status 429 Too Many Requests\n• Continuing'; export ORCA_SCREEN
eq "Codex continuing clears its old error" "$(lim idle $since)" ""
# A billing error is kind `credits`: row `<wt> - <notice> - credits` (4th field `-`, no reset), at once on an
# idle worker (1 min), on its own agent's worker only, and gone once the agent wrote on.
CRD="$ROOT/tests/fixtures/credits"
lim_as muse
ORCA_SCREEN="$(cat "$CRD/muse-402-a.txt")"; export ORCA_SCREEN
got="$(lim idle $(( (LN - 60) * 1000 )))"
eq "credits: Muse 402 on an idle worker -> row, no reset, 5th field credits" "$(printf '%s' "$got" | cut -f1,2,4,5)" "$(printf 'repo1::/p/lead\t-\t-\tcredits')"
eq "credits: the notice is the error line" "$(printf '%s' "$got" | cut -f3 | cut -c1-32)" "model failed: API error 402 [req"
eq "credits: Muse 402 on a working worker with recent output -> nothing" "$(ORCA_ACT_MS=$(( (LN - 60) * 1000 )) lim working $since)" ""
ORCA_SCREEN="$(cat "$CRD/muse-prose-after.txt")"; export ORCA_SCREEN
eq "credits: Muse output after the error -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN="$(cat "$CRD/muse-quoted.txt")"; export ORCA_SCREEN
eq "credits: Muse prose quoting the error -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN="$(cat "$CRD/muse-402-a.txt")"; export ORCA_SCREEN
lim_as claude
eq "credits: a Muse 402 on a claude worker -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN="$(cat "$CRD/claude-402.txt")"; export ORCA_SCREEN
eq "credits: Claude 402 -> credits row" "$(lim idle $since | cut -f2,4,5)" "$(printf -- '-\t-\tcredits')"
ORCA_SCREEN="$(cat "$CRD/claude-quoted.txt")"; export ORCA_SCREEN
eq "credits: a grep result quoting the 402 line -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN="$(cat "$CRD/claude-login.txt")"; export ORCA_SCREEN
eq "login: Claude '· Please run /login' -> login row, no reset" "$(lim idle $since | cut -f2,4,5)" "$(printf -- '-\t-\tlogin')"
ORCA_SCREEN="$(cat "$CRD/claude-login-after.txt")"; export ORCA_SCREEN
eq "login: output after the line -> nothing" "$(lim idle $since)" ""
lim_as muse
ORCA_SCREEN="$(cat "$CRD/claude-login.txt")"; export ORCA_SCREEN
eq "login: a Claude login line on a muse worker -> nothing" "$(lim idle $since)" ""
lim_as claude
lim_as codex
ORCA_SCREEN="$(cat "$CRD/codex-quota.txt")"; export ORCA_SCREEN
eq "credits: Codex insufficient_quota -> credits row" "$(lim idle $since | cut -f2,4,5)" "$(printf -- '-\t-\tcredits')"
lim_as none
unset ORCA_SCREEN
eq  "limited: done counts too"                    "$(lim "done" $since | cut -f1)" "repo1::/p/lead"
eq  "limited: idle only 1 min -> nothing"         "$(lim idle $(( (LN - 60) * 1000 )))" ""
# Weekly notice: the qualifier between "your" and "limit" must match, and the dated reset is
# read in the zone the notice names (expectation computed under TZ=Europe/Berlin, not the host's).
ORCA_SCREEN=$'  ⎿  You\'ve hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)\nWhat do you want to do?' ; export ORCA_SCREEN
want_weekly="$(TZ=Europe/Berlin date -d '2026-10-31 20:00' +%s)"
eq  "limited: weekly notice -> row with tz-aware dated reset" "$(lim idle $since)" "$(printf 'repo1::/p/lead\t%s\tYou'\''ve hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)' "$want_weekly")"
ORCA_SCREEN=$'  ⎿  You\'ve hit your weekly limit · resets Oct 31, 8:30pm (Europe/Berlin)' ; export ORCA_SCREEN
eq  "limited: dated reset with minutes -> 20:30 Berlin" "$(lim idle $since | cut -f2)" "$(TZ=Europe/Berlin date -d '2026-10-31 20:30' +%s)"
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets at 15:00' ; export ORCA_SCREEN
eq  "limited: 24h 'resets at 15:00' -> parsed reset" "$(lim idle $since | cut -f2)" "$want_reset"
ORCA_SCREEN=$'  ⎿  You\'ve hit your weekly limit · resets Oct 31, 8pm (America/Argentina/Buenos_Aires)' ; export ORCA_SCREEN
eq  "limited: multi-segment zone -> read in that zone" "$(lim idle $since | cut -f2)" "$(TZ=America/Argentina/Buenos_Aires date -d '2026-10-31 20:00' +%s)"
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 5 hours from now' ; export ORCA_SCREEN
eq  "limited: a bare hour is no clock time -> reset '-'" "$(lim idle $since | cut -f2)" "-"
unset ORCA_SCREEN
# Dialog state: `working` on screen, but no terminal output for SILENT_MIN+ (its last output
# anchors the reset, so with the activity at the idle `since` the reset is the same as idle's).
export ORCA_ACT_MS=$(( (LN - 900) * 1000 ))
eq  "limited: working, no output 15 min (dialog) -> row" "$(lim working $since)" "$(printf 'repo1::/p/lead\t%s\t5-hour limit reached ∙ resets 3pm' "$want_reset")"
# A genuinely active agent (recent output) never counts, even with a 429 on screen.
export ORCA_ACT_MS=$(( (LN - 60) * 1000 ))
eq  "limited: a working agent with recent output -> nothing" "$(lim working $since)" ""
ORCA_SCREEN=$'  ⎿  API Error: 429 usage limit, resets at 15:00' ; export ORCA_SCREEN
eq  "limited: active working agent with a 429 -> nothing"    "$(lim working $since)" ""
# U11 dialog waiver: notice + at least two dialog options in the last 12 lines proves stuck,
# so a working agent with RECENT output still counts, flagged `dialog` in field 4.
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n2. Wait here' ; export ORCA_SCREEN
eq  "limited: working+dialog with recent output -> row flagged dialog" "$(lim working $since)" "$(printf 'repo1::/p/lead\t%s\t5-hour limit reached ∙ resets 3pm\tdialog' "$want_reset")"
ORCA_SCREEN=$'What do you want to do?\n1. Stop and wait\n2. Wait here\n3. Add funds' ; export ORCA_SCREEN
eq  "limited: dialog words without a notice -> nothing" "$(lim working $since)" ""
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nf1\nf2\nf3\nf4\nf5\nf6\nf7\nf8\nf9\nf10\nWhat do you want to do?\n1. Stop and wait\n2. Wait here' ; export ORCA_SCREEN
eq  "limited: notice scrolled beyond last 12 lines -> nothing" "$(lim working $since)" ""
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?' ; export ORCA_SCREEN
eq  "limited: notice + only one dialog line -> nothing (recent)" "$(lim working $since)" ""
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait' ; export ORCA_SCREEN
eq  "limited: header + one numbered option -> nothing (recent)" "$(lim working $since)" ""
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nquoted: What do you want to do? 1. Stop and wait 2. Wait here 3. Add funds' ; export ORCA_SCREEN
eq  "limited: dialog strings quoted on one line -> nothing (recent)" "$(lim working $since)" ""
# Dialog rows do not roll an undated reset forward: last output after 11am, dialog still up.
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 11am\nWhat do you want to do?\n1. Stop and wait\n2. Wait here' ; export ORCA_SCREEN
eq  "limited: dialog row keeps past undated reset (no roll-forward)" "$(lim working $since | cut -f2)" "$(date -d '2026-10-16 11:00' +%s)"
ORCA_SCREEN=$'  ⎿  You\'ve hit your weekly limit · resets Oct 15, 8pm (Europe/Berlin)\nWhat do you want to do?\n1. Stop and wait\n2. Wait here' ; export ORCA_SCREEN
eq  "limited: dialog row keeps past dated reset (no year roll)" "$(lim working $since | cut -f2)" "$(TZ=Europe/Berlin date -d '2026-10-15 20:00' +%s)"
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n2. Wait here\n⏺ ordinary output after' ; export ORCA_SCREEN
eq  "limited: dialog followed by output -> nothing (recent)" "$(lim working $since)" ""
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n1. Stop and wait' ; export ORCA_SCREEN
eq  "limited: duplicated option -> nothing (recent)" "$(lim working $since)" ""
# U15 real dialog: verbatim screen tails of two live limit dialogs (acme builders u22/u69,
# 30 Oct) — options run on past the short prefixes, ❯ sits on option 1, a footer follows.
want_wk="$(TZ=Europe/Berlin date -d '2026-10-31 21:00' +%s)"
WK="You've hit your weekly limit · resets Oct 31, 9pm (Europe/Berlin)"
for u in u22 u69; do
  ORCA_SCREEN="$(cat "$ROOT/tests/fixtures/limit-dialog-$u.txt")" ; export ORCA_SCREEN
  eq  "limited: real dialog ($u), recent output -> dialog row with weekly reset" "$(lim working $since)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_wk" "$WK")"
done
eq  "limited: real dialog, idle 15 min -> flagged dialog too" "$(lim idle $since | cut -f4)" "dialog"
# U40: the real screen of 2 Nov (option 3 renamed; the second in a narrow pane), on an idle worker
# Orca gives no state time. The same cases as tests/loop/limits.test.ts.
want_six="$(TZ=Europe/Berlin date -d '2026-11-02 18:00' +%s)"
SIX="You've hit your weekly limit · resets Nov 2, 6pm (Europe/Berlin)"
CREDITS="$ROOT/tests/fixtures/loop/screens/dialog-weekly-credits.txt"
# ORCA_TERM_PANES: a terminal that has no last output either.
no_act() { printf '%s' '{"result":{"terminals":[{"handle":"tab_l3","connected":true,"writable":true,"agentIdentity":"claude","worktreeId":"repo1::/p/lead","orphaned":false}]}}'; }
ORCA_SCREEN="$(cat "$CREDITS")" ; export ORCA_SCREEN
ORCA_TERM_PANES="$(no_act)" ; export ORCA_TERM_PANES
eq  "limited: U40 real screen, no state time -> dialog row with the 6pm reset" "$(lim idle null)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_six" "$SIX")"
unset ORCA_TERM_PANES
eq  "limited: U40 real screen, working with recent output -> dialog row" "$(lim working $since)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_six" "$SIX")"
eq  "limited: U40 no state time, last output just now -> nothing yet" "$(lim idle null)" ""
ORCA_ACT_MS=$(( (LN - 900) * 1000 )) ; export ORCA_ACT_MS
eq  "limited: U40 no state time, last output long ago -> dialog row" "$(lim idle null)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_six" "$SIX")"
ORCA_ACT_MS=$(( (LN - 60) * 1000 )) ; export ORCA_ACT_MS
ORCA_SCREEN="$(cat "$ROOT/tests/fixtures/loop/screens/dialog-weekly-credits-wrapped.txt")" ; export ORCA_SCREEN
eq  "limited: U40 wrapped in a narrow pane, recent output -> the same reset" "$(lim working $since | cut -f2,4)" "$(printf '%s\tdialog' "$want_six")"
ORCA_TERM_PANES="$(no_act)" ; export ORCA_TERM_PANES
ORCA_SCREEN="$(cat "$ROOT/tests/fixtures/limit-dialog-u69.txt")" ; export ORCA_SCREEN
eq  "limited: U40 old wording, no state time -> dialog row" "$(lim idle null)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_wk" "$WK")"
ORCA_SCREEN=$'  ⎿  You\'ve hit your weekly limit · resets Oct 31, 9pm (Europe/Berlin)\n❯' ; export ORCA_SCREEN
eq  "limited: U40 a notice with no dialog and no time at all -> nothing" "$(lim idle null)" ""
ORCA_SCREEN="$(cat "$ROOT/tests/fixtures/loop/screens/dialog-near-miss.txt")" ; export ORCA_SCREEN
eq  "limited: U40 near-miss, no time -> nothing" "$(lim idle null)" ""
ORCA_SCREEN="$(cat "$ROOT/tests/fixtures/loop/screens/prose-quote.txt")" ; export ORCA_SCREEN
eq  "limited: U40 prose, no time -> nothing" "$(lim idle null)" ""
unset ORCA_TERM_PANES
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n3. Switch to usage credits' ; export ORCA_SCREEN
eq  "limited: U40 option 3 without option 2 -> no dialog" "$(lim working $since)" ""
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n2. Wait here\n3. Something new\nprose after it' ; export ORCA_SCREEN
eq  "limited: U40 any option 3, then text at its own indent -> no dialog" "$(lim working $since)" ""
ORCA_SCREEN="$(cat "$ROOT/tests/fixtures/limit-dialog-u69.txt")" ; export ORCA_SCREEN
DLG="$ROOT/tests/fixtures/limit-dialog-u69.txt"
# Two extra blank lines above the dialog put the notice 10 lines up: still inside the window.
ORCA_SCREEN="$(awk '/^▔/ { print ""; print "" } { print }' "$DLG")" ; export ORCA_SCREEN
eq  "limited: real dialog, notice 10 lines up -> dialog row" "$(lim working $since)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_wk" "$WK")"
# Margins: the verbatim dialog plus one trailing blank line, and one extra line between
# the notice and the dialog header, both still read as a dialog row.
ORCA_SCREEN="$(cat "$DLG")"$'\n' ; export ORCA_SCREEN
eq  "limited: real dialog + 1 trailing blank line -> dialog row" "$(lim working $since)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_wk" "$WK")"
ORCA_SCREEN="$(awk '/^▔/ { print "" } { print }' "$DLG")" ; export ORCA_SCREEN
eq  "limited: 1 extra line between notice and header -> dialog row" "$(lim working $since)" "$(printf 'repo1::/p/lead\t%s\t%s\tdialog' "$want_wk" "$WK")"
ORCA_SCREEN="$(grep -v 'weekly limit' "$DLG")" ; export ORCA_SCREEN
eq  "limited: real dialog without the notice -> nothing" "$(lim working $since)" ""
ORCA_SCREEN="$(sed '/^▔/,$d' "$DLG")" ; export ORCA_SCREEN
eq  "limited: notice without the dialog, idle -> row without the flag" "$(lim idle $since)" "$(printf 'repo1::/p/lead\t%s\t%s' "$want_wk" "$WK")"
eq  "limited: notice without the dialog, recent output -> nothing" "$(lim working $since)" ""
ORCA_SCREEN="$(grep -v '^▔' "$DLG")"$'\n❯ what does that dialog mean?' ; export ORCA_SCREEN
eq  "limited: quoted dialog followed by a prompt -> nothing (recent)" "$(lim working $since)" ""
ORCA_SCREEN="$(sed 's/Enter to confirm · Esc to cancel/Press any key to continue/' "$DLG")" ; export ORCA_SCREEN
eq  "limited: unknown footer line -> nothing (recent)" "$(lim working $since)" ""
# U19 dialog tail: after the last option only raw-blank lines or the footer pass. An empty ❯
# prompt and a box border strip to "" too, so a quoted dialog followed by the input box is no
# dialog (idle: a plain row, no flag; recent output: nothing).
ORCA_SCREEN="$(grep -v -e '^▔' -e 'Enter to confirm' "$DLG")"$'\n╭──────╮\n❯ \n╰──────╯' ; export ORCA_SCREEN
eq  "limited: quoted dialog + input box -> nothing (recent)" "$(lim working $since)" ""
eq  "limited: quoted dialog + input box, idle -> row, no dialog flag" "$(lim idle $since | awk -F'\t' '{print NF}')" "3"
# U19 anchor: the notice must start the line (after whitespace and ⎿ only). R4 quoted a notice
# in a finding; a ⏺ message, a ⎿ line with a prose or timestamp prefix quote it too.
R4='Finding P2: the Builder sat on "You'\''ve hit your weekly limit · resets Oct 31, 9pm"'
export ORCA_SCREEN="$R4"$'\n❯'
eq  "limited: R4 quoted prose line, idle -> nothing" "$(lim idle $since)" ""
export ORCA_SCREEN="  ⎿  $R4"$'\n❯'
eq  "limited: R4 prose behind ⎿, idle -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN=$'⏺ You\'ve hit your weekly limit · resets Oct 31, 9pm (Europe/Berlin)\n❯' ; export ORCA_SCREEN
eq  "limited: notice quoted in a ⏺ message, idle -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN=$'  ⎿  2026-10-30 14:02 5-hour limit reached ∙ resets 3pm\n❯' ; export ORCA_SCREEN
eq  "limited: timestamp before the notice, idle -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN=$'  ⎿  Opus weekly limit reached ∙ resets 3pm\n✻ Worked for 2m · done 2:11 PM\n╭──────╮\n│ >    │\n╰──────╯\n❯' ; export ORCA_SCREEN
eq  "limited: two-word head, then footer + prompt box, idle -> row" "$(lim idle $since | cut -f3)" "Opus weekly limit reached ∙ resets 3pm"
# U19 last entry: a notice counts only while no ⏺/● entry follows it — the agent recovered.
export ORCA_SCREEN=$'  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}\n⏺ Retrying the build.\n❯'
eq  "limited: recovered 429 (later ⏺ line), idle -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN=$'  ⎿  5-hour limit reached ∙ resets 3pm\n\n● Back at it, the reset passed.\n❯' ; export ORCA_SCREEN
eq  "limited: reset notice then a later ● line, idle -> nothing" "$(lim idle $since)" ""
export ORCA_SCREEN=$'⏺ Running the build.\n  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}\n❯'
eq  "limited: 429 as the last entry, idle -> row" "$(lim idle $since | cut -f1)" "repo1::/p/lead"
# Claude Code's recovery line is no notice ("reset", not "resets"), and it voids a notice above it.
ORCA_SCREEN=$'  ⎿  Usage limit reset · Continuing automatically\n❯' ; export ORCA_SCREEN
eq  "limited: 'Usage limit reset · Continuing automatically', idle -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN=$'  ⎿  You\'ve hit your weekly limit · resets Oct 31, 9pm (Europe/Berlin)\n  ⎿  Usage limit reset · Continuing automatically\n❯' ; export ORCA_SCREEN
eq  "limited: notice then the recovery line, idle -> nothing" "$(lim idle $since)" ""
unset ORCA_SCREEN ORCA_ACT_MS
# U12 aggregator-pool 429: idle 15 min -> row, ISO reset resolved to the instant itself. Claude Code
# renders an API error under the result marker (`  ⎿  API Error …`), so the fixture carries it.
AGG='API Error: Request rejected (429) · All credentials for model claude-sonnet-5-5 are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-29T16:11:19Z.)'
ORCA_SCREEN="  ⎿  $AGG" ; export ORCA_SCREEN
eq  "limited: aggregator 429 idle -> row with ISO reset" "$(lim idle $since)" "$(printf 'repo1::/p/lead\t%s\t%s' "$(date -d '2026-10-29T16:11:19Z' +%s)" "$(printf '%s' "$AGG" | cut -c1-160)")"
export ORCA_ACT_MS=$(( (LN - 60) * 1000 ))
eq  "limited: aggregator 429 with recent output -> nothing" "$(lim working $since)" ""
unset ORCA_ACT_MS
ORCA_SCREEN=$'rate_limit_exceeded: Subscription quota exhausted' ; export ORCA_SCREEN
eq  "limited: bare rate_limit_exceeded/quota without 429-or-cooling -> nothing" "$(lim idle $since)" ""
ORCA_SCREEN=$'  ⎿  API Error: Request rejected (429) · resets at 2026-10-29T16:11:19+02:00' ; export ORCA_SCREEN
eq  "limited: ISO reset with +02:00 offset -> same instant" "$(lim idle $since | cut -f2)" "$(date -d '2026-10-29T16:11:19+02:00' +%s)"
# Each pool alternative is independently distinctive: cooling-down alone (no 429) also rows.
ORCA_SCREEN=$'  ⎿  All credentials for model claude-sonnet-5-5 are cooling down' ; export ORCA_SCREEN
eq  "limited: cooling-down alone -> row" "$(lim idle $since | cut -f1)" "repo1::/p/lead"
eq  "limited: cooling-down alone -> reset '-'" "$(lim idle $since | cut -f2)" "-"
# A past ISO instant is the reset itself (no roll-forward, unlike the month-name forms).
ORCA_SCREEN=$'  ⎿  API Error: Request rejected (429) · resets at 2026-10-15T16:11:19Z' ; export ORCA_SCREEN
eq  "limited: past ISO reset -> that instant, not rolled" "$(lim idle $since | cut -f2)" "$(date -d '2026-10-15T16:11:19Z' +%s)"
ORCA_SCREEN=$'Subscription quota exhausted' ; export ORCA_SCREEN
eq  "limited: bare quota exhausted alone -> nothing" "$(lim idle $since)" ""
unset ORCA_SCREEN
: > "$ORCA_LOG"; lim idle $(( (LN - 60) * 1000 )) >/dev/null
# A billing error counts at once on an idle worker, so a recently idle worker's screen is read (once; the kept screen
# is reused until its state or output changes).
eq  "limited: a recently idle worker's screen is read once (credits count at once)"    "$(grep -c 'terminal read' "$ORCA_LOG" || true)" "1"

# Claude accounts come from loop.db's accounts table (never `orca account list`): the default first.
# seed_accounts [acctB]: the system login and Orca profile acctB (NULL folder), that one marked default.
seed_accounts() {
  bun "$ROOT/tests/lib/accounts-table.ts" "$DS_STATE_ROOT" \
    claude system "system login (a@x)" system - 0 claude acctB "B org" orca - "$([ "${1:-}" = acctB ] && echo 1 || echo 0)"
}
export DS_ORCA_DATA="$TMP/orcadata"
mkdir -p "$DS_ORCA_DATA/claude-profiles/acctB/home"
seed_accounts
: > "$ORCA_LOG"; al="$("$ADAPTER" account-list 2>/dev/null || true)"
eq  "account-list: system login first, then the table's accounts" "$(printf '%s\n' "$al" | awk -F'\t' '$1=="claude"{printf "%s=%s;", $2,$3}')" "system=system login (a@x);acctB=B org;"
eq  "account-list: still three TSV columns"       "$(printf '%s\n' "$al" | awk -F'\t' 'NF!=3' | wc -l | tr -d ' ')" "0"
eq  "account-list: Orca is not asked"             "$(cat "$ORCA_LOG")" ""
seed_accounts acctB
eq  "account-list: the table's default comes first" "$("$ADAPTER" account-list | awk -F'\t' '$1=="claude"{printf "%s ", $2}')" "acctB system "
seed_accounts

# start ops take a trailing `account` and `-` for a skipped optional positional.
export DS_CLAUDE_SYSTEM_JSON_DIR="$TMP/sysjson"
mkdir -p "$DS_CLAUDE_SYSTEM_JSON_DIR"
BHOME="$DS_ORCA_DATA/claude-profiles/acctB/home"
# claude-config-dir: the CLAUDE_CONFIG_DIR a claude on that account runs with (install --check probes
# each account's plugin registry under it); `system` = empty (run with it unset).
rc=0; got="$("$ADAPTER" claude-config-dir system 2>/dev/null)" || rc=$?
eq  "claude-config-dir system: empty (CLAUDE_CONFIG_DIR unset)" "$rc:$got" "0:"
rc=0; got="$("$ADAPTER" claude-config-dir acctB 2>/dev/null)" || rc=$?
eq  "claude-config-dir managed: its profile home"  "$rc:$got" "0:$BHOME"
rc=0; err="$("$ADAPTER" claude-config-dir acctGone 2>&1 >/dev/null)" || rc=$?
eq  "claude-config-dir missing profile home: exit 1" "$rc" "1"
has "claude-config-dir missing profile home: says which" "$err" "no Claude home for account acctGone"
rc=0; "$ADAPTER" claude-config-dir >/dev/null 2>&1 || rc=$?
eq  "claude-config-dir with no account: usage exit 2" "$rc" "2"
# preflight (U246): ONE start gives install.sh the runtime check and every account's config dir: the account-list rows,
# a Claude row with its config dir as a fourth column (empty for system); exit 1 and nothing printed when unreachable.
pf="$("$ADAPTER" preflight 2>/dev/null || true)"
eq  "preflight: claude rows carry the config dir" "$(printf '%s\n' "$pf" | awk -F'\t' '$1=="claude"{printf "%s=[%s];", $2,$4}')" "system=[];acctB=[$BHOME];"
eq  "preflight: non-claude rows stay three columns" "$(printf '%s\n' "$pf" | awk -F'\t' '$1!="claude" && NF!=3' | wc -l | tr -d ' ')" "0"
ORCA_STATUS_WAS="${ORCA_STATUS:-}"; export ORCA_STATUS='{"ok":true,"result":{"runtime":{"reachable":false}}}'
rc=0; pfo="$("$ADAPTER" preflight 2>/dev/null)" || rc=$?
eq  "preflight: unreachable runtime -> exit 1, nothing printed" "$rc:$pfo" "1:"
if [ -n "$ORCA_STATUS_WAS" ]; then export ORCA_STATUS="$ORCA_STATUS_WAS"; else unset ORCA_STATUS; fi
: > "$ORCA_LOG"; "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system >/dev/null 2>&1 || true
# public-readiness U9: every Claude start on this host is a claude tab with bin/hooks/path-gates first on PATH
# (the hook shims), the default login too: worker-start --agent cannot carry that PATH.
has "role-start on the default login: a plain claude tab with the path gates" "$(cat "$ORCA_LOG")" "terminal create --worktree id:wt_new --title claude --command $SHIMP claude --dangerously-skip-permissions --model opus"
has "role-start on the default login: that tab is supervised" "$(cat "$ORCA_LOG")" "worker-start --worktree id:wt_new --spec spec --run run_1 --terminal tab_new"
hasnt "role-start on the default login: no --agent launch" "$(cat "$ORCA_LOG")" "--agent"
hasnt "role-start: '-' is not passed as --on"  "$(cat "$ORCA_LOG")" "--on -"
hasnt "role-start: '-' is not passed as --effort" "$(cat "$ORCA_LOG")" "--effort -"
: > "$ORCA_LOG"; "$ADAPTER" role-start run_1 repo1 - spec claude opus nm >/dev/null 2>&1 || true
has "role-start with no account: the path gates too" "$(cat "$ORCA_LOG")" "--command $SHIMP claude --dangerously-skip-permissions --model opus"
hasnt "role-start with no account: no --agent launch" "$(cat "$ORCA_LOG")" "--agent"
: > "$ORCA_LOG"; "$ADAPTER" role-start run_1 repo1 - spec muse muse-spark-1.3 nm >/dev/null 2>&1 || true
has "role-start of another agent: Orca's own launch (no path gates)" "$(cat "$ORCA_LOG")" "--agent muse --model muse-spark-1.3"
hasnt "role-start of another agent: no tab of ours" "$(cat "$ORCA_LOG")" "terminal create"
# U4 (orca-backend-alternatives): a loop start hands DS_START_MEMBER/DS_START_GEN; the claude tab's launch line
# carries them as DS_MEMBER, DS_WT and DS_GEN. Orca's own launch (muse) carries none. The tab never inherits
# the caller's DS_MEMBER: only the DS_START_* pair sets one.
: > "$ORCA_LOG"; DS_START_MEMBER=fx/sq/builder-u1 DS_START_GEN=gen-7 "$ADAPTER" worker-start run_1 "id:repo1::/w/b1" spec claude opus - - system >/dev/null 2>&1 || true
has "a loop start: the claude tab carries its identity" "$(cat "$ORCA_LOG")" "--command DS_MEMBER=fx/sq/builder-u1 DS_WT=/w/b1 DS_GEN=gen-7 $SHIMP claude --dangerously-skip-permissions --model opus"
: > "$ORCA_LOG"; DS_START_MEMBER=fx/sq/builder-u1 DS_START_GEN=gen-8 "$ADAPTER" worker-resume run_1 "id:repo1::/w/b1" spec opus system claude >/dev/null 2>&1 || true
has "a loop resume: the claude tab carries its identity" "$(cat "$ORCA_LOG")" "DS_MEMBER=fx/sq/builder-u1 DS_WT=/w/b1 DS_GEN=gen-8 $SHIMP claude --continue"
: > "$ORCA_LOG"; DS_MEMBER=fx/sq/lead DS_GEN=g0 "$ADAPTER" worker-start run_1 "id:repo1::/w/b1" spec claude opus - - system >/dev/null 2>&1 || true
hasnt "a caller's own DS_MEMBER is not passed on" "$(cat "$ORCA_LOG")" "DS_MEMBER="
: > "$ORCA_LOG"; DS_START_MEMBER=fx/sq/builder-u1 DS_START_GEN=gen-7 "$ADAPTER" worker-start run_1 wtX spec muse muse-spark-1.3 - - default >/dev/null 2>&1 || true
hasnt "Orca's own launch (muse) carries no identity" "$(cat "$ORCA_LOG")" "DS_MEMBER="

# Another account: a claude tab under that account's config dir, then worker-start --terminal.
: > "$ORCA_LOG"; rc=0; "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - high acctB >/dev/null 2>&1 || rc=$?
eq  "role-start on account B: ok"               "$rc" "0"
has "role-start on account B: claude runs with B's config dir" "$(cat "$ORCA_LOG")" "terminal create --worktree id:wt_new --title claude@acctB --command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --model opus --effort high"
has "role-start on account B: that tab is supervised" "$(cat "$ORCA_LOG")" "worker-start --worktree id:wt_new --spec spec --run run_1 --terminal tab_new"
hasnt "role-start on account B: no --agent launch" "$(cat "$ORCA_LOG")" "--agent"
: > "$ORCA_LOG"; "$ADAPTER" lead-worker-start run_1 task_1 wtL claude sonnet - - acctB >/dev/null 2>&1 || true
has "lead-worker-start on account B: keeps the task" "$(cat "$ORCA_LOG")" "worker-start --worktree id:wtL --task task_1 --run run_1 --keep-open --terminal tab_new"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctB >/dev/null 2>&1 || true
has "worker-start (restart) on account B"        "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --model opus"
hasnt "worker-start: '-' host/effort skipped"  "$(cat "$ORCA_LOG")" "--on"
# An account `ds account add` made: the tab's CLAUDE_CONFIG_DIR is its row's folder.
mkdir -p "$TMP/ds-accounts/claude/acctD"
bun "$ROOT/tests/lib/accounts-table.ts" "$DS_STATE_ROOT" claude system "system login (a@x)" system - 1 claude acctD "D" ds "$TMP/ds-accounts/claude/acctD" 0
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctD >/dev/null 2>&1 || true
has "worker-start on a ds row: its folder"      "$(cat "$ORCA_LOG")" "--title claude@acctD --command CLAUDE_CONFIG_DIR=$TMP/ds-accounts/claude/acctD $SHIMP claude --dangerously-skip-permissions --model opus"
seed_accounts
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - system >/dev/null 2>&1 || true
hasnt "the system login is a plain launch while it is the default" "$(cat "$ORCA_LOG")" "CLAUDE_CONFIG_DIR"
seed_accounts acctB
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - system >/dev/null 2>&1 || true
SYSCMD="env -u CLAUDE_CONFIG_DIR $SHIMP claude --dangerously-skip-permissions"
has   "system with B selected: launched with no config dir" "$(cat "$ORCA_LOG")" "--command $SYSCMD --model opus"
hasnt "system with B selected: no CLAUDE_CONFIG_DIR=" "$(cat "$ORCA_LOG")" "CLAUDE_CONFIG_DIR="
printf '{"hasCompletedOnboarding":true}\n' > "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json"; printf '{"theme":"b"}\n' > "$BHOME/.claude.json"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 "id:repo1::/w/sys" spec claude opus - - system >/dev/null 2>&1 || true
eq  "system: worktree trusted in the system .claude.json" "$(jq -r '.projects["/w/sys"].hasTrustDialogAccepted' "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json")" "true"
eq  "system: B's .claude.json untouched" "$(cat "$BHOME/.claude.json")" '{"theme":"b"}'
: > "$ORCA_LOG"; "$ADAPTER" worker-resume run_1 wtX spec opus system claude >/dev/null 2>&1 || true
has "system with B selected: resume keeps no config dir" "$(cat "$ORCA_LOG")" "$SYSCMD --continue --model opus"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - system 200000 >/dev/null 2>&1 || true
has "system with B selected: window on the same launch" "$(cat "$ORCA_LOG")" "$SYSCMD --model opus --settings"
rm -f "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json" "$BHOME/.claude.json"
seed_accounts
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec muse muse-spark-1.3 - - default >/dev/null 2>&1 || true
has "muse starts by Orca's native --agent muse"  "$(cat "$ORCA_LOG")" "--agent muse --model muse-spark-1.3"
# KTD17: a Codex account other than the system login is a tab with its folder env, then supervised.
CXH="$TMP/codex-work"; mkdir -p "$CXH"
seed_codex() { bun "$ROOT/tests/lib/accounts-table.ts" "$DS_STATE_ROOT" claude system "system login" system - 0 \
  claude acctB "B org" orca - 0 codex default codex system - 0 codex work Work ds "$CXH" "${1:-0}" codex gone Gone ds "$TMP/no-such" 0; }
seed_codex
CXLINE="env CODEX_HOME=$CXH codex -c disable_paste_burst=true --dangerously-bypass-approvals-and-sandbox --model gpt-x"
: > "$ORCA_LOG"; rc=0; "$ADAPTER" worker-start run_1 "repo1::/w/cx" spec codex gpt-x - high work >/dev/null 2>&1 || rc=$?
eq  "codex on a ds account: ok" "$rc" "0"
has "codex on a ds account: its folder env on Codex's own line" "$(cat "$ORCA_LOG")" "--title codex@work --command $CXLINE -c model_reasoning_effort=high"
has "codex on a ds account: that tab is supervised" "$(cat "$ORCA_LOG")" "worker-start --worktree id:repo1::/w/cx --spec spec --run run_1 --terminal tab_new"
hasnt "codex on a ds account: no --agent launch" "$(cat "$ORCA_LOG")" "--agent"
"$ADAPTER" worker-start run_1 "repo1::/w/cx" spec codex gpt-x - - work >/dev/null 2>&1 || true
eq  "codex on a ds account: the worktree is trusted there, once" "$(grep -cxF '[projects."/w/cx"]' "$CXH/config.toml"):$(grep -c 'trust_level = "trusted"' "$CXH/config.toml")" "1:1"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec codex gpt-x - - default >/dev/null 2>&1 || true
has "codex on its system login: Orca's own --agent launch" "$(cat "$ORCA_LOG")" "--agent codex --model gpt-x"
hasnt "codex on its system login: no tab of ours" "$(cat "$ORCA_LOG")" "terminal create"
seed_codex 1
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec codex gpt-x >/dev/null 2>&1 || true
has "codex with no account: the table's default" "$(cat "$ORCA_LOG")" "--command $CXLINE"
: > "$ORCA_LOG"; rc=0; err="$("$ADAPTER" worker-start run_1 wtX spec codex gpt-x laptop - work 2>&1 >/dev/null)" || rc=$?
eq  "codex on a ds account with --on: refused, nothing started" "$([ "$rc" != 0 ] && echo refused):$(grep -c 'terminal create\|worker-start' "$ORCA_LOG" || true)" "refused:0"
: > "$ORCA_LOG"; rc=0; err="$("$ADAPTER" worker-start run_1 wtX spec codex gpt-x - - gone 2>&1 >/dev/null)" || rc=$?
has "codex account with no folder: says which" "$err" "no codex home for account gone ($TMP/no-such)"
hasnt "codex account with no folder: no tab" "$(cat "$ORCA_LOG")" "terminal create"
: > "$ORCA_LOG"; rc=0; err="$("$ADAPTER" worker-start run_1 wtX spec muse muse-spark-1.3 - - other 2>&1 >/dev/null)" || rc=$?
has "muse on another account: refused, it has no folder variable" "$err" "muse has no folder variable"
hasnt "muse on another account: nothing started" "$(cat "$ORCA_LOG")" "worker-start"
seed_accounts
# Failures stay loud and leave no tab behind.
: > "$ORCA_LOG"; rc=0; "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctZ >/dev/null 2>&1 || rc=$?
eq  "an account with no Claude home -> exit 1"  "$rc:$(grep -c 'worker-start' "$ORCA_LOG" || true)" "1:0"
: > "$ORCA_LOG"; rc=0; "$ADAPTER" worker-start run_1 wtX spec claude opus saved:env1 - acctB >/dev/null 2>&1 || rc=$?
eq  "account B with --on a remote host -> exit 1, nothing opened" "$rc:$(grep -c 'terminal create' "$ORCA_LOG" || true)" "1:0"
: > "$ORCA_LOG"; rc=0; FAKE_TUI_FAIL=1 "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctB >/dev/null 2>&1 || rc=$?
eq  "claude never came up -> exit 1, no worker-start" "$rc:$(grep -c 'worker-start' "$ORCA_LOG" || true)" "1:0"
has "claude never came up -> its tab is closed" "$(cat "$ORCA_LOG")" "terminal close --terminal tab_new"
# U270: the tab's screen is read before the close and printed on one start_failed line.
: > "$ORCA_LOG"; err="$(FAKE_TUI_FAIL=1 ORCA_SCREEN=$'Error: config is locked\n\n' "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctB 2>&1 >/dev/null || true)"
eq  "claude never came up -> its screen is read, then its tab closed" "$(grep -o 'terminal read\|terminal close' "$ORCA_LOG" | tr '\n' ' ')" "terminal read terminal close "
sf="$(printf '%s\n' "$err" | sed -n 's/^orca adapter: start_failed //p')"
eq  "claude never came up -> one start_failed line" "$(printf '%s\n' "$sf" | grep -c .)" "1"
eq  "claude never came up -> start_failed keeps the screen, worktree, account and Orca's answer" \
    "$(printf '%s' "$sf" | jq -c '[.screen, .worktree, .account, (.orca | contains("wait timed out")), (.failure | test("never came up"))]')" \
    '["Error: config is locked","wtX","acctB",true,true]'
: > "$ORCA_LOG"; rc=0; err="$(FAKE_TC_FAIL=1 "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctB 2>&1 >/dev/null)" || rc=$?
eq  "terminal create with no handle -> exit 1, no wait" "$rc:$(grep -c 'terminal wait' "$ORCA_LOG" || true)" "1:0"
has "terminal create with no handle -> the failure line" "$err" "orca adapter: could not open a terminal in wtX for account acctB"
eq  "terminal create with no handle -> start_failed keeps what Orca printed" \
    "$(printf '%s\n' "$err" | sed -n 's/^orca adapter: start_failed //p' | jq -c '[.screen, (.orca | contains("worktree is not ready")), (.orca | contains("{\"ok\":false}"))]')" '[null,true,true]'
: > "$ORCA_LOG"; rc=0; FAKE_WS_FENCE=1 "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctB >/dev/null 2>&1 || rc=$?
eq  "worker-start --terminal refused -> exit 1"  "$rc" "1"
has "worker-start --terminal refused -> its tab is closed" "$(cat "$ORCA_LOG")" "terminal close --terminal tab_new"

# No system row and no listed default: a named account is still that account, never a plain claude.
bun "$ROOT/tests/lib/accounts-table.ts" "$DS_STATE_ROOT" claude acctB "B org" orca - 0
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - acctB >/dev/null 2>&1 || true
has "no default listed: start keeps the named account"  "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --model opus"
: > "$ORCA_LOG"; "$ADAPTER" worker-resume run_1 wtX spec opus acctB claude >/dev/null 2>&1 || true
has "no default listed: resume keeps the named account" "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --continue --model opus"
seed_accounts

# worker-resume keeps the account: --continue under that account's config dir.
: > "$ORCA_LOG"; "$ADAPTER" worker-resume run_1 wtX spec opus acctB claude >/dev/null 2>&1 || true
has "worker-resume on account B: claude --continue with B's config dir" "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --continue --model opus"
has "worker-resume on account B: supervises that tab" "$(cat "$ORCA_LOG")" "worker-start --terminal tab_new --worktree id:wtX --spec spec --run run_1"
: > "$ORCA_LOG"; "$ADAPTER" worker-resume run_1 wtX spec opus >/dev/null 2>&1 || true
has "worker-resume on the default login: plain claude --continue" "$(cat "$ORCA_LOG")" "--command $SHIMP claude --continue --dangerously-skip-permissions --model opus"
rc=0; "$ADAPTER" worker-resume run_1 wtX spec muse-spark-1.3 default muse >/dev/null 2>&1 || rc=$?
eq  "worker-resume: muse has no resume -> exit 1 (caller starts fresh)" "$rc" "1"
rc=0; "$ADAPTER" worker-resume run_1 wtX spec gpt - codex >/dev/null 2>&1 || rc=$?
eq  "worker-resume: another non-claude agent -> exit 1" "$rc" "1"
# The worktree is pre-trusted in the account's own .claude.json before claude launches there.
printf '{"theme":"dark","projects":{"/old":{"allowedTools":[]}}}\n' > "$BHOME/.claude.json"; chmod 600 "$BHOME/.claude.json"
"$ADAPTER" worker-start run_1 "id:repo1::/w/new" spec claude opus - - acctB >/dev/null 2>&1 || true
eq  "trust: new path gets hasTrustDialogAccepted" "$(jq -r '.projects["/w/new"].hasTrustDialogAccepted' "$BHOME/.claude.json")" "true"
eq  "trust: existing keys preserved" "$(jq -c '[.theme, .projects["/old"]]' "$BHOME/.claude.json")" '["dark",{"allowedTools":[]}]'
eq  "trust: file mode kept" "$(stat -c %a "$BHOME/.claude.json")" "600"
# shellcheck disable=SC2010  # a test temp dir with known names
eq  "trust: no temp files left" "$(ls -A "$BHOME" | grep -c 'XXXX\|\.claude\.json\.' || true)" "0"
cksum "$BHOME/.claude.json" > "$TMP/ck1"; touch -d '2001-01-01' "$BHOME/.claude.json"
"$ADAPTER" worker-start run_1 "id:repo1::/w/new" spec claude opus - - acctB >/dev/null 2>&1 || true
cksum "$BHOME/.claude.json" > "$TMP/ck2"
eq  "trust: already-true file byte-identical" "$(cat "$TMP/ck2")" "$(cat "$TMP/ck1")"
eq  "trust: already-true file not rewritten" "$(stat -c %y "$BHOME/.claude.json" | cut -c1-4)" "2001"
printf '{"theme":"dark"}\n' > "$BHOME/.claude.json"
"$ADAPTER" worker-start run_1 /w/bare spec claude opus - - acctB >/dev/null 2>&1 || true
eq  "trust: a bare path is used as is; missing projects created" "$(jq -r '.projects["/w/bare"].hasTrustDialogAccepted' "$BHOME/.claude.json")" "true"
printf 'not json' > "$BHOME/.claude.json"
"$ADAPTER" worker-start run_1 "id:repo1::/w/x" spec claude opus - - acctB >/dev/null 2>&1 || true
eq  "trust: bad JSON left alone" "$(cat "$BHOME/.claude.json")" "not json"
rm -f "$BHOME/.claude.json"
"$ADAPTER" worker-start run_1 "id:repo1::/w/x" spec claude opus - - acctB >/dev/null 2>&1 || true
eq  "trust: missing file is not created" "$(find "$BHOME" -mindepth 1 -maxdepth 1 ! -name projects | wc -l | tr -d ' ')" "0"
printf '{"keep":1}\n' > "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 "id:repo1::/w/def" spec claude opus - - system >/dev/null 2>&1 || true
eq  "trust: the system login is pre-trusted too (a tab, U9)" "$(jq -c '[.keep, .projects["/w/def"].hasTrustDialogAccepted]' "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json")" '[1,true]'
rm -f "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json"

# Auto-compact window: the trailing `window` launches claude with --settings env (it outranks
# ~/.claude/settings.json); worker-start --agent can't carry it, so even the default login gets a tab.
W='--settings \{\"env\":\{\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\":\"200000\"\}\}'
: > "$ORCA_LOG"; rc=0; "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system 200000 >/dev/null 2>&1 || rc=$?
eq  "window on the default login: ok"            "$rc" "0"
has "window on the default login: plain claude with the window" "$(cat "$ORCA_LOG")" "terminal create --worktree id:wt_new --title claude --command $SHIMP claude --dangerously-skip-permissions --model opus $W"
has "window on the default login: that tab is supervised" "$(cat "$ORCA_LOG")" "worker-start --worktree id:wt_new --spec spec --run run_1 --terminal tab_new"
hasnt "window on the default login: no CLAUDE_CONFIG_DIR" "$(cat "$ORCA_LOG")" "CLAUDE_CONFIG_DIR"
hasnt "window on the default login: no --agent launch" "$(cat "$ORCA_LOG")" "--agent"
: > "$ORCA_LOG"; "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - high acctB 200000 >/dev/null 2>&1 || true
has "window on account B: B's config dir, effort, then the window" "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --model opus --effort high $W"
seed_accounts acctB
: > "$ORCA_LOG"; "$ADAPTER" lead-worker-start run_1 task_1 wtL claude sonnet - - - 200000 >/dev/null 2>&1 || true
has "window when a managed account is the default: its config dir" "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --model sonnet $W"
has "window on lead-worker-start: keeps the task" "$(cat "$ORCA_LOG")" "worker-start --worktree id:wtL --task task_1 --run run_1 --keep-open --terminal tab_new"
seed_accounts
: > "$ORCA_LOG"; "$ADAPTER" lead-start run_1 task_1 repo1 claude opus nm - - - - 150000 >/dev/null 2>&1 || true
has "lead-start carries the window"               "$(cat "$ORCA_LOG")" "CLAUDE_CODE_AUTO_COMPACT_WINDOW\\\":\\\"150000"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - - 200000 >/dev/null 2>&1 || true
has "worker-start (restart) carries the window"   "$(cat "$ORCA_LOG")" "--model opus $W"
# Skill list (U229): the window and the role's skillOverrides share ONE --settings JSON.
SO='{"dataviz":"off","ds-up":"off","lavish":"name-only"}'
: > "$ORCA_LOG"; SO_OUT="$SO" SO_LOG="$TMP/so.log" "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system 200000 >/dev/null 2>&1 || true
has "skills: one --settings with the window and skillOverrides" "$(cat "$ORCA_LOG")" "--settings $(printf '%q' '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"200000"},"skillOverrides":{"dataviz":"off","ds-up":"off","lavish":"name-only"}}')"
eq  "skills: exactly one --settings" "$(grep -o -- '--settings' "$ORCA_LOG" | wc -l | tr -d ' ')" "1"
has "skills: resolved for the worktree it starts" "$(cat "$TMP/so.log")" "--wt "
: > "$ORCA_LOG"; SO_OUT="$SO" "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system - >/dev/null 2>&1 || true
has "skills: no window still carries the skill list" "$(cat "$ORCA_LOG")" "--settings $(printf '%q' '{"skillOverrides":{"dataviz":"off","ds-up":"off","lavish":"name-only"}}')"
: > "$ORCA_LOG"; rc=0; SO_FAIL=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system 200000 >/dev/null 2>"$TMP/err" || rc=$?
eq  "skills: a failing resolve still starts the role" "$rc" "0"
has "skills: failing resolve: the window alone, no skillOverrides" "$(cat "$ORCA_LOG")" "--model opus $W"
hasnt "skills: failing resolve: no skillOverrides" "$(cat "$ORCA_LOG")" "skillOverrides"
has "skills: failing resolve logs one line" "$(cat "$TMP/err")" "skill list unavailable"
# MCP servers (U283): `ds skills resolve --all` gives {skillOverrides, mcp, deniedMcpServers}; the denied servers ride in the same --settings.
FULL='{"skillOverrides":{"dataviz":"off"},"mcp":{"linear-server":"off"},"deniedMcpServers":[{"serverName":"linear-server"},{"serverName":"claude.ai Claude Docs"}]}'
: > "$ORCA_LOG"; SO_OUT="$FULL" "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system 200000 >/dev/null 2>&1 || true
has "mcp: builder start carries deniedMcpServers in the one --settings" "$(cat "$ORCA_LOG")" "--settings $(printf '%q' '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"200000"},"skillOverrides":{"dataviz":"off"},"deniedMcpServers":[{"serverName":"linear-server"},{"serverName":"claude.ai Claude Docs"}]}')"
eq  "mcp: exactly one --settings" "$(grep -o -- '--settings' "$ORCA_LOG" | wc -l | tr -d ' ')" "1"
: > "$ORCA_LOG"; SO_OUT='{"skillOverrides":{},"mcp":{},"deniedMcpServers":[{"serverName":"linear-server"}]}' "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system - >/dev/null 2>&1 || true
has "mcp: denied servers alone still make a --settings" "$(cat "$ORCA_LOG")" "--settings $(printf '%q' '{"deniedMcpServers":[{"serverName":"linear-server"}]}')"
: > "$ORCA_LOG"; SO_FAIL=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system 200000 >/dev/null 2>&1 || true
hasnt "mcp: failing resolve: every server, no deniedMcpServers" "$(cat "$ORCA_LOG")" "deniedMcpServers"
# Plugins (review-unit-no-receipt U1): the resolver's enabledPlugins (the plugins a role has off) ride in the same --settings.
: > "$ORCA_LOG"; SO_OUT='{"skillOverrides":{"dataviz":"off"},"mcp":{},"deniedMcpServers":[],"plugins":{"p@m":"off"},"enabledPlugins":{"p@m":false}}' "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system - >/dev/null 2>&1 || true
has "plugins: a role start carries enabledPlugins in the one --settings" "$(cat "$ORCA_LOG")" "--settings $(printf '%q' '{"skillOverrides":{"dataviz":"off"},"enabledPlugins":{"p@m":false}}')"
: > "$ORCA_LOG"; SO_OUT='{"skillOverrides":{},"mcp":{},"deniedMcpServers":[],"plugins":{"p@m":"off"},"enabledPlugins":{"p@m":false}}' "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system - >/dev/null 2>&1 || true
has "plugins: off plugins alone still make a --settings" "$(cat "$ORCA_LOG")" "--settings $(printf '%q' '{"enabledPlugins":{"p@m":false}}')"
: > "$ORCA_LOG"; SO_OUT='{"skillOverrides":{},"mcp":{},"deniedMcpServers":[],"plugins":{"p@m":"on"},"enabledPlugins":{}}' "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - system - >/dev/null 2>&1 || true
hasnt "plugins: none off, no enabledPlugins" "$(cat "$ORCA_LOG")" "enabledPlugins"
for nw in - off; do
  : > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec claude opus - - - "$nw" >/dev/null 2>&1 || true
  has   "window '$nw': a plain claude tab" "$(cat "$ORCA_LOG")" "--command $SHIMP claude --dangerously-skip-permissions --model opus"
  hasnt "window '$nw': no --settings"              "$(cat "$ORCA_LOG")" "--settings"
done
# studio-start (U262, KTD4): /ds-up opens the Studio as a plain claude tab through the same launch path
# (account, model, effort, one --settings with the window and the skill list, the prompt last) and prints
# its handle. No Orca worker is bound to it and it never closes the worktree's other terminals.
P='You are the Studio'
: > "$ORCA_LOG"; rc=0; out="$(SO_OUT="$SO" SO_LOG="$TMP/so.log" "$ADAPTER" studio-start wtS - opus high 200000 "$P" 2>/dev/null)" || rc=$?
eq  "studio-start: ok, prints the handle"        "$rc:$out" "0:tab_new"
has "studio-start: claude with the window and the skill list, the prompt last" "$(cat "$ORCA_LOG")" "terminal create --worktree id:wtS --title claude --command $SHIMP claude --dangerously-skip-permissions --model opus --effort high --settings $(printf '%q' '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"200000"},"skillOverrides":{"dataviz":"off","ds-up":"off","lavish":"name-only"}}') $(printf '%q' "$P")"
has "studio-start: skills resolved for the Studio's worktree" "$(cat "$TMP/so.log")" "--wt wtS"
hasnt "studio-start: no Orca worker"             "$(cat "$ORCA_LOG")" "worker-start"
hasnt "studio-start: no fresh-start guard (no terminal close)" "$(cat "$ORCA_LOG")" "terminal close"
hasnt "studio-start: no fresh-start guard (no terminal list)"  "$(cat "$ORCA_LOG")" "terminal list"
hasnt "studio-start: default login: no CLAUDE_CONFIG_DIR" "$(cat "$ORCA_LOG")" "CLAUDE_CONFIG_DIR"
: > "$ORCA_LOG"; "$ADAPTER" studio-start wtS acctB opus - 200000 "$P" >/dev/null 2>&1 || true
has "studio-start --account B: B's config dir, no effort" "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --model opus $W"
seed_accounts acctB
: > "$ORCA_LOG"; "$ADAPTER" studio-start wtS - - - - "$P" >/dev/null 2>&1 || true
has "studio-start: a managed default login: its config dir" "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions"
hasnt "studio-start: no model, no window: neither flag" "$(cat "$ORCA_LOG")" "--model"
seed_accounts
: > "$ORCA_LOG"; rc=0; out="$(FAKE_TUI_FAIL=1 "$ADAPTER" studio-start wtS acctB opus - 200000 "$P" 2>/dev/null)" || rc=$?
eq  "studio-start: claude never came up -> exit 1, no handle" "$rc:$out" "1:"
has "studio-start: claude never came up -> its tab is closed" "$(cat "$ORCA_LOG")" "terminal close --terminal tab_new"
eq  "studio-start: usage"                        "$("$ADAPTER" studio-start wtS - >/dev/null 2>&1; echo $?)" "1"
: > "$ORCA_LOG"; "$ADAPTER" worker-start run_1 wtX spec muse muse-spark-1.3 - - default 200000 >/dev/null 2>&1 || true
has   "muse ignores the window: native --agent muse" "$(cat "$ORCA_LOG")" "--agent muse --model muse-spark-1.3"
hasnt "muse ignores the window: no --settings"   "$(cat "$ORCA_LOG")" "--settings"
: > "$ORCA_LOG"; rc=0; "$ADAPTER" worker-start run_1 wtX spec claude opus saved:env1 - - 200000 >/dev/null 2>&1 || rc=$?
eq  "window with --on a remote host: still starts" "$rc" "0"
has "window with --on: dropped, worker-start --agent --on" "$(cat "$ORCA_LOG")" "--agent claude --model opus --on saved:env1"
hasnt "window with --on: no tab"                 "$(cat "$ORCA_LOG")" "terminal create"
: > "$ORCA_LOG"; "$ADAPTER" worker-resume run_1 wtX spec opus - claude 200000 >/dev/null 2>&1 || true
has "worker-resume on the default login keeps the window" "$(cat "$ORCA_LOG")" "--command $SHIMP claude --continue --dangerously-skip-permissions --model opus $W"
: > "$ORCA_LOG"; "$ADAPTER" worker-resume run_1 wtX spec opus acctB claude 200000 >/dev/null 2>&1 || true
has "worker-resume on account B keeps the window" "$(cat "$ORCA_LOG")" "--command CLAUDE_CONFIG_DIR=$BHOME $SHIMP claude --dangerously-skip-permissions --continue --model opus $W"
printf '{"theme":"dark"}\n' > "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json"
"$ADAPTER" worker-start run_1 "id:repo1::/w/win" spec claude opus - - - 200000 >/dev/null 2>&1 || true
eq  "window on the default login: pre-trusted in the plain login's .claude.json" "$(jq -r '.projects["/w/win"].hasTrustDialogAccepted' "$DS_CLAUDE_SYSTEM_JSON_DIR/.claude.json")" "true"

# Standing roles (U64): a Lead, Thinker or Studio start carries --keep-open on both start paths (--agent
# on the default login, --terminal on another account or a window), so Orca never releases its
# terminal when a dispatch settles; a Builder start does not. The role is each op's last positional.
ws_line() { grep 'orchestration worker-start' "$ORCA_LOG"; }
for c in "role-start run_1 repo1 - spec claude opus nm - - system - lead|--run run_1 --keep-open --terminal tab_new" \
         "role-start run_1 repo1 - spec claude opus nm - - acctB - thinker|--run run_1 --keep-open --terminal tab_new" \
         "worker-start run_1 wtX spec muse muse-spark-1.3 - - - - studio|--run run_1 --keep-open --agent muse" \
         "worker-start run_1 wtX spec claude opus - - acctB - lead|--run run_1 --keep-open --terminal tab_new" \
         "worker-resume run_1 wtX spec opus - claude - thinker|--run run_1 --keep-open" \
         "lead-start run_1 task_1 repo1 claude opus nm|--run run_1 --keep-open --terminal tab_new" \
         "lead-worker-start run_1 task_1 wtL claude sonnet - - acctB|--run run_1 --keep-open --terminal tab_new"; do
  : > "$ORCA_LOG"; read -ra argv <<< "${c%%|*}"; "$ADAPTER" "${argv[@]}" >/dev/null 2>&1 || true
  has "standing: ${c%%|*} keeps its terminal open" "$(ws_line)" "${c#*|}"
done
for c in "role-start run_1 repo1 - spec claude opus nm - - system - builder" \
         "role-start run_1 repo1 - spec claude opus nm - - acctB - builder" \
         "worker-start run_1 wtX spec claude opus - - - - tester" \
         "worker-start run_1 wtX spec claude opus - - acctB" \
         "worker-resume run_1 wtX spec opus - claude - builder"; do
  : > "$ORCA_LOG"; read -ra argv <<< "$c"; "$ADAPTER" "${argv[@]}" >/dev/null 2>&1 || true
  eq  "not standing: $c starts once, without --keep-open" "$(ws_line | wc -l | tr -d ' '):$(ws_line | grep -c -- --keep-open || true)" "1:0"
done
unset DS_CLAUDE_SYSTEM_JSON_DIR

# run-dispatches (U64): each worktree's newest dispatch in the Run with its status, for liveness to see a
# standing role's dispatch settle. Scoped by --run (an unscoped worker-list is the caller's own Run).
: > "$ORCA_LOG"; got="$(run run-dispatches run_1)"
has "run-dispatches scopes worker-list to the Run" "$(cat "$ORCA_LOG")" "worker-list --run run_1 --json --full"
has "run-dispatches: the newest dispatch per worktree, with its status" "$got" "$(printf 'repo1::/p/lead\tctx_old\tcompleted')"
hasnt "run-dispatches: one row per worktree"     "$got" "ctx_live"
has "run-dispatches: a dispatch with no status is an empty column" "$got" "$(printf 'repo1::/p/dup\tctx_dupNew\t')"

# --- inbox-wait surfaces a real error, drops keepalive noise -----------------
err="$(run inbox-wait run_1 1000 del_bad 2>&1 >/dev/null)" && r=0 || r=$?
eq "inbox-wait rejection exits nonzero" "$r" "1"
has "inbox-wait surfaces rejection" "$err" "unknown delivery del_bad"
hasnt "inbox-wait drops keepalive"  "$err" "keepalive"

# --- send-run-worker: cross-Run delivery by worktree in run ----------------------
sentrun(){ printf '{"ok":true,"result":{"messages":[{"id":"msg_9","to_handle":"%s","run_id":"%s"}]}}' "$1" "${2:-run_x}"; }
sentmrun(){ printf '{"ok":true,"result":{"message":{"id":"msg_9","to_handle":"%s","run_id":"%s"}}}' "$1" "${2:-run_x}"; }
ORCA_SEND_OUT="$(sentrun term_live)" run send-run-worker run_x "repo1::/p/lead" s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "send-run-worker live worker -> ok" "$r" "0"
has "send-run-worker scopes @worktree: to the peer run" "$(cat "$ORCA_LOG")" "send --run run_x --to @worktree:repo1::/p/lead"
hasnt "send-run-worker looks up no dispatch" "$(cat "$ORCA_LOG")" "worker-list"
has "send-run-worker prints a receipt" "$(cat "$TMP/out")" "delivered to term_live (msg_9)"
ORCA_SEND_FAIL='terminal_not_found|No recipients resolved for group address: @worktree:repo1::/p/nobody' run send-run-worker run_x "repo1::/p/nobody" s b >/dev/null 2>"$TMP/err" && r=0 || r=$?
eq "send-run-worker no-terminal worktree -> exit 3" "$r" "3"
has "no-terminal says NOT delivered" "$(cat "$TMP/err")" "NOT delivered"
ORCA_SEND_FAIL='dispatch_run_mismatch|Dispatch ctx_1 belongs to Run run_own, not run_x' run send-run-worker run_x "repo1::/p/lead" s b >/dev/null 2>"$TMP/err" && r=0 || r=$?
eq "send-run-worker active sender dispatch -> exit 3" "$r" "3"
has "mismatch names the active dispatch" "$(cat "$TMP/err")" "ACTIVE dispatch"
ORCA_SEND_OUT="$(sentrun run:run_x)" run send-run-worker run_x "repo1::/p/lead" s b >/dev/null 2>&1 && r=0 || r=$?
eq "send-run-worker run:* receipt (misfile) -> exit 3" "$r" "3"
ORCA_SEND_OUT="$(sentrun term_live run_other)" run send-run-worker run_x "repo1::/p/lead" s b >/dev/null 2>&1 && r=0 || r=$?
eq "send-run-worker wrong-run receipt -> exit 3" "$r" "3"
ORCA_SEND_OUT="$(sentmrun term_live)" run send-run-worker run_x "repo1::/p/lead" s b >/dev/null 2>&1 && r=0 || r=$?
eq "send-run-worker accepts the message{} receipt shape too" "$r" "0"
ORCA_SEND_STDERR='warning: legacy_terminal_recipient' ORCA_SEND_OUT="$(sentrun term_live)" run send-run-worker run_x "repo1::/p/lead" s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "send-run-worker stderr noise on a good send -> still delivered" "$r" "0"
has "stderr noise: receipt still parsed" "$(cat "$TMP/out")" "delivered to term_live (msg_9)"
ORCA_SEND_FAIL_RC=0 ORCA_SEND_FAIL='terminal_not_found|No recipients resolved for group address: @worktree:repo1::/p/nobody' run send-run-worker run_x "repo1::/p/nobody" s b >/dev/null 2>"$TMP/err" && r=0 || r=$?
eq "send-run-worker ok:false with exit 0 -> exit 3" "$r" "3"
has "ok:false exit 0 still names the missing terminal" "$(cat "$TMP/err")" "no live terminal"
# U79: --to <handle> sends to that terminal, and a receipt for another terminal is no delivery.
ORCA_SEND_OUT="$(sentrun term_claude)" run send-run-worker --to term_claude run_x "repo1::/p/lead" s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "send-run-worker --to: delivered -> ok" "$r" "0"
has "send-run-worker --to passes the handle" "$(cat "$ORCA_LOG")" "send --run run_x --to term_claude"
hasnt "send-run-worker --to drops @worktree:" "$(cat "$ORCA_LOG")" "@worktree:"
has "send-run-worker --to receipt names the handle" "$(cat "$TMP/out")" "delivered to term_claude (msg_9)"
ORCA_SEND_OUT="$(sentrun term_bash)" run send-run-worker --to term_claude run_x "repo1::/p/lead" s b >/dev/null 2>"$TMP/err" && r=0 || r=$?
eq "send-run-worker --to: a receipt for another handle -> exit 3" "$r" "3"
has "the misdelivery names both terminals" "$(cat "$TMP/err")" "misdelivered: the receipt names term_bash, not term_claude"
ORCA_WORKER_SHOW='{"result":{"dispatch":{"id":"ctx_l","assigneeHandle":"term_claude"}}}' ORCA_SEND_OUT="$(sentrun dispatch:ctx_l)" \
  run send-run-worker --to term_claude run_x "repo1::/p/lead" s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "send-run-worker --to: a dispatch receipt on that terminal -> ok" "$r" "0"
has "the dispatch receipt is looked up" "$(cat "$ORCA_LOG")" "orchestration worker-show --dispatch ctx_l"
has "the dispatch receipt prints the terminal" "$(cat "$TMP/out")" "delivered to term_claude"
ORCA_WORKER_SHOW='{"result":{"dispatch":{"id":"ctx_b","assigneeHandle":"term_bash"}}}' ORCA_SEND_OUT="$(sentrun dispatch:ctx_b)" \
  run send-run-worker --to term_claude run_x "repo1::/p/lead" s b >/dev/null 2>"$TMP/err" && r=0 || r=$?
eq "send-run-worker --to: a dispatch receipt on another terminal -> exit 3" "$r" "3"
has "...named as misdelivered" "$(cat "$TMP/err")" "misdelivered: the receipt names term_bash"
ORCA_WORKER_SHOW='{"result":{}}' ORCA_SEND_OUT="$(sentrun dispatch:ctx_x)" run send-run-worker --to term_claude run_x "repo1::/p/lead" s b >/dev/null 2>&1 && r=0 || r=$?
eq "send-run-worker --to: a dispatch receipt it can't resolve -> exit 1 (in doubt)" "$r" "1"

# U79: terminal-shells lists plain terminals in worktrees with their idle/busy state from $DS_PROC;
# terminal-close closes one.
mkdir -p "$TMP/proc/100" "$TMP/proc/200" "$TMP/proc/300" "$TMP/proc/os"
printf '100 (bash) S 1 100 100 34816 100 0\n' >"$TMP/proc/100/stat"; printf 'HOME=/x\0ORCA_TERMINAL_HANDLE=term_idle\0' >"$TMP/proc/100/environ"
printf '200 (bash) S 1 200 200 34817 250 0\n' >"$TMP/proc/200/stat"; printf 'ORCA_TERMINAL_HANDLE=term_busy\0' >"$TMP/proc/200/environ"
printf '300 (a (b)) S 1 300 299 34818 300 0\n' >"$TMP/proc/300/stat"; printf 'ORCA_TERMINAL_HANDLE=term_busy\0' >"$TMP/proc/300/environ"  # not a session leader
mkdir -p "$TMP/proc/400"                                              # gone mid-scan: no stat
mkdir -p "$TMP/proc/500" "$TMP/proc/501"                              # a shell holding a stopped job (vim, Ctrl-Z)
printf '500 (bash) S 1 500 500 34819 500 0\n' >"$TMP/proc/500/stat"; printf 'ORCA_TERMINAL_HANDLE=term_job\0' >"$TMP/proc/500/environ"
printf '501 (vim) T 500 501 500 34819 500 0\n' >"$TMP/proc/501/stat"
shells='{"result":{"terminals":[
  {"handle":"term_idle","worktreeId":"repo1::/p/b","connected":true,"title":"bash","lastOutputAt":1800000000999},
  {"handle":"term_busy","worktreeId":"repo1::/p/b","connected":true,"title":"vim\tx"},
  {"handle":"term_unk","worktreeId":"repo1::/p/b","connected":true},
  {"handle":"term_job","worktreeId":"repo1::/p/b","connected":true,"title":"bash"},
  {"handle":"term_agent","worktreeId":"repo1::/p/b","connected":true,"agentIdentity":"claude"},
  {"handle":"term_orph","worktreeId":"repo1::/p/b","connected":true,"orphaned":true},
  {"handle":"term_nowt","connected":true}]}}'
out="$(DS_PROC="$TMP/proc" ORCA_TERM_PANES="$shells" run terminal-shells 2>"$TMP/err")" && r=0 || r=$?
eq "terminal-shells: ok" "$r" "0"
eq "terminal-shells: plain terminals in worktrees with their state" "$out" "$(printf 'repo1::/p/b\tterm_idle\tidle\t1800000000\tbash\nrepo1::/p/b\tterm_busy\tbusy\t-\tvim x\nrepo1::/p/b\tterm_unk\tunknown\t-\t\nrepo1::/p/b\tterm_job\tbusy\t-\tbash')"
eq "terminal-shells: a process gone mid-scan says nothing" "$(cat "$TMP/err")" ""
FAKE_TL_FAIL=1 run terminal-shells >/dev/null 2>&1 && r=0 || r=$?
eq "terminal-shells: unreadable list -> exit 1" "$r" "1"
ORCA_TERM_PANES='{"result":{}}' run terminal-shells >/dev/null 2>&1 && r=0 || r=$?
eq "terminal-shells: garbled list -> exit 1" "$r" "1"
eq "terminal-close: closed" "$(run terminal-close term_idle)" "terminal-close: closed term_idle"
has "terminal-close closes that terminal" "$(cat "$ORCA_LOG")" "terminal close --terminal term_idle"
rw="$(run run-workers run_x)"
has "run-workers: live worker row" "$rw" "$(printf 'repo1::/p/lead\tyes\tctx_live')"
has "run-workers: sibling live" "$rw" "$(printf 'repo1::/p/tester\tyes\tctx_sibling')"
has "run-workers: live row names its dispatch's terminal, task and status" "$rw" "$(printf 'repo1::/p/lead\tyes\tctx_live\tterm_live\t-\tdispatched')"
has "run-workers: no live dispatch -> the newest one's terminal" "$rw" "$(printf 'repo1::/p/dup\tno\t-\tterm_dupNew\t-')"
FAKE_WL_FAIL=1 run run-workers run_x >/dev/null 2>&1 && r=0 || r=$?
eq "run-workers: unreadable -> exit 1 (not an empty list)" "$r" "1"
FAKE_WL_FAIL=garbled run run-workers run_x >/dev/null 2>&1 && r=0 || r=$?
eq "run-workers: no worker array -> exit 1" "$r" "1"
# U215: the 7th column, reported. A 6-column consumer still parses (the first six fields are unchanged).
: > "$ORCA_LOG"
rw="$(FAKE_WL_REPORTED=1 run run-workers run_x)"
has "run-workers: completed newest row is reported" "$rw" "$(printf 'repo1::/p/done\tno\t-\tterm_done\t-\tcompleted\tyes')"
has "run-workers: failed by worker report is reported" "$rw" "$(printf 'repo1::/p/failrep\tno\t-\tterm_fr\t-\tfailed\tyes')"
has "run-workers: failed any other way is not reported" "$rw" "$(printf 'repo1::/p/failcrash\tno\t-\tterm_fc\t-\tfailed\tno')"
has "run-workers: a live worktree is not reported" "$rw" "$(printf 'repo1::/p/open\tyes\tctx_openold\tterm_o\t-\tdispatched\tno')"
eq "run-workers: worker-show only for failed newest rows without an open dispatch" "$(grep -c 'worker-show' "$ORCA_LOG")" "2"
eq "run-workers: 6-column consumer reads the same first six fields" "$(printf '%s\n' "$rw" | grep 'p/done' | cut -f1-6)" "$(printf 'repo1::/p/done\tno\t-\tterm_done\t-\tcompleted')"
# U234: a failed dispatch's verdict is read once and remembered in $STATE/loop/dispatch-reported.tsv.
CACHE="$DS_STATE_ROOT/loop/dispatch-reported.tsv"; rm -f "$CACHE"
wl() { jq -n --argjson ids "$1" '{result:{workers:[$ids[] | {dispatchId: ., dispatchStatus: "failed", agentTerminalHandle: ("t_" + .), resource:{worktreeId: ("repo1::/p/" + .)}}]}}'; }
wl '["ctx_failrep","ctx_failcrash","ctx_cfplain"]' > "$TMP/wl3.json"
export ORCA_PAUSE_WORKERS_FILE="$TMP/wl3.json"
rw1="$(run run-workers run_c)"; c1="$(grep -c 'worker-show' "$ORCA_LOG")"
rw2="$(run run-workers run_c)"; c2="$(grep -c 'worker-show' "$ORCA_LOG" || true)"
eq "run-workers cache: first call asks worker-show once per failed dispatch" "$c1" "3"
eq "run-workers cache: second call asks none" "$c2" "0"
eq "run-workers cache: second call prints the same lines" "$rw2" "$rw1"
has "run-workers cache: the worker_report verdict is kept" "$rw2" "$(printf 'repo1::/p/ctx_failrep\tno\t-\tt_ctx_failrep\t-\tfailed\tyes')"
wl '["ctx_failrep","ctx_failcrash","ctx_cfplain","ctx_cferr"]' > "$TMP/wl4.json"; export ORCA_PAUSE_WORKERS_FILE="$TMP/wl4.json"
rw3="$(run run-workers run_c)"
eq "run-workers cache: a new failed dispatch makes exactly one call" "$(grep -c 'worker-show' "$ORCA_LOG")" "1"
has "run-workers cache: a failed worker-show prints no" "$rw3" "$(printf 'repo1::/p/ctx_cferr\tno\t-\tt_ctx_cferr\t-\tfailed\tno')"
eq "run-workers cache: a failed worker-show is not remembered" "$(grep -c ctx_cferr "$CACHE")" "0"
run run-workers run_c >/dev/null; eq "run-workers cache: and is asked again next call" "$(grep -c 'worker-show' "$ORCA_LOG")" "1"
# trimming: over the limit keeps only the ids still listed; a garbled file reads as a miss.
{ for i in $(seq 1 30); do printf 'ctx_old%s\tno\n' "$i"; done; } >> "$CACHE"
DS_DISPATCH_CACHE_MAX=10 run run-workers run_c >/dev/null
eq "run-workers cache: over the limit drops ids no longer listed" "$(cut -f1 "$CACHE" | sort | tr '\n' ' ')" "ctx_cfplain ctx_failcrash ctx_failrep "
printf 'garbage\n\t\nctx_cfplain\n' > "$CACHE"
run run-workers run_c >/dev/null
eq "run-workers cache: a garbled file is a miss for every id" "$(grep -c "worker-show" "$ORCA_LOG")" "4"
unset ORCA_PAUSE_WORKERS_FILE; rm -f "$CACHE"
: > "$ORCA_LOG"
# U216: an injected (unsupervised) dispatch has resource null and the worktree only in projection.workspace.id.
rw="$(FAKE_WL_INJECTED=1 run run-workers run_x)"
has "run-workers: an injected open dispatch makes the member live" "$rw" "$(printf 'repo1::/p/rebound\tyes\tctx_inj_open\tterm_inj\t-\tdispatched')"
has "run-workers: an injected newest row is the worktree's newest" "$rw" "$(printf 'repo1::/p/newest\tno\t-\tterm_injd\t-\tcompleted\tyes')"
hasnt "run-workers: a row with neither field is skipped" "$rw" "term_none"
eq "run-workers: one line per worktree" "$(printf '%s\n' "$rw" | grep -c .)" "2"
: > "$ORCA_LOG"; FAKE_WL_INJECTED=1 "$ADAPTER" worker-stop run_x "repo1::/p/rebound" >/dev/null 2>&1
has "worker-stop finds the injected live dispatch" "$(cat "$ORCA_LOG")" "worker-stop --dispatch ctx_inj_open"
: > "$ORCA_LOG"; FAKE_WL_INJECTED=1 "$ADAPTER" worker-release run_x "repo1::/p/rebound" >/dev/null 2>&1
has "worker-release finds the injected dispatch" "$(cat "$ORCA_LOG")" "worker-release --dispatch ctx_inj_open"
eq "run-dispatches: the injected row is the worktree's newest" "$(FAKE_WL_INJECTED=1 run run-dispatches run_x | grep rebound)" "$(printf 'repo1::/p/rebound\tctx_inj_open\tdispatched')"
has "worker-detail lists the injected terminal" "$(FAKE_WL_INJECTED=1 run worker-detail run_x 2>&1)" "$(printf 'repo1::/p/rebound\tterm_inj')"
# --- agent-handles / task-spec / dispatch / dispatch-abandon (U71: rebind a member to its Run) ---
eq "agent-handles: only the connected agent terminal" "$(run agent-handles)" "$(printf 'repo1::/p/lead\ttab_l3\t')"
FAKE_TL_FAIL=1 run agent-handles >/dev/null 2>&1 && r=0 || r=$?
eq "agent-handles: unreadable -> exit 1" "$r" "1"
eq "task-spec: the task's spec" "$(run task-spec run_x task_lead)" "$(printf 'You are the Lead.\nRead the plan.')"
run task-spec run_x task_nope >/dev/null 2>&1 && r=0 || r=$?
eq "task-spec: unknown task -> exit 1" "$r" "1"
FAKE_TASKLIST_FAIL=1 run task-spec run_x task_lead >/dev/null 2>&1 && r=0 || r=$?
eq "task-spec: unreadable -> exit 1" "$r" "1"
eq "dispatch: prints the dispatch id" "$(DS_ORCA_FROM=term_loop run dispatch task_new term_lead run_x)" "ctx_new"
dl="$(cat "$ORCA_LOG")"
has "dispatch: --task --to --run" "$dl" "orchestration dispatch --task task_new --to term_lead --run run_x"
has "dispatch: --inject" "$dl" "--inject"
has "dispatch: from the coordinator" "$dl" "--from term_loop"
FAKE_DISPATCH_FAIL=1 run dispatch task_squad term_lead run_x >/dev/null 2>&1 && r=0 || r=$?
eq "dispatch: refused -> exit 1" "$r" "1"
FAKE_DISPATCH_NOID=1 run dispatch task_new term_lead run_x >/dev/null 2>&1 && r=0 || r=$?
eq "dispatch: no dispatch id -> exit 1" "$r" "1"
eq "dispatch-abandon: fences one dispatch" "$(run dispatch-abandon ctx_old)" "dispatch-abandon: fenced ctx_old"
has "dispatch-abandon: --dispatch" "$(cat "$ORCA_LOG")" "orchestration worker-abandon --dispatch ctx_old"
hasnt "dispatch-abandon: no --from" "$(DS_ORCA_FROM=term_loop run dispatch-abandon ctx_old >/dev/null; cat "$ORCA_LOG")" "--from"
FAKE_ABANDON_REFUSE=1 run dispatch-abandon ctx_old >/dev/null 2>&1 && r=0 || r=$?
eq "dispatch-abandon: refused -> exit 1" "$r" "1"
# --- wt-terminals: worktrees with a live terminal --------------------------------
eq "wt-terminals lists each worktree once (orphaned + wt-less rows excluded)" "$(run wt-terminals)" "repo1::/p/lead"
FAKE_TL_FAIL=1 run wt-terminals >/dev/null 2>&1 && r=0 || r=$?
eq "wt-terminals unreadable -> exit 1" "$r" "1"
run inbox-all-self >/dev/null; has "inbox-all-self -> check --all" "$(cat "$ORCA_LOG")" "check --all --json"
run inbox-all run_x >/dev/null; has "inbox-all -> check --run --all" "$(cat "$ORCA_LOG")" "check --run run_x --all --json"

# --- worker-done completes THIS terminal's dispatch (finish-unit.sh) ----------------
# Fixtures mirror the live shapes (host-confirmed 2026-10-28, docs/orca-notes.md):
# check --peek carries .result.dispatchId with zero unread; worker-show carries
# .result.dispatch.taskId + .assigneeHandle.
ORCA_TERMINAL_HANDLE=term_me run worker-done "finished U (PR #7)" "body text" >"$TMP/out" 2>&1 && r=0 || r=$?
eq "worker-done happy path exits 0" "$r" "0"
has "worker-done receipts the task" "$(cat "$TMP/out")" "completed task task_self (dispatch ctx_self)"
has "worker-done peeks its own dispatch" "$(cat "$ORCA_LOG")" "check --terminal term_me --peek --json"
has "worker-done resolves task via worker-show" "$(cat "$ORCA_LOG")" "worker-show --dispatch ctx_self --json"
has "worker-done sends from the assignee" "$(cat "$ORCA_LOG")" "--from term_self --type worker_done"
has "worker-done sends both ids + outcome" "$(cat "$ORCA_LOG")" "--task-id task_self --dispatch-id ctx_self --outcome succeeded"
# U3 (orca-backend-alternatives): finish-unit.sh --failed sends --outcome failed; any other outcome is refused.
: > "$ORCA_LOG"; ORCA_TERMINAL_HANDLE=term_me run worker-done --outcome failed "failed U" "why" >"$TMP/out" 2>&1 && r=0 || r=$?
eq "worker-done --outcome failed exits 0" "$r" "0"
has "worker-done --outcome failed sends failed" "$(cat "$ORCA_LOG")" "--task-id task_self --dispatch-id ctx_self --outcome failed"
: > "$ORCA_LOG"; ORCA_TERMINAL_HANDLE=term_me run worker-done --outcome maybe s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "worker-done --outcome maybe exits 2" "$r" "2"
eq "worker-done --outcome maybe issues no orca call" "$(wc -l < "$ORCA_LOG" | tr -d ' ')" "0"
: > "$ORCA_LOG"; rc=0; env -u ORCA_TERMINAL_HANDLE "$ADAPTER" worker-done s b >"$TMP/out" 2>&1 || rc=$?
eq "worker-done without a handle exits 1" "$rc" "1"
has "worker-done without a handle says why" "$(cat "$TMP/out")" "ORCA_TERMINAL_HANDLE"
eq "worker-done without a handle issues no orca call" "$(wc -l < "$ORCA_LOG" | tr -d ' ')" "0"
ORCA_CHECK_SELF='{"result":{}}' ORCA_TERMINAL_HANDLE=term_me run worker-done s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "worker-done with no dispatch exits 1" "$r" "1"
has "worker-done with no dispatch hints at already-sent" "$(cat "$TMP/out")" "already sent"
hasnt "worker-done with no dispatch sends nothing" "$(cat "$ORCA_LOG")" "orchestration send"
ORCA_WORKER_SHOW='{"result":{"dispatch":{}}}' ORCA_TERMINAL_HANDLE=term_me run worker-done s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "worker-done with unresolvable task exits 1" "$r" "1"
has "worker-done with unresolvable task says so" "$(cat "$TMP/out")" "could not resolve"
hasnt "worker-done with unresolvable task sends nothing" "$(cat "$ORCA_LOG")" "orchestration send"
ORCA_SEND_FAIL='dispatch_inactive|gone' ORCA_TERMINAL_HANDLE=term_me run worker-done s b >"$TMP/out" 2>&1 && r=0 || r=$?
eq "worker-done with refused send exits 1" "$r" "1"
has "worker-done with refused send names the task" "$(cat "$TMP/out")" "task_self"

# --- one worktree per name under a crash (U38) --------------------------------
# The killed loop's adapter child (the orphan) and the restarted loop's replay run at once.
# Every case gets its own world and state root, so no lock or mark carries over.
export DS_ORCA_DATA="$TMP/orcadata" DS_CLAUDE_SYSTEM_JSON_DIR="$TMP/sysjson"
mkdir -p "$DS_ORCA_DATA/claude-profiles/acctB/home" "$DS_CLAUDE_SYSTEM_JSON_DIR"
fresh_world() {
  W="$(mktemp -d "$TMP/world.XXXXXX")"; mkdir -p "$W/wts" "$W/req"; : > "$W/workers"; : > "$W/tabs"
  export DS_STATE_ROOT="$W/state"; LOCKS="$DS_STATE_ROOT/.wt-locks"; mkdir -p "$LOCKS"
  : > "$ORCA_LOG"
}
wts()     { find "$W/wts" -name .wt -printf '%h\n' | sed "s|^$W/wts/||" | sort | tr '\n' ' '; }
workers() { grep -c . "$W/workers" || true; }
creates() { grep -c '^worktree create' "$ORCA_LOG" || true; }
locks()   { find "$LOCKS" -mindepth 1 -maxdepth 1 -name '*.lock' | wc -l | tr -d ' '; }
dead_pid() { sh -c 'exit 0' & local p=$!; wait "$p" || true; printf '%s' "$p"; }

fresh_world
FAKE_WT_DIR="$W" FAKE_WT_SLEEP=1 "$ADAPTER" wt-create repo1 nm >"$W/a" 2>&1 & a=$!
FAKE_WT_DIR="$W" FAKE_WT_SLEEP=1 "$ADAPTER" wt-create repo1 nm >"$W/b" 2>&1 & b=$!
wait "$a" && ra=0 || ra=$?; wait "$b" && rb=0 || rb=$?
eq "two creates of one name: both succeed"     "$ra$rb" "00"
eq "two creates of one name: one worktree"     "$(wts)" "nm "
eq "two creates of one name: one create"       "$(creates)" "1"
eq "two creates of one name: the first has it" "$(cat "$W/a")" "wt:nm"
eq "two creates of one name: the same id"      "$(cat "$W/b")" "wt:nm"
eq "the lock is gone after the create"         "$(locks)" "0"

# A lock left by a dead run never blocks a create, and however many runs find it, one create.
fresh_world; mkdir "$LOCKS/nm.lock"; : > "$LOCKS/nm.lock/pid.$(dead_pid)"
pids=(); for i in 1 2 3 4 5; do FAKE_WT_DIR="$W" FAKE_WT_SLEEP=0.3 "$ADAPTER" wt-create repo1 nm >"$W/o$i" 2>"$W/e$i" & pids+=($!); done
rcs=""; for p in "${pids[@]}"; do if wait "$p"; then rcs+=0; else rcs+=1; fi; done
eq "a dead holder's lock is taken over"        "$rcs" "00000"
eq "a dead holder's lock: one worktree"        "$(wts)" "nm "
eq "a dead holder's lock: one create"          "$(creates)" "1"
eq "a dead holder's lock: all get the same id" "$(for i in 1 2 3 4 5; do printf '%s\n' "$(cat "$W/o$i")"; done | sort -u | tr -d '\n')" "wt:nm"
has "a dead holder's lock: the takeover is logged" "$(cat "$W"/e[1-5])" "took over the lock of nm"
eq "a dead holder's lock is gone afterwards"   "$(locks)" "0"

# A lock with no pid yet is a holder between its two steps; old, it is a holder that died there.
fresh_world; mkdir "$LOCKS/nm.lock"
rc=0; FAKE_WT_DIR="$W" DS_WT_LOCK_WAIT=0 "$ADAPTER" wt-create repo1 nm >"$W/out" 2>&1 || rc=$?
eq "a fresh lock with no pid is respected"     "$rc:$(creates)" "1:0"
touch -d '1 minute ago' "$LOCKS/nm.lock"
eq "an old lock with no pid is taken over"     "$(FAKE_WT_DIR="$W" DS_WT_LOCK_WAIT=2 "$ADAPTER" wt-create repo1 nm 2>/dev/null)" "wt:nm"

# A live holder that outlasts the wait: a non-zero exit, no create, its lock untouched.
fresh_world; sleep 60 & holder=$!; mkdir "$LOCKS/nm.lock"; : > "$LOCKS/nm.lock/pid.$holder"
rc=0; FAKE_WT_DIR="$W" DS_WT_LOCK_WAIT=1 "$ADAPTER" wt-create repo1 nm >"$W/out" 2>&1 || rc=$?
eq  "a live holder outlasts the wait: non-zero" "$rc" "1"
eq  "a live holder outlasts the wait: no create" "$(creates):$(wts)" "0:"
has "a live holder outlasts the wait: says who" "$(cat "$W/out")" "pid $holder"
eq  "a live holder keeps its lock"              "$(ls "$LOCKS/nm.lock")" "pid.$holder"
has "a live holder: the loop reads it as pending" "$(cat "$W/out")" "still pending"
# ... and a different name is not blocked by it.
eq  "a different name is not blocked"           "$(FAKE_WT_DIR="$W" DS_WT_LOCK_WAIT=0 "$ADAPTER" wt-create repo1 other 2>/dev/null)" "wt:other"
kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true

# A name that is no file name still gets its own lock.
fresh_world
eq "a name with a slash locks fine"             "$(FAKE_WT_DIR="$W" DS_WT_LOCK_WAIT=0 "$ADAPTER" wt-create repo1 a/b 2>/dev/null)" "wt:a/b"

# The lock is released before the worker start: a start that long-polls holds nothing up.
fresh_world
FAKE_WT_DIR="$W" FAKE_WS_AFTER="$W/go" DS_ORCA_RETRY_REQUEST=rq_h DS_WORKER_START_RETRIES=1 \
  "$ADAPTER" role-start run_1 repo1 - spec claude opus nm >/dev/null 2>&1 & a=$!
until [ -e "$W/wts/nm/.wt" ] && [ "$(locks)" = 0 ]; do kill -0 "$a" 2>/dev/null || break; sleep 0.05; done
eq "no lock while the worker start is waiting"  "$(FAKE_WT_DIR="$W" DS_WT_LOCK_WAIT=0 "$ADAPTER" wt-create repo1 nm 2>/dev/null)" "wt:nm"
: > "$W/go"; wait "$a" || true

# Each order: whichever of the orphan and the replay reaches the worker start first, one worktree,
# one worker, and neither run fails, so the wish ends running. On a managed account also one tab.
# start_run <run> <file to wait for> <account or -> <retry id> -> $W/<run>.out, .err, .done
start_run() {
  FAKE_WT_DIR="$W" FAKE_WT_SLEEP=0.5 FAKE_WS_AFTER="$2" FAKE_WS_MARK="$W/$1.done" \
    DS_ORCA_RETRY_REQUEST="$4" DS_WORKER_START_RETRIES=1 \
    "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - "$3" >"$W/$1.out" 2>"$W/$1.err"
}
for order in orphan replay; do
  for acct in - acctB; do
    label="$order first, account $acct"
    fresh_world; : > "$W/now"
    case "$order" in
      orphan) orphan_after="$W/now"; replay_after="$W/orphan.done" ;;
      replay) orphan_after="$W/replay.done"; replay_after="$W/now" ;;
    esac
    start_run orphan "$orphan_after" "$acct" "rq_$order" & a=$!
    start_run replay "$replay_after" "$acct" "rq_$order" & b=$!
    wait "$a" && ra=0 || ra=$?; wait "$b" && rb=0 || rb=$?
    eq  "$label: both runs succeed"     "$ra$rb" "00"
    eq  "$label: one worktree"          "$(wts)" "nm "
    eq  "$label: one worker"            "$(workers)" "1"
    eq  "$label: both print its id"     "$(printf '%s\n' "$(cat "$W/orphan.out")" "$(cat "$W/replay.out")" | sort -u | tr -d '\n')" "wt:nm"
    hasnt "$label: no request_mismatch" "$(cat "$W/orphan.err" "$W/replay.err")" "request_mismatch"
    if [ "$acct" = acctB ]; then eq "$label: one tab" "$(grep -c . "$W/tabs")" "1"; fi
  done
done
# A replay after the start finished finds the id's tab again.
fresh_world; rc=0
for _ in 1 2; do FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_keep DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || rc=$?; done
eq "a replay of a finished start: one tab, one worker" "$rc:$(grep -c . "$W/tabs"):$(workers)" "0:1:1"
# A recorded tab that closed, no receipt: the replay opens one and starts in it.
fresh_world
FAKE_WT_DIR="$W" FAKE_WS_REFUSE=1 FAKE_RS_FAIL=1 DS_ORCA_RETRY_REQUEST=rq_gone DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || true
: > "$W/tabs"
rc=0; FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_gone DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || rc=$?
eq "a closed tab with no receipt is replaced"   "$rc:$(grep -c . "$W/tabs"):$(workers)" "0:1:1"
# A recorded tab that closed, the start landed: no tab, the same input, the recorded outcome.
fresh_world
FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_land DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || true
: > "$W/tabs"
rc=0; FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_land DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >"$W/out" 2>&1 || rc=$?
eq  "a closed tab under a landed id: it succeeds, no new tab, one worker" "$rc:$(grep -c . "$W/tabs" || true):$(workers)" "0:0:1"
has "a closed tab under a landed id: prints the worktree" "$(cat "$W/out")" "wt:nm"
hasnt "a closed tab under a landed id: no request_mismatch" "$(cat "$W/out")" "request_mismatch"
# A recorded tab that closed, Orca still on it or no answer: no new tab, the loop reads it as pending.
for how in "FAKE_RS_STATE=pending" "FAKE_RS_FAIL=1"; do
  fresh_world
  FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_wait DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || true
  : > "$W/tabs"
  rc=0; env "$how" FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_wait DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >"$W/out" 2>&1 || rc=$?
  eq  "a closed tab, $how: fails with no new tab" "$([ "$rc" != 0 ] && echo failed):$(grep -c . "$W/tabs" || true)" "failed:0"
  has "a closed tab, $how: still pending"        "$(cat "$W/out")" "still pending"
done
# No word on the recorded tab: the run fails and opens none, and the replay finds it.
fresh_world
FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_blip DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || true
rc=0; FAKE_WT_DIR="$W" FAKE_TL_FAIL=1 DS_ORCA_RETRY_REQUEST=rq_blip DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >"$W/out" 2>&1 || rc=$?
eq "an unreadable terminal list fails the run"  "$([ "$rc" != 0 ] && echo failed):$(grep -c . "$W/tabs")" "failed:1"
has "an unreadable terminal list says so"       "$(cat "$W/out")" "cannot tell whether tab"
rc=0; FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_blip DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || rc=$?
eq "and the replay after it uses the one tab"   "$rc:$(grep -c . "$W/tabs"):$(workers)" "0:1:1"
has "an unreadable terminal list: the loop reads it as pending" "$(cat "$W/out")" "still pending"

# A resume replay, on an account and on the default login: one tab, one worker, the same input.
for acct in acctB -; do
  fresh_world; rc=0
  for _ in 1 2 3; do FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_res DS_WORKER_START_RETRIES=1 "$ADAPTER" worker-resume run_1 wt:nm spec opus "$acct" claude >"$W/out" 2>&1 || rc=$?; done
  eq "a resume replay on account $acct: one tab, one worker" "$rc:$(grep -c . "$W/tabs"):$(workers)" "0:1:1"
  : > "$W/tabs"; rc=0
  FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_res DS_WORKER_START_RETRIES=1 "$ADAPTER" worker-resume run_1 wt:nm spec opus "$acct" claude >"$W/out" 2>&1 || rc=$?
  eq "a landed resume whose tab closed, account $acct: no new tab, no mismatch" "$rc:$(grep -c . "$W/tabs" || true)" "0:0"
  # Refused under ids the loop gives anew: every tab closes.
  fresh_world
  for id in rq_a rq_b; do FAKE_WT_DIR="$W" FAKE_WS_REFUSE=1 DS_ORCA_RETRY_REQUEST="$id" DS_WORKER_START_RETRIES=1 "$ADAPTER" worker-resume run_1 wt:nm spec opus "$acct" claude >/dev/null 2>&1 || true; done
  eq "a refused resume on account $acct leaves no tab" "$(grep -c . "$W/tabs" || true)" "0"
done

# A failed worktree list is not an empty one: no create beside the live worktree.
fresh_world; FAKE_WT_DIR="$W" "$ADAPTER" wt-create repo1 nm >/dev/null 2>&1
rc=0; FAKE_WT_DIR="$W" FAKE_PS_FAIL=1 "$ADAPTER" wt-create repo1 nm >"$W/out" 2>&1 || rc=$?
eq  "a failed list: non-zero, no second worktree" "$([ "$rc" != 0 ] && echo failed):$(creates):$(wts)" "failed:1:nm "
has "a failed list: the loop reads it as pending" "$(cat "$W/out")" "still pending"

# A start Orca refused, under ids the loop gives anew: every tab closes, no record stays.
fresh_world
for id in rq_r1 rq_r2 rq_r3; do
  FAKE_WT_DIR="$W" FAKE_WS_REFUSE=1 DS_ORCA_RETRY_REQUEST="$id" DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || true
done
eq "a refused start leaves no tab"              "$(grep -c . "$W/tabs" || true)" "0"
eq "a refused start leaves no record of a tab"  "$(find "$LOCKS" -name '*.handle' | wc -l | tr -d ' ')" "0"
eq "a refused start leaves no lock"             "$(locks)" "0"
# Under the same id, no word from request-show: the tab stays for the replay.
fresh_world
FAKE_WT_DIR="$W" FAKE_WS_REFUSE=1 FAKE_RS_FAIL=1 DS_ORCA_RETRY_REQUEST=rq_doubt DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || true
eq "no answer on a failed start: the tab stays" "$(grep -c . "$W/tabs")" "1"
rc=0; FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_doubt DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || rc=$?
eq "and the replay runs in it"                  "$rc:$(grep -c . "$W/tabs"):$(workers)" "0:1:1"
# No retry id: the tab of a failed start closes, as ever.
fresh_world
FAKE_WT_DIR="$W" FAKE_WS_REFUSE=1 DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || true
eq "no retry id: a failed start's tab closes"   "$(grep -c . "$W/tabs" || true)" "0"
# A failed start closes every terminal it left in its worktree: a new worktree's first shell, the agent
# tab Orca opened (U59). Another worktree's tabs, and the worktree's own from before, stay.
tabs_in() { awk -F'\t' -v w="$1" '$2 == w' "$W/tabs" | grep -c . || true; }
fresh_world; printf 'tab_other\twt:elsewhere\n' > "$W/tabs"
FAKE_WT_DIR="$W" FAKE_WT_SHELL=1 FAKE_WS_TAB=1 FAKE_WS_REFUSE=1 DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec muse muse-spark-1.3 nm >/dev/null 2>&1 || true
eq "a failed role start leaves no tab in its new worktree" "$(tabs_in wt:nm):$(tabs_in wt:elsewhere)" "0:1"
printf 'tab_pane\twt:nm\n' >> "$W/tabs"
FAKE_WT_DIR="$W" FAKE_WS_TAB=1 FAKE_WS_REFUSE=1 DS_WORKER_START_RETRIES=1 "$ADAPTER" worker-start run_1 wt:nm spec muse muse-spark-1.3 >/dev/null 2>&1 || true
eq "a failed restart keeps only the tab that was there"    "$(awk -F'\t' '$2 == "wt:nm" {print $1}' "$W/tabs")" "tab_pane"
FAKE_WT_DIR="$W" FAKE_WS_TAB=1 FAKE_WS_REFUSE=1 FAKE_RS_FAIL=1 DS_ORCA_RETRY_REQUEST=rq_tabs DS_WORKER_START_RETRIES=1 "$ADAPTER" worker-start run_1 wt:nm spec muse muse-spark-1.3 >/dev/null 2>&1 || true
eq "no answer for its retry id: the agent tab stays"       "$(tabs_in wt:nm)" "2"
fresh_world
FAKE_WT_DIR="$W" FAKE_WT_SHELL=1 FAKE_WS_TAB=1 DS_ORCA_RETRY_REQUEST=rq_took DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec muse muse-spark-1.3 nm >/dev/null 2>&1 || true
eq "a start that took keeps its tabs"                      "$(tabs_in wt:nm):$(workers)" "2:1"
# U118: the pause decision belongs before the launch. A pause that lands as the tab opens leaves the
# start to finish: the bind and its cleanup are not refused, so no agent is left unrecorded.
# The adapter itself runs in Bun (U226): the fake fences only check-activity and hands the rest to the real bun.
mkdir -p "$TMP/fence"
printf '#!/usr/bin/env bash\ncase "${1:-}" in *check-activity.ts) [ ! -e "$FAKE_FENCE" ] || { echo "activity: paused" >&2; exit 75; }; exit 0 ;; esac\nexec %q "$@"\n' "$(command -v bun)" > "$TMP/fence/bun"; chmod +x "$TMP/fence/bun"
fence() { PATH="$TMP/fence:$PATH" FAKE_WT_DIR="$W" FAKE_FENCE="$W/paused" DS_LOOP_ACTIVITY='{}' DS_WORKER_START_RETRIES=1 "$@"; }
with_wt() { fresh_world; mkdir -p "$W/wts/nm"; : > "$W/wts/nm/.wt"; }
ntabs() { grep -c . "$W/tabs" || true; }
fresh_world; rc=0
fence env FAKE_TC_PAUSE="$W/paused" DS_ORCA_RETRY_REQUEST=rq_p1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >"$W/out" 2>"$W/err" || rc=$?
eq "pause after the launch: a role start finishes, one agent" "$rc:$(cat "$W/out"):$(ntabs):$(workers)" "0:wt:nm:1:1"
hasnt "pause after the launch: nothing is refused"            "$(cat "$W/err")" "activity: paused"
with_wt; rc=0
fence env FAKE_TC_PAUSE="$W/paused" DS_ORCA_RETRY_REQUEST=rq_p2 "$ADAPTER" worker-start run_1 wt:nm spec claude opus - - acctB >/dev/null 2>&1 || rc=$?
eq "pause after the launch: a fresh restart finishes"         "$rc:$(ntabs):$(workers)" "0:1:1"
with_wt; rc=0
fence env FAKE_TC_PAUSE="$W/paused" DS_ORCA_RETRY_REQUEST=rq_p3 "$ADAPTER" worker-resume run_1 wt:nm spec opus - claude - builder >/dev/null 2>&1 || rc=$?
eq "pause after the launch: a resume finishes"                "$rc:$(ntabs):$(workers)" "0:1:1"
with_wt; rc=0
fence env FAKE_TC_PAUSE="$W/paused" DS_ORCA_RETRY_REQUEST=rq_p4 "$ADAPTER" worker-resume run_1 wt:nm spec opus acctB claude - builder >/dev/null 2>&1 || rc=$?
eq "pause after the launch: a resume on an account finishes"  "$rc:$(ntabs):$(workers)" "0:1:1"
# A launch that fails after the pause is cleaned up: its close is not refused either.
with_wt
fence env FAKE_TC_PAUSE="$W/paused" FAKE_TUI_FAIL=1 "$ADAPTER" worker-resume run_1 wt:nm spec opus - claude - builder >/dev/null 2>&1 || true
eq "pause after the launch: a tab that never came up closes"  "$(ntabs):$(workers)" "0:0"
with_wt
fence env FAKE_TC_PAUSE="$W/paused" FAKE_WS_REFUSE=1 DS_ORCA_RETRY_REQUEST=rq_p5 "$ADAPTER" worker-resume run_1 wt:nm spec opus - claude - builder >/dev/null 2>&1 || true
eq "pause after the launch: a refused bind closes its tab"    "$(ntabs):$(workers)" "0:0"
# A pause before the launch starts nothing, with or without a worktree.
fresh_world; : > "$W/paused"; rc=0
fence env DS_ORCA_RETRY_REQUEST=rq_p6 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>"$W/err" || rc=$?
eq "pause before the worktree: nothing starts"                "$rc:$(wts):$(ntabs):$(workers)" "1::0:0"
has "pause before the worktree: the refusal says so"          "$(cat "$W/err")" "activity: paused"
with_wt; : > "$W/paused"; rc=0
fence env DS_ORCA_RETRY_REQUEST=rq_p7 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || rc=$?
eq "pause before the launch: no tab, no worker"               "$rc:$(ntabs):$(workers)" "1:0:0"
with_wt; : > "$W/paused"; rc=0
fence env DS_ORCA_RETRY_REQUEST=rq_p8 "$ADAPTER" worker-resume run_1 wt:nm spec opus - claude - builder >/dev/null 2>&1 || rc=$?
eq "pause before the launch: a resume starts nothing"         "$rc:$(ntabs):$(workers)" "1:0:0"
# A crash between launch and bind: the tab was recorded as it opened, so a replay under the same
# retry id binds that tab, paused or not, and opens no second one.
crash_start() { { FAKE_WT_DIR="$W" FAKE_TW_CRASH="$W/crashed" DS_ORCA_RETRY_REQUEST="$1" DS_WORKER_START_RETRIES=1 setsid --wait "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1; } 2>/dev/null || true; }
fresh_world; crash_start rq_c1; rc=0
eq "a crash in the TUI wait leaves its tab, no worker"        "$(ntabs):$(workers)" "1:0"
FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_c1 DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || rc=$?
eq "its replay binds that tab, no second agent"               "$rc:$(ntabs):$(workers)" "0:1:1"
has "the replay waits for the tab's TUI first"                "$(cat "$ORCA_LOG")" "terminal wait"
fresh_world; crash_start rq_c2; : > "$W/paused"; rc=0
fence env DS_ORCA_RETRY_REQUEST=rq_c2 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >"$W/out" 2>&1 || rc=$?
eq "a paused replay of a launched start finishes it"          "$rc:$(ntabs):$(workers)" "0:1:1"
# A recorded tab whose TUI never comes up closes, as the first run would have closed it: a replay
# that called it pending would spin on it and hold a pause in Pausing.
fresh_world; crash_start rq_c4; rc=0
FAKE_WT_DIR="$W" FAKE_TUI_FAIL=1 DS_ORCA_RETRY_REQUEST=rq_c4 DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>"$W/err" || rc=$?
eq "a replay whose tab never comes up closes it"              "$rc:$(ntabs):$(workers)" "1:0:0"
hasnt "and fails for good, so the start can give up"          "$(cat "$W/err")" "still pending"
# A recorded tab that closed launched nothing that lives: a paused replay opens no new one.
fresh_world; crash_start rq_c3; : > "$W/tabs"; : > "$W/paused"; rc=0
fence env DS_ORCA_RETRY_REQUEST=rq_c3 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - acctB >/dev/null 2>&1 || rc=$?
eq "a paused replay whose tab closed starts nothing"          "$rc:$(ntabs):$(workers)" "1:0:0"
# A start Orca already took answers its replay, paused or not, on either path.
for acct in - acctB; do
  fresh_world; rc=0
  FAKE_WT_DIR="$W" DS_ORCA_RETRY_REQUEST=rq_d DS_WORKER_START_RETRIES=1 "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - "$acct" >/dev/null 2>&1
  : > "$W/paused"
  fence env DS_ORCA_RETRY_REQUEST=rq_d "$ADAPTER" role-start run_1 repo1 - spec claude opus nm - - "$acct" >"$W/out" 2>/dev/null || rc=$?
  eq "a paused replay of a landed start, account $acct"       "$rc:$(cat "$W/out"):$(workers)" "0:wt:nm:1"
done
# A Lead restart closes its worktree's tabs but the loop's pane there (U59).
fresh_world; printf 'tab_loop\twt:lead\ntab_old\twt:lead\ntab_older\twt:lead\ntab_other\twt:b\n' > "$W/tabs"
FAKE_WT_DIR="$W" "$ADAPTER" terminal-close-worktree id:wt:lead tab_loop >/dev/null 2>&1
eq "closing a worktree's tabs keeps the one named" "$(cut -f1 "$W/tabs" | tr '\n' ' ')" "tab_loop tab_other "

# Waiters that find one abandoned empty lock together: each create runs alone, so one worktree.
fresh_world; mkdir "$LOCKS/nm.lock"; touch -d '1 minute ago' "$LOCKS/nm.lock"
for i in 1 2 3 4 5 6; do FAKE_WT_DIR="$W" FAKE_WT_SLEEP=0.3 "$ADAPTER" wt-create repo1 nm >"$W/o$i" 2>/dev/null & done
wait
eq "an abandoned empty lock: one worktree"      "$(wts)" "nm "
eq "an abandoned empty lock: all have its id"   "$(cat "$W"/o? | sed 's/wt:nm/x/g')" "xxxxxx"
eq "an abandoned empty lock: no lock left"      "$(locks)" "0"

# --- every account's projects is a link to the system login's (U39) -------------
unset FAKE_WT_DIR
lp_world() {
  LP="$(mktemp -d "$TMP/lp.XXXXXX")"
  export DS_ORCA_DATA="$LP/orca" DS_CLAUDE_HOME="$LP/sys" DS_STATE_ROOT="$LP/state"
  SYSP="$DS_CLAUDE_HOME/projects"; PH="$DS_ORCA_DATA/claude-profiles/acctC/home"; PP="$PH/projects"
  mkdir -p "$PH" "$SYSP"; : > "$ORCA_LOG"
}
lp_start() { "$ADAPTER" worker-start run_1 "id:repo1::/w/lp" spec claude opus 2>"$LP/err" >/dev/null || true; }
started()  { grep -c 'orchestration worker-start' "$ORCA_LOG" || true; }

lp_world; rm -rf "$SYSP"; lp_start
eq  "projects missing: gets the link"           "$(readlink "$PP")" "$SYSP"
eq  "projects missing: the system login's folder is made" "$([ -d "$SYSP" ] && echo yes)" "yes"
eq  "projects missing: no warning"              "$(cat "$LP/err")" ""
eq  "projects missing: the worker starts"       "$(started)" "1"

lp_world; mkdir -p "$PP/-w-a/sess/sub" "$PP/-w-a/memory" "$PP/-w-b" "$SYSP/-w-a/memory"
printf new > "$PP/-w-a/s1.jsonl"; printf old > "$SYSP/-w-a/s1.jsonl"
printf same > "$PP/-w-a/s2.jsonl"; printf same > "$SYSP/-w-a/s2.jsonl"
printf tool > "$PP/-w-a/sess/sub/t.txt"; printf only > "$PP/-w-b/s3.jsonl"
printf mine > "$PP/-w-a/memory/MEMORY.md"; printf theirs > "$SYSP/-w-a/memory/MEMORY.md"
printf taken > "$SYSP/-w-a/s1.from-acctC-1.jsonl"
lp_start
eq  "real folder: replaced by the link"         "$(readlink "$PP")" "$SYSP"
eq  "real folder: a new file moves across"      "$(cat "$SYSP/-w-b/s3.jsonl")" "only"
eq  "real folder: a nested file moves across"   "$(cat "$SYSP/-w-a/sess/sub/t.txt")" "tool"
eq  "real folder: same name, other bytes: nothing overwritten" "$(cat "$SYSP/-w-a/s1.jsonl")" "old"
eq  "real folder: same name, other bytes: an earlier kept copy stays" "$(cat "$SYSP/-w-a/s1.from-acctC-1.jsonl")" "taken"
eq  "real folder: same name, other bytes: kept beside it, still a .jsonl" "$(cat "$SYSP/-w-a/s1.from-acctC-2.jsonl")" "new"
eq  "real folder: a memory file too"            "$(cat "$SYSP/-w-a/memory/MEMORY.md") $(cat "$SYSP/-w-a/memory/MEMORY.from-acctC-1.md")" "theirs mine"
eq  "real folder: same bytes: one copy"         "$(find "$SYSP/-w-a" -maxdepth 1 -name 's2*' | wc -l | tr -d ' ')" "1"
has "real folder: a kept copy is reported"      "$(cat "$LP/err")" "kept both"
eq  "real folder: the worker starts"            "$(started)" "1"
eq  "real folder: the lock is released"         "$(find "$DS_STATE_ROOT" -name '*.lock' | wc -l | tr -d ' ')" "0"

lp_world; ln -s "$SYSP" "$PP"; before="$(stat -c '%i %Y' "$PP")"; lp_start
eq  "the right link: untouched"                 "$(stat -c '%i %Y' "$PP")" "$before"
eq  "the right link: no warning"                "$(cat "$LP/err")" ""
eq  "the right link: takes no lock"             "$([ -e "$DS_STATE_ROOT" ] && find "$DS_STATE_ROOT" -name '*.lock' | wc -l | tr -d ' ' || echo 0)" "0"

lp_world; rm -rf "$SYSP"; mkdir -p "$PP/-w-a"; printf s > "$PP/-w-a/s.jsonl"; ln -s "$PP" "$SYSP"; lp_start
eq  "the system login's folder links into the account's: its files stay" "$(cat "$PP/-w-a/s.jsonl")" "s"
eq  "the system login's folder links into the account's: no change" "$([ -L "$PP" ] && echo link || echo folder)" "folder"
eq  "the system login's folder links into the account's: the worker starts" "$(started)" "1"
lp_world; rm -rf "$DS_CLAUDE_HOME"; mkdir -p "$PH/projects/-w-a"; printf s > "$PP/-w-a/s.jsonl"; ln -s "$PH" "$DS_CLAUDE_HOME"; lp_start
eq  "an account home that is the system login's: its files stay" "$(cat "$PP/-w-a/s.jsonl")" "s"

lp_world; mkdir -p "$PP/-w-a"; printf s > "$PP/-w-a/s.jsonl"; ln -s "$PP/-w-a" "$SYSP/-w-a"; lp_start
eq  "a session folder linked into the account's: its file stays" "$(cat "$PP/-w-a/s.jsonl")" "s"
eq  "a session folder linked into the account's: the account stays a folder" "$([ -L "$PP" ] && echo link || echo folder)" "folder"
has "a session folder linked into the account's: a warning" "$(cat "$LP/err")" "could not move"
eq  "a session folder linked into the account's: the worker starts" "$(started)" "1"
lp_world; mkdir -p "$SYSP/-w-a" "$PP/-w-a"; printf s > "$SYSP/-w-a/s.jsonl"; ln -s "$SYSP/-w-a/s.jsonl" "$PP/-w-a/s.jsonl"; lp_start
eq  "an account file linking to the system login's: the file stays" "$(cat "$SYSP/-w-a/s.jsonl")" "s"
eq  "an account file linking to the system login's: the account is linked" "$([ -L "$PP" ] && echo link || echo folder)" "link"

lp_world; mkdir -p "$PP/-w-a" "$PP/-w-b"; printf a > "$PP/-w-a/a.jsonl"; printf b > "$PP/-w-b/b.jsonl"; printf x > "$SYSP/-w-b"; lp_start
eq  "one file that cannot move: nothing moves" "$(cat "$PP/-w-a/a.jsonl")$(cat "$PP/-w-b/b.jsonl")" "ab"
eq  "one file that cannot move: nothing went across" "$([ -e "$SYSP/-w-a" ] && echo there || echo none)" "none"
has "one file that cannot move: a warning" "$(cat "$LP/err")" "nothing moved"
eq  "one file that cannot move: the worker starts" "$(started)" "1"

lp_world; mv "$DS_ORCA_DATA" "$LP/orca-custom"
env -u DS_ORCA_DATA ORCA_USER_DATA_PATH="$LP/orca-custom" "$ADAPTER" worker-start run_1 "id:repo1::/w/lp" spec claude opus >/dev/null 2>&1 || true
eq  "accounts under ORCA_USER_DATA_PATH get the link" "$(readlink "$LP/orca-custom/claude-profiles/acctC/home/projects")" "$SYSP"

# The blocked file in the middle: whichever order find takes, one folder is listed before it.
lp_world; mkdir -p "$PP/-w-a" "$PP/-w-m" "$PP/-w-z"; printf 1 > "$PP/-w-a/a.jsonl"; printf 2 > "$PP/-w-m/m.jsonl"; printf 3 > "$PP/-w-z/z.jsonl"; printf x > "$SYSP/-w-m"; lp_start
eq  "a blocked file: no folder is made" "$(find "$SYSP" -mindepth 1 -type d | wc -l | tr -d ' ')" "0"

lp_world; mkdir "$LP/elsewhere"; printf x > "$LP/elsewhere/keep"; ln -s "$LP/elsewhere" "$PP"; lp_start
eq  "a link elsewhere: left alone"              "$(readlink "$PP")" "$LP/elsewhere"
has "a link elsewhere: a warning"               "$(cat "$LP/err")" "warning: $PP"
eq  "a link elsewhere: the worker starts"       "$(started)" "1"

lp_world; mkdir -p "$PP/-w-a"; printf s > "$PP/-w-a/s.jsonl"; printf blocker > "$SYSP/-w-a"; lp_start
has "a move that fails: a warning"              "$(cat "$LP/err")" "could not move"
eq  "a move that fails: the file stays"         "$(cat "$PP/-w-a/s.jsonl")" "s"
eq  "a move that fails: still a folder"         "$([ -L "$PP" ] && echo link || echo folder)" "folder"
eq  "a move that fails: the worker starts"      "$(started)" "1"
eq  "a move that fails: the lock is released"   "$(find "$DS_STATE_ROOT" -name '*.lock' | wc -l | tr -d ' ')" "0"
rm "$SYSP/-w-a"; : > "$ORCA_LOG"; lp_start
eq  "a move that failed: the next start links"  "$(readlink "$PP")" "$SYSP"
eq  "a move that failed: the file has moved"    "$(cat "$SYSP/-w-a/s.jsonl")" "s"

lp_world; mkdir -p "$DS_STATE_ROOT/.wt-locks/account-projects.lock"; : > "$DS_STATE_ROOT/.wt-locks/account-projects.lock/pid.$$"
DS_LINK_LOCK_WAIT=1 lp_start
has "another start links: a warning"            "$(cat "$LP/err")" "another start is linking"
eq  "another start links: this worker starts"   "$(started)" "1"

lp_world; mkdir -p "$PP/-w-a"; printf s > "$PP/-w-a/s.jsonl"
"$ADAPTER" worker-resume run_1 "id:repo1::/w/lp" spec opus >/dev/null 2>&1 || true
eq  "a resume links too"                        "$(readlink "$PP")" "$SYSP"
lp_world; mkdir "$DS_ORCA_DATA/claude-profiles/acctD"; mkdir -p "$DS_ORCA_DATA/claude-profiles/acctE/home"
"$ADAPTER" worker-start run_1 "id:repo1::/w/lp" spec claude opus - - acctC >/dev/null 2>&1 || true
eq  "every account is linked, not only the one starting" "$(readlink "$DS_ORCA_DATA/claude-profiles/acctE/home/projects")" "$SYSP"
eq  "a profile with no home gets none"          "$(find "$DS_ORCA_DATA/claude-profiles/acctD" -mindepth 1 | wc -l | tr -d ' ')" "0"

# Pause streams large host listings; only closure rereads current worker state.
export ORCA_PAUSE_TABS_FILE="$TMP/pause-tabs.json"
unset ORCA_TERM_PANES ORCA_TERM_CONNECTED FAKE_WT_DIR
printf '%s' '{"result":{"terminals":[{"handle":"pause_agent","worktreeId":"wt_pause","agentIdentity":"claude","connected":true},{"handle":"pause_shell","worktreeId":"wt_pause","connected":true},{"handle":"pause_loop","worktreeId":"wt_pause","agentIdentity":"claude","title":"ds-loop control","connected":true}]}}' > "$ORCA_PAUSE_TABS_FILE"
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_pause","agents":[{"state":"idle"}]}]}}'
out="$("$ADAPTER" loop-terminals)"
eq "terminal observer receives exact identity" "$(jq -r '.result.terminals[0].agentIdentity' <<<"$out")" claude
: > "$ORCA_LOG"
DS_ORCA_RETRY_REQUEST=pause_delivery "$ADAPTER" pause-deliver wt_pause pause_agent checkpoint run_1 >/dev/null
has "pause delivery carries its retry id" "$(cat "$ORCA_LOG")" '--retry-request pause_delivery'
has "delivery checks only the target worktree" "$(cat "$ORCA_LOG")" 'terminal list --worktree id:wt_pause'
hasnt "delivery does not inspect worker state" "$(cat "$ORCA_LOG")" 'worktree ps'
hasnt "delivery does not list dispatches" "$(cat "$ORCA_LOG")" 'worker-list'
rc=0; "$ADAPTER" pause-deliver wt_pause pause_shell checkpoint run_1 >/dev/null 2>&1 || rc=$?
eq "pause instruction refuses a shell recipient" "$rc" 1
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_pause","agents":[{"state":"working"}]}]}}'
: > "$ORCA_LOG"; rc=0; "$ADAPTER" pause-close wt_pause pause_agent run_1 '["pause_agent"]' >/dev/null 2>&1 || rc=$?
eq "busy role cannot close" "$rc" 1
hasnt "busy role receives no terminal close" "$(cat "$ORCA_LOG")" 'terminal close'
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_pause","agents":[]}]}}'
rc=0; "$ADAPTER" pause-close wt_pause pause_agent run_1 '["pause_agent"]' >/dev/null 2>&1 || rc=$?
eq "unknown agent state cannot close" "$rc" 1
export ORCA_PS_PRIMARY='{"result":{"worktrees":[{"worktreeId":"wt_pause","agents":[{"state":"done"}]}]}}'
rc=0; "$ADAPTER" pause-close wt_pause pause_agent run_1 '["pause_agent"]' >/dev/null 2>&1 || rc=$?
eq "done is positive idle for cooperative close" "$rc" 0
eq "only the acknowledged agent was closed" "$(jq -r '.result.terminals | map(.handle) | join(",")' "$ORCA_PAUSE_TABS_FILE")" 'pause_shell,pause_loop'
export ORCA_PAUSE_WORKERS_FILE="$TMP/pause-workers.json" ORCA_PAUSE_WORKERS_PAGE2="$TMP/pause-workers2.json"
printf '%s' '{"result":{"workers":[{"dispatchId":"pause_done","dispatchStatus":"completed","resource":{"worktreeId":"wt_pause"}},{"dispatchId":"pause_sibling","dispatchStatus":"dispatched","resource":{"worktreeId":"wt_other"}}],"page":{"hasMore":true,"nextCursor":"pause2"}}}' > "$ORCA_PAUSE_WORKERS_FILE"
printf '%s' '{"result":{"workers":[{"dispatchId":"pause_live","dispatchStatus":"dispatched","resource":{"worktreeId":"wt_pause"}}],"page":{"hasMore":false}}}' > "$ORCA_PAUSE_WORKERS_PAGE2"
: > "$ORCA_LOG"; rc=0; "$ADAPTER" pause-release run_1 wt_pause >/dev/null 2>&1 || rc=$?
eq "pause release confirms all pages" "$rc" 0
has "pause release frees a completed dispatch" "$(cat "$ORCA_LOG")" 'worker-release --dispatch pause_done'
has "pause release fences an absent live dispatch" "$(cat "$ORCA_LOG")" 'worker-abandon --dispatch pause_live'
has "pause release frees a page-two dispatch" "$(cat "$ORCA_LOG")" 'worker-release --dispatch pause_live'
hasnt "pause release leaves other worktrees alone" "$(cat "$ORCA_LOG")" 'worker-release --dispatch pause_sibling'
hasnt "pause release does not abandon completed work" "$(cat "$ORCA_LOG")" 'worker-abandon --dispatch pause_done'
for fault in failed garbled; do
  rc=0; FAKE_WL_FAIL="$fault" "$ADAPTER" pause-release run_1 wt_pause >/dev/null 2>&1 || rc=$?
  eq "pause release rejects $fault listing" "$rc" 1
done
rc=0; FAKE_RELEASE_FAIL=1 "$ADAPTER" pause-release run_1 wt_pause >/dev/null 2>&1 || rc=$?
eq "pause release propagates release failure" "$rc" 1
for release_out in '{"ok":false,"result":{"state":"released"}}' '{"ok":true,"result":{"state":"release_pending"}}' '{}'; do
  rc=0; ORCA_RELEASE_OUT="$release_out" "$ADAPTER" pause-release run_1 wt_pause >/dev/null 2>&1 || rc=$?
  eq "pause release rejects an unconfirmed result $release_out" "$rc" 1
done
# U150: a release_unknown on one dispatch does not stop the walk: every other dispatch is still
# fenced and released, and the exit names only the unknown one.
: > "$ORCA_LOG"; rc=0; err="$(ORCA_RELEASE_UNKNOWN=pause_done "$ADAPTER" pause-release run_1 wt_pause 2>&1 >/dev/null)" || rc=$?
eq "pause release with an unknown release exits 1" "$rc" 1
has "pause release still frees the dispatch after the unknown one" "$(cat "$ORCA_LOG")" 'worker-release --dispatch pause_live'
has "pause release names the unknown release" "$err" 'dispatch release unknown: '
has "pause release passes Orca's unknown text on" "$err" 'no longer resolves'
eq "pause release ends an unknown-only walk with its marker line" "$(tail -n 1 <<<"$err")" 'pause: release_unknown only; every other dispatch released'
: > "$ORCA_LOG"; rc=0; err="$(ORCA_RELEASE_UNKNOWN=pause_done FAKE_ABANDON_REFUSE=1 "$ADAPTER" pause-release run_1 wt_pause 2>&1 >/dev/null)" || rc=$?
eq "pause release with a failed fence after an unknown release exits 1" "$rc" 1
hasnt "a failed fence is never reported as unknown-only" "$err" 'release_unknown only'
# A ps, terminal listing and dispatch page each exceed Linux's per-argument 128 KB cap.
export ORCA_PS_PRIMARY_FILE="$TMP/pause-large-ps.json"
python3 - "$ORCA_PS_PRIMARY_FILE" "$ORCA_PAUSE_TABS_FILE" "$ORCA_PAUSE_WORKERS_FILE" <<'PY_LARGE'
import json, sys
padding = "x" * 180_000
json.dump({"result":{"worktrees":[{"worktreeId":"wt_pause","agents":[{"state":"idle"}],"padding":padding}]}}, open(sys.argv[1], "w"))
json.dump({"result":{"terminals":[{"handle":"pause_agent","worktreeId":"wt_pause","agentIdentity":"claude","connected":True,"padding":padding},
 {"handle":"pause_shell","worktreeId":"wt_pause","connected":True}]}}, open(sys.argv[2], "w"))
json.dump({"result":{"workers":[{"dispatchId":"large_dispatch","dispatchStatus":"completed","resource":{"worktreeId":"wt_pause"},"padding":padding}],"page":{"hasMore":False}}}, open(sys.argv[3], "w"))
PY_LARGE
out="$("$ADAPTER" loop-terminals)"
eq "large terminal listing reaches the observer" "$(jq -r '.result.terminals[0].handle' <<<"$out")" pause_agent
: > "$ORCA_LOG"
"$ADAPTER" pause-deliver wt_pause pause_agent checkpoint run_1 >/dev/null
hasnt "large-list delivery costs no ps" "$(cat "$ORCA_LOG")" 'worktree ps'
"$ADAPTER" run-dispatches run_1 > "$TMP/large-dispatches"
eq "large dispatch listing reaches the observer" "$(cat "$TMP/large-dispatches")" $'wt_pause\tlarge_dispatch\tcompleted'
: > "$ORCA_LOG"
"$ADAPTER" pause-close wt_pause pause_agent run_1 '["pause_agent"]' >/dev/null
eq "close makes exactly one ps safety read" "$(awk '/^worktree ps/ { n++ } END { print n+0 }' "$ORCA_LOG")" 1
eq "close makes exactly one scoped terminal safety read" "$(awk '/^terminal list --worktree id:wt_pause/ { n++ } END { print n+0 }' "$ORCA_LOG")" 1
hasnt "close does not gather dispatches" "$(cat "$ORCA_LOG")" 'worker-list'
eq "large-list close retains the shell" "$(jq -r '.result.terminals[0].handle' "$ORCA_PAUSE_TABS_FILE")" pause_shell
"$ADAPTER" pause-release run_1 wt_pause >/dev/null
has "large dispatch is released" "$(cat "$ORCA_LOG")" 'worker-release --dispatch large_dispatch'
for fault in garbled failed; do
  rc=0; FAKE_WL_FAIL="$fault" "$ADAPTER" run-dispatches run_1 >/dev/null 2>&1 || rc=$?
  eq "observer rejects $fault dispatch listing instead of claiming absence" "$rc" 1
done
unset ORCA_PS_PRIMARY_FILE

unset ORCA_PAUSE_WORKERS_FILE ORCA_PAUSE_WORKERS_PAGE2
unset ORCA_PAUSE_TABS_FILE

# U8b: the `orca` worktree provider's verbs print a slim JSON line per worktree.
W='{"id":"R::/w/a1","path":"/w/a1","branch":"refs/heads/feat/a1","head":"abc","parentWorktreeId":"R::/w/lead","displayName":"a1"}'
out=$(ORCA_WT_OUT="{\"result\":{\"worktree\":$W}}" run wt-make /repo a1 feat/a1 main /w/lead)
eq "wt-make prints the slim worktree" "$out" '{"id":"R::/w/a1","path":"/w/a1","branch":"refs/heads/feat/a1","head":"abc","parentWorktreeId":"R::/w/lead"}'
has "wt-make: no agent, nested, setup skipped" "$(cat "$ORCA_LOG")" "worktree create --repo path:/repo --name a1 --branch feat/a1 --base-branch main --parent-worktree path:/w/lead --setup skip --json"
ORCA_WT_OUT="{\"result\":{\"worktree\":$W}}" run wt-make /repo a1 feat/a1 main "" >/dev/null
has "wt-make with no parent is top-level" "$(cat "$ORCA_LOG")" "--no-parent --setup skip"
rc=0; ORCA_WT_OUT='{"result":{"worktree":{}}}' run wt-make /repo a1 feat/a1 main 2>/dev/null || rc=$?; eq "wt-make: an answer with no worktree fails" "$rc" "1"
eq "wt-show by path" "$(ORCA_WT_OUT="{\"result\":{\"worktree\":$W}}" run wt-show path:/w/a1 | jq -r .id)" "R::/w/a1"
L='{"id":"R::/w/lead","path":"/w/lead","branch":"refs/heads/lead","head":"abc","parentWorktreeId":null,"childWorktreeIds":["R::/w/a1"],"displayName":"lead"}'
eq "wt-show keeps Orca's childWorktreeIds (U16a)" "$(ORCA_WT_OUT="{\"result\":{\"worktree\":$L}}" run wt-show path:/w/lead | jq -c .childWorktreeIds)" '["R::/w/a1"]'
rc=0; ORCA_WT_OUT='{"ok":false,"error":{"code":"selector_not_found"}}' ORCA_WT_RC=1 run wt-show path:/w/x 2>/dev/null || rc=$?; eq "wt-show: none is exit 3" "$rc" "3"
rc=0; ORCA_WT_OUT='{"ok":false,"error":{"code":"runtime_busy"}}' ORCA_WT_RC=1 run wt-show path:/w/x 2>/dev/null || rc=$?; eq "wt-show: another failure is exit 1" "$rc" "1"
M='{"id":"R::/repo","path":"/repo","branch":"refs/heads/main","isMainWorktree":true}'
eq "wt-list leaves the main checkout out" "$(ORCA_WT_OUT="{\"result\":{\"worktrees\":[$M,$W],\"truncated\":false}}" run wt-list /repo | jq -r .path)" "/w/a1"
has "wt-list asks for the repo's whole list" "$(cat "$ORCA_LOG")" "worktree list --repo path:/repo --limit 10000 --json"
rc=0; ORCA_WT_OUT="{\"result\":{\"worktrees\":[$W],\"truncated\":true}}" run wt-list /repo >/dev/null 2>&1 || rc=$?; eq "wt-list: a truncated list fails" "$rc" "1"

echo "orca-adapter: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
