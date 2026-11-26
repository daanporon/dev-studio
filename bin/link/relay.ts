// relay.ts — side-loop-host U7 (issue #127, KTD5): the side host's half of a forwarded `bin/ds` call.
// A worker terminal on a side host gets DS_MAIN_URL=unix:<side state root>/loop/link.sock, so agents hold no key:
//   forwardDs (bin/ds.ts)  POSTs {id, argv, stdin, member, gen} to that socket and prints the answer as its own
//   startRelay (side loop) listens on the socket (mode 0600) and sends each call up the link on the `ds-call`
//                          channel, which main answers (channels/ds-call.ts).
// When the link drops mid-call the relay sends the same id again after the link is back, for up to
// resendMs (DS_LINK_RESEND_MS, default 60 s) from the first failure; main keeps each id's answer, so the call
// runs once. After that, or when the relay itself is gone, the caller gets "main unreachable" and exit code 75
// (EXIT.unreachable): nothing ran, try again.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EXIT, STDIN_MAX } from "./forward-table.ts";
import type { DsResult } from "./channels/ds-call.ts";

export const CHANNEL = "ds-call";
export const relaySocket = (root: string) => join(root, "loop", "link.sock");
/** The DS_MAIN_URL value a side host's worker terminals get. */
export const mainUrlFor = (root: string) => `unix:${relaySocket(root)}`;

const envMs = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
/** How long the relay keeps resending one call while the link is down (60 s). */
export const resendMs = () => envMs("DS_LINK_RESEND_MS", 60_000);
/** How long one try waits for main's answer while the link stays up (10 min: a `--wait` send may block). */
const TRY_MS = 10 * 60_000;
const RETRY_PAUSE_MS = 250;
const BODY_MAX = 2 * 1024 * 1024;

const unreachable = (why: string): DsResult => ({ code: EXIT.unreachable, stdout: "", stderr: `ds: main unreachable (${why}); nothing ran, try again\n` });

export type Requester = (ch: string, body: unknown, timeoutMs: number) => Promise<unknown>;

// A link failure is worth a resend; an error main raised while answering is not.
const linkFailure = (e: Error) => /^link: /.test(e.message) && !/no channel/.test(e.message);

/** Send one call up the link, resending the same id while the link is down, for up to resendMs from the first failure. */
export async function relayCall(request: Requester, body: Record<string, unknown>): Promise<DsResult> {
  let firstFail = 0;
  for (;;) {
    try {
      const r = (await request(CHANNEL, body, TRY_MS)) as DsResult;
      return { code: Number(r?.code ?? 1), stdout: String(r?.stdout ?? ""), stderr: String(r?.stderr ?? "") };
    } catch (e) {
      const err = e as Error;
      if (!linkFailure(err)) return { code: 1, stdout: "", stderr: `ds: main failed the call: ${err.message}\n` };
      firstFail ||= Date.now();
      if (Date.now() - firstFail >= resendMs()) return unreachable(err.message.replace(/^link: /, ""));
      await Bun.sleep(RETRY_PAUSE_MS);
    }
  }
}

export type Relay = { socket: string; stop(): void };

/** The side loop's relay socket: each POST /ds is one call, sent up through `request` (the LinkClient's). */
export function startRelay(root: string, request: Requester): Relay {
  const sock = relaySocket(root);
  mkdirSync(dirname(sock), { recursive: true });
  rmSync(sock, { force: true });
  const srv = Bun.serve({
    unix: sock,
    idleTimeout: 0,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/ds") return new Response("not found", { status: 404 });
      const text = await req.text();
      if (Buffer.byteLength(text) > BODY_MAX) return Response.json({ code: EXIT.refused, stdout: "", stderr: "ds: the call is too big to forward\n" });
      let b: Record<string, unknown>;
      try { b = JSON.parse(text); } catch { return Response.json({ code: 2, stdout: "", stderr: "ds: the relay takes JSON\n" }); }
      const body = { id: typeof b.id === "string" && b.id ? b.id : randomUUID(), argv: Array.isArray(b.argv) ? b.argv.map(String) : [],
        stdin: typeof b.stdin === "string" ? b.stdin.slice(0, STDIN_MAX) : "", member: String(b.member ?? ""), gen: String(b.gen ?? "") };
      return Response.json(await relayCall(request, body));
    },
  });
  chmodSync(sock, 0o600);
  return { socket: sock, stop() { try { srv.stop(true); } catch { /* stopped */ } rmSync(sock, { force: true }); } };
}

/** Stdin when it is a redirected file, up to STDIN_MAX; empty otherwise. A pipe or terminal is not read: an agent
 *  shell may leave one open that never ends, and no forwarded command reads stdin today. */
function readStdin(): string {
  try {
    if (!statSync("/dev/stdin").isFile()) return "";
    return readFileSync(0).subarray(0, STDIN_MAX).toString("utf8");
  } catch { return ""; }
}

/** bin/ds on a side host: hand argv to the relay at DS_MAIN_URL, print main's answer, return its exit code. */
export async function forwardDs(url: string, argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const out = (r: DsResult) => { if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); return r.code; };
  if (!url.startsWith("unix:")) return out({ code: 2, stdout: "", stderr: `ds: DS_MAIN_URL is unix:<socket>, not '${url}'\n` });
  const sock = url.slice(5);
  if (!existsSync(sock)) return out(unreachable("the side loop's relay is not running"));
  const body = { id: randomUUID(), argv, stdin: readStdin(), member: env.DS_MEMBER ?? "", gen: env.DS_GEN ?? "" };
  try {
    const r = await fetch("http://relay/ds", { unix: sock, method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } } as RequestInit);
    return out((await r.json()) as DsResult);
  } catch (e) {
    return out(unreachable(`the side loop's relay: ${(e as Error).message}`));
  }
}
