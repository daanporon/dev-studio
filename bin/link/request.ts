// request.ts — side-loop-host U4 (issue #127, KTD2): how any process on main asks a linked host, through the link
// server's unix socket (`<state root>/link/server.sock`, served by server.ts). Kept apart from server.ts so a
// role-side CLI call (bin/lib/contract-roles.ts) can reach a side host without loading the server, its store or
// its WebSocket code: this file imports only node:fs and node:path.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** How long a request waits for its answer by default (30 s); protocol.ts re-exports it. */
export const REQUEST_TIMEOUT_MS = 30_000;

export const socketPath = (root: string) => join(root, "link", "server.sock");

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
