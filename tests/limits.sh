#!/usr/bin/env bash
# limits.sh — ds_limit precedence (default < per-project override < env), bin/commands/limits.sh set/rm/show,
# and that the sweep and the picker read through it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export DS_STATE_ROOT="$TMP/state"
# shellcheck source=tests/lib/twins.sh
. "$ROOT/tests/lib/twins.sh"
L="$ROOT/bin/commands/limits.sh"

pass=0; fail=0
eq() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 (want [$3], got [$2])" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
# A project's own limits rows (U256: loop.db rows, read through the export; no limits.conf is written).
own() { "$ROOT/bin/ds" --state "$DS_STATE_ROOT" config export --project "$1" | awk '/^#== /{s=($2=="limits.conf");next} s&&NF'; }

# --- precedence -----------------------------------------------------------------------------
eq "default" "$(ds_limit proj context_compact)" "150000"
"$L" set proj context_compact 120000 >/dev/null
eq "override beats default" "$(ds_limit proj context_compact)" "120000"
eq "other project keeps the default" "$(ds_limit other context_compact)" "150000"
eq "role default lead" "$(ds_limit proj context_compact_lead)" "100000"
eq "role default thinker" "$(ds_limit proj context_compact_thinker)" "120000"
eq "role default builder" "$(ds_limit proj context_compact_builder)" "150000"
eq "compact_idle_min default" "$(ds_limit proj compact_idle_min)" "55"
[ "$(ds_limit proj compact_idle_min)" -lt 60 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "  FAIL: compact_idle_min must stay under 60" >&2; }
eq "role env override" "$(DS_LIMIT_CONTEXT_COMPACT_LEAD=7 ds_limit proj context_compact_lead)" "7"
eq "env beats override (DS_LIMIT_<KEY>)" "$(DS_LIMIT_CONTEXT_COMPACT=99 ds_limit proj context_compact)" "99"
eq "historical env name works" "$(DS_RESUME_MAX_CTX=77000 ds_limit proj context_warn)" "77000"
eq "src: default" "$(ds_limit_src proj context_warn | cut -f2)" "default"
eq "src: override" "$(ds_limit_src proj context_compact | cut -f2)" "override"
eq "src: env" "$(DS_SWEEP_LIMIT_PCT=80 ds_limit_src proj limit_pct | cut -f2)" "env"

# --- set / rm / show ------------------------------------------------------------------------
"$L" set proj context_compact 130000 >/dev/null
eq "set twice keeps one row" "$(own proj | grep -c '^context_compact')" "1"
eq "no limits.conf file" "$(test -e "$TMP/state/proj/limits.conf" && echo file || echo none)" "none"
eq "set replaces" "$(ds_limit proj context_compact)" "130000"
"$L" set proj compact_mode_lead clear >/dev/null
eq "compact_mode value" "$(ds_limit proj compact_mode_lead)" "clear"
eq "compact_mode default" "$(ds_limit proj compact_mode_builder)" "compact"
"$L" set proj compact_mode_thinker off >/dev/null
eq "compact_mode off accepted" "$(ds_limit proj compact_mode_thinker)" "off"
if "$L" set proj compact_mode_builder squash >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: bad compact_mode accepted" >&2; else pass=$((pass+1)); fi
eq "bad compact_mode not written" "$(ds_limit proj compact_mode_builder)" "compact"
has "show: compact_mode off row" "$("$L" show proj)" "compact_mode_thinker     off          override"
if "$L" set proj nosuchkey 1 >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: unknown key accepted" >&2; else pass=$((pass+1)); fi
SHOW="$("$L" show proj)"
has "show: key, value and source" "$SHOW" "context_compact          130000       override"
has "show: default row" "$SHOW" "context_warn             100000       default"
for k in compact_mode_lead compact_mode_thinker compact_mode_builder auto_compact_builder unit_token_max; do has "show lists $k" "$SHOW" "$k"; done
has "show: env row" "$(DS_SWEEP_LIMIT_PCT=98 "$L" show proj)" "limit_pct                98           env"
"$L" rm proj context_compact >/dev/null
eq "rm -> default again" "$(ds_limit proj context_compact)" "150000"
eq "override survives for other keys" "$(ds_limit proj compact_mode_lead)" "clear"

