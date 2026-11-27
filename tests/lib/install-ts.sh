# shellcheck shell=bash
# install-ts.sh — sourced by the tests that build a partial checkout around bin/host/install.sh or
# install-skills.sh (U262): both exec `ds install-ts` / `ds install-skills-ts`, so that checkout needs
# the ds front door and the two commands with what they import.
#
#   install_ts_copy <checkout root>
install_ts_copy() {
  local dest="$1" src
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  mkdir -p "$dest/bin/commands" "$dest/bin/lib" "$dest/bin/loop/core"
  cp "$src/bin/ds" "$src/bin/ds.ts" "$dest/bin/"
  cp "$src/bin/commands/install-ts.ts" "$src/bin/commands/install-skills-ts.ts" "$src/bin/commands/wrap-hooks-ts.ts" "$dest/bin/commands/"
  cp "$src/bin/lib/shared.ts" "$src/bin/lib/install.ts" "$src/bin/lib/account-skills.ts" "$src/bin/lib/loop-unit.ts" "$dest/bin/lib/"
  mkdir -p "$dest/bin/lib/account-kinds" "$dest/bin/loop/drivers"
  cp "$src/bin/lib/account-dirs.ts" "$dest/bin/lib/"; cp "$src/bin/lib/account-kinds/"*.ts "$dest/bin/lib/account-kinds/"   # the account list
  cp "$src/bin/loop/drivers/claude-launch.ts" "$dest/bin/loop/drivers/"
  cp "$src/bin/lib/contract-here.ts" "$dest/bin/lib/"; cp "$src/bin/loop/core/whoami.ts" "$dest/bin/loop/core/"   # shared.ts imports them
}
