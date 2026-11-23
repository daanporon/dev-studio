// fakes/contract.ts — an in-memory backend for the contract v2 (orca-backend-alternatives U2;
// bin/backend/contract.ts). It runs no agent: each terminal is a tiny fake shell that echoes what is
// typed and answers `echo <text>`, `echo $NAME` (from the terminal's env) and `pwd` (its cwd), so the
// conformance suite (tests/loop/backend-conformance.ts) can ask the same of it as of a real tmux.
//
//   const b = fakeContract({ parents: "groups", state: "none" });   // capabilities switchable, also later: b.caps.keys = "none"
//   await b.call("terminal.create", { cwd, env: { DS_GEN: "g1" }, label: "lead", group: "squad" });
//
// Knobs: `caps` (read on every call), `setState(id, s)` (what `agent.state` answers with state native),
// `exit(id)` (the terminal is gone, as after a crash), `lie` (answer that op outside its type, so a test
// can see the checker catch it), `calls` (every request, in order), `now` (seconds; default the clock).
//
// It also runs as a server on a unix socket, so the conformance suite can kill the process that started
// it and see the server and its terminals survive (bin/backend/server-unit.ts):
//   bun bin/loop/fakes/contract.ts serve <sock> [caps-json]       the server (POST /call {op, req})
//   bun bin/loop/fakes/contract.ts caller <sock> <name> <log> [caps-json]
//        starts `serve` through startServer, creates one terminal (label `survivor`, DS_GEN `survivor`),
//        prints `ready <server pid> <via> <terminal id>` and waits forever: the process to kill.
// `socketBackend(sock)` is the client: the same Backend over the socket.
import { rmSync } from "node:fs";
import {
  type AgentState, type Answer, type Backend, type Capabilities, type Op, type Request, type Terminal,
  fail, handle, okAnswer,
} from "../../backend/contract.ts";
import { startServer } from "../../backend/server-unit.ts";

const DEFAULT_CAPS: Capabilities = { parents: "groups", state: "native", turn_confirm: "native", keys: "native" };
const ROWS = 24;

type Term = { t: Terminal; env: Record<string, string>; lines: string[]; input: string; state: AgentState; last: number | null };

export type FakeContract = Backend & {
  caps: Capabilities;
  terms: Map<string, Term>;
  calls: { op: Op; req: unknown }[];
  lie: Op | null;
  now: () => number;
  setState(id: string, s: AgentState): void;
  exit(id: string): void;
};

