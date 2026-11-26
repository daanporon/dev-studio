// server.ts — side-loop-host U2 (issue #127, KTD1/KTD2/KTD4): main's link server, its own process beside the board
// (the loop runs it: bin/loop/fulfil/link.ts). Two doors:
//   the network listener   `GET /link` upgrades to a WebSocket a side host dials (bin/link/client.ts); `GET /healthz`
//                          answers {ok, pid} for the loop's ping. It binds loopback and the tailnet address only
//                          (KTD2): any other bind address is refused unless DS_LINK_BIND_ANY=1.
//   the unix socket        `<state root>/link/server.sock`, mode 0600, for processes on main: `POST /request`
//                          {host, ch, body, timeout_ms?} sends one request down that host's link and answers
//                          {ok, body} or {ok:false, error}; `GET /links` lists the hosts whose link is up.
// Before the hello a frame is a join request (U1 `requestJoin`, answered then closed) or a hello. Only an
// `accepted` host that signs main's fresh challenge gets in (U1 `verifyHello`); a wrong link version is refused
// with the fix. A second connection for a host whose link is still live (heard within DEAD_MS) is refused and
// logged (`host_link_refused`); it never replaces the first. Every PING_MS the server re-reads each linked
// host's row: a host no longer accepted is closed (`host_link_closed`), a link silent for DEAD_MS is marked down
// (`host_link_down`, hosts.unreachable_since = the last time it was heard), else it is pinged. Each hello and
// ping pass records hosts.last_seen_at; the hello also records link_version, up_migration and code_rev (KTD15).
// Run as a script: `bun bin/link/server.ts <binds> <port>`; it exits 75 when a file under bin/link/ changes, so
// the loop restarts it on the new code (uncounted, like the board).
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket, Server } from "bun";
import { open, stateRoot, type Store } from "../loop/core/store.ts";
import { tailnetIp } from "../loop/io/tailnet.ts";
import { Challenges, nameProblem, parseJoinFrame, requestJoin, verifyHello } from "./host-keys.ts";
import { deadMs, JOIN_MAX_BYTES, LINK_VERSION, loadChannels, MAX_FRAME_BYTES, parseFrame, Peer, pingMs, REQUEST_TIMEOUT_MS, type Channel, type Frame } from "./protocol.ts";

export const socketPath = (root: string) => join(root, "link", "server.sock");

type Conn = { phase: "new" | "challenged" | "up" | "closing"; name: string; nonce: Buffer | null; peer: Peer | null; addr: string };
type WS = ServerWebSocket<Conn>;

export type LinkServer = {
  /** The TCP port the network listener bound (the asked one, or the one Bun chose for port 0). */
  port: number;
  socket: string;
  /** The hosts whose link is up now, by name. */
  links(): string[];
  /** Send one request to a linked host (what `POST /request` on the unix socket does). */
  request(host: string, ch: string, body: unknown, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
};

/** The bind addresses the link may listen on: loopback and this host's tailnet address (KTD2). */
export function allowedBind(addr: string): boolean {
  if (process.env.DS_LINK_BIND_ANY === "1") return true;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "localhost") return true;
  const t = tailnetIp();
  return !!t && addr === t;
}

