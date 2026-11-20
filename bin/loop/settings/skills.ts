// skills.ts — which skills and start hooks a role starts with (U229). Rules come from
// conventions/skills.conf (shipped) and the project's `config` rows (file skills.conf, key
// "<role> <pattern>", value "<level>"); the resolver turns them into Claude Code's skillOverrides.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ROOT, stateRoot } from "../core/store.ts";

export const LEVELS = ["on", "name-only", "user-invocable-only", "off"] as const;
export const ROLES = ["builder", "thinker", "lead", "tester", "researcher", "reviewer", "review", "studio"] as const;

export type Rule = { role: string; pattern: string; level: string; required: boolean; project: boolean };
export type Skill = { name: string; source: string; description: string };

// One line: `<role> <pattern> <level> [required]  # comment`. A bad line is skipped.
export function parseRules(text: string, project = false): Rule[] {
  const out: Rule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const f = line.split(/\s+/);
    if (f.length < 3 || f.length > 4 || !(LEVELS as readonly string[]).includes(f[2])) continue;
    if (f[3] !== undefined && f[3] !== "required") continue;
    out.push({ role: f[0], pattern: f[1], level: f[2], required: f[3] === "required", project });
  }
  return out;
}

export function shippedRules(file = join(ROOT, "conventions", "skills.conf")): Rule[] {
  return existsSync(file) ? parseRules(readFileSync(file, "utf8")) : [];
}

// The project's edits: config rows (project, file 'skills.conf'); key "<role> <pattern>", value the level.
export function projectRules(db: { query: (q: string) => { all: (...a: unknown[]) => unknown[] } } | null, project: string): Rule[] {
  if (!db || !project) return [];
  try {
    const rows = db.query("SELECT key, value FROM config WHERE project = ? AND file = 'skills.conf'").all(project) as { key: string; value: string }[];
    return parseRules(rows.map((r) => `${r.key} ${r.value}`).join("\n"), true).map((r) => ({ ...r, required: false }));
  } catch { return []; }
}

// `project:*` is the one pattern about where a skill comes from: any skill of the project repo (U236).
export const PROJECT_PATTERN = "project:*";
export function matches(pattern: string, name: string, proj = false): boolean {
  if (pattern === "*") return true;
  if (pattern === PROJECT_PATTERN) return proj;
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

// Rank: a role's own exact/glob rule, then its own `*`, then role `*`'s globs, then role `*`'s `*`.
function rank(r: Rule): number[] {
  const spec = r.pattern === "*" ? 0 : r.pattern.endsWith("*") ? 1 + r.pattern.length : 1e6;
  const tier = r.role === "*" ? (r.pattern === "*" ? 0 : 1) : (r.pattern === "*" ? 2 : 3);
  return [tier, spec, r.project ? 1 : 0];
}
function best(rules: Rule[]): Rule | undefined {
  let b: Rule | undefined, br: number[] = [];
  for (const r of rules) {
    const k = rank(r);
    if (!b || k[0] > br[0] || (k[0] === br[0] && (k[1] > br[1] || (k[1] === br[1] && k[2] >= br[2])))) { b = r; br = k; }
  }
  return b;
}

// The level of one name (skill or hook:<name>) for a role, or undefined when no rule names it.
export function levelOf(name: string, role: string, shipped: Rule[], project: Rule[], proj = false): string | undefined {
  const mine = (r: Rule) => (r.role === role || r.role === "*") && matches(r.pattern, name, proj);
  const ship = best(shipped.filter(mine));
  if (ship?.required) return ship.level;
  const win = best([...shipped, ...project].filter(mine));
  return win?.level;
}

// The shipped `required` rule that pins a name for a role, if any (a project edit can't change it).
export function requiredOf(name: string, role: string, shipped: Rule[], proj = false): Rule | undefined {
  const b = best(shipped.filter((r) => (r.role === role || r.role === "*") && matches(r.pattern, name, proj)));
  return b?.required ? b : undefined;
}

// Does any shipped or project rule other than a bare `*` name this skill (for any role)?
export function isNamed(name: string, shipped: Rule[], project: Rule[], proj = false): boolean {
  return [...shipped, ...project].some((r) => r.pattern !== "*" && matches(r.pattern, name, proj));
}

export function skillOverrides(skills: string[], role: string, shipped: Rule[], project: Rule[], projNames: Set<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of skills) {
    const l = levelOf(s, role, shipped, project, projNames.has(s));
    if (l && l !== "on") out[s] = l;
  }
  return out;
}

