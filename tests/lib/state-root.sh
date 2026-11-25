#!/usr/bin/env bash
# state-root.sh — sourced by a test that writes state/<project>/…: it gets its own temp state root
# (DS_STATE_ROOT) so nothing lands in the checkout's state/ or the live loop.db (U253). A DS_STATE_ROOT
# the caller already holds is not trusted — a Builder's terminal or the Lead's may point it at the live
# state — so this always makes a new one. tests/ci.sh sets DS_TEST_STATE_BASE (removed when it ends).
# The root is <temp>/state: done-request.sh only accepts paths under a dir named state/.
DS_STATE_PARENT="$(mktemp -d -p "${DS_TEST_STATE_BASE:-${TMPDIR:-/tmp}}" dsstate.XXXXXX)" || { echo "state-root: no temp dir" >&2; exit 1; }
mkdir -p "$DS_STATE_PARENT/state"
DS_STATE_ROOT="$DS_STATE_PARENT/state"
export DS_STATE_ROOT DS_STATE_PARENT
# A script that needs its own cleanup calls state_root_on_exit '<cmd>' (single-quoted, expanded at exit),
# never a bare `trap … EXIT`, which would replace this one and leak the folder (tests/state-root-trap.sh).
# Calls add up; the state folder is removed last.
_STATE_ROOT_CMDS=""
state_root_on_exit() {
  _STATE_ROOT_CMDS="$1"
  # shellcheck disable=SC2064
  trap 'eval "$_STATE_ROOT_CMDS"; rm -rf "$DS_STATE_PARENT"' EXIT
}
state_root_on_exit ':'
