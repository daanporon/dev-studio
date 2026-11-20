#!/usr/bin/env bash
# demo-board-shot.sh [dir] — take docs/img/board.png and board-full.png from the fake demo board (see demo-board.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/demo-board.sh" --shot "${1:-$ROOT/docs/img}"