// --- MCP servers per role (U283) -----------------------------------------------------------------
// `mcp:<server>` rules (level on | off) name the servers a role's session loads. Probed 2026-11-17 on
// Claude Code 2.1.326 (`claude -p` with --output-format stream-json, the init event's mcp_servers):
// `--settings '{"deniedMcpServers":[{"serverName":"<name>"}]}'` stops one server of every kind and keeps
// the rest: a user server of ~/.claude.json ("linear-server"), a plugin server ("plugin:<plugin>:<server>",
// context-mode) and a claude.ai connector ("claude.ai Claude Docs"). --strict-mcp-config drops all servers,
// ENABLE_CLAUDEAI_MCP_SERVERS=false drops every connector, and enabledPlugins=false also drops the plugin's
// skills and hooks: all coarser, so none is used. A bare name or a name no session lists denies nothing.
export const MCP_SERVERS: Record<string, string[]> = {
  "linear-server": ["linear-server"],
  "claude-docs": ["claude.ai Claude Docs"],
  "context-mode": ["plugin:context-mode:context-mode"],
  "easel": ["plugin:easel:easel", "plugin:cc-plugin-easel:easel", "easel"],
};
export const MCP_LEVELS = ["on", "off"] as const;
export const isMcpName = (n: string) => n.startsWith("mcp:");

/** The server names a `mcp:<server>` rule can set: the known ones and any a rule names (no glob). */
export function mcpServers(...rules: Rule[][]): string[] {
  const names = new Set(Object.keys(MCP_SERVERS));
  for (const r of rules.flat()) if (isMcpName(r.pattern) && !r.pattern.includes("*")) names.add(r.pattern.slice(4));
  return [...names].sort();
}

/** One role's choice per server: `on` unless a rule says `off`. */
export function mcpLevels(role: string, shipped: Rule[], project: Rule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of mcpServers(shipped, project)) out[n] = levelOf(`mcp:${n}`, role, shipped, project) === "off" ? "off" : "on";
  return out;
}

/** The `deniedMcpServers` entries of the servers a role has off. */
export function deniedMcpServers(levels: Record<string, string>): { serverName: string }[] {
  const out: { serverName: string }[] = [];
  for (const [n, l] of Object.entries(levels)) if (l === "off") for (const serverName of MCP_SERVERS[n] ?? [n, `plugin:${n}:${n}`]) out.push({ serverName });
  return out;
}

// --- plugins per role (review-unit-no-receipt U1) ------------------------------------------------
// `plugin:<plugin id>` rules (level on | off; the id as `enabledPlugins` keys it, `<name>@<marketplace>`)
// turn a whole plugin off for a role's sessions: `enabledPlugins: {"<id>": false}` in the one --settings
// drops the plugin's skills, hooks and MCP server together. Only a plugin a rule names (no glob) is set, and
// only `plugin:` rules set it: a role's blanket `*  off` (the board's "other skills") reaches no plugin.
const PLUGIN = "plugin:";
export const isPluginName = (n: string) => n.startsWith(PLUGIN);

/** The plugin ids a `plugin:<id>` rule names (no glob). */
export function pluginIds(...rules: Rule[][]): string[] {
  const ids = new Set<string>();
  for (const r of rules.flat()) if (isPluginName(r.pattern) && !r.pattern.includes("*")) ids.add(r.pattern.slice(PLUGIN.length));
  return [...ids].sort();
}

/** One role's choice per named plugin: `on` unless a `plugin:` rule says `off` (a role's `*` row never reaches a plugin). */
export function pluginLevels(role: string, shipped: Rule[], project: Rule[]): Record<string, string> {
  const own = (rules: Rule[]) => rules.filter((r) => isPluginName(r.pattern));
  const out: Record<string, string> = {};
  for (const id of pluginIds(shipped, project)) out[id] = levelOf(`${PLUGIN}${id}`, role, own(shipped), own(project)) === "off" ? "off" : "on";
  return out;
}

/** The `enabledPlugins` entries of the plugins a role has off ({} when none). */
export function disabledPlugins(levels: Record<string, string>): Record<string, false> {
  const out: Record<string, false> = {};
  for (const [id, l] of Object.entries(levels)) if (l === "off") out[id] = false;
  return out;
}

// --- which skills exist on this host -------------------------------------------------------------

function front(file: string): { name?: string; description?: string } {
  try {
    const m = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const get = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
    return { name: get("name"), description: get("description") };
  } catch { return {}; }
}

function folders(dir: string): string[] {
  try { return readdirSync(dir).filter((d) => existsSync(join(dir, d, "SKILL.md"))); } catch { return []; }
}

