// ds team-ts — a squad's roster, switch and reap (U222): what bin/commands/team.sh runs.
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, dsLabel, chomp, readJson, globJson, backendPath, hostBackendPath, run as runCmd, stateRoot, writeOut, writeErr } from "../lib/shared";
import { contractHere, contractStates, isLocalWt, projectOffOrca, squadContract } from "../lib/contract-roles.ts";
import { attachLine } from "../lib/attach-line.ts";

export const help = `<project> [--topic <slug>] [--switch <label>|--reap] — print a squad's roster, jump to a role's terminal, or reap stale terminals (team.sh)`;

class Exit extends Error { constructor(public code: number) { super("exit"); } }

const str = (v: unknown): string => (v === null || v === undefined || v === false ? "" : String(v));

export async function run(argv: string[]): Promise<number> {
  try { return await main(argv); } catch (e) { if (e instanceof Exit) return e.code; throw e; }
}

async function main(argv: string[]): Promise<number> {
  // `current` through this squad's own adapter (bin/backend/contract.sh off Orca); every other read is
  // about Orca's members, so it goes to the host's adapter, and a `local::` member is the contract's (U11b).
  const BACKEND = hostBackendPath();
  const DIRECTORY = process.env.DIRECTORY || join(ROOT, "bin", "lib", "directory.sh");
  const be = (args: string[]) => runCmd([args[0] === "current" ? backendPath() : BACKEND, ...args]);
  const err = (s: string) => writeErr(s + "\n");
  const out = (s: string) => writeOut(s);

  let PROJECT = "", TOPIC = "", SWITCH = "", REAP = false;
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--topic") { TOPIC = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--switch") { SWITCH = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--reap") { REAP = true; i++; }
    else { PROJECT = a; i++; }
  }
  if (!PROJECT) { err("usage: team.sh <project> [--topic <slug>] [--switch <label>|--reap]"); return 2; }

  const LABEL = dsLabel(PROJECT);
  const DIR = join(process.env.DS_STATE_ROOT || join(ROOT, "state"), LABEL, "squads");
  if (!(existsSync(DIR) && statSync(DIR).isDirectory())) { err(`team: no squads for '${LABEL}'`); return 0; }

  // Auto-scope to the squad this terminal belongs to when no --topic. A host shell in a project with no part on
  // Orca has no Orca worktree to find, so Orca is not asked (U58).
  const OFF = projectOffOrca(stateRoot(), LABEL);
  if (!TOPIC && !(OFF && !contractHere(stateRoot()))) {
    const cur = chomp((await be(["current"])).out);
    if (cur) {
      for (const f of globJson(DIR)) {
        const d = readJson(f);
        const wts = d && Array.isArray(d.worktrees) ? d.worktrees : [];
        const ms = d && Array.isArray(d.members) ? d.members : [];
        if (wts.includes(cur) || ms.some((m: any) => m?.wt === cur)) { TOPIC = basename(f, ".json"); break; }
      }
    }
  }

  const oneSquad = (): string => {
    if (TOPIC) {
      const f = join(DIR, TOPIC + ".json");
      if (!existsSync(f)) { err(`team: no squad '${TOPIC}' for '${LABEL}'`); throw new Exit(1); }
      return f;
    }
    const files = globJson(DIR);
    if (files.length === 1) return files[0];
    err(`team: --switch needs --topic (more than one squad in '${LABEL}')`);
    throw new Exit(2);
  };

  const dirList = async (): Promise<any[]> => {
    const r = await runCmd([DIRECTORY, "list", "--project", LABEL, "--json"]);
    if (r.rc !== 0) { err(`team: directory.sh list failed for '${LABEL}'`); throw new Exit(1); }
    try { const j = JSON.parse(r.out); return Array.isArray(j) ? j : []; } catch { return []; }
  };

  if (SWITCH) {
    const f = oneSquad(); const topic = basename(f, ".json");
    const dirJson = await dirList();
    const hit = dirJson.find((e) => e?.squad === topic && e?.name === SWITCH);
    const wid = hit ? str(hit.wt) : "";
    if (!wid) { err(`team: no roster member '${SWITCH}' in ${topic}`); return 1; }
    const tok = str((hit.terminals ?? [])[0]);
    if (isLocalWt(wid)) {
      // Off Orca: the member's own backend has no focus or terminal-switch, so print how to reach it (U58).
      const b = squadContract(stateRoot(), LABEL, topic) ?? "its backend";
      out(`team: '${SWITCH}' runs on ${b}${tok ? "" : " (no live terminal seen)"}; reach it with:\n  ${attachLine(b, LABEL, stateRoot(), tok, wid.slice("local::".length))}\n`);
      return 0;
    }
    if (!tok) {
      const r = Bun.spawnSync([BACKEND, "focus", wid], { stdout: "inherit", stderr: "ignore", stdin: "ignore" });
      if (r.exitCode !== 0) { err(`team: '${SWITCH}' has no live terminal (idle/gone?) — nothing to switch to`); return 1; }
    } else {
      const r = Bun.spawnSync([BACKEND, "terminal-switch", tok], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
      if (r.exitCode !== 0) return r.exitCode ?? 1; // set -e
    }
    out(`team: switched to ${SWITCH} (${wid})\n`);
    return 0;
  }

  if (REAP) {
    let total = 0;
    const reapOne = async (f: string) => {
      const topic = basename(f, ".json");
      const d = readJson(f);
      const runId = d && typeof d === "object" ? str(d.run_id) : "";
      const off = squadContract(stateRoot(), LABEL, topic);
      if (off) { out(`team: ${topic} — on ${off}: the loop closes its stray and duplicate terminals; nothing reaped here\n`); return; }
      if (!runId) return;
      const r = await be(["terminal-reap", runId]);
      let c = r.rc === 0 ? chomp(r.out) : chomp(r.out + "0\n");
      if (!/^[0-9]+$/.test(c)) c = "0";
      out(`team: ${topic} — closed ${c} stale terminal(s) (kept each live owner)\n`);
      total += Number(c);
    };
    if (TOPIC) await reapOne(oneSquad());
    else for (const f of globJson(DIR)) await reapOne(f);
    out(`team: closed ${total} stale terminal(s) in '${LABEL}'${TOPIC ? ` (topic=${TOPIC})` : ""} — kept the owners\n`);
    return 0;
  }

  // Default: print the roster.
  const scope = TOPIC ? [oneSquad()] : globJson(DIR);
  const wts = scope.flatMap((f) => { const d = readJson(f); return (d && Array.isArray(d.members) ? d.members : []).map((m: any) => str(m?.wt)); });
  const lines: string[] = [];
  if (wts.some((w: string) => w && !isLocalWt(w))) lines.push(...chomp((await be(["worker-states"])).out).split("\n"));
  if (wts.some(isLocalWt)) {
    const c = await contractStates(stateRoot(), LABEL);
    lines.push(...c.lines);
    for (const b of c.blind) err(`team: can't read the squads off Orca (${b}) — their members show GONE`);
  }
  const states = lines.map((l) => l.split("\t"));
  const stateOf = (id: string) => str(states.find((r) => r[0] === id)?.[1]);
  const nameOf = (id: string) => str(states.find((r) => r[0] === id)?.[2]);
  const DIR_JSON = await dirList();

  const squad = (f: string) => {
    const topic = basename(f, ".json");
    const d = readJson(f);
    const runId = d && typeof d === "object" && d.run_id !== null && d.run_id !== undefined && d.run_id !== false ? String(d.run_id) : "?";
    out(`TEAM — ${topic}   (run ${runId})\n`);
    out("------------------------------------------------------------\n");
    const members: any[] = d && Array.isArray(d.members) ? d.members : [];
    if (members.length === 0) { out("  (no roster recorded for this squad)\n\n"); return; }
    const details: { wt: string; tok: string }[] = [];
    for (const e of DIR_JSON) if (e?.squad === topic) for (const t of e?.terminals ?? []) details.push({ wt: str(e.wt), tok: String(t) });
    for (const m of members) {
      const role = str(m?.role), suffix = str(m?.suffix), wid = str(m?.wt), forv = str(m?.for);
      const owns = Array.isArray(m?.owns) ? m.owns.map(str).join(", ") : "";
      if (!wid) continue;
      const st = stateOf(wid) || "GONE";
      const nm = nameOf(wid) || "(worktree gone)";
      const dets = details.filter((x) => x.wt === wid).map((x) => x.tok).filter((t) => t !== "");
      let tcol = "";
      if (dets.length > 1) tcol = `  [⚠ ${dets.length} live terminals — duplicate; ${isLocalWt(wid) ? "the loop closes the extra" : "--reap keeps the owner"}]`;
      else if (dets.length === 1) tcol = `  [term ${dets[0]}]`;
      const who = role + (suffix ? "-" + suffix : "");
      out(`  ${who.padEnd(22)} ${st.padEnd(8)} ${nm.padEnd(42)}${forv ? ` for:${forv}` : ""}${owns ? `  owns: ${owns}` : ""}${tcol}\n`);
    }
    out("\n");
  };

  for (const f of scope) squad(f);
  if (!TOPIC && !scope.length) out(`team: no squads for '${LABEL}'\n`);
  return 0;
}