export function fakeContract(caps: Partial<Capabilities> = {}, opts: { name?: string; now?: () => number } = {}): FakeContract {
  let seq = 0;
  const b: FakeContract = {
    caps: { ...DEFAULT_CAPS, ...caps },
    terms: new Map(),
    calls: [],
    lie: null,
    now: opts.now ?? (() => Math.floor(Date.now() / 1000)),
    setState(id, s) { const x = b.terms.get(id); if (x) x.state = s; },
    exit(id) { b.terms.delete(id); },
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      b.calls.push({ op, req });
      if (b.lie === op) return { ok: true, nonsense: 1 } as unknown as Answer<O>;
      return answer(op, req as Request<Op>) as Answer<O>;
    },
  };

  const screen = (x: Term): string[] => [...x.lines, `$ ${x.input}`];
  const print = (x: Term, ...ls: string[]) => { x.lines.push(...ls); x.last = b.now(); };
  const run = (x: Term, line: string) => {
    print(x, `$ ${line}`);
    const cmd = line.trim();
    if (cmd === "pwd") print(x, x.t.cwd);
    else if (/^echo \$[A-Za-z_][A-Za-z0-9_]*$/.test(cmd)) print(x, x.env[cmd.slice(6)] ?? "");
    else if (cmd.startsWith("echo ")) print(x, cmd.slice(5));
  };

  function answer(op: Op, req: Request<Op>): Answer<Op> {
    const r = req as Record<string, any>;
    if (op === "backend.info") return okAnswer("backend.info", { name: opts.name ?? "fake", version: "1", capabilities: { ...b.caps } });
    if (op === "terminal.create") {
      const id = `fake_${++seq}`, env = { ...(r.env ?? {}) } as Record<string, string>;
      const t: Terminal = {
        id, cwd: r.cwd, label: r.label,
        group: b.caps.parents === "groups" ? (r.group ?? null) : null,
        parent: b.caps.parents === "native" ? (r.parent ?? null) : null,
        gen: env.DS_GEN ?? null,
        created_at: b.now(),
      };
      b.terms.set(id, { t, env, lines: [], input: "", state: "idle", last: null });
      return okAnswer("terminal.create", { terminal: { ...t } });
    }
    if (op === "terminal.list") return okAnswer("terminal.list", { terminals: [...b.terms.values()].map((x) => ({ ...x.t })) });
    if (op === "terminal.close") return okAnswer("terminal.close", { closed: b.terms.delete(r.id) });
    const x = b.terms.get(r.id);
    if (!x) return fail("not_found", `no terminal ${r.id}`);
    if (op === "terminal.send") {
      if (r.keys) {
        if (b.caps.keys !== "native") return fail("unsupported", "this backend types no named keys");
        for (const k of r.keys as string[]) {
          if (k === "Enter") { run(x, x.input); x.input = ""; }
          else if (k === "C-c") { print(x, `$ ${x.input}^C`); x.input = ""; }
          else if (k === "Backspace") x.input = x.input.slice(0, -1);
          else if (k.length === 1) x.input += k;
        }
        x.last = b.now();
        return okAnswer("terminal.send", { delivery: "accepted" });
      }
      x.input += r.text;
      x.last = b.now();
      if (r.submit) { run(x, x.input); x.input = ""; }
      const started = r.submit && b.caps.turn_confirm === "native";
      if (started && b.caps.state === "native") x.state = "working";
      return okAnswer("terminal.send", { delivery: started ? "turn_started" : "accepted" });
    }
    if (op === "terminal.read") {
      const all = screen(x);
      const keep = r.screen ? ROWS : Math.max(1, Math.floor(r.lines ?? 2000));
      return okAnswer("terminal.read", { text: all.slice(-keep).join("\n") });
    }
    if (op === "terminal.last_output") return okAnswer("terminal.last_output", { at: x.last });
    if (op === "agent.state") return okAnswer("agent.state", { state: b.caps.state === "native" ? x.state : "unknown" });
    return fail("bad_request", `unknown op ${op}`);
  }
  return b;
}

// The fake served on a unix socket: POST /call with an envelope {op, req}, the answer as JSON.
export function serveFake(sock: string, fake: Backend): { stop(): void } {
  rmSync(sock, { force: true });
  const s = Bun.serve({
    unix: sock,
    async fetch(r) {
      let env: unknown;
      try { env = await r.json(); } catch { return Response.json(fail("bad_request", "the body is not JSON")); }
      return Response.json(await handle(fake, env));
    },
  });
  return { stop: () => { s.stop(true); rmSync(sock, { force: true }); } };
}

// A Backend whose calls go over the socket. A refused connection throws (no server).
export function socketBackend(sock: string): Backend {
  return {
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      const r = await fetch("http://fake/call", { unix: sock, method: "POST", body: JSON.stringify({ op, req }) } as RequestInit);
      return (await r.json()) as Answer<O>;
    },
  };
}

// Wait until the socket answers backend.info, up to ms.
async function waitServer(sock: string, ms = 10_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) {
    try { const a = await socketBackend(sock).call("backend.info", {}); if (a.ok) return true; } catch { /* not yet */ }
    await Bun.sleep(50);
  }
  return false;
}

if (import.meta.main) {
  const [cmd, sock, ...rest] = process.argv.slice(2);
  if (cmd === "serve" && sock) {
    serveFake(sock, fakeContract(JSON.parse(rest[0] || "{}") as Partial<Capabilities>));
  } else if (cmd === "caller" && sock && rest[0] && rest[1]) {
    const [name, log, caps = "{}"] = rest;
    const h = await startServer({ name, log, argv: [process.execPath, import.meta.path, "serve", sock, caps] });
    if (!(await waitServer(sock))) { console.error(`caller: the server never answered on ${sock}`); process.exit(1); }
    const a = await socketBackend(sock).call("terminal.create", { cwd: process.cwd(), env: { DS_GEN: "survivor" }, label: "survivor", group: "survive" });
    if (!a.ok) { console.error(`caller: ${a.error.message}`); process.exit(1); }
    console.log(`ready ${h.pid} ${h.via} ${a.terminal.id}`);
    setInterval(() => {}, 1 << 30); // stay up until killed
  } else {
    console.error("usage: contract.ts serve <sock> [caps-json] | caller <sock> <name> <log> [caps-json]");
    process.exit(2);
  }
}