export function diskSkills(home = homedir(), dsRoot = ROOT): Skill[] {
  const out: Skill[] = [];
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  for (const d of folders(join(cfg, "skills"))) {
    const f = front(join(cfg, "skills", d, "SKILL.md"));
    out.push({ name: f.name || d, source: "user", description: f.description ?? "" });
  }
  // Each enabled plugin's newest install: the registry names the install paths.
  try {
    const reg = JSON.parse(readFileSync(join(cfg, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
    let enabled: Record<string, boolean> = {};
    try { enabled = JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")).enabledPlugins ?? {}; } catch { /* none */ }
    for (const [key, installs] of Object.entries(reg) as [string, { installPath: string }[]][]) {
      if (enabled[key] === false) continue;
      const plugin = key.split("@")[0], p = installs.map((i) => i.installPath).filter((p) => existsSync(p)).sort().pop();
      if (!p) continue;
      for (const d of folders(join(p, "skills"))) {
        const f = front(join(p, "skills", d, "SKILL.md"));
        out.push({ name: `${plugin}:${f.name || d}`, source: `plugin ${plugin}`, description: f.description ?? "" });
      }
    }
  } catch { /* no registry */ }
  // Slash commands show up in the listing too (the operator's ds-* commands).
  for (const dir of [join(cfg, "commands"), join(dsRoot, ".claude", "commands")]) {
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
        const name = f.slice(0, -3);
        if (!out.some((s) => s.name === name)) out.push({ name, source: "command", description: front(join(dir, f)).description ?? "" });
      }
    } catch { /* no commands dir */ }
  }
  return out;
}

// The project repo's own skills (U236): <dir>/.claude/skills/*/SKILL.md, the folder often a link to
// .agents/skills. Probed 2026-11-12: Claude Code keys them by bare name and every level works.
export function projectSkills(dir: string, label = ""): Skill[] {
  const base = join(dir, ".claude", "skills");
  return folders(base).map((d) => {
    const f = front(join(base, d, "SKILL.md"));
    return { name: f.name || d, source: `project ${label || basename(dir)}`, description: f.description ?? "" };
  });
}
export const isProjectSkill = (s: Skill) => s.source.startsWith("project ");

// The repo dir of a project: the `repo` selector of its squad files (`path:<dir>`, `id:<uuid>::<dir>`).
export function projectRepoDir(project: string, root = stateRoot()): string | null {
  try {
    const dir = join(root, project, "squads");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort().reverse()) {
      try {
        const sel = JSON.parse(readFileSync(join(dir, f), "utf8")).repo;
        const d = typeof sel === "string" ? sel.replace(/^path:/, "").replace(/^id:[^:]*::/, "") : "";
        if (d.startsWith("/") && existsSync(d)) return d;
      } catch { /* not a squad file */ }
    }
  } catch { /* no squads dir */ }
  return null;
}

const cachePath = () => join(stateRoot(), "skills-listing.json");

// The `skill_listing` of the newest session that ran with no overrides (a listing of 60+ skills),
// which also holds the built-in and claude.ai skills no folder shows.
export function sessionListing(home = homedir(), maxFiles = 40): Skill[] {
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
  const files: { f: string; t: number }[] = [];
  try {
    for (const d of readdirSync(base)) for (const f of readdirSync(join(base, d))) if (f.endsWith(".jsonl")) {
      const p = join(base, d, f); files.push({ f: p, t: statSync(p).mtimeMs });
    }
  } catch { return []; }
  files.sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(0, maxFiles)) {
    let text: string; try { text = readFileSync(f, "utf8"); } catch { continue; }
    let at = text.lastIndexOf('"skill_listing"');
    while (at >= 0) {
      const start = text.lastIndexOf("\n", at) + 1, end = text.indexOf("\n", at);
      try {
        const c = JSON.parse(text.slice(start, end < 0 ? undefined : end))?.attachment?.content as string | undefined;
        const lines = (c ?? "").split("\n").filter((l) => l.startsWith("- "));
        if (lines.length >= 60) return lines.map((l) => {
          const m = l.match(/^- ([^:\s]+(?::[^:\s]+)?)(?::\s(.*))?$/);
          return { name: m?.[1] ?? l.slice(2), source: "session listing", description: m?.[2] ?? "" };
        });
      } catch { /* not that line */ }
      at = text.lastIndexOf('"skill_listing"', at - 1);
    }
  }
  return [];
}

export function cachedListing(): Skill[] {
  try { return JSON.parse(readFileSync(cachePath(), "utf8")).skills ?? []; } catch { return []; }
}
export function refreshListing(): Skill[] {
  const skills = sessionListing();
  if (skills.length) { mkdirSync(dirname(cachePath()), { recursive: true }); writeFileSync(cachePath(), JSON.stringify({ at: Date.now(), skills })); }
  return skills;
}

// The union, a name once: the disk scan's description wins over the listing's.
export function allSkills(refresh = false, repoDir = "", label = ""): Skill[] {
  const by = new Map<string, Skill>();
  // No cache yet (a fresh host): take the first listing now; `ds skills list --refresh` renews it.
  const listed = refresh || !existsSync(cachePath()) ? refreshListing() : cachedListing();
  for (const s of listed) by.set(s.name, s);
  for (const s of diskSkills()) by.set(s.name, { ...by.get(s.name), ...s, description: s.description || by.get(s.name)?.description || "" });
  if (repoDir) for (const s of projectSkills(repoDir, label)) by.set(s.name, { ...by.get(s.name), ...s });
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- which role / project a worktree is --------------------------------------------------------

export function roleOf(dir: string, projects: string[], prefix = process.env.DS_PREFIX || "ds-"): { project: string; role: string } | null {
  const name = basename(dir.replace(/\/+$/, ""));
  for (const p of [...projects].sort((a, b) => b.length - a.length)) {
    const at = name.indexOf(`${prefix}${p}-`);
    if (at < 0) continue;
    const rest = name.slice(at + prefix.length + p.length + 1);
    const m = rest.match(/^(lead|thinker|builder|tester|researcher|reviewer|studio)(-|$)/);
    if (m) return { project: p, role: m[1] };
  }
  return null;
}
