// tmux.ts — the tmux backend for contract v2 (orca-backend-alternatives U14; conventions/backend.md,
// "Contract v2", "The tmux backend"). One tmux server per project, one session per squad (the
// terminal's `group`), one window per member started in its worktree with its env:
//
//   const b = projectTmux("myproj", { stateRoot });     // socket -L ds-myproj, started on first create
//   const a = await b.call("terminal.create", { cwd, env: { DS_GEN: gen }, label: "builder", group: "squad" });
//
// The server is never the caller's child: it is started through bin/backend/server-unit.ts as
// `tmux -f /dev/null -D` (a foreground server with no config of the user's, `exit-empty` off), and every
// client call carries `-N`, so a command can never start a server inside the loop's cgroup by itself.
//
// A terminal's id is its pane id (`%7`). What the contract echoes (cwd, label, group, gen, created_at)
// is kept in the window's user option `@ds_meta`, set in the same command list as the window, so a
// terminal is never listed without its gen. Text goes through a paste buffer read from stdin
// (`load-buffer -`), so no text is ever parsed as tmux syntax; submit presses Enter after it.
// Last output is the window's `window_activity` (tmux 3.4 has no pane_activity; one pane per window).
//
// Capabilities: parents groups, state none (the loop-side reader gives state), turn_confirm none,
// keys native.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Answer, type Backend, type Capabilities, type Failure, type Op, type Request, type Terminal, fail, okAnswer } from "./contract.ts";
import { type ServerHandle, defaultEnv, startServer } from "./server-unit.ts";

export const TMUX_CAPS: Capabilities = { parents: "groups", state: "none", turn_confirm: "none", keys: "native" };

export type TmuxOptions = {
  socket: string;                       // a socket name (`-L`), or a path (`-S`) when it holds a "/"
  tmux?: string;                        // the tmux binary (default: tmux on PATH)
  // How to start the server when none answers on the socket. Without it, a create on a dead socket fails.
  server?: { name: string; log: string; env?: Record<string, string> };
  shell?: string;                       // the server's default-shell (default: the server env's SHELL)
  size?: { cols: number; rows: number }; // a detached window's size (default 200x50)
  history?: number;                     // scrollback lines per pane (default 10000)
  submitDelayMs?: number;               // pause between the text and its Enter, for TUIs (default 100)
  timeoutMs?: number;                   // per tmux client call (default 10000)
};

export type TmuxBackend = Backend & {
  // Start the server if none answers; the handle when this call started it, else null.
  ensureServer(): Promise<ServerHandle | null>;
  killServer(): Promise<void>;
};

type Meta = { cwd: string; label: string; group: string | null; gen: string | null; created_at: number };
type Ran = { code: number; out: string; err: string };

const PANE_ID = /^%\d+$/;
// No server, or a server with no session left (tmux then has no target to resolve anything against).
const NO_SERVER = /no server running|error connecting|server exited unexpectedly|lost server|no current target/i;
const NOT_FOUND = /can't find (pane|window|session)/i;
const DEFAULT_GROUP = "_ds";
// The contract's key names that tmux spells differently; any other key (a named one or a single
// digit or letter) is the same word for tmux.
const KEY_NAMES: Record<string, string> = { Backspace: "BSpace" };
// The server's own env leaves out the identity of whoever started it, so a terminal made without
// DS_GEN lists gen null and never inherits another member's identity.
const NOT_INHERITED = ["DS_MEMBER", "DS_WT", "DS_GEN", "DS_BACKEND", "TMUX", "TMUX_PANE"];

// tmux reads an argument ending in ";" as the end of a command; "\;" at the end is a literal ";".
export const tmuxArg = (a: string): string => (a.endsWith(";") ? `${a.slice(0, -1)}\\;` : a);
// A session name tmux keeps as given (it turns "." and ":" into "_" itself).
export const sessionName = (group: string): string => group.replace(/[^A-Za-z0-9_-]/g, "_") || DEFAULT_GROUP;

