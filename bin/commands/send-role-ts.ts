// ds send-role-ts — message a squad member by squad + role name (U192): what bin/role/send-role.sh runs.
import { ROOT, backendPath, callerScript, dsLabel, dsLoopArgs, dsLoopCheck, dsLoopOn, run as runCmd, writeErr, writeOut } from "../lib/shared";
import { waitFor } from "../loop/core/cli.ts";
import { toplevel } from "../loop/squad/exposed.ts";
import { scriptSend, type Sender } from "../loop/messages/messages.ts";
import { open } from "../loop/core/store.ts";
import { isClaudeP, parseAgents } from "../loop/reconcilers/members.ts";

export const help = `<squad> <role[-suffix]> <subject> <body> [--project <label>] [--from <squad>] — message a squad member through the phone book (send-role.sh)`;

const USAGE = "usage: send-role.sh <squad> <role[-suffix]> <subject> <body> [--project <label>] [--from <squad>]\n";

export async function run(raw: string[]): Promise<number> {
  const script = callerScript("send-role.sh");
  const DIRECTORY = process.env.DIRECTORY || `${ROOT}/bin/lib/directory.sh`;
  const BACKEND = backendPath();
  const usage = (): number => { writeErr(USAGE); return 2; };
  const la = dsLoopArgs(script.split("/").pop()!, raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  const argv = la.argv;

  let PROJECT = "", FROM = "", FROM_SET = false; const ARGS: string[] = [];
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--project") { PROJECT = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--from") { FROM = argv[i + 1] ?? ""; FROM_SET = true; i += 2; }
    else if (a === "-h" || a === "--help") return usage();
    else { ARGS.push(a); i++; }
  }
  if (ARGS.length !== 4) return usage();
  const [squad, want, subject, body] = ARGS;

  if (dsLoopOn()) {
    const lp = PROJECT ? dsLabel(PROJECT) : "";
    const chk = [squad, want, ...(PROJECT ? ["--project", PROJECT] : [])];
    const stop = await dsLoopCheck(usage, DIRECTORY, chk);
    if (stop !== undefined) return stop;
    // U45: the message is a loop.db row the receiver reads with `ds msg inbox`; the loop wakes it.
    return (await loopSend({ project: lp, squad, want, subject, body, kind: "message", wait: la.wait, who: "send-role" })).rc;
  }

  const reachArgs = [squad, want, ...(PROJECT ? ["--project", PROJECT] : []), ...(FROM_SET ? ["--from", FROM] : [])];
  const got = await runCmd([DIRECTORY, "reach", ...reachArgs]);
  writeErr(got.err);
  if (got.rc !== 0) return got.rc;
  // `IFS=$'\t' read -r kind _ run wt`: tab is IFS whitespace, so empty fields collapse and wt takes the rest.
  const f = (got.out.split("\n")[0] ?? "").replace(/^\t+/, "").split(/\t+/);
  let kind = f[0] ?? ""; const runId = f[2] ?? ""; const wt = f.slice(3).join("\t").replace(/\t+$/, "");
  if (kind === "run" && wt) {
    const h = await runCmd([BACKEND, "run-coordinator", runId]);
    if (h.rc === 0 && h.out.replace(/\n+$/, "") === "") kind = "worktree-run";
  }
  let out = "";
  const be = async (args: string[]) => { const r = await runCmd([BACKEND, ...args]); writeErr(r.err); return r; };
  switch (kind) {
    case "run": {
      const r = await be(["send", runId, subject, body]);
      if (r.rc === 0) out = r.out;
      else {
        let ok = false;
        if (wt) { const r2 = await be(["send-run-worker", runId, wt, subject, body]); if (r2.rc === 0) { out = r2.out; ok = true; kind = "worktree-run, run inbox refused"; } }
        if (!ok) return 1;
      }
      break;
    }
    case "worktree": {
      // U267 (4): `@worktree:` can resolve to a plain shell or the Setup tab in that worktree, where the
      // agent never reads it (and the stray close then destroys it): send to the member's newest agent
      // terminal (never a `claude -p` review child), with send-run-worker's receipt check; else as before.
      const hs = runId ? await runCmd([BACKEND, "agent-handles"]) : null;
      const handle = hs?.rc === 0 ? (parseAgents(hs.out).find((a) => a.wt === wt && !isClaudeP(a.title))?.handle ?? "") : "";
      const r = handle ? await be(["send-run-worker", "--to", handle, runId, wt, subject, body]) : await be(["send-worker", wt, subject, body]);
      if (r.rc !== 0) return r.rc;
      out = r.out; break;
    }
    case "worktree-run": { const r = await be(["send-run-worker", runId, wt, subject, body]); if (r.rc !== 0) return r.rc; out = r.out; break; }
    default: writeErr(`send-role: the phone book returned unknown kind '${kind}'\n`); return 1;
  }
  out = out.replace(/\n+$/, "");
  writeOut(`send-role: delivered to ${squad}/${want} (${kind})${out ? ` — ${out}` : ""}\n`);
  return 0;
}

/** The loop-root send (U45): one `messages` row, printed as {created, id, to}; --wait <s> waits for the wake poke to go out. */
export async function loopSend(o: { project: string; squad: string; want: string; subject: string; body: string; kind: string; wait: string; who: string; from?: Sender }): Promise<{ rc: number; id?: number; project?: string; created?: boolean }> {
  const s = open();
  try {
    const r = scriptSend(s, { ...o, top: toplevel() });
    if ("error" in r) { writeErr(`${o.who}: ${r.error}\n`); return { rc: 2 }; }
    const id = r.message.id, project = String(r.message.project);
    writeOut(JSON.stringify({ created: r.created, id, to: `${o.squad}/${o.want}` }) + "\n");
    if (!o.wait || await waitFor(Number(o.wait) || 0, () => s.get("messages", { id })?.delivered_at != null)) return { rc: 0, id, project, created: r.created };
    writeErr(`${o.who}: message ${id} not delivered within ${o.wait}s (it stays queued; the loop wakes ${o.squad}/${o.want} when it can)\n`);
    return { rc: 1, id, project, created: r.created };
  } finally { s.close(); }
}
