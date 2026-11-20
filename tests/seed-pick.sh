#!/usr/bin/env bash
# seed-pick.sh — sourced by tests that run spawn-squad / add-role against a fake backend: `ds pick`
# reads loop.db, so give it an empty temp state root with the conventions imported (every agent then
# runs on its default login). seed_pick_root <dir> -> prints <dir>; point DS_STATE_ROOT at it.
seed_pick_root() {
  mkdir -p "$1"
  "${ROOT:?}/bin/ds" --state "$1" import >/dev/null 2>&1
  printf '%s' "$1"
}
