// ds orch-ts — the agents' entry point to the backend (U272): what bin/role/orch.sh runs. Worker-protocol ops pass
// straight to $BACKEND; lifecycle ops are refused (only the loop does those); `ask` falls back to the squad's Lead
// as mail when the backend says the caller's dispatch is closed (U267), exit 5.
// U276: on a loop root (dsLoopOn) send, send-worker, reply and ask write and read loop.db's message rows
// (U45, bin/loop/messages/messages.ts) instead of an Orca inbox: send <run> is a row to that Run's squad Lead,
// send-worker <wt> a row to the member at that worktree, reply <id> answers a row (or a relayed Orca
// question, by its msg_… id), and ask is a needs-reply row to the Lead that blocks until the reply row
// comes back (linked by reply_to) or DS_ASK_WAIT_S passes (exit 5, the answer comes as mail). A target
// with no member or squad row, or a caller that is no squad member (for ask and reply), keeps the backend.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, backendPath, dsLoopOn, run as runCmd, stateRoot, writeErr, writeOut } from "../lib/shared";
import { inherit } from "../lib/install";
import { open, type Store } from "../loop/core/store.ts";
import { toplevel } from "../loop/squad/exposed.ts";
import { ack, memberAt, reply, replyTo, senderAt, sendMessage, squadOfRun, type Addr, type Sender } from "../loop/messages/messages.ts";

export const help = `<op> [args...] — the agent-facing entry point to the backend (orch.sh): send, reply, ask, … and the refusal of lifecycle ops`;

const ASK_FELL_BACK = 5;
/** How long a loop-root ask blocks for its reply row (under the agent's 10-minute tool cap). */
const ASK_WAIT_S = () => Number(process.env.DS_ASK_WAIT_S) || 540;
const HELP = [
  "orch.sh — the agent-facing entry point to the backend. Roles call",
  "`~/.dev-studio/bin/role/orch.sh <op> [args]` instead of `orca` directly, so the backend",
  "stays swappable (it honors $BACKEND). This is the agent counterpart to the scripts",
  "(board/spawn/watch/…) that already route through $BACKEND.",
  "",
  "Worker-protocol ops only (see conventions/backend.md):",
  "  send  <run> <subject> <body>        message a Run's inbox",
  "  reply <msg_id> <run> <body>         reply to a message (relay an answer down)",
  "  ask   <run> <question>              ask the coordinator and BLOCK until answered; when the",
  "                                      backend refuses because your dispatch is closed or missing,",
  "                                      the question goes to your squad's Lead as mail instead",
  "                                      (send-role.sh <squad> lead) and ask exits 5: the answer comes",
  "                                      as mail — read it with watch.sh --worktree (U267)",
  "  ping  <own_wt> <text>               set a card note; \"\" clears. NOT the way to reach the",
  "                                      operator — use bin/role/ask-operator.sh (board + ping + receipt)",
  "  send-worker <wt> <subject> <body>   message ONE worker's own inbox at its worktree",
  "  send-run-worker [--to <handle>] <run> <wt> <subj> <body>  message a worker of ANOTHER Run at its worktree (or that terminal) in that Run",
  "  run-workers <run>                   <worktree_id>\\t<live yes|no>\\t<dispatch|->\\t<terminal|->\\t<task|-> per worker",
  "  inbox-all <run> | inbox-all-self    every message (read too) without marking read",
  "  inbox-wait <run> <timeout_ms>       block until a message or timeout",
  "  gate-create <task> <question>       create a checkpoint gate -> prints gate id",
  "  gate-resolve <gate> <resolution>    resolve a checkpoint gate",
  "",
  "U159: only the loop talks to Orca for lifecycle, in Bun through bin/backend/orca.sh —",
  "scripts (and slash commands) only write wishes. So this entry point refuses the lifecycle",
  "ops below; an agent that needs one writes a wish with the lifecycle script (add-role,",
  "restart-role, close-role, spawn/suspend/close-squad) instead. Adopting a Run the loop holds",
  "only starts a tug-of-war (roles/lead.md), so adopt is refused too: the loop binds its own",
  "pane as the seat.",
].join("\n") + "\n";

