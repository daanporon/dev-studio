// protocol.ts — side-loop-host U2 (issue #127, KTD1): the link's frames and the request matcher both ends use.
// One WebSocket carries JSON text frames in both directions:
//   before the hello  side → main  {t:"join", name, public_key}         an unauthenticated join request (U1 caps)
//                     main → side  {t:"joined", ok, fingerprint?, why?}  then main closes
//                     side → main  {t:"hello", name}                     main answers {t:"challenge", nonce}
//                     side → main  {t:"auth", signature, link_version, up_migration, code_rev}
//                     main → side  {t:"welcome", host} | {t:"refused", why} (then main closes)
//   after the hello   both ways    {t:"ping", at} / {t:"pong", at}        every PING_MS; DEAD_MS of silence = down
//                     both ways    {t:"req", id, ch, body} / {t:"res", id, ok, body?, error?}
// A frame before the hello is at most JOIN_MAX_BYTES (U1); after it at most MAX_FRAME_BYTES. A request names a
// channel (bin/link/channels/<name>.ts, KTD3); the answering end runs that channel's handler.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { JOIN_MAX_BYTES } from "./host-keys.ts";
import type { Store } from "../loop/core/store.ts";

export const LINK_VERSION = "1";
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export { JOIN_MAX_BYTES };

const envMs = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
/** How often each end pings (10 s); tests shorten it with DS_LINK_PING_MS. */
export const pingMs = () => envMs("DS_LINK_PING_MS", 10_000);
/** Silence after which an end calls the link down (30 s); DS_LINK_DEAD_MS. */
export const deadMs = () => envMs("DS_LINK_DEAD_MS", 30_000);
/** How long a request waits for its answer by default (30 s). */
export const REQUEST_TIMEOUT_MS = 30_000;

export type Frame = { t: string; [k: string]: unknown };

/** A frame off the wire: refused over `max` bytes before it is parsed, else the object with a string `t`. */
export function parseFrame(raw: string | Buffer | ArrayBuffer | Uint8Array, max: number): Frame | { bad: string } {
  const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
  if (Buffer.byteLength(text) > max) return { bad: `a frame is at most ${max} bytes here` };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { bad: "a frame is JSON" }; }
  if (!v || typeof v !== "object" || typeof (v as Frame).t !== "string") return { bad: "a frame has a type" };
  return v as Frame;
}

// ---------------------------------------------------------------- channels (KTD3)

/** What a channel handler gets: the host at the other end of the link, the end it runs on, and that end's store when it has one open. */
export type ChannelCtx = { host: string; end: "main" | "side"; root: string; store?: Store };
export type Channel = {
  name: string;
  /** The end(s) that answer this channel; the other end only sends on it. */
  answers: "main" | "side" | "both";
  handle(body: unknown, ctx: ChannelCtx): unknown | Promise<unknown>;
};

const CHANNEL_DIR = join(import.meta.dir, "channels");
const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Every channel file under bin/link/channels/ that answers on `end`, by name (`dir` for tests). */
export async function loadChannels(end: "main" | "side", dir = CHANNEL_DIR): Promise<Map<string, Channel>> {
  const out = new Map<string, Channel>();
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort(); } catch { return out; }
  for (const f of files) {
    const c = (await import(join(dir, f))).default as Channel | undefined;
    if (!c || typeof c.handle !== "function" || c.name !== f.slice(0, -3) || !NAME_RE.test(c.name)) {
      throw new Error(`link: ${f} is not a channel (default export {name: "${f.slice(0, -3)}", answers, handle})`);
    }
    if (c.answers === end || c.answers === "both") out.set(c.name, c);
  }
  return out;
}

// ---------------------------------------------------------------- one end of an authenticated link

/** Requests in flight and the answers to the other end's requests, over one send function. */
export class Peer {
  private next = 1;
  private waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  lastHeard = Date.now();

  constructor(private send: (f: Frame) => void, private channels: Map<string, Channel>, private ctx: ChannelCtx, private prefix = "") {}

  /** Ask the other end: resolves with its answer's body, rejects with its error, a timeout or the link closing. */
  request(ch: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = `${this.prefix}${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`link: no answer on ${ch} within ${timeoutMs} ms`)); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try { this.send({ t: "req", id, ch, body }); } catch (e) { clearTimeout(timer); this.waiting.delete(id); reject(e as Error); }
    });
  }

  /** A frame after the hello. Returns false for a frame type this class does not handle. */
  async onFrame(f: Frame): Promise<boolean> {
    this.lastHeard = Date.now();
    if (f.t === "ping") { this.send({ t: "pong", at: f.at ?? null }); return true; }
    if (f.t === "pong") return true;
    if (f.t === "res") {
      const w = this.waiting.get(String(f.id));
      if (!w) return true;                     // late: its request timed out
      this.waiting.delete(String(f.id));
      clearTimeout(w.timer);
      if (f.ok) w.resolve(f.body); else w.reject(new Error(String(f.error ?? "link: the other end failed")));
      return true;
    }
    if (f.t === "req") {
      const id = String(f.id ?? ""), ch = this.channels.get(String(f.ch));
      if (!ch) { this.send({ t: "res", id, ok: false, error: `link: no channel '${String(f.ch)}' on this end` }); return true; }
      try { this.send({ t: "res", id, ok: true, body: (await ch.handle(f.body, this.ctx)) ?? null }); }
      catch (e) { this.send({ t: "res", id, ok: false, error: (e as Error).message || String(e) }); }
      return true;
    }
    return false;
  }

  /** The link is gone: every request still waiting fails. */
  close(why = "link: closed"): void {
    for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(why)); this.waiting.delete(id); }
  }

  get pending(): number { return this.waiting.size; }
}
