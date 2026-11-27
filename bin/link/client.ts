// client.ts — side-loop-host U2 (issue #127, KTD1/KTD4): the side host's end of the link. The side dials out to
// main's link server (`ws://<main>:<link_port>/link`), says hello with its name, signs main's challenge with the
// private key in its own state root (`<root>/link/host.key`, U1 `ensureHostKey`; the key never travels) and,
// once welcomed, carries requests both ways (protocol.ts `Peer`). It pings every PING_MS and calls the link down
// after DEAD_MS without hearing main, the same half minute main uses, so both ends notice a loss together. With
// `reconnect` it dials again after a loss with a growing pause (1 s up to 30 s); a refusal (not accepted, removed,
// a second link, a wrong version) is kept in `refusal` and also retried, since the operator may accept the host
// later. `sendJoin` is the one-shot join request (U12's `ds join` calls it). Main proves nothing to the side and
// the link adds no encryption (KTD4), so every dial goes through `dialUrl`: plain ws only to loopback or a
// tailnet address (DS_LINK_ANY_MAIN=1 lifts that, as DS_LINK_BIND_ANY does for the server's binds).
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { ROOT } from "../loop/core/store.ts";
import { ensureHostKey, hostKeyPath, signHello } from "./host-keys.ts";
import { UP_MIGRATION } from "./replica.ts";
import { deadMs, LINK_VERSION, loadChannels, MAX_FRAME_BYTES, parseFrame, Peer, pingMs, REQUEST_TIMEOUT_MS, type Channel, type Frame } from "./protocol.ts";

export type LinkState = "connecting" | "up" | "down" | "refused" | "stopped";

/** `http://h:p`, `ws://h:p` or `h:p` → the link's WebSocket URL `ws://h:p/link`. */
export function linkUrl(main: string): string {
  let u = main.trim();
  if (!/^[a-z]+:\/\//.test(u)) u = `ws://${u}`;
  const url = new URL(u.replace(/^http/, "ws"));
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/link";
  return url.toString();
}

/** Loopback, or a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function privateAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return v4[1] === "127" || (v4[1] === "100" && Number(v4[2]) >= 64 && Number(v4[2]) <= 127);
  return ip === "::1" || ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export class DialRefused extends Error {}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const resolveAll: Resolve = (host) => lookup(host, { all: true });

/** The URL to open for `main`, resolved on every dial. wss is TLS's to vouch for. A ws URL comes back with the
 *  checked address in place of the name, so the socket cannot resolve it to another one. */
export async function dialUrl(main: string, resolve: Resolve = resolveAll): Promise<string> {
  const url = new URL(linkUrl(main));
  if (url.protocol === "wss:" || process.env.DS_LINK_ANY_MAIN === "1") return url.toString();
  let found: Awaited<ReturnType<Resolve>> = [];
  try { found = await resolve(url.hostname.replace(/^\[|\]$/g, "")); } catch { /* said below */ }
  if (!found.length) throw new Error(`link: cannot reach ${main} (its name does not resolve)`);
  const open = found.find((a) => !privateAddress(a.address));
  if (open) throw new DialRefused(`link: refusing to dial ${main} over plain ws: it resolves to ${open.address}, not loopback or a tailnet address, and nothing would prove it is main. Use main's tailnet name or address, or an https url`);
  const pick = found.find((a) => a.family === 4) ?? found[0];
  url.hostname = pick.family === 6 ? `[${pick.address}]` : pick.address;
  return url.toString();
}

/** The newest migration that changed an up-table (KTD15's `up_migration`, replica.ts). */
export const newestMigration = (): string => UP_MIGRATION;

/** This checkout's commit, short; empty when git cannot say. */
export function codeRev(): string {
  try {
    const r = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short=12", "HEAD"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch { return ""; }
}

/** One join request: resolves with main's answer ({ok, fingerprint} or {ok:false, why}); rejects when main is unreachable. */
export async function sendJoin(main: string, name: string, publicKey: string, timeoutMs = 10_000): Promise<{ ok: true; fingerprint: string; created: boolean } | { ok: false; why: string }> {
  const url = await dialUrl(main);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* gone */ } reject(new Error(`link: no answer from ${main} within ${timeoutMs} ms`)); }, timeoutMs);
    let done = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, public_key: publicKey }));
    ws.onmessage = (ev) => {
      const f = parseFrame(String(ev.data), 64 * 1024);
      if ("bad" in f) return;
      done = true;
      clearTimeout(timer);
      if (f.t === "joined" && f.ok) resolve({ ok: true, fingerprint: String(f.fingerprint), created: !!f.created });
      else resolve({ ok: false, why: String(f.why ?? "main refused the join request") });
      try { ws.close(); } catch { /* gone */ }
    };
    ws.onerror = () => { if (!done) { clearTimeout(timer); reject(new Error(`link: cannot reach ${main}`)); } };
    ws.onclose = () => { if (!done) { clearTimeout(timer); reject(new Error(`link: ${main} closed before answering`)); } };
  });
}

