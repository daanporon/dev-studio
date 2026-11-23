// fakes/orca.ts — two fakes. FakeOrca: an OrcaAdapter for the observers (U4) that replays recorded
// backend outputs and counts its calls (Bun).
//
//   const o = FakeOrca.recorded("tests/fixtures/loop/orca");   // ps.json, inbox-unread-all.tsv, directory-<label>.json
//   o.procs = [{ cwd, agent, account }]                         // what agent-accounts reads (null = fails)
//   o.procs = FakeOrca.accounts("tests/fixtures/loop/orca/agent-accounts.tsv") // recorded lines, both shapes (U149)
//   orcaObserver(o)  ...  o.calls.ps, o.calls.unread, o.calls.directory, o.calls.screenTail, o.calls.dispatches
//
// The recordings are the shapes orca.sh ps, orca.sh inbox-unread-all and directory.sh list --json
// print. Tests change `worktrees`, `mail`, `dirs` and `screens` between ticks; `delayMs` makes every
// call take that long, for the tick-timing budget.
//
// FakeBackend: an in-memory Orca for the actuator's tests (U11): it answers the backend ops the
// actuator uses (terminal-create/-find, adopt, worker-start/-resume, role-start, poke, keys,
// request-show) the way bin/backend/orca.sh does, and records every call with its sender and retry id.
//   - a start needs a sender bound to its Run with adopt (else consumer_fenced, as Orca)
//   - a start under a retry id Orca has already seen is a no-op that answers the same (a replay)
//   - hold() keeps starts in flight until released (counts the most at once); hang makes a start
//     land but never answer, as a loop killed mid-call; lose makes it land and answer a timeout
//   - pending holds retry ids request-show calls pending (Orca still on it)
//   - gone(handle) closes a terminal; restart() gives every live pane a new handle
//   - pokes.set(wt, [codes]) answers that member's next pokes (0 started, 3 accepted, 1 failed)
//   - fail(op, out) answers the next call of op with out
//   - answer(call) overrides the answer to any call for as long as it returns one; after(call, out)
//     sees every answer (a test mirrors the fake's seats for a child script)
//   - workers holds handles that are dispatched workers of a Run: their adopt is refused
//     (worker_cannot_coordinate_own_run), as Orca refuses a restarted Lead's
//   - run-coordinator answers the handle bound to the Run
//   - mail (U61): post()/ask() put a worker's message in run:<id>; run-inbox-peek/-take read it as
//     the Run's coordinator only (else consumer_fenced), take marks it read; send-run-worker and
//     send-worker put a message in a worktree's inbox (inbox(wt)), not delivered (exit 3) to a
//     worktree in `away`; reply answers a parked question from the coordinator: questions.get(id)
//     .answer, refused as Orca does when it is closed (dispatch_inactive), already answered
//     differently (answer_conflict) or unknown (question_not_found)
//   - send-run-worker --to <handle> (U79) delivers to that terminal (the message's `term`), exit 3
//     when it is no live terminal of the worktree; misroute.set(handle, other) makes Orca put it
//     into `other` instead, and the receipt check exit 3 "misdelivered" as the adapter does
//   - shells: the plain terminals (no agent) terminal-shells lists, busy or idle; terminal-close
//     closes one (closeFails holds handles whose close fails)
//   - studio-start opens an agent tab in its worktree (agents) and prints its handle
//   - worktrees (U8b): wt-make makes a real git worktree under `wtRoot`/<repo folder>/<name> as Orca does
//     (an existing branch or taken folder gets `-2`, the parent is recorded), wt-show finds one by
//     `path:` or `id:` (exit 3 when none), wt-list lists the repo's worktrees but those in `unlisted`
//     (Orca lost them), and worktree-rm of a known one removes its folder and keeps its branch
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "../io/worktrees.ts";
import { parseAgentAccounts, parseUnread, type DirMember, type LiveAccount, type LiveTerminal, type OrcaAdapter, type PsWorktree, type RunDispatch, type Unread } from "../observers/orca.ts";
import type { Orca, Out, Via } from "../io/orca.ts";