// U20b: `capture-pane -p` drops styles, so Claude's grey prompt suggestion (`❯ mark the unit done`, drawn
// faint with SGR 2) read as typed text. The screen is read with `-e`; text drawn faint is dropped (a
// suggestion is not a draft) and every other escape is stripped, so the answer is plain text again.
export function plainScreen(raw: string): string {
  let faint = false, out = "";
  const re = /\x1b\[([0-9;:?<>=]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|([^\x1b]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(raw)); ) {
    if (m[3] !== undefined) { if (!faint) out += m[3]; continue; }
    if (m[2] !== "m") continue;
    const ps = m[1]!.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
    for (let i = 0; i < ps.length; i++) {
      const c = ps[i]!;
      if (c === 38 || c === 48 || c === 58) i += ps[i + 1] === 5 ? 2 : ps[i + 1] === 2 ? 4 : 0; // a colour's own numbers
      else if (c === 0 || c === 22) faint = false;
      else if (c === 2) faint = true;
    }
  }
  return out;
}

export function tmuxBackend(o: TmuxOptions): TmuxBackend {
  const bin = o.tmux ?? Bun.which("tmux") ?? "tmux";
  const sock = o.socket.includes("/") ? ["-S", o.socket] : ["-L", o.socket];
  const timeoutMs = o.timeoutMs ?? 10_000, submitDelay = o.submitDelayMs ?? 100;
  const size = o.size ?? { cols: 200, rows: 50 };
  const clientEnv = { ...process.env };
  for (const k of ["TMUX", "TMUX_PANE"]) delete clientEnv[k];
  let version: string | null = null, starting: Promise<ServerHandle | null> | null = null, seq = 0;

  // One tmux client call: each inner list is one command, joined by ";" into one command list that
  // the server runs as a whole.
  async function run(cmds: string[][], input?: string): Promise<Ran> {
    const argv = [bin, "-N", ...sock];
    cmds.forEach((c, i) => { if (i) argv.push(";"); argv.push(...c.map(tmuxArg)); });
    let p: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
    try {
      p = Bun.spawn(argv, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: clientEnv }) as typeof p;
    } catch (e) { return { code: 127, out: "", err: (e as Error).message }; }
    if (input !== undefined && p.stdin && typeof p.stdin !== "number") {
      try { await p.stdin.write(input); await p.stdin.end(); } catch { /* tmux already exited (no server): its stderr says why */ }
    }
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, out, err: err.trim() };
  }

  const up = async (): Promise<boolean> => (await run([["list-sessions", "-F", "#{session_id}"]])).code === 0;

  async function startIt(): Promise<ServerHandle | null> {
    if (await up()) return null;
    if (!o.server) throw new Error(`no tmux server on ${o.socket}`);
    const env = o.server.env ?? (() => { const e = defaultEnv(); for (const k of NOT_INHERITED) delete e[k]; return e; })();
    const h = await startServer({ name: o.server.name, log: o.server.log, env, argv: [bin, "-f", "/dev/null", ...sock, "-D"] });
    for (let t = 0; !(await up()); t += 50) {
      if (t >= 5000) throw new Error(`the tmux server on ${o.socket} never answered (log: ${o.server.log})`);
      await Bun.sleep(50);
    }
    const set = (k: string, v: string) => ["set-option", "-g", k, v];
    const r = await run([
      set("exit-empty", "off"), // the server stays when its last terminal closes
      set("history-limit", String(o.history ?? 10_000)),
      set("default-size", `${size.cols}x${size.rows}`),
      ...(o.shell ? [set("default-shell", o.shell)] : []),
    ]);
    if (r.code !== 0) throw new Error(`tmux set-option: ${r.err}`);
    return h;
  }
  // One start at a time: two creates racing on a dead socket start one server.
  function ensureServer(): Promise<ServerHandle | null> {
    starting ??= startIt().finally(() => { starting = null; });
    return starting;
  }

  const decode = (raw: string): Meta | null => {
    if (!raw) return null;
    try { return JSON.parse(decodeURIComponent(raw)) as Meta; } catch { return null; }
  };
  const asTerminal = (id: string, m: Meta): Terminal => ({
    id, cwd: m.cwd, label: m.label, group: m.group, parent: null, gen: m.gen, created_at: m.created_at,
  });
  // Why a call on a terminal failed: gone (no such pane, or no server at all) or anything else.
  const missing = (r: Ran) => NOT_FOUND.test(r.err) || NO_SERVER.test(r.err);
  const gone = (id: string) => fail("not_found", `no terminal ${id}`);
  const broke = (what: string, r: Ran) => fail("failed", `tmux ${what}: ${r.err || `exit ${r.code}`}`);
  const failed = (id: string, what: string, r: Ran): Failure => (missing(r) ? gone(id) : broke(what, r));

  async function create(req: Request<"terminal.create">): Promise<Answer<"terminal.create">> {
    if (!existsSync(req.cwd)) return fail("failed", `no such folder: ${req.cwd}`);
    try { await ensureServer(); } catch (e) { return fail("failed", (e as Error).message); }
    const meta: Meta = { cwd: req.cwd, label: req.label, group: req.group ?? null, gen: req.env?.DS_GEN ?? null, created_at: Math.floor(Date.now() / 1000) };
    const s = sessionName(req.group ?? DEFAULT_GROUP);
    const env = Object.entries(req.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // tmux expands formats in -n and -c ("#S", "##"); "##" keeps a "#" as it is.
    const lit = (v: string) => v.replaceAll("#", "##");
    const where = ["-n", lit(req.label || "terminal"), "-c", lit(req.cwd), ...env, "-P", "-F", "#{pane_id}"];
    // The chained set-option lands on the new window: without -d it is the command list's current one.
    const tag = ["set-option", "-w", "@ds_meta", encodeURIComponent(JSON.stringify(meta))];
    const inWindow = () => run([["new-window", "-t", `=${s}:`, ...where], tag]);
    let r = await inWindow();
    if (r.code !== 0 && /can't find session|no current target|no sessions/i.test(r.err)) {
      r = await run([["new-session", "-d", "-s", s, ...where], tag]);
      if (r.code !== 0 && /duplicate session/i.test(r.err)) r = await inWindow(); // another create made it first
    }
    const id = r.out.trim().split("\n")[0] ?? "";
    if (r.code !== 0 || !PANE_ID.test(id)) return broke("new-window", r);
    return okAnswer("terminal.create", { terminal: asTerminal(id, meta) });
  }

  async function list(): Promise<Answer<"terminal.list">> {
    const r = await run([["list-panes", "-a", "-F", "#{pane_id}\t#{@ds_meta}"]]);
    if (r.code !== 0) return NO_SERVER.test(r.err) ? okAnswer("terminal.list", { terminals: [] }) : broke("list-panes", r);
    const terminals: Terminal[] = [];
    for (const line of r.out.split("\n")) {
      const [id = "", raw = ""] = line.split("\t");
      const m = PANE_ID.test(id) ? decode(raw) : null;
      if (m) terminals.push(asTerminal(id, m));
    }
    return okAnswer("terminal.list", { terminals });
  }

  // The terminal's window_activity, which also tells whether it is there.
  async function lastOutput(id: string): Promise<Answer<"terminal.last_output">> {
    const r = await run([["list-panes", "-t", id, "-F", "#{window_activity}"]]);
    if (r.code !== 0) return failed(id, "list-panes", r);
    const at = Number(r.out.trim().split("\n")[0]);
    return okAnswer("terminal.last_output", { at: Number.isFinite(at) && at > 0 ? at : null });
  }

  async function send(req: Request<"terminal.send">): Promise<Answer<"terminal.send">> {
    const id = req.id;
    if (req.keys) {
      const r = await run([["send-keys", "-t", id, ...req.keys.map((k) => KEY_NAMES[k] ?? k)]]);
      if (r.code !== 0) return failed(id, "send-keys", r);
      return okAnswer("terminal.send", { delivery: "accepted" });
    }
    const text = req.text ?? "";
    if (text) {
      const buf = `ds-${process.pid}-${++seq}`;
      // -p: bracketed paste when the program asked for it; -r: the text's newlines as they are.
      const r = await run([["load-buffer", "-b", buf, "-"], ["paste-buffer", "-d", "-p", "-r", "-b", buf, "-t", id]], text);
      if (r.code !== 0) {
        await run([["delete-buffer", "-b", buf]]);
        return failed(id, "paste-buffer", r);
      }
    }
    if (req.submit) {
      if (text && submitDelay > 0) await Bun.sleep(submitDelay);
      const r = await run([["send-keys", "-t", id, "Enter"]]);
      if (r.code !== 0) return failed(id, "send-keys", r);
    } else if (!text) {
      const a = await lastOutput(id); // an empty send still answers not_found for a gone terminal
      if (!a.ok) return a;
    }
    return okAnswer("terminal.send", { delivery: "accepted" });
  }

  async function read(req: Request<"terminal.read">): Promise<Answer<"terminal.read">> {
    const lines = Math.max(1, Math.floor(req.lines ?? 2000));
    const r = await run([["capture-pane", "-p", "-e", "-t", req.id, ...(req.screen ? [] : ["-S", `-${lines}`])]]);
    if (r.code !== 0) return failed(req.id, "capture-pane", r);
    const all = plainScreen(r.out).replace(/\n$/, "").split("\n");
    while (all.length && !all[all.length - 1]!.trim()) all.pop();
    return okAnswer("terminal.read", { text: (req.screen ? all : all.slice(-lines)).join("\n") });
  }

  async function answer(op: Op, req: Request<Op>): Promise<Answer<Op>> {
    if (op === "backend.info") {
      if (version === null) {
        const r = await run([["-V"]]); // `tmux -N -S <sock> -V` prints the version without the server
        const m = /tmux\s+(\S+)/.exec(r.out);
        if (!m) return fail("failed", `tmux not usable at ${bin}: ${r.err || `exit ${r.code}`}`);
        version = m[1]!;
      }
      return okAnswer("backend.info", { name: "tmux", version, capabilities: { ...TMUX_CAPS } });
    }
    if (op === "worktree.parent" || op === "worktree.set_parent") return fail("unsupported", "tmux nests no worktrees");
    if (op === "terminal.create") return create(req as Request<"terminal.create">);
    if (op === "terminal.list") return list();
    const id = (req as { id: string }).id;
    if (op === "terminal.close") {
      if (!PANE_ID.test(id)) return okAnswer("terminal.close", { closed: false });
      const r = await run([["kill-window", "-t", id]]);
      if (r.code === 0) return okAnswer("terminal.close", { closed: true });
      return missing(r) ? okAnswer("terminal.close", { closed: false }) : broke("kill-window", r);
    }
    if (!PANE_ID.test(id)) return gone(id);
    if (op === "terminal.send") return send(req as Request<"terminal.send">);
    if (op === "terminal.read") return read(req as Request<"terminal.read">);
    if (op === "terminal.last_output") return lastOutput(id);
    if (op === "agent.state") {
      const a = await lastOutput(id); // state none: unknown for a terminal that is there
      return a.ok ? okAnswer("agent.state", { state: "unknown" }) : a;
    }
    return fail("bad_request", `unknown op ${op}`);
  }

  return {
    ensureServer,
    async killServer() { await run([["kill-server"]]); },
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      return (await answer(op, req as Request<Op>)) as Answer<O>;
    },
  };
}

