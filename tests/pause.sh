#!/usr/bin/env bash
# Public commands and the real journal helper, against isolated SQLite state and fake agents.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec bun test tests/loop/pause-command.test.ts