// U276: on a loop root the message ops are ds msg rows; the shared text above stays the shell body's (parity-role-host).
const LOOP_HELP = [
  "",
  "On this loop root (U276) send, send-worker, reply and ask are ds msg rows in loop.db, not Orca mail:",
  "  send <run> goes to the Lead of the squad whose Run it names; send-worker <wt> to that member;",
  "  reply takes the row id (or a relayed question's msg_… id) — the same as ds msg reply; ask writes a",
  "  needs-reply row to your squad's Lead and blocks for its reply row; none within DS_ASK_WAIT_S (540)",
  "  exits 5 and the answer comes as mail (the loop pokes you; ds msg inbox, watch.sh --worktree).",
].join("\n") + "\n";

const LIFECYCLE = new Set(["adopt", "run-create", "task-create", "lead-start", "lead-worker-start", "role-start", "wt-create", "worker-resume",
  "worker-start", "worker-stop", "worker-release", "worker-reclaim", "worker-abandon", "dispatch", "dispatch-abandon",
  "worktree-rm", "terminal-close-worktree", "studio-start"]);
/** Backend verbs only one loop fulfiller may run, for an operator's press on the board (account-free-resets
 *  U4: using a free reset grant spends it for good). An agent never runs them. */
const OPERATOR_ONLY: Record<string, string> = {
  "account-reset-use": "uses a free reset grant — only the loop does that, for an operator's Use press on the board",
};

/** The squad state file (`<state>/<label>/squads/<topic>.json`) whose run_id is `run`, first in glob order. */
function squadFileOfRun(run: string): string {
  const state = stateRoot();
  const re = new RegExp(`"run_id": *"${run}"`);
  let labels: string[] = [];
  try { labels = readdirSync(state).filter((n) => !n.startsWith(".")).sort(); } catch { return ""; }
  for (const l of labels) {
    const dir = join(state, l, "squads");
    let files: string[] = [];
    try { files = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      try { if (re.test(readFileSync(p, "utf8"))) return p; } catch { /* not a file */ }
    }
  }
  return "";
}

export async function run(argv: string[]): Promise<number> {
  const BACKEND = backendPath();
  if (argv.length < 1) { writeErr("usage: orch.sh <op> [args...] (send|send-worker|reply|ask|ping|inbox-wait|gate-create|gate-resolve|…)\n"); return 2; }
  const op = argv[0];
  if (op === "-h" || op === "--help" || op === "help") {
    writeOut(HELP);
    if (dsLoopOn()) writeOut(LOOP_HELP);
    writeOut(`exit codes: the backend's own, 2 = usage or a lifecycle op, ${ASK_FELL_BACK} = ask fell back to the Lead (answer comes as mail on watch.sh --worktree)\n`);
    return 0;
  }
  if (LIFECYCLE.has(op)) {
    writeErr(`orch.sh: '${op}' is lifecycle — only the loop does that (in Bun, through bin/backend/orca.sh).\n`);
    writeErr("orch.sh: write a wish with the lifecycle script instead (add-role, restart-role, close-role,\n");
    writeErr("orch.sh: spawn/suspend/close-squad); never adopt a Run the loop holds (roles/lead.md).\n");
    return 2;
  }
  if (op in OPERATOR_ONLY) {
    writeErr(`orch.sh: '${op}' ${OPERATOR_ONLY[op]}; it is refused here.\n`);
    return 2;
  }
  if (dsLoopOn() && ROW_OPS.has(op)) {
    const rc = await viaRows(op, argv.slice(1));
    if (rc != null) return rc;
  }
  if (op !== "ask") {
    if (!existsSync(BACKEND)) { writeErr(`orch.sh: ${BACKEND}: No such file or directory\n`); return 127; }
    return inherit([BACKEND, ...argv]);
  }

  // ask (U267): Orca answers an ask only inside an active supervised dispatch. A Builder whose task
  // ended would otherwise lose the question: it goes to the squad's Lead as mail, found by the Run id.
  const got = await runCmd([BACKEND, ...argv]);
  writeOut(got.out); writeErr(got.err);
  const rc = got.rc;
  if (rc === 0 || argv.length < 3) return rc;
  if (!/dispatch_inactive|requires an active (supervised )?dispatch|no active (supervised )?dispatch|dispatch (is )?(closed|not found|missing)/i.test(got.out + "\n" + got.err)) return rc;
  const runId = argv[1], question = argv[2];
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return rc;
  const file = squadFileOfRun(runId);
  if (!file) { writeErr(`orch.sh: ask refused (dispatch closed) and no squad state names Run ${runId} — ask your Lead with send-role.sh\n`); return rc; }
  const squad = file.slice(file.lastIndexOf("/") + 1).replace(/\.json$/, "");
  const label = file.split("/").slice(-3)[0];
  const top = await runCmd(["git", "rev-parse", "--show-toplevel"]);
  const wt = (top.rc === 0 && top.out.trim() ? top.out.replace(/\n+$/, "") : process.cwd()).split("/").pop()!;
  const body = `Question from ${wt} (${process.env.ORCA_TERMINAL_HANDLE || "no terminal handle"}); its ask was refused because its dispatch is closed, so it reads your answer as mail at its worktree:\n\n${question}`;
  const sent = await runCmd([join(ROOT, "bin", "role", "send-role.sh"), squad, "lead", `Question from ${wt} (ask fell back)`, body, "--project", label]);
  writeErr(sent.out); writeErr(sent.err);
  if (sent.rc === 0) {
    writeOut("orch.sh: ask fell back: your dispatch is closed, so the question went to the " + squad + " Lead as mail; the answer comes as mail: read it with watch.sh --worktree.\n");
    return ASK_FELL_BACK;
  }
  writeErr(`orch.sh: ask fell back but sending to the ${squad} Lead failed; tell your Lead with send-role.sh ${squad} lead\n`);
  return rc;
}