export class FakeOrca implements OrcaAdapter {
  worktrees: PsWorktree[] = [];
  mail: Unread[] = [];
  dirs = new Map<string, DirMember[]>();
  screens = new Map<string, string>();
  failScreens = new Set<string>(); // the next screenTail of these throws, once
  procs: LiveAccount[] | null = null; // agent-accounts' answer; null = the read fails (the columns stay)
  runs = new Map<string, RunDispatch[]>(); // run-dispatches' answer per Run (U64)
  tabs: LiveTerminal[] | null = null;
  calls = { ps: 0, unread: 0, directory: [] as string[], screenTail: [] as string[], dispatches: [] as string[] };

  constructor(public delayMs = 0) {}

  static recorded(dir: string, delayMs = 0): FakeOrca {
    const f = new FakeOrca(delayMs);
    f.worktrees = (JSON.parse(readFileSync(join(dir, "ps.json"), "utf8")) as { result: { worktrees: PsWorktree[] } }).result.worktrees;
    const inbox = join(dir, "inbox-unread-all.tsv");
    if (existsSync(inbox)) {
      f.mail = parseUnread(readFileSync(inbox, "utf8"));
    }
    for (const n of readdirSync(dir).filter((x) => /^directory-.+\.json$/.test(x))) {
      f.dirs.set(n.slice("directory-".length, -".json".length), JSON.parse(readFileSync(join(dir, n), "utf8")) as DirMember[]);
    }
    return f;
  }

  // Recorded agent-accounts output, parsed as the shell adapter parses it.
  static accounts(file: string): LiveAccount[] { return parseAgentAccounts(readFileSync(file, "utf8")); }

  private async wait(): Promise<void> { if (this.delayMs > 0) await Bun.sleep(this.delayMs); }
  async ps() { this.calls.ps++; await this.wait(); return structuredClone(this.worktrees); }
  async unread() { this.calls.unread++; await this.wait(); return [...this.mail]; }
  async directory(project: string) { this.calls.directory.push(project); await this.wait(); return structuredClone(this.dirs.get(project) ?? []); }
  async screenTail(wt: string) {
    this.calls.screenTail.push(wt);
    await this.wait();
    if (this.failScreens.delete(wt)) throw new Error(`screen-tail ${wt}: timeout`);
    return this.screens.get(wt) ?? "";
  }

  async dispatches(run: string) { this.calls.dispatches.push(run); await this.wait(); return structuredClone(this.runs.get(run) ?? []); }
  async terminals() {
    await this.wait();
    return structuredClone(this.tabs ?? [...this.dirs.values()].flatMap((ds) => ds.flatMap((d) => (d.terminals ?? []).map((handle) =>
      ({ handle, worktreeId: d.wt, connected: true, agentIdentity: "claude" })))));
  }

  async agentAccounts() { await this.wait(); if (!this.procs) throw new Error("agent-accounts: unsupported"); return structuredClone(this.procs); }

  reset(): void { this.calls = { ps: 0, unread: 0, directory: [], screenTail: [], dispatches: [] }; }
}

export type Call = { op: string; args: string[]; via: Via };
export type FakeMsg = { id: string; run: string; to: string; term?: string; from_handle: string; type: string; subject: string; body: string; payload: string | null; read: boolean };
// A Run's dispatch of a task to a terminal (run-workers groups them by worktree, newest first).
export type FakeDispatch = { id: string; run: string; wt: string; handle: string; task: string; status: "dispatched" | "completed" | "failed"; provenance?: string };
export type FakeTask = { run: string; spec: string; title: string; parent: string | null; startable: boolean };
export type FakeWt = { id: string; path: string; repo: string; branch: string; parent: string | null };
const ok = (out = ""): Out => ({ code: 0, out, err: "" });
const no = (err: string, code = 1): Out => ({ code, out: "", err });

