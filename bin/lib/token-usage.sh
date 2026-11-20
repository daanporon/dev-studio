#!/usr/bin/env bash
# token-usage.sh — how many tokens each dev-studio role spent, from Claude Code's session logs.
#
#   token-usage.sh [--days N | --since EPOCH] [--dir <claude-projects-dir>] [--by-worker] [--top N]
#
# --since EPOCH counts from that moment (unix seconds) instead of the last N days.
#
# Run it on the host that runs the squads (the logs live there, under ~/.claude/projects/).
# A session belongs to a role by its worktree name (`<DS_PREFIX><label>-<role>-…`, DS_PREFIX defaulting
# to `ds-`); everything else is left out. One row per role + model, biggest first:
#   role  model  turns  input  cache_write  cache_read  output
# --by-worker prints one row per worker session folder instead, with its squad topic:
#   worker  topic  role  model  turns  input  cache_write  cache_read  output  ctx
# ctx is the worker's context size at its last assistant turn (input + cache_read + cache_write of
# its newest usage record, any model), the same on each of the worker's rows; the sweep reads it
# to decide whether a limit restart resumes the conversation or starts fresh.
# The topic comes from the newest surviving boot prompt ("… of squad \"<topic>\""); when the logs hold
# none, a Builder's exact worktree is looked up in member/unit metadata (DS_STATE_ROOT, default
# state/ beside bin/; loop.db first, squad files otherwise). Lead/Thinker folders still supply their
# `<role>-<topic>` remainder. Without either source the topic is "?".
# --top N prints only the first N rows (plus the header) — 0 (the default) prints all. Long
# tables flood a remote terminal, so prefer `--top 15`, or page it: `… | less -S`.
# cw_1h / cw_5m split cache_write by its cache TTL (the 1-hour writes cost twice the 5-minute ones);
# 5m also holds a write whose message did not say. ctx ignores sub-agent turns (isSidechain).
# Sub-agent transcripts (<session>/subagents/**.jsonl) count for the worker that ran them. A headless
# review session (entrypoint sdk-cli, prompt naming ce-code-review) and its sub-agents are their own
# `<worker>:review` row, role `review`.
# cache_write is the expensive one to watch: a turn that starts after the 5-minute prompt cache
# expired re-writes the whole conversation. A message logged more than once counts once.
# U265: a transcript last written more than an hour before the cutoff is not read for records (its head
# still gives the topic). What a scan read is kept in state/loop/token-cache.db, so the next one parses
# only the bytes appended since (bin/lib/token-cache.ts); the output is what a full scan prints.
# DS_TOKEN_CACHE=0 scans with no cache. Each run logs one line to stderr: wall time, files parsed in full,
# read incrementally, unchanged and skipped, the bytes parsed and the cache state (new, on, rebuild for a
# cutoff older than the cache holds: one full scan that refills it, busy, reset, off).
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/token-usage-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" token-usage-ts "$@"
