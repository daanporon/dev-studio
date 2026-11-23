// herdr.ts — the herdr backend for the contract v2 (orca-backend-alternatives U15; bin/backend/contract.ts,
// conventions/backend.md "The herdr backend"). herdr (github.com/herdrdev/herdr) is a
// terminal multiplexer for agents: a server owns workspaces > tabs > panes, and each pane is a real PTY
// whose agent herdr recognises. Pinned to one release (HERDR_VERSION, protocol HERDR_PROTOCOL); a server
// that answers another protocol is refused.
//
//   const s = await startHerdr({ bin, dir, name: "herdr-myproj" });   // through server-unit.ts, never our child
//   const b = herdrBackend(s.socket);
//   await b.call("terminal.create", { cwd: wt, env: { DS_GEN: gen }, label: "builder", group: "squad" });
//
// Layout B: one herdr workspace per group (a squad) and one tab per terminal (a member), each tab started
// with its own cwd and env. The first terminal of a group makes the workspace and takes its first tab;
// closing a group's last tab closes the workspace (herdr does). A terminal made without a group goes to
// one shared ungrouped workspace.
//
// Everything the contract asks back lives in herdr itself, so any client (a new loop process, the
// survive case of the conformance suite) reads the same answers:
//   - The terminal id is ours (`h-<random>`), kept as the pane token `ds_id`. herdr's own pane ids
//     (`w1:p2`) are positions that are not stable over a server's life, so every op finds its pane by
//     that token (`pane.list`). A pane without one is not ours and is never listed.
//   - cwd, label, group, gen and created_at go in the pane's tokens as base64url JSON cut in 80-character
//     pieces (`ds_n`, `ds_m0`…): herdr caps a token at 80 characters and trims spaces.
//   - A group's workspace carries the token `ds_g` (a hash of the group name; the label shows the name).
//   - `terminal.last_output` hashes the visible screen and keeps the hash and the time it last changed in
//     `ds_oh`/`ds_oa`: the time is when a read first saw the change, not when the bytes arrived.
// Tokens are not restored after a herdr server restart; the restored panes are new shells anyway
// (`resume_agents_on_restore = false`), so they are not listed and the loop starts its members again.
//
// Capabilities: parents groups, state native (`agent_status`: working → working, blocked → waiting,
// idle and done → idle, else unknown), keys native, turn_confirm none (a send answers when herdr took
// the bytes; herdr's turn signal, `agent.prompt --wait`, needs an agent it already recognises).
//
// `herdr integration install` is never run: state comes from herdr's own screen and process detection.
//
//   bun bin/backend/herdr.ts caller <bin> <dir> <name> [home]   start a server through startHerdr, create one
//        terminal (label and DS_GEN `survivor`), print `ready <server pid> <via> <terminal id>`, wait forever.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  type AgentState, type Answer, type Backend, type Capabilities, type ErrorCode, type Key, type Op, type Request, type Terminal,
  fail, okAnswer,
} from "./contract.ts";
import { type ServerHandle, defaultEnv, startServer } from "./server-unit.ts";

export const HERDR_VERSION = "0.9.5";
export const HERDR_PROTOCOL = 22;
export const HERDR_CAPS: Capabilities = { parents: "groups", state: "native", turn_confirm: "none", keys: "native" };

// The pinned release's Linux binaries and their sha256 (GitHub's asset digests for v0.9.5).
const RELEASE = `https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}`;
const ASSETS: Record<string, { asset: string; sha256: string }> = {
  "linux-x64": { asset: "herdr-linux-x86_64", sha256: "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d" },
  "linux-arm64": { asset: "herdr-linux-aarch64", sha256: "17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c" },
};

const SOURCE = "ds:loop";          // the metadata source our token reports carry
const TOKEN_MAX = 80;              // herdr's cap on a token value
const META_PIECES = 13;            // ds_m0..ds_m12, + ds_id, ds_n and ds_oh: herdr takes at most 16 keys per report

// ---- the socket ------------------------------------------------------------------------------------

