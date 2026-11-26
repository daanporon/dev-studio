// channels/info.ts — side-loop-host U2: the smallest channel, answered on both ends. It names the end that
// answered, the host at the other end, the link version and the time, so a caller (and the tests) can
// prove a request gets its answer. Later units add one file each here (KTD3).
import type { Channel } from "../protocol.ts";
import { LINK_VERSION } from "../protocol.ts";

const info: Channel = {
  name: "info",
  answers: "both",
  handle(body, ctx) {
    return { end: ctx.end, peer: ctx.host, link_version: LINK_VERSION, at: Date.now(), echo: body ?? null };
  },
};
export default info;
