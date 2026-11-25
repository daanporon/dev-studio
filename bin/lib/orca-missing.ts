// orca-missing.ts — is Orca missing for the host's account commands (orca-backend-alternatives U58)? The accounts
// stay Orca's until issue #125, so on a host without Orca `accounts-refresh` and `account-skills check` skip with
// one line instead of failing loudly.
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { orcaData } from "../loop/drivers/claude-launch.ts";
import { ROOT, run } from "./shared";

/** The line a skipped account command prints. */
export const ACCOUNTS_SKIP = (cmd: string): string => `${cmd}: Orca is not here, so there are no accounts to read; skipped (accounts off Orca are issue #125)`;

const exe = (p: string): boolean => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

/** An `orca` CLI where Orca's adapter looks for one (bin/backend/orca.ts resolveOrcaCli): DS_ORCA_CLI_BIN_DIR /
 *  ORCA_CLI_BIN_DIR, else Orca's bundled CLI, else PATH. */
export function orcaCliHere(env: Record<string, string | undefined> = process.env): boolean {
  const dir = env.DS_ORCA_CLI_BIN_DIR || env.ORCA_CLI_BIN_DIR || "";
  if (dir) return exe(join(dir, "orca"));
  return exe(join(orcaData(env), "cli", "bin", "orca")) || !!Bun.which("orca", { PATH: env.PATH ?? "" });
}

/** Orca is missing when `adapter` is Orca's own (bin/backend/orca.sh, no BACKEND swap) and there is no `orca` CLI
 *  (no adapter call), or its `preflight` fails: the runtime does not answer, and `account-list` would offer only the
 *  built-in defaults. A swapped adapter answers for itself: never missing. */
export async function orcaMissing(adapter: string): Promise<boolean> {
  if (process.env.BACKEND || adapter !== join(ROOT, "bin", "backend", "orca.sh")) return false;
  if (!orcaCliHere()) return true;
  return (await run([adapter, "preflight"])).rc !== 0;
}