type HerdrError = { code: string; message: string };
type Reply = { result?: Record<string, unknown>; error?: HerdrError };

let seq = 0;
// One request over herdr's socket (newline-delimited JSON, answered by id), on its own connection.
export function rpc(sock: string, method: string, params: Record<string, unknown> = {}, ms = 10_000): Promise<Reply> {
  const id = `ds_${process.pid}_${++seq}`;
  return new Promise((resolve, reject) => {
    let buf = "", done = false;
    const c = createConnection(sock);
    const end = (err: Error | null, r?: Reply) => {
      if (done) return;
      done = true; clearTimeout(timer); c.destroy();
      if (err) reject(err); else resolve(r!);
    };
    const timer = setTimeout(() => end(new Error(`herdr: no answer to ${method} within ${ms} ms`)), ms);
    c.setEncoding("utf8");
    c.on("connect", () => c.write(`${JSON.stringify({ id, method, params })}\n`));
    c.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: string } & Reply;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === id) return end(null, { result: m.result, error: m.error });
      }
    });
    c.on("error", (e) => end(new Error(`herdr: ${method}: ${e.message}`)));
    c.on("close", () => end(new Error(`herdr: the socket closed before answering ${method}`)));
  });
}

// ---- pure mappings (exported for the unit tests) ---------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  Enter: "enter", Escape: "esc", Tab: "tab", Backspace: "backspace",
  Up: "up", Down: "down", Left: "left", Right: "right", "C-c": "ctrl+c", "C-d": "ctrl+d",
};
export const herdrKey = (k: Key): string => KEY_NAMES[k] ?? k;

export function agentState(status: unknown): AgentState {
  switch (status) {
    case "working": return "working";
    case "blocked": return "waiting";
    case "idle": case "done": return "idle";
    default: return "unknown";
  }
}

type Meta = { id: string; cwd: string; label: string; group: string | null; gen: string | null; at: number };

// Meta → tokens (ds_id, ds_n, ds_m0…), or null when it does not fit in one report.
export function metaTokens(m: Meta): Record<string, string> | null {
  const b = Buffer.from(JSON.stringify(m)).toString("base64url");
  const n = Math.ceil(b.length / TOKEN_MAX);
  if (n > META_PIECES) return null;
  const t: Record<string, string> = { ds_id: m.id, ds_n: String(n) };
  for (let i = 0; i < n; i++) t[`ds_m${i}`] = b.slice(i * TOKEN_MAX, (i + 1) * TOKEN_MAX);
  return t;
}

export function tokensMeta(t: Record<string, unknown> | undefined): Meta | null {
  if (!t || typeof t.ds_id !== "string") return null;
  const n = Number(t.ds_n);
  if (!Number.isInteger(n) || n < 1 || n > META_PIECES) return null;
  let b = "";
  for (let i = 0; i < n; i++) { const p = t[`ds_m${i}`]; if (typeof p !== "string") return null; b += p; }
  try {
    const m = JSON.parse(Buffer.from(b, "base64url").toString("utf8")) as Meta;
    return m && m.id === t.ds_id && typeof m.cwd === "string" && typeof m.label === "string" && typeof m.at === "number" ? m : null;
  } catch { return null; }
}

export const groupKey = (group: string | null): string =>
  group === null ? "none" : `g${createHash("sha256").update(group).digest("hex").slice(0, 32)}`;
const screenHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

// The last `lines` lines of a read, without the blank rows below the cursor.
export function tail(text: string, lines?: number): string {
  const ls = text.replace(/\s+$/, "").split("\n");
  return (lines === undefined ? ls : lines <= 0 ? [] : ls.slice(-lines)).join("\n");
}

// ---- the backend -----------------------------------------------------------------------------------

type Pane = { pane_id: string; tab_id: string; workspace_id: string; agent_status?: string; tokens?: Record<string, unknown> };
type Space = { workspace_id: string; tokens?: Record<string, unknown> };

