// skills-data.ts — GET /api/skills for the Skills tab (U230), apart from board-data.ts because it is
// the one board read that looks at the host: the skills `ds skills list` finds (the session-listing cache
// and a scan of the skill folders) and the shipped conventions/skills.conf. The rest of the board reads
// loop.db alone, and tests/board.sh keeps board-data.ts and board-server.ts free of file reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allSkills, isNamed, mcpServers, isProjectSkill, projectRepoDir, levelOf, parseRules, requiredOf, ROLES as SKILL_ROLES, shippedRules, type Rule, type Skill } from "../loop/settings/skills.ts";
import { openReadOnly, ROOT, stateRoot } from "../loop/core/store.ts";

// GET /api/skills (U230): each role's skills for the Skills tab. Per role: the level of every skill
// `ds skills list` finds and of every start hook (shipped rules + the project's `config` rows, file
// skills.conf), what is locked (a shipped `required` rule) and why, the role's "other skills" level,
// and roughly what the list saves (characters of descriptions not listed, as tokens at 4 chars each).
const SKILL_GROUPS = ["Compound Engineering", "dev-studio", "user", "built-in", "claude.ai", "Project repo"];
export function skillGroup(s: Skill): string {
  if (isProjectSkill(s)) return "Project repo";
  if (s.source === "plugin compound-engineering") return "Compound Engineering";
  if (s.source === "command" || s.name.startsWith("ds-")) return "dev-studio";
  if (s.source === "user") return "user";
  if (s.name.startsWith("anthropic-skills:")) return "claude.ai";
  return "built-in";
}
// Why a role can't change a name: the role's doc or AGENTS.md names it, else the shipped file says so.
function requiredWhy(name: string, role: string, rule: Rule, dsRoot: string): string {
  const short = name.includes(":") ? name.split(":")[1] : name;
  for (const f of [`roles/${role}.md`, "AGENTS.md"]) {
    try {
      const t = readFileSync(join(dsRoot, f), "utf8");
      if (t.includes(name) || (!name.startsWith("hook:") && new RegExp(`(^|[^\\w-])${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(t))) return `named in ${f}`;
    } catch { /* no such doc */ }
  }
  return `required by conventions/skills.conf (${rule.role} ${rule.pattern})`;
}
export function skillsJson(project: string, root = stateRoot(), opts: { repoDir?: string | null; skills?: Skill[]; shipped?: Rule[]; dsRoot?: string } = {}) {
  let st; try { st = openReadOnly(root); } catch { return null; }
  try {
    const db = { all: (q: string, ...a: unknown[]) => st.db.query(q).all(...(a as never[])) as Record<string, unknown>[] };
    const dsRoot = opts.dsRoot ?? ROOT, shipped = opts.shipped ?? shippedRules(join(dsRoot, "conventions", "skills.conf"));
    const mine = parseRules(db.all("SELECT key, value FROM config WHERE project = ? AND file = 'skills.conf' ORDER BY rowid", project).map((r) => `${r.key} ${r.value}`).join("\n"), true).map((r) => ({ ...r, required: false }));
    const skills = (opts.skills ?? allSkills(false, opts.repoDir === undefined ? projectRepoDir(project, root) ?? "" : opts.repoDir ?? "", project)).filter((s) => s.name);
    const hooks = [...new Set([...shipped, ...mine].map((r) => r.pattern).filter((p) => p.startsWith("hook:") && !p.includes("*")))].sort();
    const servers = mcpServers(shipped, mine);   // U283: the MCP servers a role can load (known + any a rule names)
    const roles = SKILL_ROLES.map((role) => {
      const item = (name: string, extra: Record<string, unknown>, hook: boolean, proj = false) => {
        const level = levelOf(name, role, shipped, mine, proj) ?? "on", dflt = levelOf(name, role, shipped, [], proj) ?? "on";
        const req = requiredOf(name, role, shipped, proj);
        return { name, ...extra, level, default: dflt, edited: level !== dflt, required: !!req, reason: req ? requiredWhy(name, role, req, dsRoot) : null, is_new: !hook && !isNamed(name, shipped, mine, proj) };
      };
      const list = skills.map((s) => item(s.name, { group: skillGroup(s), description: s.description }, false, isProjectSkill(s)));
      const hookRows = hooks.map((h) => item(h, { group: "hook", description: "" }, true));
      // `mcp:` names take on or off only: any other level a stray rule gives reads as on (a server is loaded or it is not).
      const mcpRows = servers.map((n) => { const r = item(`mcp:${n}`, { group: "mcp", description: "" }, true); return { ...r, level: r.level === "off" ? "off" : "on", default: r.default === "off" ? "off" : "on" }; });
      const other = { level: levelOf("*", role, shipped, mine) ?? "on", default: levelOf("*", role, shipped, []) ?? "on" };
      const saved = list.reduce((n, x) => n + (x.level === "on" ? 0 : x.description.length), 0);
      const count = (l: string) => list.filter((x) => x.level === l).length;
      const own = mine.filter((r) => r.role === role);
      return { role, override: own.length > 0, other, skills: list, hooks: hookRows, mcp: mcpRows,
        summary: { required: list.filter((x) => x.required).length, on: count("on"), name_only: count("name-only"), user_invocable_only: count("user-invocable-only"), off: count("off"), saved_tokens: Math.round(saved / 4) } };
    });
    return { project, groups: SKILL_GROUPS, roles };
  } finally { st.close(); }
}

