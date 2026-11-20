// settings-mark.ts — has this state root had its settings cut-over (U256, settings-migrate.ts)? The
// mark `<root>/.settings-migrated` is written last, after every project's override files were
// imported into rows and renamed; from then on nothing reads state/<label>/{limits,roles,models}.conf
// or ship-mode.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const SETTINGS_MARK = ".settings-migrated";
export const settingsMigrated = (root: string): boolean => existsSync(join(root, SETTINGS_MARK));
