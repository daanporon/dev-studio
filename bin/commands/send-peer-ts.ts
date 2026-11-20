// ds send-peer-ts — message a peer squad's Thinker or Lead (U192): what bin/role/send-peer.sh runs.
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, backendPath, callerScript, dsLabel, dsLoopArgs, dsLoopCheck, dsLoopOn, dsPrefix, globJson, readJson, run as runCmd, writeErr, writeOut } from "../lib/shared";
import { toplevel } from "../loop/squad/exposed.ts";
import { roleName, senderAt, splitRole, type Sender } from "../loop/messages/messages.ts";
import { open } from "../loop/core/store.ts";
import { loopSend } from "./send-role-ts.ts";

export const help = `<squad> <role[-suffix]> <subject> <body> [--project <label>] [--ruling] [--from <squad>/<role>] — message a peer squad's Thinker or Lead (send-peer.sh)`;

const USAGE = "usage: send-peer.sh <squad> <role[-suffix]> <subject> <body> [--project <label>] [--ruling] [--from <squad>/<role>]\n";

const members = (f: string): any[] => { const j = readJson(f); return Array.isArray(j?.members) ? j.members : []; };

export async function run(raw: string[]): Promise<number> {
  const script = callerScript("send-peer.sh");
  const BACKEND = backendPath();
  const sr = process.env.DS_STATE_ROOT || join(ROOT, "state");
  const usage = (): number => { writeErr(USAGE); return 2; };
  const la = dsLoopArgs(script.split("/").pop()!, raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  const argv = la.argv;

  let PROJECT = "", FROM = "", RULING = false; const POS: string[] = [];
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--project") { if (argv.length - i < 2) return usage(); PROJECT = argv[i + 1]; i += 2; }
    else if (a === "--from") { if (argv.length - i < 2) return usage(); FROM = argv[i + 1]; i += 2; }
    else if (a === "--ruling") { RULING = true; i++; }
    else if (a === "-h" || a === "--help") return usage();
    else if (a === "--") { POS.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith("--")) { writeErr(`send-peer: unknown option '${a}'\n`); return usage(); }
    else { POS.push(a); i++; }
  }
  if (POS.length !== 4) return usage();
  const [SQUAD, WANT, SUBJECT, BODY] = POS;
  if (!SQUAD || !WANT || !SUBJECT || !BODY) return usage();

  const base = WANT.split("-")[0];
  if (base !== "thinker" && base !== "lead") {
    writeErr(`send-peer: ${SQUAD}/${WANT} is a ${base} — peer messaging is Thinker/Lead only; ask your Lead\n`); return 2;
  }

  if (dsLoopOn()) {
    const lp = PROJECT ? dsLabel(PROJECT) : "";
    const stop = await dsLoopCheck(usage, `${ROOT}/bin/lib/directory.sh`, [SQUAD, WANT, ...(PROJECT ? ["--project", PROJECT] : [])]);
    if (stop !== undefined) return stop;
    // U45: a loop.db message row (kind peer), logged in cross-squad.md as before.
    const st = open();
    let from: Sender, label: string;
    try {
      from = FROM ? fromFlag(FROM, lp) : senderAt(st, toplevel());
      if (!from.squad) { writeErr("send-peer: can't tell who you are (this worktree is in no squad roster) — pass --from <squad>/<role>\n"); return 2; }
      if (from.squad === SQUAD) { writeErr(`send-peer: ${SQUAD}/${WANT} is in your own squad (${from.squad}) — reach it with: send-role.sh ${SQUAD} ${WANT} "<subject>" "<body>"\n`); return 2; }
      label = lp || from.project || "";
    } finally { st.close(); }
    const sent = await loopSend({ project: label, squad: SQUAD, want: WANT, subject: SUBJECT, body: BODY, kind: "peer", wait: la.wait, who: "send-peer", from: { ...from, project: from.project ?? (label || null) } });
    if (sent.rc === 2 || !sent.id || !sent.created) return sent.rc;   // the same send again was logged the first time
    return logPeer(sr, sent.project ?? label, fromName(from), SQUAD, WANT, SUBJECT, BODY, RULING, `msg#${sent.id}`, sent.rc);
  }

  const cur = await runCmd([BACKEND, "current"]);
  const CUR = cur.rc === 0 ? cur.out.replace(/\n+$/, "") : "";

  let LABEL = "";
  if (PROJECT) LABEL = dsLabel(PROJECT);
  else {
    let only = "", n = 0;
    const labels = existsSync(sr) ? readdirSync(sr).sort() : [];
    for (const l of labels) {
      const files = globJson(join(sr, l, "squads"));
      if (files.length === 0) continue;
      n++; only = l;
      if (CUR) {
        const docs = files.map((f) => readJson(f));
        if (docs.every((d) => d !== undefined) && docs.some((d) => (Array.isArray(d?.members) ? d.members : []).some((m: any) => m?.wt === CUR))) { LABEL = only; break; }
      }
    }
    if (!LABEL && n === 1) LABEL = only;
    if (!LABEL) { writeErr("send-peer: can't tell the project — pass --project <label>\n"); return 2; }
  }
  const DIR = join(sr, LABEL, "squads");

  if (!FROM && CUR) {
    for (const f of globJson(DIR)) {
      const m = members(f).find((x: any) => x?.wt === CUR);
      if (m) { FROM = `${f.split("/").pop()!.replace(/\.json$/, "")}/${m.role}${(m.suffix ?? "") === "" ? "" : `-${m.suffix}`}`; break; }
    }
    if (!FROM) {
      const nm = CUR.split("/").pop()!;
      const pre = `${dsPrefix()}${LABEL}-`;
      if (nm.startsWith(pre)) {
        const rest = nm.slice(pre.length);
        let b = "", mid = "";
        for (const r of ["lead", "thinker", "builder", "reviewer", "tester", "researcher"]) {
          if (rest.startsWith(`${r}-`)) { b = r; mid = rest.slice(r.length + 1); break; }
        }
        if (b && mid) {
          let best = "";
          for (const f of globJson(DIR)) {
            const t = f.split("/").pop()!.replace(/\.json$/, "");
            if ((mid === t || mid.endsWith(`-${t}`)) && t.length > best.length) best = t;
          }
          if (best) {
            let suf = mid.slice(0, mid.length - best.length);
            if (suf.endsWith("-")) suf = suf.slice(0, -1);
            FROM = `${best}/${b}${suf ? `-${suf}` : ""}`;
          }
        }
      }
    }
  }
  if (!FROM.includes("/")) { writeErr("send-peer: can't tell who you are (this worktree is in no squad roster) — pass --from <squad>/<role>\n"); return 2; }
  const FROM_SQUAD = FROM.slice(0, FROM.indexOf("/")), FROM_ROLE = FROM.slice(FROM.indexOf("/") + 1);
  if (!FROM_SQUAD || !FROM_ROLE) { writeErr(`send-peer: --from must be <squad>/<role> (got '${FROM}')\n`); return 2; }

  const notLive = "send-peer: not delivered — the Studio route still exists: ask your Lead, who raises it to the Studio.\n";
  const reach = await runCmd([`${ROOT}/bin/lib/directory.sh`, "reach", SQUAD, WANT, "--project", LABEL, "--from", FROM_SQUAD]);
  writeErr(reach.err);
  const reachOut = reach.out.replace(/\n+$/, "");
  if (reach.rc !== 0) {
    if (reach.rc === 4 && (/^run\t/.test(reachOut) || /^worktree-run\t/.test(reachOut))) writeErr("send-peer: liveness unknown (directory exit 4) — trying anyway; the receipt judges.\n");
    else if (reach.rc === 4 && /^worktree\t/.test(reachOut)) { /* same-squad: falls into the worktree branch below */ }
    else { if (reach.rc === 3) writeErr(notLive); return reach.rc; }
  }
  const f = (reachOut.split("\n")[0] ?? "").replace(/^\t+/, "").split(/\t+/);
  const kind = f[0] ?? "", runId = f[2] ?? "", wt = f.slice(3).join("\t").replace(/\t+$/, "");

  const PSUB = `peer:${FROM} ${SUBJECT}`;
  let op: string, bargs: string[];
  if (kind === "run") { op = "send"; bargs = [runId, PSUB, BODY]; }
  else if (kind === "worktree-run") { op = "send-run-worker"; bargs = [runId, wt, PSUB, BODY]; }
  else if (kind === "worktree") { writeErr(`send-peer: ${SQUAD}/${WANT} is in your own squad (${FROM_SQUAD}) — reach it with: orch.sh send-worker ${wt} "<subject>" "<body>"\n`); return 2; }
  else { writeErr(`send-peer: unexpected address kind '${kind}' from directory.sh\n`); return 1; }
  const sent = await runCmd([BACKEND, op, ...bargs]);
  writeErr(sent.err);
  if (sent.rc !== 0) { if (sent.rc === 3) writeErr(notLive); return sent.rc; }
  let backendOut = sent.out.replace(/\n+$/, "");

  let msg = "";
  for (const line of backendOut.split("\n")) { const m = line.match(/^.* \(([^()]*)\)$/); if (m) msg = m[1]; }
  if (!msg) msg = "-";
  if (!backendOut) backendOut = `run:${runId}`;
  const rc = await logPeer(sr, LABEL, FROM, SQUAD, WANT, SUBJECT, BODY, RULING, msg, 0);
  if (rc === 0) writeOut(`send-peer: ${FROM} → ${SQUAD}/${WANT} delivered (${backendOut}) — logged in cross-squad.md\n`);
  return rc;
}

