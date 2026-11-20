// ds approve-handoff-ts — a Thinker approves its plan and hands it to the Lead (U192): what bin/role/approve-handoff.sh runs.
import { copyFileSync, existsSync, mkdtempSync, accessSync, constants, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ROOT, readJson, run as runCmd, writeErr, writeOut } from "../lib/shared";

export const help = `<state> <plan> <lead_wt> — dry-run register-plan, approve the plan, resolve its question, hand it to the Lead (approve-handoff.sh)`;

export async function run(argv: string[]): Promise<number> {
  const SS = join(ROOT, "bin", "role", "squad-state.sh");
  const ORCH = process.env.ORCH || join(ROOT, "bin", "role", "orch.sh");
  const usage = (): number => { writeErr("usage: approve-handoff.sh <state> <plan> <lead_wt>\n"); return 2; };
  if (argv.length !== 3) return usage();
  const [STATE, PLAN_ARG, LEAD_WT] = argv;
  const PLAN = PLAN_ARG ? resolve(PLAN_ARG) : PLAN_ARG;
  if (!STATE || !PLAN_ARG || !LEAD_WT) return usage();
  if (!existsSync(STATE) || !isFile(STATE)) { writeErr(`approve-handoff: no state file at ${STATE}\n`); return 1; }
  try { accessSync(PLAN, constants.R_OK); } catch { writeErr(`approve-handoff: cannot read plan '${PLAN_ARG}'\n`); return 1; }

  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir() || "/tmp", "approve-handoff."));
  try {
    const scratch = join(dir, "state.json");
    copyFileSync(STATE, scratch);
    const dry = await runCmd([SS, scratch, "register-plan", PLAN]);
    if (dry.rc !== 0) {
      writeErr(dry.err);
      writeErr(`approve-handoff: register-plan refused '${PLAN_ARG}' — nothing in ${STATE} changed; fix the plan and retry\n`);
      return 1;
    }
    writeErr(dry.err);
    const nUnits = dry.out.split("\n").filter((l) => l !== "").length;

    const ap = await runCmd([SS, STATE, "approve-plan", PLAN]);
    writeOut(ap.out); writeErr(ap.err);
    if (ap.rc !== 0) return ap.rc;
    const topic = basename(STATE, ".json");
    let pbase = basename(PLAN);
    pbase = pbase.replace(/\.md$/, "").replace(/-plan$/, "");
    let short = pbase.startsWith(`${topic}-`) ? pbase.slice(topic.length + 1) : pbase;
    if (!short) short = basename(PLAN, ".md");
    const QID = `plan-${short}`;
    const st = readJson(STATE);
    let cleared: string;
    if ((st?.waiting_on_you ?? []).some((q: any) => q?.id === QID)) {
      const rq = await runCmd([SS, STATE, "resolve-question", QID, "--answer", "approved"]);
      writeOut(rq.out); writeErr(rq.err);
      if (rq.rc !== 0) return rq.rc;
      cleared = `${QID} resolved`;
    } else {
      if ((st?.autonomy ?? "checkpoints") !== "lfg") writeErr(`approve-handoff: warning: no open question '${QID}' in ${STATE} — queue left alone (was approval asked under a different id?)\n`);
      cleared = `no open '${QID}' question to resolve`;
    }
    // U269: the approval widens the squad's framing — say so in the state (once per plan) and in the handoff.
    const date = new Date().toISOString().slice(0, 10);
    const stNow = readJson(STATE);
    const framing = String(stNow?.framing ?? "");
    const pname = basename(PLAN);
    if (!framing.includes(`operator approved ${pname};`)) {
      const next = `${framing}${framing ? " " : ""}· ${date}: operator approved ${pname}; the squad builds it`;
      const sf = await runCmd([SS, STATE, "set-framing", next]);
      writeOut(sf.out); writeErr(sf.err);
      if (sf.rc !== 0) return sf.rc;
    }
    const body = `report-path=${PLAN}\nApproved (${cleared}, register-plan dry-run passed: ${nUnits} units). Ready to build.\nThe operator approved this plan for squad ${topic} on ${date} (it is in approved_plans). It widens the squad's framing: build it.`;
    const sent = await runCmd([ORCH, "send-worker", LEAD_WT, "handoff", body]);
    writeOut(sent.out); writeErr(sent.err);
    if (sent.rc !== 0) return sent.rc;
    writeOut(`approve-handoff: ${PLAN} approved (${cleared}, ${nUnits} units) and handed off to ${LEAD_WT}\n`);
    return 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function isFile(p: string): boolean { try { return require("node:fs").statSync(p).isFile(); } catch { return false; } }