# --- expected_checks: a list of names, unset by default ------------------------------------------
eq "expected_checks default is none" "$(ds_limit proj expected_checks)" "-"
"$L" set proj expected_checks tests,lint.v2_x >/dev/null
eq "expected_checks takes a comma list" "$(ds_limit proj expected_checks)" "tests,lint.v2_x"
if "$L" set proj expected_checks "a b" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: a space accepted" >&2; else pass=$((pass+1)); fi
if "$L" set proj context_warn 1,2 >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: a comma accepted on another key" >&2; else pass=$((pass+1)); fi
eq "show --json marks it a list" "$("$L" show --json proj | jq -r '.limits[] | select(.key=="expected_checks") | .list')" "true"
"$L" rm proj expected_checks >/dev/null

# --- review severity and risk paths are configurable, typed settings ---------------------------
eq "ordinary severity default" "$(ds_limit proj review_block_severity)" P1
eq "risky severity default" "$(ds_limit proj review_block_severity_risky)" P2
eq "risk paths default" "$(ds_limit proj review_risk_paths)" -
for key in review_block_severity review_block_severity_risky; do
  "$L" set proj "$key" P3 >/dev/null
  eq "severity override $key" "$(ds_limit proj "$key")" P3
  if "$L" set proj "$key" P4 >"$TMP/bad.out" 2>&1; then fail=$((fail+1)); else pass=$((pass+1)); fi
  has "severity error names key" "$(cat "$TMP/bad.out")" "$key"
  eq "severity choices in JSON" "$("$L" show --json proj | jq -c --arg key "$key" '.limits[] | select(.key==$key) | .allowed')" '["P0","P1","P2","P3"]'
  "$L" rm proj "$key" >/dev/null
done
"$L" set proj review_risk_paths 'contracts/**/*.sol,src/auth/*.ts' >/dev/null
eq "comma globs accepted" "$(ds_limit proj review_risk_paths)" 'contracts/**/*.sol,src/auth/*.ts'
eq "risk paths marked list" "$("$L" show --json proj | jq -r '.limits[] | select(.key=="review_risk_paths") | .list')" true
for bad in 'a b' 'a,,b'; do
  if "$L" set proj review_risk_paths "$bad" >/dev/null 2>&1; then fail=$((fail+1)); else pass=$((pass+1)); fi
done
"$L" rm proj review_risk_paths >/dev/null

# --- U138/U176: the wide-delta size (legacy review_delta_full_lines still works) ------------
eq "wide line threshold default" "$(ds_limit proj review_delta_wide_lines)" 400
"$L" set proj review_delta_wide_lines 120 >/dev/null
eq "wide line threshold override" "$(ds_limit proj review_delta_wide_lines)" 120
if "$L" set proj review_delta_wide_lines many >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: a non-numeric wide threshold accepted" >&2; else pass=$((pass+1)); fi
"$L" rm proj review_delta_wide_lines >/dev/null
"$L" set proj review_delta_full_lines 120 >/dev/null
eq "legacy threshold override stored" "review_delta_full_lines 120" "$(own proj | grep -E '^review_delta_full_lines ')"
if "$L" set proj review_delta_full_lines many >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: a non-numeric legacy threshold accepted" >&2; else pass=$((pass+1)); fi
"$L" rm proj review_delta_full_lines >/dev/null
# --- U1: the Flow's stuck floor, in minutes -----------------------------------------------------
eq "flow stuck floor default" "$(ds_limit proj flow_stuck_floor_min)" 10
"$L" set proj flow_stuck_floor_min 30 >/dev/null
eq "flow stuck floor override" "$(ds_limit proj flow_stuck_floor_min)" 30
if "$L" set proj flow_stuck_floor_min soon >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: a non-numeric stuck floor accepted" >&2; else pass=$((pass+1)); fi
"$L" rm proj flow_stuck_floor_min >/dev/null
# --- U279: minutes of quiet before a late Flow card reads stuck, not slow ---------------------------
eq "flow quiet default" "$(ds_limit proj flow_quiet_min)" 20
"$L" set proj flow_quiet_min 45 >/dev/null
eq "flow quiet override" "$(ds_limit proj flow_quiet_min)" 45
if "$L" set proj flow_quiet_min soon >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: a non-numeric flow_quiet_min accepted" >&2; else pass=$((pass+1)); fi
"$L" rm proj flow_quiet_min >/dev/null
# --- U145: max_builders: - (no limit) or a positive integer --------------------------------------
eq "max_builders default" "$(ds_limit proj max_builders)" -
"$L" set proj max_builders 6 >/dev/null
eq "max_builders override" "$(ds_limit proj max_builders)" 6
for bad in 0 06 -1 six 2.5; do
  if "$L" set proj max_builders "$bad" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: max_builders '$bad' accepted" >&2; else pass=$((pass+1)); fi
