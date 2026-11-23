#!/usr/bin/env bash
# shadow-drill.sh — the helper for the shadow drill (orca-backend-alternatives U10b, docs/backends/shadow.md).
#   shadow-drill.sh crash <worktree> [--dry-run]   kill the agent (claude) processes that run inside one drill worktree
#   shadow-drill.sh report --since <iso|epoch> [--project <label>]   ds shadow report, then say which drill evidence is missing
# `crash` signals only processes whose working folder is under the worktree you name (never pkill by name), so it cannot
# touch another squad. The drill squad must be a throwaway one you started for it. `report` exits 0 only on `exit: met`.
set -uo pipefail
DS="${DS_BIN:-$(cd "$(dirname "$0")/../.." && pwd -P)/bin/ds}"
die() { echo "shadow-drill: $*" >&2; exit 2; }
cmd="${1:-}"; shift || true
case "$cmd" in
  crash)
    wt="${1:-}"; shift || true
    dry=0; [ "${1:-}" = "--dry-run" ] && dry=1
    [ -n "$wt" ] && [ -d "$wt" ] || die "usage: crash <worktree> [--dry-run] (a folder that exists)"
    wt="$(cd "$wt" && pwd -P)"
    case "$wt" in /|"$HOME"|"$HOME/") die "refusing $wt: name one drill worktree";; esac
    found=0
    for p in /proc/[0-9]*; do
      pid="${p#/proc/}"
      cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
      case "$cwd" in "$wt"|"$wt"/*) ;; *) continue;; esac
      cmdline="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)" || continue
      case "$cmdline" in *claude*) ;; *) continue;; esac
      found=$((found + 1))
      echo "crash: pid $pid ($cmdline)"
      [ "$dry" = 1 ] || kill -KILL "$pid" 2>/dev/null
    done
    [ "$found" -gt 0 ] || { echo "shadow-drill: no agent process under $wt" >&2; exit 1; }
    echo "crash: $found process(es) $([ "$dry" = 1 ] && echo 'would be killed' || echo killed) at $(date -u +%FT%TZ)"
    ;;
  report)
    since=""; project=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --since) since="${2:-}"; shift 2;;
        --project) project=(--project "${2:-}"); shift 2;;
        *) die "unknown option '$1'";;
      esac
    done
    [ -n "$since" ] || die "report needs --since <U10's merge, ISO or epoch>"
    out="$("$DS" shadow report "${project[@]}" --since "$since" 2>&1)"; rc=$?
    echo "$out"
    [ "$rc" = 0 ] || exit "$rc"
    grep -qx 'exit: met' <<< "$out" || { echo "shadow-drill: exit not met (the drill is not over)" >&2; exit 1; }
    ;;
  *) die "usage: shadow-drill.sh crash <worktree> [--dry-run] | report --since <iso|epoch> [--project <label>]";;
esac
