// orca-missing.ts — is there an orca CLI on this host (orca-backend-alternatives U58)? The accounts refresh asks
// before it reads Orca's profiles.
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { orcaData } from "../loop/drivers/claude-launch.ts";

const exe = (p: string): boolean => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

/** An `orca` CLI where Orca's adapter looks for one (bin/backend/orca.ts resolveOrcaCli): DS_ORCA_CLI_BIN_DIR /
 *  ORCA_CLI_BIN_DIR, else Orca's bundled CLI, else PATH. */
export function orcaCliHere(env: Record<string, string | undefined> = process.env): boolean {
  const dir = env.DS_ORCA_CLI_BIN_DIR || env.ORCA_CLI_BIN_DIR || "";
  if (dir) return exe(join(dir, "orca"));
  return exe(join(orcaData(env), "cli", "bin", "orca")) || !!Bun.which("orca", { PATH: env.PATH ?? "" });
}
