// fulfil/skills.ts — kind `skills` (U230): the board's Skills tab edits one role's skill levels. Payload
//   {role, set: {<skill | hook:<name> | mcp:<server> | *>: level}}   edit (a level equal to the shipped one drops its row)
//   {role, reset: true}                               drop the role's project rows
// A project edit is a `config` row (project, file 'skills.conf', key "<role> <pattern>", value the level),
// written to the database directly: there is no project skills.conf file (observers/config keeps the rows).
// A name a shipped `required` rule pins is refused here too, so a request that skipped the server's check
// still can't lower it. `ds skills resolve` reads the rows, so the change shows at the role's next start.
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { replace } from "../core/gate.ts";
import { allSkills, isProjectSkill, LEVELS, levelOf, projectRepoDir, requiredOf, ROLES, shippedRules } from "../settings/skills.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

type P = ActionPayload<"skills">;

const skills: Fulfiller = {
  name: "skills",
  scope: "host",
  kinds: ["skills"],
  run: (ctx) => requestActions(ctx, ["skills"]),
  exec(a, x) {
    const p = payloadOf<"skills">(a), project = a.project;
    if (!project || !p.role || !(ROLES as readonly string[]).includes(p.role)) return { failed: "a skills edit needs a project and a known role" };
    if (!p.reset && (!p.set || typeof p.set !== "object" || !Object.keys(p.set).length)) return { failed: "a skills edit needs a reset or at least one skill: level" };
    const shipped = shippedRules();
    const dir = projectRepoDir(project, x.store.root ?? undefined) ?? "";
    const proj = new Set(dir ? allSkills(false, dir, project).filter(isProjectSkill).map((k) => k.name) : []);
    const rows = new Map<string, string>(
      (x.store.db.query("SELECT key, value FROM config WHERE project = ? AND file = 'skills.conf'").all(project) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    if (p.reset) for (const k of [...rows.keys()]) { if (k.startsWith(p.role + " ")) rows.delete(k); }
    else for (const [name, level] of Object.entries(p.set!)) {
      if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level)) return { failed: `${name}: unknown level ${String(level)}` };
      const req = requiredOf(name, p.role, shipped, proj.has(name));
      if (req && level !== req.level) return { failed: `${name} is required for ${p.role}; it can't be lowered` };
      const key = `${p.role} ${name}`;
      if (level === (levelOf(name, p.role, shipped, [], proj.has(name)) ?? "on")) rows.delete(key); else rows.set(key, level);
    }
    const at = x.now;
    x.store.tx(() => replace(x.store, [...rows].map(([key, value]) => ({ table: "config", key: { project, file: "skills.conf", key }, set: { value, comment: null, observed_at: at } })), at, [["config", { project, file: "skills.conf" }]]));
    finishRequest(x.store, a, { ok: true, role: p.role, rows: [...rows.keys()].filter((k) => k.startsWith(p.role + " ")).length }, x.now);
    return { done: true };
  },
  giveUp: failRequest,
};
export default skills;
