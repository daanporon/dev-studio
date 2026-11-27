// side-plugins.ts — side-loop-host U3 (issue #127, KTD7): what a side host's loop (`main.ts --role side`) runs.
// One allow-list, by file name without `.ts`: a plugin not named here never runs on a side host, so a new
// deciding reconciler is main-only by default, and the decider (decide.ts) is never loaded there. The list is
// docs/backends/local-reads.md's reads of the agents' own host. Also here: what else differs for a side loop.
import { isTestProject } from "../settings/projects.ts";
import type { Store } from "./store.ts";

export const SIDE_PLUGINS: Record<"observers" | "reconcilers" | "fulfil", readonly string[]> = {
  observers: [
    "chat", "cleanup", "codex", "contract", "disk-usage", "exposed", "machine", "procs", "reviews",
    "state",       // transcripts only on a side host: its other reads are main's own state/ files
    "worktrees",
  ],
  reconcilers: ["side-fence", "side-push", "side-skills"],   // U14: push ahead, fence itself; U21: role skills
  fulfil: [],
};

/** Plugins that only a side host runs: a main loop leaves these files out (core/plugins.ts loadAll). */
export const SIDE_ONLY: Record<"observers" | "reconcilers" | "fulfil", readonly string[]> = {
  observers: [],
  reconcilers: ["side-fence", "side-push", "side-skills"],
  fulfil: [],
};

/** A side root holds no project folders: its projects are the rows main sent down (bin/link/replica.ts). */
export function sideProjects(store: Store): string[] {
  return (store.db.query("SELECT label FROM projects ORDER BY label").all() as { label: string }[])
    .map((r) => r.label).filter((l) => !isTestProject(l));
}