const ROW_OPS = new Set(["send", "send-worker", "reply", "ask"]);
const printed = (o: unknown) => writeOut(JSON.stringify(o) + "\n");

/** The loop-root form of a message op (U276); null when the rows can't carry it and the backend should. */
async function viaRows(op: string, a: string[]): Promise<number | null> {
  if (a.length < (op === "ask" ? 2 : 3)) return null;
  const s = open();
  try {
    const me = senderAt(s, toplevel());
    const member = me.project && me.squad && me.member ? me as Sender & { project: string; squad: string; member: string } : null;
    if (op === "send" || op === "send-worker") {
      const to: Addr | null = op === "send" ? lead(s, a[0]) : addr(memberAt(s, a[0]));
      if (!to) return null;
      const r = sendMessage(s, { to, from: me, subject: a[1], body: a[2] });
      printed({ created: r.created, id: r.message.id, to: `${to.squad}/${to.role}${to.suffix ? `-${to.suffix}` : ""}` });
      return 0;
    }
    if (!member) return null;
    if (op === "reply") {
      const id = /^\d+$/.test(a[0]) ? Number(a[0]) : Number(s.get("messages", { key: `relay:${a[0]}` })?.id ?? 0);
      if (!id) return null;
      const r = reply(s, member, id, a[2]);
      if ("error" in r) { writeErr(`orch.sh: ${r.error}\n`); return 2; }
      printed({ created: r.created, id: r.message?.id ?? null, reply_to: id, ...(r.request ? { orca_reply_request: r.request } : {}) });
      return 0;
    }
    return await ask(s, member, a[0], a[1]);
  } finally { s.close(); }
}

/** The Lead of the squad whose Run is `run`. */
function lead(s: Store, run: string): Addr | null {
  const q = squadOfRun(s, run);
  return q ? { ...q, role: "lead", suffix: "" } : null;
}
const addr = (m: Sender | null): Addr | null => (m?.project && m.squad ? { project: m.project, squad: m.squad, role: m.role, suffix: m.suffix } : null);

/** A needs-reply row to the Lead; block until its reply row arrives, print the answer and mark it read. */
async function ask(s: Store, me: Sender & { project: string; squad: string; member: string }, run: string, question: string): Promise<number> {
  const to = lead(s, run) ?? { project: me.project, squad: me.squad, role: "lead", suffix: "" };
  const subject = question.split("\n")[0].slice(0, 80);
  const q = sendMessage(s, { to, from: me, subject, body: question, needsReply: true });
  const id = q.message.id, wait = ASK_WAIT_S();
  writeErr(`orch.sh: asked the ${to.squad} Lead (message ${id}); waiting up to ${wait}s for the reply\n`);
  const end = Date.now() + wait * 1000;
  for (;;) {
    const r = replyTo(s, id);
    if (r) {
      writeOut(r.body.endsWith("\n") ? r.body : r.body + "\n");
      ack(s, me, [r.id]);
      return 0;
    }
    if (Date.now() >= end) break;
    await Bun.sleep(Math.min(1000, Math.max(0, end - Date.now())));
  }
  writeOut(`orch.sh: no reply to message ${id} within ${wait}s; the answer comes as mail: the loop pokes you, read it with ds msg inbox (watch.sh --worktree lists it).\n`);
  return ASK_FELL_BACK;
}
