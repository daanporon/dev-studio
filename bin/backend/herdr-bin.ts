// herdr-bin.ts — which herdr binary the loop runs (orca-backend-alternatives U16c). Kept apart from
// herdr.ts so the registry (bin/backend/registry.ts) can check for it at spawn without loading the adapter.
//
//   DS_HERDR_BIN                       a binary to use instead (its protocol is still checked on the first call)
//   <data>/dev-studio/herdr/<v>/herdr  the pinned install (`bun bin/backend/herdr.ts install`), <data> being
//                                      $XDG_DATA_HOME, else ~/.local/share
//   herdr on PATH                      last
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HERDR_VERSION = "0.9.5";

/** The folder the pinned release `version` is installed in. */
export function herdrPinnedDir(version = HERDR_VERSION, env: Record<string, string | undefined> = process.env): string {
  const data = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(data, "dev-studio", "herdr", version);
}

/** The herdr binary to run, or null when there is none. `which` is for tests. */
export function herdrBin(o: { env?: Record<string, string | undefined>; which?: (bin: string) => string | null } = {}): string | null {
  const env = o.env ?? process.env;
  if (env.DS_HERDR_BIN) return existsSync(env.DS_HERDR_BIN) ? env.DS_HERDR_BIN : null;
  const pinned = join(herdrPinnedDir(HERDR_VERSION, env), "herdr");
  if (existsSync(pinned)) return pinned;
  return (o.which ?? ((b: string) => Bun.which(b)))("herdr");
}
