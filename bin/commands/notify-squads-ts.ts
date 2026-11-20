// ds notify-squads-ts — write a reload wish on every roster member of a project (U263): what bin/commands/notify-squads.sh runs.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, dsLabel, dsLoopArgs, readJson, run as runCmd, stateRoot, writeErr, writeOut } from "../lib/shared";
import { jqOr, jqRaw } from "../lib/operator";

export const help = `<project> — write a reload wish on every roster member of a project (notify-squads.sh)`;

export async function run(raw: string[]): Promise<number> {
  const la = dsLoopArgs("notify-squads.sh", raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  if (la.argv.length !== 1) { writeErr("usage: notify-squads.sh <project>\n"); return 2; }
  const label = dsLabel(la.argv[0]);
  const dir = join(stateRoot(), label, "squads");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { writeOut(`notify-squads: no squads for '${label}'\n`); return 0; }

  let n = 0, failed = 0;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
    const f = join(dir, name);
    const d = readJson(f);
    const t = d?.topic;
    let topic = t === null || t === undefined || t === false ? "" : jqRaw(t);
    if (topic === "") topic = basename(f, ".json");
    const r = d?.run_id;
    const runId = r === null || r === undefined || r === false ? "" : jqRaw(r);
    if (runId === "") { writeOut(`skipped ${topic} (no run yet)\n`); continue; }
    const members: any[] = Array.isArray(d?.members) ? d.members : [];
    for (const m of members) {
      if (m === null || typeof m !== "object") continue;
      const role = jqRaw(m.role), suffix = String(jqOr(m.suffix) === "" ? "" : jqRaw(m.suffix));
      if (role === "") continue;
      const member = `${label}/${topic}/${role}${suffix ? "/" + suffix : ""}`;
      const p = await runCmd([join(ROOT, "bin", "ds"), "--state", stateRoot(), "want", "member", member, "--reload", "--by", "notify-squads", "--why", "dev-studio update: re-read instructions"]);
      writeErr(p.err);
      if (p.rc === 0) { writeOut(`reload ${topic}/${role}${suffix ? "-" + suffix : ""} (run=${runId})\n`); n++; }
      else { writeErr(`notify-squads: no member '${member}' for reload\n`); failed++; }
    }
  }
  writeOut(`notify-squads: wrote reload wishes for ${n} member(s) in '${label}'\n`);
  return failed === 0 ? 0 : 1;
}