/** Start the link server for state root `root`. Throws when a bind address is not allowed or nothing binds. */
export async function startLinkServer(opts: { root?: string; binds: string; port: number; store?: Store; channels?: Map<string, Channel> }): Promise<LinkServer> {
  const root = opts.root ?? stateRoot();
  const binds = opts.binds.split(/\s+/).filter(Boolean);
  const refused = binds.filter((b) => !allowedBind(b));
  if (!binds.length) throw new Error("link: no bind address");
  if (refused.length) throw new Error(`link: refusing to bind ${refused.join(", ")}: the link listens on loopback and the tailnet address only (DS_LINK_BIND_ANY=1 allows others)`);
  const store = opts.store ?? open(root);
  const ownStore = !opts.store;
  const channels = opts.channels ?? await loadChannels("main");
  const challenges = new Challenges();
  const live = new Map<string, WS>();
  const sec = () => Math.floor(Date.now() / 1000);

  const fact = (kind: string, payload: Record<string, unknown>) => { try { store.fact(kind, [], { payload }); } catch (e) { console.error(`link: ${kind}: ${(e as Error).message}`); } };
  const sendTo = (ws: WS, f: Frame) => { ws.send(JSON.stringify(f)); };
  const refuse = (ws: WS, why: string) => { ws.data.phase = "closing"; try { sendTo(ws, { t: "refused", why }); ws.close(1008, why.slice(0, 120)); } catch { /* gone */ } };
  const isLive = (ws: WS | undefined) => !!ws && ws.data.phase === "up" && !!ws.data.peer && Date.now() - ws.data.peer.lastHeard < deadMs();

  function hostUp(ws: WS, f: Frame): void {
    const name = ws.data.name;
    const at = sec();
    store.db.run("UPDATE hosts SET last_seen_at = ?, link_version = ?, up_migration = ?, code_rev = ?, unreachable_since = NULL WHERE name = ?",
      [at, String(f.link_version ?? ""), String(f.up_migration ?? "") || null, String(f.code_rev ?? "") || null, name]);
    ws.data.phase = "up";
    ws.data.peer = new Peer((fr) => sendTo(ws, fr), channels, { host: name, end: "main", root }, "m");
    live.set(name, ws);
    fact("host_link_up", { name, addr: ws.data.addr, link_version: String(f.link_version ?? ""), code_rev: String(f.code_rev ?? "") });
    sendTo(ws, { t: "welcome", host: name, link_version: LINK_VERSION });
  }

  async function onMessage(ws: WS, raw: string | Buffer): Promise<void> {
    const c = ws.data;
    if (c.phase === "closing") return;
    const f = parseFrame(raw, c.phase === "up" ? MAX_FRAME_BYTES : JOIN_MAX_BYTES);
    if ("bad" in f) { refuse(ws, f.bad); return; }
    if (c.phase === "up") {
      if (!(await c.peer!.onFrame(f))) refuse(ws, `unexpected frame '${f.t}'`);
      return;
    }
    if (c.phase === "new" && f.t === "join") {
      const j = parseJoinFrame(JSON.stringify({ name: f.name, public_key: f.public_key }));
      const r = j.ok ? requestJoin(store, j) : j;
      c.phase = "closing";
      sendTo(ws, r.ok ? { t: "joined", ok: true, name: r.name, fingerprint: r.fingerprint, created: r.created } : { t: "joined", ok: false, why: r.why });
      ws.close(1000, "join answered");
      return;
    }
    if (c.phase === "new" && f.t === "hello") {
      const bad = nameProblem(f.name);
      if (bad) { refuse(ws, bad); return; }
      c.name = String(f.name);
      c.nonce = challenges.issue(c.name);
      c.phase = "challenged";
      sendTo(ws, { t: "challenge", nonce: c.nonce.toString("base64") });
      return;
    }
    if (c.phase === "challenged" && f.t === "auth") {
      const nonce = c.nonce!;
      c.nonce = null;
      if (String(f.link_version ?? "") !== LINK_VERSION) {
        challenges.take(c.name, nonce);
        refuse(ws, `link version ${String(f.link_version ?? "?")} on ${c.name}, main speaks ${LINK_VERSION}: update dev-studio on the side host (git pull, then restart its loop)`);
        return;
      }
      const v = verifyHello(store, challenges, { name: c.name, nonce, linkVersion: String(f.link_version), signature: String(f.signature ?? "") });
      if (!v.ok) { refuse(ws, v.why); return; }
      const old = live.get(c.name);
      if (old && old !== ws && isLive(old)) {
        fact("host_link_refused", { name: c.name, addr: c.addr, why: "a live link for this host is already open" });
        refuse(ws, `host ${c.name} already has a live link`);
        return;
      }
      if (old && old !== ws) dropLink(old, "replaced by a new hello after it went silent", false);
      hostUp(ws, f);
      return;
    }
    refuse(ws, `unexpected frame '${f.t}' before the hello`);
  }

  // A link ends: its waiting requests fail, the map forgets it, and (when `down`) the host's unreachable clock starts.
  function dropLink(ws: WS, why: string, down: boolean, kind = "host_link_down"): void {
    const c = ws.data, name = c.name;
    const wasUp = c.phase === "up";
    c.phase = "closing";
    c.peer?.close(`link: ${why}`);
    if (live.get(name) === ws) live.delete(name);
    try { ws.close(1001, why.slice(0, 120)); } catch { /* gone */ }
    if (!wasUp) return;
    const heard = Math.floor((c.peer?.lastHeard ?? Date.now()) / 1000);
    if (down) store.db.run("UPDATE hosts SET last_seen_at = ?, unreachable_since = COALESCE(unreachable_since, ?) WHERE name = ?", [heard, heard, name]);
    fact(kind, { name, why });
  }

  // Every PING_MS: removed or no longer accepted → closed; silent for DEAD_MS → down; else last seen + a ping.
  const tick = setInterval(() => {
    const at = Date.now();
    for (const [name, ws] of [...live]) {
      const row = store.get("hosts", { name });
      if (!row || row.status !== "accepted") {
        try { sendTo(ws, { t: "refused", why: `host ${name} was removed on main` }); } catch { /* gone */ }
        dropLink(ws, `host ${name} is ${row?.status ?? "gone"}`, false, "host_link_closed");
        continue;
      }
      const p = ws.data.peer!;
      if (at - p.lastHeard >= deadMs()) { dropLink(ws, `silent for ${Math.round((at - p.lastHeard) / 1000)} s`, true); continue; }
      store.db.run("UPDATE hosts SET last_seen_at = ? WHERE name = ?", [Math.floor(p.lastHeard / 1000), name]);
      try { sendTo(ws, { t: "ping", at }); } catch { /* the close handler settles it */ }
    }
  }, pingMs());

  const websocket = {
    maxPayloadLength: MAX_FRAME_BYTES,
    idleTimeout: 0,
    sendPings: false,
    message(ws: WS, m: string | Buffer) { onMessage(ws, m).catch((e) => { console.error(`link: ${(e as Error).message}`); refuse(ws, "internal error"); }); },
    close(ws: WS) {
      const c = ws.data;
      if (c.phase === "up" && live.get(c.name) === ws) dropLink(ws, "the side closed the link", true);
      c.phase = "closing";
    },
  };
  const fetchTcp = (req: Request, srv: Server): Response | undefined => {
    const u = new URL(req.url);
    if (u.pathname === "/healthz") return Response.json({ ok: true, pid: process.pid, link_version: LINK_VERSION });
    if (u.pathname === "/link") {
      const addr = srv.requestIP(req)?.address ?? "";
      if (srv.upgrade(req, { data: { phase: "new", name: "", nonce: null, peer: null, addr } satisfies Conn })) return undefined;
      return new Response("a WebSocket upgrade is expected", { status: 426 });
    }
    return new Response("not found", { status: 404 });
  };

  const servers: Server[] = [];
  let port = opts.port;
  const errors: string[] = [];
  for (const hostname of binds) {
    try {
      const s = Bun.serve<Conn, never>({ hostname, port, fetch: fetchTcp, websocket, idleTimeout: 30 });
      servers.push(s);
      port = s.port;      // port 0: the rest bind the one Bun chose
    } catch (e) { errors.push(`${hostname}: ${(e as Error).message}`); }
  }
  if (!servers.length) { clearInterval(tick); if (ownStore) store.close(); throw new Error(`link: could not bind port ${opts.port} (${errors.join("; ")})`); }

  const request = async (host: string, ch: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> => {
    const ws = live.get(host);
    if (!ws || !isLive(ws)) throw new Error(`link: host ${host} is not linked`);
    return ws.data.peer!.request(ch, body, timeoutMs);
  };

  // The unix socket for processes on main.
  const sock = socketPath(root);
  mkdirSync(join(root, "link"), { recursive: true, mode: 0o700 });
  rmSync(sock, { force: true });
  const local = Bun.serve({
    unix: sock,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname === "/links") return Response.json({ ok: true, links: [...live.keys()].filter((h) => isLive(live.get(h))).sort() });
      if (req.method === "POST" && u.pathname === "/request") {
        let b: { host?: unknown; ch?: unknown; body?: unknown; timeout_ms?: unknown };
        try { b = await req.json() as typeof b; } catch { return Response.json({ ok: false, error: "the request is JSON" }, { status: 400 }); }
        if (typeof b.host !== "string" || typeof b.ch !== "string") return Response.json({ ok: false, error: "name host and ch" }, { status: 400 });
        try { return Response.json({ ok: true, body: await request(b.host, b.ch, b.body ?? null, Number(b.timeout_ms) || REQUEST_TIMEOUT_MS) }); }
        catch (e) { return Response.json({ ok: false, error: (e as Error).message }); }
      }
      return new Response("not found", { status: 404 });
    },
  });
  chmodSync(sock, 0o600);

  return {
    port,
    socket: sock,
    links: () => [...live.keys()].filter((h) => isLive(live.get(h))).sort(),
    request,
    async stop() {
      clearInterval(tick);
      for (const ws of [...live.values()]) { ws.data.peer?.close("link: main stopped"); ws.data.phase = "closing"; try { ws.close(1001, "main stopped"); } catch { /* gone */ } }
      live.clear();
      for (const s of servers) s.stop(true);
      local.stop(true);
      rmSync(sock, { force: true });
      if (ownStore) store.close();
    },
  };
}

