// free-port.ts — the board's port when the one it asks for is taken (board-empty-state-and-port U2).
// A port is held when binding it on any of the board's addresses fails with EADDRINUSE; any other
// bind error (an address that is not up, a privileged port) is the server's to report, not a reason
// to move. freePort walks from the asked port up to DS_BOARD_PORT_TRIES (20) ports further and
// returns the first one nobody holds and `skip` does not rule out (another scope's registered port, a
// port another start is probing). Both start paths call it: the loop's (fulfil/board.ts) and
// board.sh --serve-fg (bin/commands/board-ts.ts).
import { createServer } from "node:net";

export const portTries = (): number => {
  const n = Number(process.env.DS_BOARD_PORT_TRIES);
  return Number.isInteger(n) && n >= 0 ? n : 20;
};

// The last port freePort tries from `start`.
export const lastPort = (start: number, tries = portTries()): number => Math.min(65535, start + tries);

// True when another process listens on this address and port.
export function heldOn(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "EADDRINUSE"));
    s.listen({ host, port, exclusive: true }, () => s.close(() => done(false)));
  });
}

// True when the port is held on any of the space-separated bind addresses.
export async function held(port: number, binds: string): Promise<boolean> {
  for (const h of binds.split(/\s+/).filter(Boolean)) if (await heldOn(h, port)) return true;
  return false;
}

// The first port from `start` (at most `tries` further) that `skip` leaves and nobody holds, or null.
// `claim` runs before a port's probe and `release` after a held one, so two starts probing at once
// never pick the same port (the caller keeps what it claimed until its start settles).
export async function freePort(start: number, binds: string, o: {
  tries?: number; skip?: (port: number) => boolean; claim?: (port: number) => void; release?: (port: number) => void;
} = {}): Promise<number | null> {
  for (let p = start, last = lastPort(start, o.tries); p <= last; p++) {
    if (o.skip?.(p)) continue;
    o.claim?.(p);
    if (!(await held(p, binds))) return p;
    o.release?.(p);
  }
  return null;
}