done
"$L" set proj max_builders - >/dev/null
eq "max_builders back to no limit" "$(ds_limit proj max_builders)" -
# --- adaptive-builder-capacity U3: the light lane's two limits -------------------------------------
eq "max_light_builders default" "$(ds_limit proj max_light_builders)" 0
eq "light_lane_cpu_h default" "$(ds_limit proj light_lane_cpu_h)" 3
"$L" set proj max_light_builders 2 >/dev/null
eq "max_light_builders override" "$(ds_limit proj max_light_builders)" 2
"$L" set proj light_lane_cpu_h 1.5 >/dev/null
eq "light_lane_cpu_h override" "$(ds_limit proj light_lane_cpu_h)" 1.5
for bad in -1 two 1.5 -; do
  if "$L" set proj max_light_builders "$bad" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: max_light_builders '$bad' accepted" >&2; else pass=$((pass+1)); fi
done
for bad in 0 -1 three -; do
  if "$L" set proj light_lane_cpu_h "$bad" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: light_lane_cpu_h '$bad' accepted" >&2; else pass=$((pass+1)); fi
done
"$L" set proj max_light_builders 0 >/dev/null
eq "max_light_builders back to off" "$(ds_limit proj max_light_builders)" 0
# --- U153: restart_rss_gb: - (off) or a positive number of GB -----------------------------------
eq "restart_rss_gb default" "$(ds_limit proj restart_rss_gb)" -
"$L" set proj restart_rss_gb 6 >/dev/null
eq "restart_rss_gb override" "$(ds_limit proj restart_rss_gb)" 6
"$L" set proj restart_rss_gb 0.5 >/dev/null
eq "restart_rss_gb fractional" "$(ds_limit proj restart_rss_gb)" 0.5
for bad in 0 -1 six 1.2.3; do
  if "$L" set proj restart_rss_gb "$bad" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: restart_rss_gb '$bad' accepted" >&2; else pass=$((pass+1)); fi
done
"$L" set proj restart_rss_gb - >/dev/null
eq "restart_rss_gb back to off" "$(ds_limit proj restart_rss_gb)" -
"$L" rm proj restart_rss_gb >/dev/null
"$L" rm proj max_builders >/dev/null
eq "skip lenses default" "$(ds_limit proj review_skip_lenses)" -
"$L" set proj review_skip_lenses security,learnings,performance >/dev/null
eq "skip lenses take a comma list" "$(ds_limit proj review_skip_lenses)" security,learnings,performance
eq "skip lenses marked list" "$("$L" show --json proj | jq -r '.limits[] | select(.key=="review_skip_lenses") | .list')" true
for bad in correctness 'security,correctness' 'a b' ',security' 'security,,learnings' 'Security'; do
  if "$L" set proj review_skip_lenses "$bad" >"$TMP/bad.out" 2>&1; then fail=$((fail+1)); echo "  FAIL: skip lenses '$bad' accepted" >&2; else pass=$((pass+1)); fi
done
has "dropping correctness says why" "$("$L" set proj review_skip_lenses correctness 2>&1)" "correctness"
"$L" rm proj review_skip_lenses >/dev/null

# --- the picker reads through it ------------------------------------------------------------
N="$(date +%s)"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\nclaude\ta\t60\t-\t10\t-\t-\t%s\n' "$N" > "$TMP/state/accounts.tsv"
# `ds pick` reads loop.db: import the accounts.tsv each time (the project's limits are its rows already, U256).
pk() { mkdir -p "$TMP/state/proj/squads"; "$ROOT/bin/ds" import >/dev/null; DS_NOW="$N" "$ROOT/bin/ds" pick proj builder --agent claude --model opus 2>/dev/null | cut -f4; }
eq "picker: 60% is under the default 95" "$(pk)" "a"
"$L" set proj pick_session_max 55 >/dev/null
w="$(pk || true)"; eq "picker: per-project pick_session_max 55 -> WAIT" "${w%% *}" "WAIT"

