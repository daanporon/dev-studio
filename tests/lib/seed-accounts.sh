# shellcheck shell=bash
# seed-accounts.sh — sourced by the tests that need Claude rows in a throwaway loop.db's `accounts` table.
#
#   seed_claude_accounts <state root> <account>[:<folder>]...
#
# Migrates <state root>/loop.db and replaces its accounts rows: `system` is the system row, every other one a
# dev-studio (`ds`) login at <folder> (none: no config_dir). No folder is made.
seed_claude_accounts() {
  local st="$1" lib; shift
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  mkdir -p "$st"; "$lib/bin/ds" --state "$st" migrate >/dev/null
  bun -e '
    const { Database } = require("bun:sqlite");
    const [db, ...specs] = process.argv.slice(1);
    const d = new Database(db);
    d.run("DELETE FROM accounts");
    for (const s of specs) {
      const [account, folder] = s.split(":");
      d.run("INSERT INTO accounts (agent, account, source, config_dir, observed_at) VALUES (?, ?, ?, ?, 1)",
        ["claude", account, account === "system" ? "system" : "ds", folder || null]);
    }
    d.close();
  ' "$st/loop.db" "$@"
}
