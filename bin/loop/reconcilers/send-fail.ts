// send-fail.ts — one Studio card when typing into a member fails SEND_FAIL_CARD times in a row
// (studio-chat-queued-busy U2). The streak is the `send-fail` episode (squad/send-fail.ts) that the chat
// fulfiller and the Studio branch of the poke fulfiller write; the card is `sweep-send-fail.<member>-<n>`,
// titled `Can't type into <member>: <last err>`, and alertGone clears it once the episode ends.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { alertAction } from "./alerts.ts";
import { SEND_FAIL, SEND_FAIL_CARD } from "../squad/send-fail.ts";

export function sendFail(ctx: TickCtx): Action[] {
  const { store, project } = ctx, out: Action[] = [];
  const rows = store.db.query("SELECT * FROM episodes WHERE project = ? AND kind = ? AND ended_at IS NULL AND count >= ?").all(project, SEND_FAIL, SEND_FAIL_CARD) as Record<string, unknown>[];
  for (const r of rows) {
    const member = String(r.subject).slice(`send-fail:${project}/`.length), err = String(r.state ?? "").trim() || "send failed";
    const episode = `send-fail|${member}|${r.started_at}`;
    out.push(...alertAction(store, { project, squad: null, key: `send-fail.${member}`, episode, idEpisode: episode,
      title: `Can't type into ${member}: ${err}`,
      text: `The last ${r.count} sends of a chat or message into ${member}'s terminal failed (${err}). The loop keeps retrying; the card clears on the next send that works.`,
      option: "ok — I'm looking", why: `${r.count} failed sends in a row (limit ${SEND_FAIL_CARD})` }));
  }
  return out;
}

export default {
  name: "send-fail",
  run(ctx: TickCtx) { return sendFail(ctx); },
} satisfies Reconciler;