// The project's tmux backend: socket `-L ds-<project>`, its server in the unit ds-tmux-<project>,
// logging to <stateRoot>/<project>/loop/tmux-server.log.
export function projectTmux(project: string, o: { stateRoot: string } & Partial<TmuxOptions>): TmuxBackend {
  const safe = project.replace(/[^A-Za-z0-9_.-]/g, "-");
  const { stateRoot, ...rest } = o;
  return tmuxBackend({
    socket: `ds-${safe}`,
    server: { name: `tmux-${safe}`, log: join(stateRoot, project, "loop", "tmux-server.log") },
    ...rest,
  });
}

// `tmux.ts caller <socket> <name> <log>` (the conformance suite's survive case): start the server
// through server-unit, make one terminal (DS_GEN survivor) and print `ready <pid> <via> <id>`, then
// stay up until killed.
if (import.meta.main) {
  const [cmd, socket, name, log, shell] = process.argv.slice(2);
  if (cmd === "caller" && socket && name && log) {
    const b = tmuxBackend({ socket, server: { name, log }, shell });
    const h = await b.ensureServer();
    if (!h) { console.error(`caller: a tmux server already answers on ${socket}`); process.exit(1); }
    const a = await b.call("terminal.create", { cwd: process.cwd(), env: { DS_GEN: "survivor" }, label: "survivor", group: "survive" });
    if (!a.ok) { console.error(`caller: ${a.error.message}`); process.exit(1); }
    console.log(`ready ${h.pid} ${h.via} ${a.terminal.id}`);
    setInterval(() => {}, 1 << 30);
  } else {
    console.error("usage: tmux.ts caller <socket> <name> <log> [shell]");
    process.exit(2);
  }
}
