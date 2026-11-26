// channels/ds-call.ts — side-loop-host U7 (issue #127, KTD5): main runs a side host worker's forwarded `bin/ds`
// call. The body is `{id, argv, stdin?, member, gen}` from the side relay (relay.ts); main checks it
// (forward-table.ts checkCall), runs the real `bin/ds` with the member row's identity (DS_MEMBER, DS_GEN, DS_WT)
// against main's state root, and answers `{code, stdout, stderr}`. A refusal is an answer too, with its own exit
// code and line, and runs nothing. Each request id's answer is kept for RESULT_KEEP_MS: a resent id (its answer was
// lost on a dropped link) gets the same answer, and one still running is awaited, so a call runs once on main.
import { join } from "node:path";
import { open, ROOT, type Store } from "../../loop/core/store.ts";
import type { Channel } from "../protocol.ts";
import { checkCall, STDIN_MAX } from "../forward-table.ts";

export const RESULT_KEEP_MS = 10 * 60_000;
export const OUTPUT_MAX = 1024 * 1024;

export type DsResult = { code: number; stdout: string; stderr: string };

const kept = new Map<string, { at: number; result: Promise<DsResult> }>();

const opened = new Map<string, Store>();
const storeFor = (root: string) => { let s = opened.get(root); if (!s) { s = open(root); opened.set(root, s); } return s; };

// The environment main runs a forwarded call with: main's own, minus any identity of main's process, plus the member's.
const DROP = ["DS_MEMBER", "DS_GEN", "DS_WT", "DS_MAIN_URL", "ORCA_TERMINAL_HANDLE", "CLAUDE_PROJECT_DIR", "DS_START_MEMBER", "DS_START_GEN"];

const cut = (t: string) => (Buffer.byteLength(t) > OUTPUT_MAX ? `${Buffer.from(t).subarray(0, OUTPUT_MAX).toString("utf8")}\n[ds: output cut at ${OUTPUT_MAX} bytes]\n` : t);

async function runDs(root: string, argv: string[], identity: Record<string, string>, stdin: string): Promise<DsResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.includes(k)) env[k] = v;
  Object.assign(env, identity, { DS_STATE_ROOT: root, DS_LINK_FORWARDED: "1" });
  const p = Bun.spawn([process.execPath, join(ROOT, "bin", "ds.ts"), ...argv], { cwd: root, env, stdin: stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (stdin && p.stdin) { p.stdin.write(stdin); p.stdin.end(); }
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout: cut(stdout), stderr: cut(stderr) };
}

/** One forwarded call from `host`: the stored answer for a known id, else checked and run once. */
export function dsCall(store: Store, root: string, host: string, body: unknown): Promise<DsResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  const now = Date.now();
  for (const [k, v] of kept) if (now - v.at > RESULT_KEEP_MS) kept.delete(k);
  const key = `${host}\0${id}`;
  const had = id ? kept.get(key) : undefined;
  if (had) return had.result;
  const argv = Array.isArray(b.argv) ? b.argv.map(String) : [];
  const stdin = typeof b.stdin === "string" ? b.stdin.slice(0, STDIN_MAX) : "";
  const c = checkCall(store, host, { argv, member: String(b.member ?? ""), gen: String(b.gen ?? "") });
  const result: Promise<DsResult> = c.ok
    ? runDs(root, argv, c.env, stdin).catch((e) => ({ code: 1, stdout: "", stderr: `ds: main could not run the call: ${(e as Error).message}\n` }))
    : Promise.resolve({ code: c.code, stdout: "", stderr: `ds: refused on main: ${c.why}\n` });
  if (id) kept.set(key, { at: now, result });
  return result;
}

const dsCallChannel: Channel = {
  name: "ds-call",
  answers: "main",
  handle: (body, ctx) => dsCall(ctx.store ?? storeFor(ctx.root), ctx.root, ctx.host, body),
};
export default dsCallChannel;