# --- U166: auto_merge: off | squash | merge | rebase -------------------------------------------------
eq "auto_merge default is off" "$(ds_limit proj auto_merge)" off
"$L" set proj auto_merge squash >/dev/null
eq "auto_merge override" "$(ds_limit proj auto_merge)" squash
for bad in Squash YES merge+rebase "squash merge"; do
  if "$L" set proj auto_merge "$bad" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: auto_merge '$bad' accepted" >&2; else pass=$((pass+1)); fi
done
eq "bad auto_merge not written" "$(ds_limit proj auto_merge)" squash
eq "auto_merge choices in JSON" "$("$L" show --json proj | jq -c '.limits[] | select(.key=="auto_merge") | .allowed')" '["off","squash","merge","rebase"]'
"$L" rm proj auto_merge >/dev/null
eq "auto_merge rm -> default again" "$(ds_limit proj auto_merge)" off
eq "auto_merge env name is DS_LOOP_AUTO_MERGE" "$(DS_LOOP_AUTO_MERGE=squash ds_limit proj auto_merge)" squash
"$L" set proj auto_merge squash >/dev/null
eq "auto_merge env beats override" "$(DS_LOOP_AUTO_MERGE=rebase ds_limit proj auto_merge)" rebase
"$L" rm proj auto_merge >/dev/null

# --- U182: base_update: merge | rebase ---
eq "base_update default is merge" "$(ds_limit proj base_update)" merge
"$L" set proj base_update rebase >/dev/null
eq "base_update override" "$(ds_limit proj base_update)" rebase
for bad in Merge YES "merge rebase"; do
  if "$L" set proj base_update "$bad" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: base_update '$bad' accepted" >&2; else pass=$((pass+1)); fi
done
eq "bad base_update not written" "$(ds_limit proj base_update)" rebase
eq "base_update choices in JSON" "$("$L" show --json proj | jq -c '.limits[] | select(.key=="base_update") | .allowed')" '["merge","rebase"]'
"$L" rm proj base_update >/dev/null
eq "base_update rm -> default again" "$(ds_limit proj base_update)" merge
eq "base_update env name is DS_LIMIT_BASE_UPDATE" "$(DS_LIMIT_BASE_UPDATE=rebase ds_limit proj base_update)" rebase
"$L" set proj base_update rebase >/dev/null
eq "base_update env beats override" "$(DS_LIMIT_BASE_UPDATE=merge ds_limit proj base_update)" merge
"$L" rm proj base_update >/dev/null

# --- briefing_time / briefing_days (morning brief settings) ---------------------------------
eq "briefing_time default" "$(ds_limit proj briefing_time)" off
eq "briefing_days default" "$(ds_limit proj briefing_days)" mon-fri
for v in 08:30 off 00:00 23:59; do
  "$L" set proj briefing_time "$v" >/dev/null 2>&1 && eq "briefing_time accepts $v" "$(ds_limit proj briefing_time)" "$v" || { fail=$((fail+1)); echo "  FAIL: briefing_time $v refused" >&2; }
done
for v in daily mon-fri mon,wed,fri mon-wed,fri sun; do
  "$L" set proj briefing_days "$v" >/dev/null 2>&1 && eq "briefing_days accepts $v" "$(ds_limit proj briefing_days)" "$v" || { fail=$((fail+1)); echo "  FAIL: briefing_days $v refused" >&2; }
done
"$L" set proj briefing_time 08:30 >/dev/null; "$L" set proj briefing_days mon,wed >/dev/null
for v in 8:30 24:00 09:60 funday "" "mon;rm"; do
  if "$L" set proj briefing_time "$v" >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: briefing_time '$v' accepted" >&2; else pass=$((pass+1)); has "briefing_time '$v' message names key" "$(cat "$TMP/err")" "briefing_time must be"; fi
done
for v in funday mon- -mon "" "mon;rm" mon,,fri ,mon "mon," fri-mon-x Mon; do
  if "$L" set proj briefing_days "$v" >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: briefing_days '$v' accepted" >&2; else pass=$((pass+1)); has "briefing_days '$v' message names key" "$(cat "$TMP/err")" "briefing_days must be"; fi