export class FakeBackend implements Orca {
  calls: Call[] = [];
  procs: LiveAccount[] | null = null;                              // observer()'s process walk (U149); null = none runs
  terminals = new Map<string, { pane: string; wt: string }>();
  bound = new Map<string, string>();                               // run -> sender handle
  receipts = new Map<string, { dispatch: string; out: string; code?: number; err?: string }>(); // retry id -> what it did
  started: { op: string; wt: string; args: string[] }[] = [];
  pokes = new Map<string, number[]>();
  inflight = 0;
  most = 0;
  hang = false;
  spawn = false;                                                   // a start leaves a live agent terminal in its worktree
  lose = false;
  pending = new Set<string>();
  workers = new Set<string>();
  msgs: FakeMsg[] = [];
  questions = new Map<string, { answer?: string; closed?: boolean }>();
  away = new Set<string>();                                        // worktrees with no live terminal
  agents: { wt: string; handle: string; title: string; busy?: boolean }[] = [];   // live agent terminals (agent-handles), newest first per wt
  shells: { wt: string; handle: string; title: string; busy?: boolean; out?: number }[] = [];   // plain terminals (terminal-shells; out: last output, epoch s)
  misroute = new Map<string, string>();                            // --to handle -> the terminal Orca files it under
  parents = new Map<string, string>();                             // wt -> the parent wt-set-parent gave it (the observer reports it)
  closeFails = new Set<string>();                                  // terminal-close fails for these
  dispatches: FakeDispatch[] = [];
  tasks = new Map<string, FakeTask>();
  wtRoot = "";                                                     // where wt-make puts worktrees (Orca's workspaces)
  wts = new Map<string, FakeWt>();                                 // path -> a worktree Orca made (wt-make)
  unlisted = new Set<string>();                                    // paths wt-list leaves out; wt-show still finds them
  onCall?: (c: Call) => void;
  after?: (c: Call, out: Out) => void;
  answer?: (c: Call) => Out | undefined | Promise<Out | undefined>;
  private failures = new Map<string, Out[]>();
  private gate: Promise<void> | null = null;
  private n = 0;   // dispatch ids
  private t = 0;   // terminal handles
  private m = 0;   // message ids
  private k = 0;   // task ids

