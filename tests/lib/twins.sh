#!/usr/bin/env bash
# twins.sh — source it for the old shell helper names a test still calls; each one runs its
# TypeScript twin (tests/lib/twins.ts, U274), so the test's cases check the code the loop now runs.
# The caller sets ROOT. Env assignments before a call (DS_LIMIT_X=… ds_limit …) reach the twin.
_ds_twin() { bun "$ROOT/tests/lib/twins.ts" "$@"; }
ds_limit() { _ds_twin ds_limit "$@"; }
ds_limit_src() { _ds_twin ds_limit_src "$@"; }
ds_compact_window() { _ds_twin ds_compact_window "$@"; }
ds_ship_mode() { _ds_twin ds_ship_mode "$@"; }
ds_muse_resolve() { _ds_twin ds_muse_resolve "$@"; }
ds_notes_note() { _ds_twin ds_notes_note "$@"; }
ds_role_spec() { _ds_twin ds_role_spec "$@"; }
ds_loop_key() { _ds_twin ds_loop_key "$@"; }
ds_role_brief() { _ds_twin ds_role_brief "$@"; }
ds_role_row() { _ds_twin ds_role_row "$@"; }
wt_probe() { _ds_twin wt_probe "$@"; }
pr_health() { _ds_twin pr_health "$@"; }
# observe_config: copy the test's state/<label>/{limits,roles,models}.conf and ship-mode into
# its loop.db's `config` rows, as the loop's config observer would (U257: no reader outside the loop reads
# those files). Call it after a case writes or removes one; the root is $DS_STATE_ROOT.
observe_config() { bun "$ROOT/tests/lib/observe-config.ts" "${DS_STATE_ROOT:?}"; }