done
eq "bad values not written" "$(ds_limit proj briefing_time)/$(ds_limit proj briefing_days)" "08:30/mon,wed"
"$L" set proj briefing_time "08:30 " >/dev/null; eq "a padded value is stored trimmed (settings.ts, U256)" "$(own proj | grep "^briefing_time ")" "briefing_time 08:30"
eq "env override wins" "$(DS_LIMIT_BRIEFING_TIME=07:15 ds_limit proj briefing_time)" "07:15"
J="$("$L" show --json proj)"
eq "show --json briefing_time hint" "$(jq -r '.limits[]|select(.key=="briefing_time")|.hint' <<<"$J")" "off or HH:MM (24h), e.g. 08:30"
eq "show --json briefing_days free text" "$(jq -r '.limits[]|select(.key=="briefing_days")|[.allowed,.list]|tostring' <<<"$J")" "[null,false]"
has "show lists briefing keys" "$("$L" show proj)" "briefing_days"
"$L" rm proj briefing_time >/dev/null; "$L" rm proj briefing_days >/dev/null
eq "rm returns briefing_time to default" "$(ds_limit proj briefing_time)" off
eq "rm returns briefing_days to default" "$(ds_limit proj briefing_days)" mon-fri
# U260: the Studio has its own auto-compact window; an unknown role still gets auto_compact_other
eq "ds_compact_window studio = auto_compact_studio" "$(ds_compact_window proj studio)" "200000"
eq "ds_compact_window unknown role = auto_compact_other" "$(ds_compact_window proj researcher)" "400000"
eq "studio keys default" "$(ds_limit proj context_compact_studio)/$(ds_limit proj compact_mode_studio)/$(ds_limit proj studio_move)" "150000/compact/auto"
if "$L" set proj compact_mode_studio clear >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: compact_mode_studio clear accepted" >&2; else pass=$((pass+1)); fi
if "$L" set proj studio_move maybe >/dev/null 2>&1; then fail=$((fail+1)); echo "  FAIL: bad studio_move accepted" >&2; else pass=$((pass+1)); fi
"$L" set proj studio_move ask >/dev/null; eq "studio_move ask accepted" "$(ds_limit proj studio_move)" "ask"
# U9: the backend a new squad starts on, and its worktree tool.
eq "backend keys default" "$(ds_limit proj default_backend)/$(ds_limit proj worktree_provider)" "orca/auto"
for kv in "default_backend screen" "worktree_provider orca"; do
  # shellcheck disable=SC2086
  if "$L" set proj $kv >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: $kv accepted" >&2; else pass=$((pass+1)); has "$kv message names key" "$(cat "$TMP/err")" "${kv%% *} must be"; fi
done
# U32: a backend that does not fit is refused when set: no binary, a roster row it cannot launch, a tool it cannot use.
mkdir -p "$TMP/fakebin"; printf '#!/bin/sh\n' >"$TMP/fakebin/tmux"; cp "$TMP/fakebin/tmux" "$TMP/fakebin/treehouse"; chmod +x "$TMP/fakebin/tmux" "$TMP/fakebin/treehouse"
if PATH="$TMP/fakebin:$PATH" "$L" set proj default_backend tmux >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: tmux accepted with a muse roster" >&2; else pass=$((pass+1)); has "default_backend tmux refused on a roster it cannot launch" "$(cat "$TMP/err")" "can start only claude"; fi
if PATH="$TMP/fakebin:$PATH" "$L" set proj worktree_provider treehouse >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: treehouse accepted on orca" >&2; else pass=$((pass+1)); has "worktree_provider treehouse refused on orca" "$(cat "$TMP/err")" "cannot use worktree_provider treehouse"; fi
for r in "builder claude opus ondemand - claude:sonnet" "builder-review claude opus elevate" "builder-review-standard claude sonnet elevate medium"; do
  # shellcheck disable=SC2086
  "$ROOT/bin/ds" --state "$DS_STATE_ROOT" config set proj roles.conf $r >/dev/null
