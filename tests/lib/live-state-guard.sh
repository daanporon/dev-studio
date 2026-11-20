#!/usr/bin/env bash
# live-state-guard.sh — sourced by tests/ci.sh (U253): the suite must never touch the checkout's real
# state/. live_state_snapshot <state-dir> prints what a test could add there: every project dir
# of state/ (name only) and every project in loop.db (label). live_state_leaks <before> <after> prints
# what is in <after> and not in <before>, empty when the suite left the live state alone. Entries that
# vanish are not leaks (the host may close a project while the suite runs). No clock is compared: the live
# loop rewrites loop.db every tick, so only new names count.
live_state_snapshot() {
  local dir="$1" f
  [ -d "$dir" ] || return 0
  # A project is a dir with squads/ or dispatcher.json (bin/loop/settings/projects.ts); a loop's own files
  # (loop.db-wal, logs, _instr-seen) are not projects.
  for f in "$dir"/*/; do
    f="${f%/}"
    { [ -d "$f/squads" ] || [ -f "$f/dispatcher.json" ]; } && printf 'entry %s\n' "${f##*/}"
  done
  [ -f "$dir/loop.db" ] || return 0
  bun -e '
    import { Database } from "bun:sqlite";
    const d = new Database(process.argv[1], { readonly: true });
    try { for (const r of d.query("SELECT label FROM projects").all() as { label: string }[]) console.log("project " + r.label); } catch {}' "$dir/loop.db" 2> /dev/null || true
}
live_state_leaks() { comm -13 <(sort -u "$1") <(sort -u "$2"); }
