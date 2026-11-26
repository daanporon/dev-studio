// channels/mirror.ts — side-loop-host U9 (issue #127, KTD14): main answers the side's read-only mirror of plans
// and notes (mirror.ts `MirrorSync`). `{op: "list"}` answers the files that host mirrors with their hashes;
// `{op: "read", path}` answers one of them. No op writes on main: nothing travels up.
import { open, type Store } from "../../loop/core/store.ts";
import type { Channel } from "../protocol.ts";
import { CHANNEL, mirrorList, mirrorRead } from "../mirror.ts";

const opened = new Map<string, Store>();
const storeFor = (root: string) => { let s = opened.get(root); if (!s) { s = open(root); opened.set(root, s); } return s; };

const mirror: Channel = {
  name: CHANNEL,
  answers: "main",
  handle(body, ctx) {
    const b = (body ?? {}) as { op?: unknown; path?: unknown };
    const store = ctx.store ?? storeFor(ctx.root);
    if (b.op === "list") return mirrorList(ctx.root, store, ctx.host);
    if (b.op === "read") return mirrorRead(ctx.root, store, ctx.host, b.path);
    throw new Error(`mirror: unknown op '${String(b.op)}'`);
  },
};
export default mirror;
