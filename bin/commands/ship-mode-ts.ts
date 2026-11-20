// ds ship-mode-ts — view or set a project's ship mode (U263): what bin/commands/ship-mode.sh runs. The
// override is the project's ship-mode row (key `mode`) in loop.db, changed through bin/loop/settings/settings.ts (U256).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dsLabel, writeErr, writeOut } from "../lib/shared";
import { SHIP_MODES, shipMode } from "../lib/operator";
import { hasOwn } from "../lib/settings-rows.ts";
import { rm, set } from "../loop/settings/settings.ts";
import { changeSettings } from "../loop/settings/settings-migrate.ts";

export const help = `<project> [<mode>|default] — view or set a project's ship mode (ship-mode.sh)`;

export async function run(argv: string[]): Promise<number> {
  if (argv.length < 1) { writeErr(`usage: ship-mode.sh <project> [<mode>|default]   (modes: ${SHIP_MODES})\n`); return 2; }
  const label = dsLabel(argv[0]); const newMode = argv[1] ?? "";

  if (newMode === "") {
    let src: string;
    const conf = join(ROOT, "conventions", "projects.conf");
    if (hasOwn(label, "ship-mode")) src = `set via /ds-mode (ds config get ${label} ship-mode mode)`;
    else if (existsSync(conf) && readFileSync(conf, "utf8").split("\n").some((l) => new RegExp(`^[ \\t\\n\\v\\f\\r]*${label}[ \\t\\n\\v\\f\\r]`).test(l))) src = "conventions/projects.conf";
    else src = "default";
    writeOut(`${label}: ship mode = ${shipMode(label)}  [${src}]\n`);
    return 0;
  }
  if (newMode === "default" || newMode === "-") {
    if (!changeSettings("ship-mode", (s) => rm(s, label, "ship-mode", "mode", "ds ship-mode"))) return 2;
    writeOut(`ship-mode: ${label} -> default (override cleared; now ${shipMode(label)})\n`);
    return 0;
  }
  if (!changeSettings("ship-mode", (s) => set(s, label, "ship-mode", "mode", newMode, "ds ship-mode"))) return 2;
  writeOut(`ship-mode: ${label} -> ${newMode}  (applies on each squad's next ship; /ds-reload ${label} to refresh running squads)\n`);
  return 0;
}