const fromName = (f: Sender) => `${f.squad}/${roleName(f.role, f.suffix)}`;

/** `--from <squad>/<role[-suffix]>` as a sender. */
function fromFlag(from: string, project: string): Sender {
  const i = from.indexOf("/"), squad = i < 0 ? "" : from.slice(0, i), r = splitRole(from.slice(i + 1)) ?? { role: from.slice(i + 1), suffix: "" };
  return { project: project || null, squad: squad || null, ...r, member: null };
}

/** The cross-squad.md line and, for a ruling, both Leads' journal decision; `rc` passes through when the log works. */
async function logPeer(sr: string, label: string, from: string, squad: string, want: string, subject: string, body: string, ruling: boolean, msg: string, rc: number): Promise<number> {
  const fromSquad = from.slice(0, from.indexOf("/"));
  const subj1 = subject.replace(/[\n\r]/g, " ");
  const extra = ruling ? ` RULING: ${body.replace(/[\n\r]/g, " ")}` : "";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  try { appendFileSync(join(sr, label, "cross-squad.md"), `- ${ts} ${from} → ${squad}/${want} [${subj1}] ${msg}${extra}\n`); }
  catch (e: any) { writeErr(`send-peer: ${join(sr, label, "cross-squad.md")}: ${e?.code === "ENOENT" ? "No such file or directory" : e?.message}\n`); return 1; }
  if (ruling) {
    const j = `${ROOT}/bin/role/journal.sh`;
    const a = await runCmd([j, label, fromSquad, "lead", "add", "decision", body, `peer ruling with ${squad} — cross-squad.md`]);
    if (a.rc !== 0) writeErr(`send-peer: warning: could not journal the ruling for ${fromSquad}'s Lead\n`);
    const b = await runCmd([j, label, squad, "lead", "add", "decision", body, `peer ruling with ${fromSquad} — cross-squad.md`]);
    if (b.rc !== 0) writeErr(`send-peer: warning: could not journal the ruling for ${squad}'s Lead\n`);
  }
  return rc;
}
