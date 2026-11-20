// update-classes.ts — the grading rule for a dev-studio update: what a set of changed paths asks of the
// running workers. Used by update-squads (--auto) and, later, the board's update banner.
//   skills        skills/**, .claude/commands/**                 -> restart (a new skill loads only in a new session)
//   instructions  the files behind `INSTRUCTIONS: changed`        -> reload  (re-read, no new session)
//   code          everything else                                 -> none    (scripts run their latest version)
// The strongest need wins: restart > reload > none.

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
