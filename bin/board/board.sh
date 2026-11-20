#!/usr/bin/env bash
# board.sh — render the overview board for a project (or all projects).
#   board.sh [<project-selector-or-label>] [--topic <slug>] [--watch [seconds]] [--json] [--serve [port]]
#     --topic <slug>  scope to one squad (used when run inside a squad)
#     --watch         re-render the text board on an interval (default every 5s) until Ctrl-C
#     --json          print the board's data as one JSON document (what the web page renders)
#     --serve [port]  keep the live web board (web/board.html + /board.json) running on :port (default
#                     8787, or the port asked for before): writes the wish (`ds want board`, a `services`
#                     row in loop.db) and prints the URL; the loop starts it and keeps it up (U16)
#     --ensure        gone: says the loop runs the board and exits 0
#     --stop          the wish set to stopped: the loop stops the board
#     --serve-fg [port]  the server itself, in the foreground (by hand; the loop runs board-server.ts)
#     (default: render text once, all projects)
#
# The server is a singleton per SCOPE (all / <project> / <project>+<topic>): one `services` row per
# scope, and --serve-fg on the SAME scope replaces the running one (kill + restart).
#
# The board itself (text and JSON) is built by bin/board/board-data.ts (Bun); this script is its front
# door: arguments, the --watch loop, the --serve wish, and the --serve-fg process.
set -euo pipefail
# U222: the work runs in TypeScript (bin/commands/board-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" board-ts "$@"
