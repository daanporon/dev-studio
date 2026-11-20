// ds close-role-ts — retire one member of a squad (U263): what bin/commands/close-role.sh runs. A wish writer.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dsLabel, dsLoopArgs, readJson, run as runCmd, stateRoot, writeErr, writeOut } from "../lib/shared";
import { dsExec, jqRaw, waitArgs } from "../lib/operator";

export const help = `<project> <topic> <label> [--cancel [--into X] [--why T]] [--force] — retire one squad member (close-role.sh)`;

const USAGE = "usage: close-role.sh <project> <topic> <label> [--cancel [--into X] [--why T]] [--force]\n";

export async function run(raw: string[]): Promise<number> {
  const la = dsLoopArgs("close-role.sh", raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  const argv = la.argv;
  let force = false, cancel = false, into = "", why = "", project = "", topic = "", labelArg = "";
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--force") { force = true; i++; }
    else if (a === "--cancel") { cancel = true; i++; }
    else if (a === "--into") { if (argv.length - i < 2) { writeErr("close-role: --into needs a value\n"); return 2; } into = argv[i + 1]; i += 2; }
    else if (a === "--why") { if (argv.length - i < 2) { writeErr("close-role: --why needs a value\n"); return 2; } why = argv[i + 1]; i += 2; }
    else {
      if (project === "") project = a; else if (topic === "") topic = a; else if (labelArg === "") labelArg = a;
      else { writeErr(`close-role: unexpected arg '${a}'\n`); return 2; }
      i++;
    }
  }
  if (project === "" || topic === "" || labelArg === "") { writeErr(USAGE); return 2; }
  if (cancel && force) { writeErr("close-role: --cancel removes dirty worktrees and preserves branches; --force is redundant\n"); return 1; }
  if (!cancel && (into !== "" || why !== "")) { writeErr("close-role: --into/--why need --cancel\n"); return 2; }

  const label = dsLabel(project);
  const state = join(stateRoot(), label, "squads", `${topic}.json`);
  if (!existsSync(state)) { writeErr(`close-role: no squad '${topic}' for '${label}' (${state})\n`); return 1; }
  const d = readJson(state);
  const members: any[] = Array.isArray(d?.members) ? d.members.filter((m: any) => m !== null && typeof m === "object") : [];
  const units: any[] = Array.isArray(d?.units) ? d.units.filter((u: any) => u !== null && typeof u === "object") : [];

  // The NEWEST member with that label, never the first (a stale GONE row can twin the live restarted one).
  const rowLabel = (m: any): string => { const s = m.suffix; return jqRaw(m.role) + (s !== undefined && s !== null && s !== false && s !== "" ? "-" + jqRaw(s) : ""); };
  const hit = members.filter((m) => rowLabel(m) === labelArg);
  if (hit.length === 0) { writeErr(`close-role: no roster member '${labelArg}' in ${topic}\n`); return 1; }
  const wt = jqRaw(hit[hit.length - 1].wt);
  const roleRow = members.find((m) => m.wt === wt);
  const role = roleRow ? jqRaw(roleRow.role) : "";
  if (role === "lead") { writeErr("close-role: refusing to close the Lead — use close-squad to tear down the whole squad\n"); return 1; }

  const slugOf = (u: any): string => { const s = u?.slug; return s === null || s === undefined || s === false ? "" : jqRaw(s); };
  let unitSlug = slugOf(units.find((u) => u.builder_wt === wt));
  if (unitSlug === "" && role === "builder" && labelArg.startsWith("builder-")) {
    const sfx = labelArg.slice("builder-".length);
    unitSlug = slugOf(units.find((u) => u.slug === sfx));
  }
  let unitStatus = "";
  if (unitSlug !== "") {
    const st = units.filter((u) => u.slug === unitSlug).map((u) => u.status).find((s) => s !== null && s !== undefined && s !== false);
    unitStatus = st === undefined ? "" : jqRaw(st);
  }

  const cu = [...(into !== "" ? ["--into", into] : []), ...(why !== "" ? ["--why", why] : [])];
  const ss = join(ROOT, "bin", "role", "squad-state.sh");
  if (cancel) {
    if (unitSlug === "") { writeErr(`close-role: no unit maps to member '${labelArg}' — --cancel retires a Builder mid-unit\n`); return 1; }
    const chk = await runCmd([ss, state, "cancel-unit", unitSlug, ...cu, "--check"]);
    writeErr(chk.err);
    if (chk.rc !== 0) return 1;
    let resolved = chk.out.replace(/\n+$/, "");
    if (resolved.startsWith("into=")) resolved = resolved.slice(5);
    if (resolved === "none") resolved = "";
    const go = await runCmd([ss, state, "cancel-unit", unitSlug, ...cu]);
    writeErr(go.err);
    if (go.rc !== 0) return go.rc;
    writeOut(resolved !== "" ? `close-role: retired ${labelArg} — unit cancelled -> ${resolved} (wish written)\n` : `close-role: retired ${labelArg} — unit cancelled (wish written)\n`);
    return 0;
  }
  if (unitSlug !== "" && unitStatus === "dispatched") { writeErr(`close-role: unit ${unitSlug} is still dispatched — use --cancel [--into X] to retire it mid-unit\n`); return 1; }

  let sfx = labelArg.startsWith(role) ? labelArg.slice(role.length) : labelArg;
  if (sfx.startsWith("-")) sfx = sfx.slice(1);
  return dsExec(["want", "member", `${label}/${topic}/${role}${sfx ? "/" + sfx : ""}`, "archived", "--by", "close-role", "--why", `close-role:${label}/${topic}/${labelArg}`, ...waitArgs(la.wait)]);
}