/** Ask a linked host from any process on main, through the server's unix socket. Throws when the server is not
 *  running, the host is not linked or the host's handler failed. */
export async function linkRequest(root: string, host: string, ch: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const sock = socketPath(root);
  if (!existsSync(sock)) throw new Error("link: the link server is not running on main");
  const r = await fetch("http://link/request", { unix: sock, method: "POST", body: JSON.stringify({ host, ch, body, timeout_ms: timeoutMs }), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs + 5000) } as RequestInit);
  const j = await r.json() as { ok: boolean; body?: unknown; error?: string };
  if (!j.ok) throw new Error(j.error ?? "link: request failed");
  return j.body;
}

// The newest mtime of the files under bin/link/ (the code this process runs).
function codeStamp(dir = import.meta.dir): number {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) m = Math.max(m, codeStamp(p));
    else if (e.name.endsWith(".ts")) { try { m = Math.max(m, statSync(p).mtimeMs); } catch { /* removed meanwhile */ } }
  }
  return m;
}

if (import.meta.main) {
  const [binds = "127.0.0.1", portArg = ""] = process.argv.slice(2);
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) { console.error(`link: usage: server.ts <binds> <port> (port '${portArg}')`); process.exit(2); }
  let srv: LinkServer;
  try { srv = await startLinkServer({ binds, port }); }
  catch (e) { console.error((e as Error).message); process.exit(1); }
  console.log(`link: listening on ${binds.split(/\s+/).filter(Boolean).map((b) => `${b}:${srv.port}`).join(" ")}, local socket ${srv.socket} (pid ${process.pid})`);
  const stamp = codeStamp();
  setInterval(async () => {
    if (codeStamp() === stamp) return;
    console.log("link: code under bin/link changed, exiting 75 for the loop to restart on it");
    await srv.stop();
    process.exit(75);
  }, 5000);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, async () => { await srv.stop(); process.exit(0); });
}
