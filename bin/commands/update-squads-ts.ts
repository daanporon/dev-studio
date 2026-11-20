// ds update-squads-ts — bring every squad of a project to the latest dev-studio (U191): what
// bin/commands/update-squads.sh runs. Rewrites the role briefs, then one wish per member.
// Without --auto: a restart-once-idle wish per member (as ever). With --auto (graded update): only what the
// commits since the project's squads-rev.json need — restart (skills), reload (instructions), nothing (code).
// elsewhere-no-other-work U1: on reload or restart the project's Studio member (if the loop recorded one)
// gets a reload wish too, never a restart (it is the operator's cockpit); reconcilers/studio.ts types it.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, stateRoot, dsLabel, globJson, readJson, run as sh, chomp, writeOut, writeErr } from "../lib/shared";
import { inherit, squadMembers, dsBin } from "../lib/upkeep";
import { classify, need as needOf, type UpdateClass, type UpdateNeed } from "../lib/update-classes";

export const help = `<project> [--auto] — rewrite every member's role brief and write the wishes the new commits need (update-squads.sh)`;

/** The files a role brief is built from besides the instruction files: a change there changes briefs. */
const BRIEF_SOURCES = ["bin/lib/lib.ts", "bin/hooks/reassert-roles.sh", "bin/commands/reassert-roles-ts.ts"];

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n");
  renameSync(tmp, file);
}

/** The project's live Studio member as a `ds want member` id, or null when loop.db records none (or cannot be read). */
export function studioMember(root: string, label: string): string | null {
  const db = join(root, "loop.db");
  if (!existsSync(db)) return null;
  let d: Database | null = null;
  try {
    d = new Database(db, { readonly: true });
    const r = d.query("SELECT 1 FROM members WHERE project = ? AND squad = '_studio' AND role = 'studio' AND suffix = '' AND COALESCE(status, '') != 'gone' LIMIT 1").get(label);
    return r ? `${label}/_studio/studio` : null;
  } catch { return null; } finally { d?.close(); }
}

export async function run(argv: string[]): Promise<number> {
  const auto = argv.includes("--auto");
  const args = argv.filter((a) => a !== "--auto");
  if (args.length < 1) { writeErr("usage: update-squads.sh <project> [--auto]\n"); return 2; }
  const label = dsLabel(args[0]);
  if (!existsSync(join(stateRoot(), label))) { writeErr(`update-squads: no state for '${label}' — run /ds-up first\n`); return 1; }

  const markerFile = join(stateRoot(), label, "squads-rev.json");
  const head = chomp((await sh(["git", "rev-parse", "HEAD"], { cwd: ROOT })).out);
  const short = (r: string) => r.slice(0, 8);
  let need: UpdateNeed = "restart";
  let classes: UpdateClass[] = [];
  if (auto) {
    const base = String(readJson(markerFile)?.rev ?? "");
    if (base === head && head !== "") { writeOut(`update-squads: [${label}] squads already on ${short(head)}\n`); return 0; }
    // A missing marker, an unknown base commit or a failed diff: today's full restart, the safe default.
    const known = base !== "" && (await sh(["git", "cat-file", "-e", `${base}^{commit}`], { cwd: ROOT })).rc === 0;
    const diff = known ? await sh(["git", "diff", "--name-only", "--no-renames", base, "HEAD"], { cwd: ROOT }) : null;
    if (diff && diff.rc === 0) {
      const paths = diff.out.split("\n").filter((l) => l !== "");
      const cls = classify(paths);
      need = needOf(cls);
      classes = [...cls].sort();
      if (need === "none" && paths.some((p) => BRIEF_SOURCES.includes(p))) need = "reload"; // briefs are rewritten below with new content
    } else classes = ["skills"];
  }

  writeOut(`update-squads: [${label}] 1/2 — rewriting role briefs (CLAUDE.local.md) so every worktree is current…\n`);
  if ((await inherit([join(ROOT, "bin", "hooks", "reassert-roles.sh"), label])) !== 0) writeErr("update-squads: WARNING — reassert-roles reported a problem (see above)\n");

  let n = 0, failed = 0, studioWish = false;
  if (need !== "none") {
    const what = need === "restart" ? "a restart-once-idle wish on every member (the loop restarts them)" : "a reload wish on every member (they re-read their instructions)";
    writeOut(`update-squads: [${label}] 2/2 — writing ${what}…\n`);
    for (const f of globJson(join(stateRoot(), label, "squads"))) {
      const topic = basename(f, ".json");
      for (const [role, suffix] of squadMembers(f)) {
        if (role === "") continue;
        const id = `${label}/${topic}/${role}${suffix ? "/" + suffix : ""}`;
        const flags = need === "restart" ? ["--restart", "idle", "--by", "update-squads", "--why", `update-squads ${topic}/${role}`]
          : ["--reload", "--by", "update-squads", "--why", "dev-studio update: re-read instructions"];
        const p = Bun.spawn([dsBin(), "want", "member", id, ...flags], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
        if ((await p.exited) === 0) n++; else { failed++; writeErr(`update-squads: ${need} wish FAILED for ${topic}/${role}\n`); }
      }
    }
    const studio = studioMember(stateRoot(), label);
    if (studio) {
      const p = Bun.spawn([dsBin(), "want", "member", studio, "--reload", "--by", "update-squads", "--why", "dev-studio update: the Studio re-reads its instructions"],
        { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
      if ((await p.exited) === 0) studioWish = true; else { failed++; writeErr("update-squads: reload wish FAILED for the Studio\n"); }
    }
  } else writeOut(`update-squads: [${label}] 2/2 — code only, no wish needed\n`);

  // The Studio's reload counts in the summary; the loop types it once the Studio is idle.
  if (studioWish) n++;
  const onStudio = studioWish ? " (one a reload of the Studio)" : "";
  if (auto) writeOut(`update-squads: [${label}] ${need} — ${classes.join(", ") || "none"} — ${n} wish(es)${onStudio}\n`);
  else {
    writeOut(`update-squads: [${label}] wrote ${studioWish ? `${n - 1} restart wish(es) and a reload wish on the Studio` : `${n} restart wish(es)`}. Squads pick up the latest code on their restart.\n`);
    writeOut("update-squads: one last step — type /reload-skills in THIS Studio to refresh its own skills (no restart/reopen needed).\n");
  }
  // A failed wish leaves the marker where it was, so the next run does the same work again.
  if (failed > 0) {
    if (!auto) return 0; // the plain form keeps its old exit code
    writeErr(`update-squads: ${failed} wish(es) failed — squads-rev.json not advanced; run it again\n`); return 1;
  }
  try { writeAtomic(markerFile, { rev: head, at: Math.floor(Date.now() / 1000), need, wishes: n }); } catch (e) { writeErr(`update-squads: WARNING — could not write ${markerFile}\n`); }
  return 0;
}
