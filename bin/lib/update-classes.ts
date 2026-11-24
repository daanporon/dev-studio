// update-classes.ts — the grading rule for a dev-studio update: what a set of changed paths asks of the
// running workers. Used by update-squads (--auto) and, later, the board's update banner.
//   skills        skills/**, .claude/commands/**                 -> restart (a new skill loads only in a new session)
//   instructions  the files behind `INSTRUCTIONS: changed`        -> reload  (re-read, no new session)
//   code          everything else                                 -> none    (scripts run their latest version)
// The strongest need wins: restart > reload > none.
// reloadTargets() says WHO a reload goes to: AGENTS.md and the brief sources -> everyone; roles/<r>.md -> role r;
// studio/studio.md -> the Studio; conventions/*.md alone -> nobody (roles read them when they use them).

export type UpdateClass = "skills" | "instructions" | "code";
export type UpdateNeed = "restart" | "reload" | "none";

/** Copied from instrHash() in bin/commands/watch-ts.ts (AGENTS.md, roles/*.md, studio/studio.md, conventions/*.md);
 *  tests/loop/update-classes.test.ts fails when the two lists differ. A `*` matches within one folder level. */
export const INSTRUCTION_GLOBS: readonly string[] = ["AGENTS.md", "roles/*.md", "studio/studio.md", "conventions/*.md"];

const globRe = (g: string): RegExp => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
const INSTR_RES = INSTRUCTION_GLOBS.map(globRe);

export function classOf(path: string): UpdateClass {
  const p = path.replace(/^\.\//, "");
  if (p.startsWith("skills/") || p.startsWith(".claude/commands/")) return "skills";
  if (INSTR_RES.some((re) => re.test(p))) return "instructions";
  return "code";
}

export function classify(paths: Iterable<string>): Set<UpdateClass> {
  const out = new Set<UpdateClass>();
  for (const p of paths) if (p !== "") out.add(classOf(p));
  return out;
}

export function need(classes: Iterable<UpdateClass>): UpdateNeed {
  const s = new Set(classes);
  if (s.has("skills")) return "restart";
  if (s.has("instructions")) return "reload";
  return "none";
}

/** The files a role brief is built from besides the instruction files: a change there changes every brief. */
export const BRIEF_SOURCES: readonly string[] = ["bin/lib/lib.ts", "bin/hooks/reassert-roles.sh", "bin/commands/reassert-roles-ts.ts"];

export type ReloadTargets = { all: boolean; roles: Set<string>; studio: boolean };

/** Who must re-read their instructions after these paths changed (the rule above). */
export function reloadTargets(paths: Iterable<string>): ReloadTargets {
  const t: ReloadTargets = { all: false, roles: new Set(), studio: false };
  for (const raw of paths) {
    const p = raw.replace(/^\.\//, "");
    if (p === "AGENTS.md" || BRIEF_SOURCES.includes(p)) t.all = true;
    else if (p === "studio/studio.md") t.studio = true;
    else { const m = /^roles\/([^/]+)\.md$/.exec(p); if (m) t.roles.add(m[1]); }
  }
  return t;
}

/** The instruction files one role re-reads (relative to the checkout), for `INSTRUCTIONS: changed`; with no role
 *  known, every instruction file. A change to conventions/*.md is no re-read: roles open those when they use them. */
export function instructionFilesFor(role: string | null): string[] {
  if (role === null || role === "") return [...INSTRUCTION_GLOBS];
  return ["AGENTS.md", role === "studio" ? "studio/studio.md" : `roles/${role}.md`];
}
