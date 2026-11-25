// squad-wish.ts — the squad's running wish as spawn-squad writes it (board-actions-as-wishes U6): one pure
// builder for `ds spawn-squad` (bin/commands/spawn-squad-ts.ts, through `ds want`) and the loop's own board
// Start (bin/loop/fulfil/squad-start.ts, through `store.want`). It reads nothing: each caller hands it what it
// read (dispatcher.json, the effective roster, the limits, the squad's placed backend).
import { chooseSquadBackend } from "../../backend/registry.ts";
import { noLaunchLine } from "../../backend/launch-lines.ts";

export const SQUAD_TYPES = ["feature", "testing"] as const;
export const SQUAD_AUTONOMY = ["checkpoints", "lfg"] as const;
export const SQUAD_STARTS = ["plan", "brainstorm", "ask", "investigate", "fix"] as const;
export const badTopic = (t: string) => t === "" || t.startsWith(".") || /[^A-Za-z0-9._-]/.test(t);

export type SquadWishIn = {
  label: string; topic: string;
  repo: string;                       // the --repo selector; dispatcher.json home_repo wins when set
  type?: string; autonomy?: string; host?: string; backend?: string; framing?: string; start?: string;
  from?: string;                      // the Studio's handle, when it has one
  disp?: Record<string, unknown> | null;   // the project's dispatcher.json
  roster: Map<string, string>;        // the effective roster (role -> roles.conf value)
  placed: string | null;              // the backend of a started, not closed squad of that topic
  worktreeProvider?: string;   // the first word of that limit
};
export type SquadWish = { label: string; topic: string; payload: Record<string, string>; fill: Record<string, string> };

export function squadWish(i: SquadWishIn): SquadWish | { error: string } {
  const type = i.type || "feature", autonomy = i.autonomy || "checkpoints", start = i.start ?? "";
  if (badTopic(i.topic)) return { error: "--topic must be [A-Za-z0-9._-] and not start with '.'" };
  if (!(SQUAD_TYPES as readonly string[]).includes(type)) return { error: "--type must be feature|testing" };
  if (!(SQUAD_AUTONOMY as readonly string[]).includes(autonomy)) return { error: "--autonomy must be checkpoints|lfg" };
  if (start !== "" && !(SQUAD_STARTS as readonly string[]).includes(start)) return { error: `--start must be ${SQUAD_STARTS.join("|")}` };
  const home = i.disp?.home_repo;
  const repo = typeof home === "string" && home !== "" ? home : i.repo;
  // U54: the project's Studio backend (dispatcher.json studio_backend, empty meaning orca), once it has a Studio.
  // U57: a squad starts on the Studio's backend (dispatcher.json studio_backend, empty meaning orca), the one backend of the project.
  const studioBackend = String(i.disp?.studio_backend ?? "").trim() || "orca";
  if (i.roster.size > 0 && !i.roster.has("lead")) return { error: "roster (conventions/roles.conf) has no 'lead' role" };
  // The backend and worktree tool (U9, bin/backend/registry.ts): written once, with the first wish. A squad
  // that has started and is not closed keeps its own; asking it for another one is refused.
  const backend = i.backend ?? "";
  let on: Record<string, string> = {};
  if (i.placed) {
    if (backend !== "" && backend !== i.placed) return { error: `squad ${i.topic} runs on ${i.placed}; a squad's backend is written once at spawn` };
  } else {
    const c = chooseSquadBackend({ flag: backend, providerSetting: i.worktreeProvider ?? "", studioBackend, project: i.label });
    if (!c.ok) return { error: c.error };
    on = { backend: c.backend, backend_host: c.host, worktree_provider: c.provider };
    // U11: on a contract backend only an agent with a driver launch line can start (bin/loop/drivers/contract.ts).
    const missing = c.backend === "orca" ? [] : noLaunchLine(i.roster);
    if (missing.length) return { error: `backend ${c.backend} can start only claude; the roster names ${missing.join(", ")} (conventions/roles.conf)` };
  }
  const keep = (o: Record<string, string | undefined>): Record<string, string> =>
    Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const host = i.host ?? "", framing = i.framing ?? "";
  return {
    label: i.label, topic: i.topic,
    fill: keep({ repo, type, autonomy, host, framing, ...on }),
    payload: keep({ repo, type, autonomy, host, framing, start, from: i.from ?? "", ...on }),
  };
}