const now = () => Math.floor(Date.now() / 1000);
const codeOf = (e: HerdrError): ErrorCode => (/not_found/.test(e.code) ? "not_found" : "failed");
const toTerminal = (m: Meta): Terminal => ({ id: m.id, cwd: m.cwd, label: m.label, group: m.group, parent: null, gen: m.gen, created_at: m.at });

class Refused extends Error { constructor(readonly code: ErrorCode, msg: string) { super(msg); } }

export function herdrBackend(sock: string, opts: { timeoutMs?: number } = {}): Backend {
  const ms = opts.timeoutMs ?? 10_000;
  let pinned: string | null = null;     // the server's version, once its protocol was checked

  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const r = await rpc(sock, method, params, ms);
    if (r.error) throw new Refused(codeOf(r.error), `herdr ${method}: ${r.error.code}: ${r.error.message}`);
    return r.result ?? {};
  };
  const check = async (): Promise<string> => {
    if (pinned !== null) return pinned;
    const p = await call("ping");
    if (p.protocol !== HERDR_PROTOCOL)
      throw new Refused("failed", `herdr server ${String(p.version)} speaks protocol ${String(p.protocol)}; this adapter is pinned to ${HERDR_VERSION} (protocol ${HERDR_PROTOCOL})`);
    return (pinned = String(p.version));
  };
  const panes = async (): Promise<Pane[]> => ((await call("pane.list")).panes ?? []) as Pane[];
  const find = async (id: string): Promise<Pane> => {
    const p = (await panes()).find((x) => x.tokens?.ds_id === id);
    if (!p) throw new Refused("not_found", `no herdr terminal ${id}`);
    return p;
  };
  const tokens = (pane_id: string, t: Record<string, string>) => call("pane.report_metadata", { pane_id, source: SOURCE, tokens: t });

  async function create(req: Request<"terminal.create">): Promise<Terminal> {
    const group = req.group ?? null;
    const meta: Meta = { id: `h-${randomBytes(8).toString("hex")}`, cwd: req.cwd, label: req.label, group, gen: req.env?.DS_GEN ?? null, at: now() };
    const mt = metaTokens(meta);
    if (!mt) throw new Refused("bad_request", "cwd, label and group are too long to keep in herdr's pane tokens");
    const g = groupKey(group);
    const spaces = ((await call("workspace.list")).workspaces ?? []) as Space[];
    const ws = spaces.find((w) => w.tokens?.ds_g === g);
    const env = req.env ?? {};
    let pane: string, tab: string;
    if (ws) {
      const r = await call("tab.create", { workspace_id: ws.workspace_id, cwd: req.cwd, env, label: req.label, focus: false });
      pane = (r.root_pane as Pane).pane_id; tab = (r.tab as { tab_id: string }).tab_id;
    } else {
      const r = await call("workspace.create", { cwd: req.cwd, env, label: group ?? "ds", focus: false });
      pane = (r.root_pane as Pane).pane_id; tab = (r.tab as { tab_id: string }).tab_id;
      const wid = (r.workspace as Space).workspace_id;
      try {
        await call("workspace.report_metadata", { workspace_id: wid, source: SOURCE, tokens: { ds_g: g } });
        await call("tab.rename", { tab_id: tab, label: req.label });
      } catch (e) { await call("workspace.close", { workspace_id: wid }).catch(() => {}); throw e; }
    }
    try { await tokens(pane, { ...mt, ds_oh: screenHash("") }); }
    catch (e) { await call("tab.close", { tab_id: tab }).catch(() => {}); throw e; }
    return toTerminal(meta);
  }

  async function list(): Promise<Terminal[]> {
    const out: Terminal[] = [];
    for (const p of await panes()) { const m = tokensMeta(p.tokens); if (m) out.push(toTerminal(m)); }
    return out;
  }

  async function close(id: string): Promise<boolean> {
    const p = (await panes()).find((x) => x.tokens?.ds_id === id);
    if (!p) return false;
    try { await call("tab.close", { tab_id: p.tab_id }); return true; }
    catch (e) { if (e instanceof Refused && e.code === "not_found") return false; throw e; }
  }

  async function send(req: Request<"terminal.send">): Promise<void> {
    const p = await find(req.id);
    if (req.keys) await call("pane.send_keys", { pane_id: p.pane_id, keys: req.keys.map(herdrKey) });
    else if (req.submit) await call("pane.send_input", { pane_id: p.pane_id, text: req.text ?? "", keys: ["enter"] });
    else await call("pane.send_text", { pane_id: p.pane_id, text: req.text ?? "" });
  }

  async function read(req: Request<"terminal.read">): Promise<string> {
    const p = await find(req.id);
    const params = req.screen
      ? { pane_id: p.pane_id, source: "visible", strip_ansi: true }
      : { pane_id: p.pane_id, source: "recent", lines: Math.max(1, Math.min(req.lines ?? 200, 10_000)), strip_ansi: true };
    const r = (await call("pane.read", params)).read as { text?: string } | undefined;
    return tail(r?.text ?? "", req.lines);
  }

  async function lastOutput(id: string): Promise<number | null> {
    const p = await find(id);
    const r = (await call("pane.read", { pane_id: p.pane_id, source: "visible", strip_ansi: true })).read as { text?: string } | undefined;
    const h = screenHash(tail(r?.text ?? ""));
    if (p.tokens?.ds_oh !== h) {
      const at = now();
      await tokens(p.pane_id, { ds_oh: h, ds_oa: String(at) });
      return at;
    }
    const at = Number(p.tokens?.ds_oa);
    return Number.isFinite(at) && at > 0 ? at : null;
  }

  async function answer(op: Op, req: Request<Op>): Promise<Answer<Op>> {
    const version = await check();
    switch (op) {
      case "backend.info": return okAnswer("backend.info", { name: "herdr", version, capabilities: HERDR_CAPS });
      case "terminal.create": return okAnswer("terminal.create", { terminal: await create(req as Request<"terminal.create">) });
      case "terminal.list": return okAnswer("terminal.list", { terminals: await list() });
      case "terminal.close": return okAnswer("terminal.close", { closed: await close((req as Request<"terminal.close">).id) });
      case "terminal.send": await send(req as Request<"terminal.send">); return okAnswer("terminal.send", { delivery: "accepted" });
      case "terminal.read": return okAnswer("terminal.read", { text: await read(req as Request<"terminal.read">) });
      case "terminal.last_output": return okAnswer("terminal.last_output", { at: await lastOutput((req as Request<"terminal.last_output">).id) });
      case "agent.state": return okAnswer("agent.state", { state: agentState((await find((req as Request<"agent.state">).id)).agent_status) });
    }
    return fail("bad_request", `unknown op ${String(op)}`);
  }

  return {
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      try { return (await answer(op, req as Request<Op>)) as Answer<O>; }
      catch (e) {
        if (e instanceof Refused) return fail(e.code, e.message) as Answer<O>;
        return fail("failed", e instanceof Error ? e.message : String(e)) as Answer<O>;
      }
    },
  };
}

