// drivers/index.ts — the driver for an agent. A member with no agent yet is Claude's, the
// roster's default.
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { muse } from "./muse.ts";
import type { DriverModule } from "./types.ts";

const DRIVERS: Record<string, DriverModule> = { claude, muse, codex };

export function driverModule(agent: string | null | undefined): DriverModule {
  const d = DRIVERS[agent || "claude"];
  if (!d) throw new Error(`loop: no driver for agent '${agent}'`);
  return d;
}
