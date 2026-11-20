// ds override — the open overrides (pins of model, effort, plan or account), U24.
//   ds override [list] [--project p]                        every open override as JSON, with its scope and target
//   ds override clear <id> | --squad <p>/<s> | --role <p>/<r> | --project <p>   clear one open override (or every one of that target)
// A member override clears itself when the member's work is done; a squad one also when the squad closes;
// role and project ones stay until cleared here or on the board.
import { now, open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";

export const help = "[list] [--project p] | clear <id> | clear --squad <p>/<s> | --role <p>/<r> | --project <p> [--by <who>] — list open overrides, or clear one";
// The project an override belongs to: a broader row names it in its target; a member row (an id or a worktree) through the members table.
type Ov = { scope: string; member?: string; target?: string };
function projectOf(s: ReturnType<typeof open>, o: Ov): { project: string | null; squad: string | null } {
  const t = String(o.member ?? o.target ?? "");
  if (o.scope === "project") return { project: t, squad: null };
  if (o.scope === "squad") { const [p, ...r] = t.split("/"); return { project: p, squad: r.join("/") }; }
  if (o.scope === "role") return { project: t.split("/")[0], squad: null };
  const m = (/^\d+$/.test(t) ? s.db.query("SELECT project, squad FROM members WHERE id = ?").get(Number(t))
    : s.db.query("SELECT project, squad FROM members WHERE wt = ? ORDER BY id DESC").get(t)) as { project: string; squad: string } | null;
  return { project: m?.project ?? null, squad: m?.squad ?? null };
}

export async function run(args: string[]): Promise<number> {
  const { pos, opt } = parse(args, ["project", "squad", "role", "by"]);
  const [verb = "list", id] = pos;
  if (!["list", "clear"].includes(verb) || pos.length > 2) { console.error(`usage: ds override ${help}`); return 2; }
  const s = open();
  try {
    if (verb === "list") {
      print((s.db.query("SELECT id, COALESCE(scope, 'member') AS scope, member AS target, model, effort, plan, account, set_by, set_at FROM overrides WHERE cleared_at IS NULL ORDER BY id").all() as (Ov & Record<string, unknown>)[])
        .map((o) => ({ ...o, project: projectOf(s, o).project }))
        .filter((o) => !opt.project || o.project === opt.project));
      return 0;
    }
    const by = opt.by ?? "cli", at = now();
    const where = id ? ["id = ?", Number(id)] as const : opt.squad ? ["scope = 'squad' AND member = ?", opt.squad] as const
      : opt.role ? ["scope = 'role' AND member = ?", opt.role] as const : opt.project ? ["scope = 'project' AND member = ?", opt.project] as const : null;
    if (!where || (id && !/^\d+$/.test(id))) { console.error(`usage: ds override ${help}`); return 2; }
    const rows = s.db.query(`SELECT id, COALESCE(scope, 'member') AS scope, member FROM overrides WHERE cleared_at IS NULL AND ${where[0]}`).all(where[1]) as { id: number; scope: string; member: string }[];
    if (!rows.length) { console.error("ds override: no open override matches"); return 2; }
    for (const o of rows) {
      s.db.run("UPDATE overrides SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL", [at, o.id]);
      const { project, squad } = projectOf(s, o);
      s.event("override_cleared", { project, squad, payload: { override: o.id, scope: o.scope, by, reason: "cleared by the operator" } });
    }
    console.log(`cleared ${rows.length} override${rows.length > 1 ? "s" : ""}: ${rows.map((o) => `#${o.id} (${o.scope} ${o.member})`).join(", ")}`);
    return 0;
  } finally { s.close(); }
}