// ---- the server ------------------------------------------------------------------------------------

export type HerdrServer = { handle: ServerHandle; socket: string; session: string; config: string };

// herdr's config for a loop-owned server: the loop resumes agents itself, nothing reaches the network
// on its own (no update or agent-manifest checks: the pinned release's detection only), no sound.
export function herdrConfig(shell?: string): string {
  return [
    "onboarding = false", "",
    "[session]", "resume_agents_on_restore = false", "",
    "[update]", "version_check = false", "manifest_check = false", "",
    "[ui.sound]", "enabled = false", "",
    ...(shell ? ["[terminal]", `default_shell = ${JSON.stringify(shell)}`, ""] : []),
  ].join("\n");
}

// True when a herdr server answers ping on the socket.
export async function herdrUp(sock: string): Promise<boolean> {
  try { return !!(await rpc(sock, "ping", {}, 2000)).result; } catch { return false; }
}

// Start a herdr server for the loop in `dir` (config.toml, herdr.sock, server.log), through
// server-unit.ts, and wait until it answers. Its own session (`ds-<name>`) and socket keep it apart
// from any herdr the operator runs. `home` replaces HOME (and drops XDG_*) for the server and every
// pane in it: tests only. `shell` sets the panes' shell.
export async function startHerdr(o: { bin: string; dir: string; name: string; home?: string; shell?: string; waitMs?: number }): Promise<HerdrServer> {
  mkdirSync(o.dir, { recursive: true });
  const socket = join(o.dir, "herdr.sock"), config = join(o.dir, "config.toml"), log = join(o.dir, "server.log");
  if (Buffer.byteLength(socket) > 100) throw new Error(`herdr: socket path too long for a unix socket: ${socket}`);
  writeFileSync(config, herdrConfig(o.shell));
  const session = `ds-${o.name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(defaultEnv())) {
    if (k.startsWith("HERDR_")) continue;
    if (o.home && k.startsWith("XDG_") && k !== "XDG_RUNTIME_DIR") continue;
    env[k] = v;
  }
  if (o.home) { mkdirSync(o.home, { recursive: true }); env.HOME = o.home; }
  Object.assign(env, { HERDR_CONFIG_PATH: config, HERDR_SOCKET_PATH: socket, HERDR_SESSION: session });
  const handle = await startServer({ name: o.name, argv: [o.bin, "server"], log, cwd: o.dir, env });
  const wait = o.waitMs ?? 15_000;
  for (let t = 0; t < wait; t += 100) {
    if (await herdrUp(socket)) return { handle, socket, session, config };
    await Bun.sleep(100);
  }
  throw new Error(`herdr: the server never answered on ${socket} (log ${log})`);
}

// Fetch the pinned herdr release binary into `dir` (sha256 checked), or say why not. DS_HERDR_BIN
// names a binary to use instead (its protocol is still checked on the first call); DS_HERDR_FETCH=0
// fetches nothing (a test then skips).
export async function fetchHerdr(dir: string, timeoutMs = 120_000): Promise<{ bin: string } | { skip: string }> {
  const given = process.env.DS_HERDR_BIN;
  if (given) return existsSync(given) ? { bin: given } : { skip: `DS_HERDR_BIN=${given} does not exist` };
  if (process.env.DS_HERDR_FETCH === "0") return { skip: "DS_HERDR_FETCH=0" };
  const a = ASSETS[`${process.platform}-${process.arch}`];
  if (!a) return { skip: `no pinned herdr ${HERDR_VERSION} binary for ${process.platform}-${process.arch}` };
  let bytes: Uint8Array;
  try {
    const r = await fetch(`${RELEASE}/${a.asset}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { skip: `fetching herdr ${HERDR_VERSION}: HTTP ${r.status}` };
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) { return { skip: `fetching herdr ${HERDR_VERSION}: ${e instanceof Error ? e.message : String(e)}` }; }
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== a.sha256) return { skip: `herdr ${HERDR_VERSION} download has sha256 ${sum}, expected ${a.sha256}` };
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "herdr"), part = `${bin}.part`;
  writeFileSync(part, bytes);
  chmodSync(part, 0o755);
  renameSync(part, bin);
  return { bin };
}

if (import.meta.main) {
  const [cmd, bin, dir, name, home] = process.argv.slice(2);
  if (cmd === "caller" && bin && dir && name) {
    const s = await startHerdr({ bin, dir, name, home, shell: "/bin/bash" });
    const a = await herdrBackend(s.socket).call("terminal.create", { cwd: dir, env: { DS_GEN: "survivor" }, label: "survivor", group: "survive" });
    if (!a.ok) { console.error(`caller: ${a.error.message}`); process.exit(1); }
    console.log(`ready ${s.handle.pid} ${s.handle.via} ${a.terminal.id}`);
    setInterval(() => {}, 1 << 30); // stay up until killed
  } else {
    console.error("usage: herdr.ts caller <bin> <dir> <name> [home]");
    process.exit(2);
  }
}
