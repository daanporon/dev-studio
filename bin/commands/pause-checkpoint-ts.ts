// ds pause-checkpoint-ts — a pausing agent journals, then acknowledges (U192): what bin/role/pause-checkpoint.sh runs.
import { ROOT, run as runCmd, writeErr, writeOut } from "../lib/shared";
import { whoAmI } from "../loop/core/whoami.ts";

export const help = `<project> <squad> <role> <suffix|-> <generation> "<checkpoint>" --commands-finished — journal a checkpoint, then acknowledge the pause; a stop-… generation is a stop checkpoint before a restart, journaled only (pause-checkpoint.sh)`;

export async function run(argv: string[]): Promise<number> {
  if (!(argv.length === 7 && argv[6] === "--commands-finished")) {
    writeErr('usage: pause-checkpoint.sh <project> <squad> <role> <suffix|-> <generation> "<checkpoint>" --commands-finished\n'); return 2;
  }
  const handle = whoAmI().handle ?? "";
  if (!handle) { writeErr("pause: checkpoint must run in the instructed agent terminal\n"); return 2; }
  const [project, squad, role, sfx, gen, text] = argv;
  if (!text) { writeErr("pause: checkpoint text is required\n"); return 2; }
  const suffix = sfx === "-" ? "" : sfx;
  const ds = `${ROOT}/bin/ds`;
  const journal = `${ROOT}/bin/role/journal.sh`, jrole = role + (suffix ? `-${suffix}` : "");
  // U266: a stop checkpoint (generation `stop-…`) before a planned restart. The loop proves it from
  // the journal line itself; there is nothing to acknowledge.
  if (gen.startsWith("stop-")) {
    const asked = await runCmd([ds, "stop-checkpoint", "show", project, squad, role, suffix || "-", gen]);
    if (asked.rc !== 0) { writeErr(asked.err); return 1; }
    const add = await runCmd([journal, project, squad, jrole, "add", "keep", `checkpoint ${gen}: ${text}`, "before a planned restart; the next session continues from its next step"]);
    writeOut(add.out); writeErr(add.err);
    if (add.rc !== 0) return add.rc;
    writeOut("stop checkpoint written; stop at your prompt — the loop restarts you once you are idle\n");
    return 0;
  }
  const shown = await runCmd([ds, "pause", "show", "member", project, squad, role, suffix]);
  if (shown.rc !== 0) { writeErr(shown.err); return shown.rc; }
  let p: any;
  try { p = JSON.parse(shown.out); } catch { writeErr("pause: stale generation or foreign agent terminal\n"); return 1; }
  const generation = String(p.generation), session = String(p.session), dispatch = p.dispatch ?? "-";
  if (!(generation === gen && session === handle && p.state === "pausing")) {
    writeErr("pause: stale generation or foreign agent terminal\n"); return 1;
  }
  const path = await runCmd([journal, project, squad, jrole, "path"]);
  if (path.rc !== 0) { writeErr(path.err); return path.rc; }
  const file = path.out.replace(/\n+$/, "");
  const add = await runCmd([journal, project, squad, jrole, "add", "keep", `checkpoint ${gen}: ${text}`, "safe closure after local commands finished; remote CI may continue"]);
  writeOut(add.out); writeErr(add.err);
  if (add.rc !== 0) return add.rc;
  const ack = await runCmd([ds, "pause", "ack", project, squad, role, suffix || "-", gen, session, dispatch, file]);
  writeOut(ack.out); writeErr(ack.err);
  return ack.rc;
}