  of(op: string): Call[] { return this.calls.filter((c) => c.op === op); }
  // Observer reads and actuator calls see the same host; reads are counted separately by FakeOrca.
  observer(worktrees: () => PsWorktree[], directory: () => DirMember[]): OrcaAdapter {
    const fake = this;
    return {
      get agentAccounts() { return fake.procs ? async () => structuredClone(fake.procs!) : undefined; },
      ps: async () => worktrees().map((w) => ({ ...w, ...(this.parents.has(w.worktreeId) ? { parentWorktreeId: this.parents.get(w.worktreeId) } : {}), agents: this.agents.filter((a) => a.wt === w.worktreeId)
        .map((a) => ({ state: a.busy ? "working" : "idle" })) })),
      unread: async () => [], directory: async () => directory(), screenTail: async () => "",
      terminals: async () => [...this.agents.map((a) => ({ handle: a.handle, worktreeId: a.wt, title: a.title, agentIdentity: "claude", connected: true })),
        ...this.shells.map((s) => ({ handle: s.handle, worktreeId: s.wt, title: s.title, agentIdentity: null, connected: true }))],
      dispatches: async (run) => [...this.dispatches].reverse().filter((d) => d.run === run).map((d) => ({ wt: d.wt, id: d.id, status: d.status })),
    };
  }
  // A worker's message to its Run's coordinator (a status, a worker_done); ask() parks a question.
  post(run: string, from: string, type: string, subject: string, body: string, payload: unknown = null): string {
    const id = `msg_${++this.m}`;
    this.msgs.push({ id, run, to: `run:${run}`, from_handle: from, type, subject, body, payload: payload == null ? null : JSON.stringify(payload), read: false });
    return id;
  }
  ask(run: string, from: string, question: string, options: string[] = []): string {
    const id = this.post(run, from, "question", "Question", question, { taskId: "task_1", dispatchId: from.replace(/^dispatch:/, ""), question, options });
    this.questions.set(id, {});
    return id;
  }
  inbox(wt: string): FakeMsg[] { return this.msgs.filter((m) => m.to === `wt:${wt}`); }
  // What one terminal got (a send by handle, or misrouted to it).
  inboxOf(handle: string): FakeMsg[] { return this.msgs.filter((m) => m.term === handle); }
  unread(run: string): FakeMsg[] { return this.msgs.filter((m) => m.to === `run:${run}` && !m.read); }
  fail(op: string, out: Out): void { this.failures.set(op, [...(this.failures.get(op) ?? []), out]); }
  gone(handle: string): void { this.terminals.delete(handle); this.agents = this.agents.filter((a) => a.handle !== handle); }
  // A live agent terminal in a worktree (a member's Claude): the newest one comes first for its wt.
  agent(wt: string, handle: string, title = "", busy = false): void { this.agents.unshift({ wt, handle, title, busy }); }
  // A role task of the Run dispatched to `handle` in `wt` (a member started by the loop).
  dispatched(run: string, wt: string, handle: string, o: { task?: string; spec?: string; status?: FakeDispatch["status"]; provenance?: string } = {}): FakeDispatch {
    const task = o.task ?? `task_r${++this.k}`;
    if (!this.tasks.has(task)) this.tasks.set(task, { run, spec: o.spec ?? `spec of ${task}`, title: task, parent: null, startable: false });
    const d: FakeDispatch = { id: `ctx_${++this.n}`, run, wt, handle, task, status: o.status ?? "dispatched", ...(o.provenance ? { provenance: o.provenance } : {}) };
    this.dispatches.push(d);
    return d;
  }
  restart(): void {
    for (const [h, t] of [...this.terminals]) { this.terminals.delete(h); this.terminals.set(`term_${++this.t}`, t); }
    this.bound.clear();
  }
  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise((r) => { release = r; });
    return () => { this.gate = null; release(); };
  }

  /** The worktree a `path:<p>` or `id:<id>` selector names. */
  private wtAt(sel: string): FakeWt | undefined {
    return sel.startsWith("path:") ? this.wts.get(sel.slice(5)) : [...this.wts.values()].find((w) => `id:${w.id}` === sel);
  }

  private wtLine(w: FakeWt): string {
    return JSON.stringify({ id: w.id, path: w.path, branch: `refs/heads/${w.branch}`, head: null, parentWorktreeId: w.parent });
  }

  async run(op: string, args: string[], via: Via = {}): Promise<Out> {
    const c = { op, args, via };
    this.calls.push(c);
    this.onCall?.(c);
    const out = await this.answerOf(c);
    this.after?.(c, out);
    return out;
  }

  private async answerOf(c: Call): Promise<Out> {
    const { op, args, via } = c;
    const a = await this.answer?.(c);
    if (a) return a;
    const f = this.failures.get(op)?.shift();
    if (f) return f;
    switch (op) {
      case "terminal-create": {
        const n = ++this.t, h = `term_${n}`, pane = `tab${n}:leaf${n}`;
        this.terminals.set(h, { pane, wt: args[0] });
        return ok(`${h}\t${pane}\n`);
      }
      case "studio-start": {   // <wt> <account> <model> <effort> <window> <prompt>: a new agent tab, its handle
        const n = ++this.t, h = `term_${n}`;
        this.terminals.set(h, { pane: `tab${n}:leaf${n}`, wt: args[0] });
        this.agents.unshift({ wt: args[0], handle: h, title: "claude" });
        return ok(`${h}\n`);
      }
      case "terminal-find": return ok(`${[...this.terminals].find(([, t]) => t.pane === args[0])?.[0] ?? ""}\n`);
      case "adopt":
        if (!via.from || !this.terminals.has(via.from)) return no(`orca adapter: adopt (run-use) failed for run ${args[0]}`);
        if (this.workers.has(via.from)) return no(`orca adapter: adopt (run-use) failed for run ${args[0]}: worker_cannot_coordinate_own_run: a dispatched worker cannot coordinate its own Run. No effects were applied.`);
        this.bound.set(args[0], via.from);
        return ok();
      case "worker-start": case "worker-resume": case "role-start": return this.start(op, args, via);
      case "poke": {
        const q = this.pokes.get(args[0]) ?? [], code = q.length ? q.shift()! : 0;
        return code === 0 || code === 3 ? { code, out: "", err: "" } : no(`orca adapter: poke: terminal send failed for ${args[0]}`, code);
      }
      case "wt-set-parent": this.parents.set(args[0], args[1]); return ok();
      case "poke-terminal": return ok();
      case "pause-deliver": {
        const seen = via.retry ? this.receipts.get(via.retry) : undefined;
        if (seen) return ok(seen.out);
        if (!this.agents.some((a) => a.wt === args[0] && a.handle === args[1])) return no("pause: recipient absent");
        this.msgs.push({ id: `msg_${++this.m}`, run: args[3], to: `wt:${args[0]}`, term: args[1], from_handle: via.from ?? "", type: "status", subject: "pause", body: args[2], payload: null, read: false });
        if (via.retry) this.receipts.set(via.retry, { dispatch: "", out: "delivered" });
        return ok("delivered");
      }
      case "pause-close": {
        const agent = this.agents.find((a) => a.wt === args[0] && a.handle === args[1]);
        if (!agent) return ok();
        if (agent.busy || this.closeFails.has(args[1])) return no("pause: terminal still busy or close failed");
        this.agents = this.agents.filter((a) => a !== agent);
        return ok();
      }
      case "worker-stop": {
        this.agents = this.agents.filter((a) => a.wt !== args[1]);
        for (const d of this.dispatches) if (d.wt === args[1]) d.status = "completed";
        return ok("stopped");
      }
      case "worker-release": {
        this.dispatches = this.dispatches.filter((d) => d.run !== args[0] || d.wt !== args[1]);
        return ok("released");
      }
      case "pause-release": {
        if (this.agents.some((a) => a.wt === args[1] && !/^ds-loop\b|claude -p/.test(a.title))) return no("pause: agent terminal still present");
        this.dispatches = this.dispatches.filter((d) => d.run !== args[0] || d.wt !== args[1]);
        return ok("released");
      }
      case "run-create": {
        const seen = via.retry ? this.receipts.get(via.retry) : undefined;
        if (seen) return ok(seen.out);
        const out = `run_${++this.k}\n`;
        if (via.retry) this.receipts.set(via.retry, { dispatch: "", out });
        return ok(out);
      }
      case "worker-reclaim": return ok("0\n");
      case "run-coordinator": return ok(`${this.bound.get(args[0]) ?? ""}\n`);
      case "keys": return ok();
      case "wt-make": {   // <repo> <name> <branch> <base> [parent_path]
        const [repo, name, branch, base, parent] = args;
        const taken = async (b: string) => (await git(["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${b}`])).code === 0;
        const dir = join(this.wtRoot, basename(resolve(repo)));
        let path = join(dir, name), br = branch;
        if (existsSync(path) || await taken(br)) { path = `${path}-2`; br = `${br}-2`; }
        mkdirSync(dir, { recursive: true });
        const add = await git(["-C", repo, "worktree", "add", "--no-track", "-b", br, path, base]);
        if (add.code !== 0) return no(add.err);
        const w: FakeWt = { id: `R::${path}`, path, repo, branch: br, parent: parent ? `R::${parent}` : null };
        this.wts.set(path, w);
        return ok(`${this.wtLine(w)}\n`);
      }
      case "wt-show": {
        const w = this.wtAt(args[0]);
        return w ? ok(`${this.wtLine(w)}\n`) : no(`{"error":{"code":"selector_not_found"}}`, 3);
      }
      case "wt-list":
        return ok([...this.wts.values()].filter((w) => w.repo === args[0] && !this.unlisted.has(w.path)).map((w) => `${this.wtLine(w)}\n`).join(""));
      case "worktree-rm": {   // <selector> [force]
        const w = this.wtAt(args[0]);
        if (!w) return ok();
        const rm = await git(["-C", w.repo, "worktree", "remove", "--force", w.path]);
        if (rm.code !== 0 && existsSync(w.path)) return no(rm.err);
        await git(["-C", w.repo, "worktree", "prune"]);
        this.wts.delete(w.path);
        return ok();
      }
      case "terminal-close-worktree": {
        // id:<wt> [keep]: close that worktree's agent + shell terminals but the kept handle (U97's guard, restart-role).
        const wt = args[0].replace(/^id:/, ""), keep = args[1];
        this.agents = this.agents.filter((a) => a.wt !== wt || a.handle === keep);
        this.shells = this.shells.filter((t) => t.wt !== wt || t.handle === keep);
        for (const [h, t] of [...this.terminals]) if (t.wt === wt && h !== keep) this.terminals.delete(h);
        return ok();
      }
      case "run-inbox-peek": case "run-inbox-take": {
        if (!via.from || this.bound.get(args[0]) !== via.from) return no(`error: consumer_fenced: This caller is not bound to Run ${args[0]}.`);
        const got = this.unread(args[0]);
        if (op === "run-inbox-take") for (const m of got) m.read = true;
        return ok(`${JSON.stringify(got.map((m) => ({ id: m.id, from_handle: m.from_handle, type: m.type, subject: m.subject, body: m.body, payload: m.payload })))}\n`);
      }
      case "send-run-worker": case "send-worker": {
        const to = op === "send-run-worker" && args[0] === "--to" ? args[1] : null, rest = to ? args.slice(2) : args;
        const [wt, subject, body] = op === "send-worker" ? rest : rest.slice(1);
        if (this.away.has(wt)) return no(`orca adapter: ${op} NOT delivered — worktree ${wt} has no live terminal`, 3);
        const seen = via.retry ? this.receipts.get(via.retry) : undefined;
        if (seen) return { code: seen.code ?? 0, out: seen.out, err: seen.err ?? "" };
        if (to && !this.agents.some((a) => a.wt === wt && a.handle === to) && !this.shells.some((t) => t.wt === wt && t.handle === to))
          return no(`orca adapter: send-run-worker NOT delivered — worktree ${wt} has no live terminal in run ${rest[0]} (terminal_not_found)`, 3);
        // U89: a terminal with an active (dispatched) dispatch does not get the mail: Orca files
        // it under `run:<id>` instead, and the adapter exits 3 with the receipt it saw. No receipt
        // is kept (like the worktree-gone branches above): `request-show` reads absent, the call
        // settles failed, and the next send goes out under a new retry id. A kept refusal would
        // replay itself forever, the trap the relay's misdelivered path marks its calls failed for.
        if (to && this.dispatches.some((d) => d.handle === to && d.status === "dispatched")) {
          const err = `orca adapter: send-run-worker NOT delivered — Orca filed it under 'run:${rest[0]}' instead of its terminal. Ask your Lead; it raises it to the Studio.`;
          return no(err, 3);
        }
        const term = to ? this.misroute.get(to) ?? to : undefined, id = `msg_${++this.m}`;
        this.msgs.push({ id, run: op === "send-worker" ? "" : rest[0], to: `wt:${wt}`, term, from_handle: via.from ?? "", type: "status", subject, body, payload: null, read: false });
        if (to && term !== to) {
          const err = `orca adapter: send-run-worker NOT delivered to ${to} — misdelivered: the receipt names ${term}, not ${to}`;
          if (via.retry) this.receipts.set(via.retry, { dispatch: "", out: "", code: 3, err });
          return no(err, 3);
        }
        const out = `${op}: delivered to ${term ?? wt} (${id})\n`;
        if (via.retry) this.receipts.set(via.retry, { dispatch: "", out });
        return ok(out);
      }
      case "terminal-shells": return ok(this.shells.map((t) => `${t.wt}\t${t.handle}\t${t.busy ? "busy" : "idle"}\t${t.out ?? "-"}\t${t.title}\n`).join(""));
      case "terminal-close": {
        if (this.closeFails.has(args[0])) return no(`orca adapter: terminal-close ${args[0]} failed: terminal_busy`);
        this.shells = this.shells.filter((t) => t.handle !== args[0]);
        this.agents = this.agents.filter((a) => a.handle !== args[0]);
        return ok(`terminal-close: closed ${args[0]}\n`);
      }
      case "reply": {
        const [id, run, body] = args;
        if (!via.from || this.bound.get(run) !== via.from) return no(`error: consumer_fenced: This caller is not bound to Run ${run}.`);
        const q = this.questions.get(id);
        if (!q) return no(`error: question_not_found: Question ${id} was not found in Run ${run}.`);
        if (q.closed) return no(`error: dispatch_inactive: Question ${id} is closed because its Dispatch is inactive.`);
        if (q.answer !== undefined && q.answer !== body) return no(`error: answer_conflict: Question ${id} already has a different answer.`);
        q.answer = body;
        return ok();
      }
      case "request-show": {
        if (this.pending.has(args[0])) return ok("pending\t\n");
        const r = via.retry ? undefined : this.receipts.get(args[0]);
        return ok(r ? `completed\t${r.dispatch}\n` : "absent\t\n");
      }
      case "run-workers": {
        const mine = this.dispatches.filter((d) => d.run === args[0]).reverse(), wts = [...new Set(mine.map((d) => d.wt))];
        return ok(wts.map((wt) => {
          const of = mine.filter((d) => d.wt === wt), live = of.find((d) => d.status === "dispatched"), n = live ?? of[0];
          const rep = !live && (n.status === "completed" || (n.status === "failed" && n.provenance === "worker_report"));
          return `${wt}\t${live ? `yes\t${live.id}` : "no\t-"}\t${n.handle}\t${n.task}\t${n.status}\t${rep ? "yes" : "no"}\n`;
        }).join(""));
      }
      case "agent-handles": return ok(this.agents.map((a) => `${a.wt}\t${a.handle}\t${a.title}\n`).join(""));
      case "task-spec": {
        const t = this.tasks.get(args[1]);
        return t && t.run === args[0] ? ok(`${t.spec}\n`) : no(`orca adapter: task-spec found no task ${args[1]} in ${args[0]}`);
      }
      case "task-create": {
        const seen = via.retry ? this.receipts.get(via.retry) : undefined;
        if (seen) return ok(seen.out);
        const id = `task_${++this.k}`, out = `${id}\n`;
        this.tasks.set(id, { run: args[0], spec: args[1], title: args[2], parent: args[3] ?? null, startable: true });
        if (via.retry) this.receipts.set(via.retry, { dispatch: "", out });
        return ok(out);
      }
      case "dispatch": {
        const [task, handle, run] = args;
        if (!via.from || this.bound.get(run) !== via.from) return no(`orca adapter: dispatch of ${task} to ${handle} failed: consumer_fenced: the caller is not the Run's coordinator`);
        const seen = via.retry ? this.receipts.get(via.retry) : undefined;
        if (seen) return ok(seen.out);
        const t = this.tasks.get(task), a = this.agents.find((x) => x.handle === handle);
        if (!t || !t.startable) return no(`orca adapter: dispatch of ${task} to ${handle} failed: task_not_startable: Task ${task} cannot be dispatched`);
        if (!a) return no(`orca adapter: dispatch of ${task} to ${handle} failed: terminal_not_found: no terminal ${handle}`);
        t.startable = false;
        const d: FakeDispatch = { id: `ctx_${++this.n}`, run, wt: a.wt, handle, task, status: "dispatched" };
        this.dispatches.push(d);
        this.away.delete(a.wt);
        if (via.retry) this.receipts.set(via.retry, { dispatch: d.id, out: `${d.id}\n` });
        return ok(`${d.id}\n`);
      }
      case "dispatch-abandon": {
        const d = this.dispatches.find((x) => x.id === args[0]);
        if (!d) return no(`orca adapter: dispatch-abandon of ${args[0]} refused: dispatch_not_found`);
        d.status = "failed";
        return ok(`dispatch-abandon: fenced ${d.id}\n`);
      }
      default: return no(`fake orca: no op ${op}`);
    }
  }

  private async start(op: string, args: string[], via: Via): Promise<Out> {
    const run = args[0];
    if (!via.from || this.bound.get(run) !== via.from) return no("consumer_fenced: the caller is not the Run's coordinator");
    // U97's backend guard, as bin/backend/orca.sh runs it: a start into an existing worktree first
    // closes its other agent terminals (ds-loop panes kept); a busy old agent refuses agent_busy
    // (exit 3, nothing started), a close that fails refuses with the reason.
    if (op !== "role-start") {
      const wt = args[1], old = this.agents.filter((a) => a.wt === wt && !/^ds-loop\b/.test(a.title));
      if (old.some((a) => a.busy)) return no(`orca adapter: agent_busy: worktree ${wt} has an agent mid-turn; refusing to start a second session`, 3);
      const stuck = old.find((a) => this.closeFails.has(a.handle));
      if (stuck) return no(`orca adapter: start in ${wt} refused: could not close the old agent terminal ${stuck.handle}`);
      if (old.length) this.agents = this.agents.filter((a) => !old.includes(a));
    }
    const seen = via.retry ? this.receipts.get(via.retry) : undefined;
    if (seen) return ok(seen.out);
    this.inflight++;
    this.most = Math.max(this.most, this.inflight);
    try {
      if (this.gate) await this.gate;
      const wt = op === "role-start" ? `fakerepo::/wt/${args[6]}` : args[1];
      const out = op === "role-start" ? `${wt}\n` : "";
      if (via.retry) this.receipts.set(via.retry, { dispatch: `ctx_${++this.n}`, out });
      this.started.push({ op, wt, args });
      if (this.spawn) this.agent(wt, `term_s${this.started.length}`, "claude");
      if (this.hang) return new Promise<Out>(() => {});
      if (this.lose) return no("orca adapter: worker-start timed out", 124);
      return ok(out);
    } finally { this.inflight--; }
  }
}
