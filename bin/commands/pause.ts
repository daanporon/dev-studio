import { parse, print } from "../loop/core/cli.ts";
import { acknowledge, projection, type PauseTarget, type Prerequisite } from "../loop/pause/pause.ts";
import { now, open } from "../loop/core/store.ts";
import { whoAmI } from "../loop/core/whoami.ts";

export const help = "<project|squad|member> <project> [squad] [role] [suffix] [--prerequisites <json>] — checkpoint and pause; show/ack are agent controls";
export function target(args: string[]): PauseTarget {
  const [scope, project, squad, role, suffix] = args;
  const count = scope === "project" ? 2 : scope === "squad" ? 3 : scope === "member" ? 4 : 0;
  if (!count || !project || args.length < count || args.length > count + (scope === "member" ? 1 : 0)) throw new Error(`usage: ds pause ${help}`);
  return { scope: scope as PauseTarget["scope"], project, squad, role, suffix: suffix === "-" ? "" : suffix ?? "" };
}
export async function run(args: string[]): Promise<void> {
  const { pos, opt } = parse(args, ["prerequisites", "by"]);
  const s = open();
  try {
    if (pos[0] === "ack") {
      if (pos.length !== 9) throw new Error("usage: ds pause ack <project> <squad> <role> <suffix|-> <generation> <session> <dispatch|-> <journal>");
      const [, project, squad, role, suffix, generation, session, dispatch, file] = pos;
      if (whoAmI().handle !== session) throw new Error("pause: acknowledgment must come from the instructed agent terminal");
      print(acknowledge(s, { project, squad, role, suffix: suffix === "-" ? "" : suffix }, generation, session, dispatch, file, now()));
      return;
    }
    const show = pos[0] === "show", t = target(show ? pos.slice(1) : pos);
    if (show) { print(projection(s, t)); return; }
    const prerequisites = opt.prerequisites == null ? undefined : JSON.parse(opt.prerequisites) as Prerequisite[];
    if (prerequisites && !Array.isArray(prerequisites)) throw new Error("pause: prerequisites must be a JSON array");
    print(s.pause(t, { source: prerequisites ? "dependency" : "manual", prerequisites, by: opt.by ?? "ds" }));
  } finally { s.close(); }
}