export type LinkClientOpts = {
  main: string;
  /** The side state root (holds link/host.key). */
  root: string;
  name: string;
  channels?: Map<string, Channel>;
  reconnect?: boolean;
  onState?: (s: LinkState, why?: string) => void;
};

export class LinkClient {
  state: LinkState = "connecting";
  /** Main's last refusal line, if any. */
  refusal: string | null = null;
  private ws: WebSocket | null = null;
  private peer: Peer | null = null;
  /** When main was last heard on the current link (epoch ms), or null while not up. */
  get lastHeard(): number | null { return this.state === "up" ? this.peer?.lastHeard ?? null : null; }
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pause = 1000;
  private channels: Map<string, Channel> | null;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(private o: LinkClientOpts) { this.channels = o.channels ?? null; }

  /** Dial main. Resolves once welcomed; rejects on a refusal or a close before the welcome. */
  async start(): Promise<void> {
    if (!this.channels) this.channels = await loadChannels("side");
    ensureHostKey(this.o.root);
    const p = this.ready();
    this.dial();
    return p;
  }

  /** Resolves at the next welcome (at once while up), rejects at the next refusal or loss before it. */
  ready(): Promise<void> {
    if (this.state === "up") return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  request(ch: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.state !== "up" || !this.peer) return Promise.reject(new Error("link: main unreachable"));
    return this.peer.request(ch, body, timeoutMs);
  }

  stop(): void {
    this.set("stopped");
    if (this.retry) clearTimeout(this.retry);
    this.end("link: stopped");
    try { this.ws?.close(1000, "stopped"); } catch { /* gone */ }
  }

  private set(s: LinkState, why?: string): void {
    if (this.state === "stopped") return;
    this.state = s;
    this.o.onState?.(s, why);
    const w = this.waiters.splice(0);
    for (const x of w) s === "up" ? x.resolve() : s !== "connecting" ? x.reject(new Error(why ?? `link: ${s}`)) : this.waiters.push(x);
  }

  private end(why: string): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.peer?.close(why);
    this.peer = null;
  }

  private dial(): void {
    if (this.state === "stopped") return;
    this.set("connecting");
    this.refusal = null;   // a refusal from an earlier dial must not label a later unreachable main
    dialUrl(this.o.main).then(
      (url) => { if (this.state !== "stopped") this.open(url); },
      (e: Error) => { this.set(e instanceof DialRefused ? "refused" : "down", e.message); this.redial(); },
    );
  }

  private redial(): void {
    if (this.state === "stopped" || !this.o.reconnect) return;
    this.retry = setTimeout(() => this.dial(), this.pause);
    this.pause = Math.min(this.pause * 2, 30_000);
  }

  private open(url: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: this.o.name }));
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const f = parseFrame(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer), MAX_FRAME_BYTES);
      if ("bad" in f) { ws.close(1003, String(f.bad)); return; }
      if (f.t === "refused") { this.refusal = String(f.why ?? "refused"); return; }
      if (welcomed) { this.peer?.onFrame(f).then((known) => { if (!known) ws.close(1003, `unexpected frame '${f.t}'`); }); return; }
      if (f.t === "challenge") {
        const nonce = Buffer.from(String(f.nonce ?? ""), "base64");
        const key = readFileSync(hostKeyPath(this.o.root), "utf8");
        ws.send(JSON.stringify({ t: "auth", signature: signHello(key, nonce, LINK_VERSION, this.o.name), link_version: LINK_VERSION, up_migration: newestMigration(), code_rev: codeRev() } satisfies Frame));
        return;
      }
      if (f.t === "welcome") {
        welcomed = true;
        this.refusal = null;
        this.pause = 1000;
        this.peer = new Peer((fr) => ws.send(JSON.stringify(fr)), this.channels!, { host: "main", end: "side", root: this.o.root }, "s");
        this.timer = setInterval(() => this.beat(ws), pingMs());
        this.set("up");
        return;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.end("link: main unreachable");
      if (this.state === "stopped") return;
      if (this.refusal && !welcomed) this.set("refused", this.refusal);
      else this.set("down", this.refusal ?? "link: closed");
      this.redial();
    };
  }

  // Every PING_MS while up: DEAD_MS without hearing main calls the link down, else a ping.
  private beat(ws: WebSocket): void {
    const p = this.peer;
    if (!p || this.ws !== ws) return;
    if (Date.now() - p.lastHeard >= deadMs()) { try { ws.close(4000, "main silent"); } catch { /* gone */ } this.forceDown(ws); return; }
    try { ws.send(JSON.stringify({ t: "ping", at: Date.now() })); } catch { /* onclose settles it */ }
  }

  // A silent link may never deliver its close (the network is gone): settle it here once.
  private forceDown(ws: WebSocket): void {
    const close = ws.onclose;
    ws.onclose = null;
    if (close) close.call(ws, new CloseEvent("close"));
  }
}
