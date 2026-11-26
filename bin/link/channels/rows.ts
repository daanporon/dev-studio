// rows.ts — side-loop-host U6 (issue #127, KTD8): the replica channel. Main answers; the side drives it
// (replica.ts `RowSync`). `{op: "down"}` answers that host's down copy; `{op: "up", table, rows, gone, keys?}`
// applies one up-table's rows from that host and answers `{applied, dropped}`.
import { open, type Store } from "../../loop/core/store.ts";
import type { Channel } from "../protocol.ts";
import { applyUp, downManifest } from "../replica.ts";

const opened = new Map<string, Store>();
const storeFor = (root: string) => { let s = opened.get(root); if (!s) { s = open(root); opened.set(root, s); } return s; };

const rows: Channel = {
  name: "rows",
  answers: "main",
  handle(body, ctx) {
    const b = (body ?? {}) as { op?: unknown };
    const store = ctx.store ?? storeFor(ctx.root);
    if (b.op === "down") return downManifest(store, ctx.host);
    if (b.op === "up") return applyUp(store, ctx.host, b as Record<string, unknown>);
    throw new Error(`rows: unknown op '${String(b.op)}'`);
  },
};
export default rows;