done
PATH="$TMP/fakebin:$PATH" "$L" set proj default_backend tmux >"$TMP/out"; eq "default_backend tmux accepted" "$(ds_limit proj default_backend)" "tmux"
has "a backend change says where new squads start" "$(cat "$TMP/out")" "new squads start on tmux; 0 running squads stay on orca"
PATH="$TMP/fakebin:$PATH" "$L" set proj worktree_provider treehouse >/dev/null; eq "worktree_provider treehouse accepted" "$(ds_limit proj worktree_provider)" "treehouse"
# expose-hosted-services U1: minutes an exposed URL may stay down; a whole number of minutes
eq "expose_down_min default" "$(ds_limit proj expose_down_min)" "15"
if "$L" set proj expose_down_min soon >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: expose_down_min soon accepted" >&2; else pass=$((pass+1)); has "expose_down_min message names key" "$(cat "$TMP/err")" "expose_down_min must be"; fi
"$L" set proj expose_down_min 30 >/dev/null; eq "expose_down_min 30 accepted" "$(ds_limit proj expose_down_min)" "30"
# exposed-cleanup U2: expose_stop_s, whole seconds 10-100.
eq "expose_stop_s default" "$(ds_limit proj expose_stop_s)" "90"
for bad in 5 101 1.5 soon; do
  if "$L" set proj expose_stop_s "$bad" >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: expose_stop_s $bad accepted" >&2; else pass=$((pass+1)); has "expose_stop_s $bad message names key" "$(cat "$TMP/err")" "expose_stop_s must be"; fi
done
"$L" set proj expose_stop_s 100 >/dev/null; eq "expose_stop_s 100 accepted" "$(ds_limit proj expose_stop_s)" "100"
# notes-cap-setting: notes_cap, whole number 1-100, default 20.
eq "notes_cap default" "$(ds_limit proj notes_cap)" "20"
for bad in 0 101 abc -; do
  if "$L" set proj notes_cap "$bad" >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: notes_cap $bad accepted" >&2; else pass=$((pass+1)); has "notes_cap $bad message names key" "$(cat "$TMP/err")" "notes_cap must be"; fi
done
"$L" set proj notes_cap 25 >/dev/null; eq "notes_cap 25 accepted" "$(ds_limit proj notes_cap)" "25"
# exposed-cleanup U3: expose_warn_min, whole minutes, 0 = off.
eq "expose_warn_min default" "$(ds_limit proj expose_warn_min)" "5"
for bad in 1.5 soon -1; do
  if "$L" set proj expose_warn_min "$bad" >/dev/null 2>"$TMP/err"; then fail=$((fail+1)); echo "  FAIL: expose_warn_min $bad accepted" >&2; else pass=$((pass+1)); has "expose_warn_min $bad message names key" "$(cat "$TMP/err")" "expose_warn_min must be"; fi
done
"$L" set proj expose_warn_min 0 >/dev/null; eq "expose_warn_min 0 accepted" "$(ds_limit proj expose_warn_min)" "0"
# --- guard: the shipped defaults leave room and the sweep fires before Claude Code's own trigger ---
# From the thinker-early-compact plan: Claude Code auto-compacts at about window - 33k (RESERVE), and a
# role starts with about 65-80k tokens in context (BASELINE; measured median 63k first turn, 80k after
# a compaction). Require >= 80k working room above both, and context_compact_<role> below the trigger.
RESERVE=33000; BASELINE=80000; ROOM=80000
guard() { # <conf> -> failing lines on stdout
  local conf="$1" role a c
  for role in lead thinker builder studio; do
    a="$(awk -v k="auto_compact_$role" '$1==k{print $2}' "$conf")"
    case "$a" in ''|*[!0-9]*) continue ;; esac
    c="$(awk -v k="context_compact_$role" '$1==k{print $2}' "$conf")"
    [ "$((a - RESERVE - BASELINE))" -ge "$ROOM" ] || echo "auto_compact_$role $a leaves under ${ROOM} tokens of room"
    case "$c" in ''|*[!0-9]*) c="$(awk '$1=="context_compact"{print $2}' "$conf")" ;; esac
    [ "$c" -lt "$((a - RESERVE))" ] || echo "context_compact_$role $c is not below the auto trigger $((a - RESERVE))"
  done
}
eq "guard: shipped limits.conf passes" "$(guard "$ROOT/conventions/limits.conf")" ""
sed 's/^auto_compact_thinker .*/auto_compact_thinker 150000/' "$ROOT/conventions/limits.conf" > "$TMP/bad1.conf"
has "guard: thinker window 150000 fails" "$(guard "$TMP/bad1.conf")" "auto_compact_thinker 150000 leaves under"
sed 's/^context_compact_thinker .*/context_compact_thinker 380000/' "$ROOT/conventions/limits.conf" > "$TMP/bad2.conf"
has "guard: sweep threshold above trigger fails" "$(guard "$TMP/bad2.conf")" "context_compact_thinker 380000 is not below"

echo "limits: $pass passed, $fail failed"
[ "$fail" = 0 ]
