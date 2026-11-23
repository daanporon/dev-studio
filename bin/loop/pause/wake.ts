// wake.ts — the one way the loop pokes a member (R16): every reconciler calls wake(), so the rules
// below hold for all of them by construction (Bun).
//
//   wake(ctx, wt, text, reason, episode) -> { status, actions }   the caller returns `actions`
//
// In order, a poke is skipped when
//   skipped:limited   members.limited_until is in the future (U8 fills it) or the screen shows a
//                     limit notice (sweep-required U16); opts.allowLimited lifts both for the
//                     limit-recovery pokes, which exist to poke limited members
//   skipped:all_done  the reason is a PR or ready poke (`pr…`, `ready…`) and the squad is all done
//   skipped:busy      the member is not idle or done, a limit dialog is on its screen (in its limit
//                     row, or in its tail: an expired dialog has no row), or its state cannot be
//                     read (no member row, no observed worker); opts.allowWorking lets
//                     a `working` member through: the quiet nudge that asks it if it is stuck, and
//                     (U148) the lifecycle's pr-stale / pr-news pokes to a Claude Builder, which
//                     hears them at its next step; a limit dialog still skips them
//   skipped:tick      it was already poked this tick
//   skipped:capped    the episode used its DS_LOOP_POKE_CAP attempts (default 5)
//   skipped:backoff   the last attempt's gap has not run out
// Attempts count in the episode's row (kind `wake:<reason>`, keyed by `episode`; a new episode
// starts over). Attempt n waits DS_LOOP_POKE_GAP_S·2^(n-1) seconds (default 60) for an answer; the
// call after the last attempt's gap marks the episode `capped` and returns one Studio alert.
// opts.cap / opts.gapS replace the cap and the doubling gap with a fixed one (the limit pokes).
// opts.handle (U263, the Studio): `member` is the Studio's worktree and the poke goes to that one
// terminal handle. The member is the `_studio` row holding that handle; its idleness is the caller's
// studioReady(), not observed_workers (the worktree's state may be a ds-loop pane's), and the limit
// dialog is looked for on that handle's own screen. The action's payload carries the handle.
// opts.payload adds fields to the poke's payload (U45: the message ids the poke delivers).
import { memberIn } from "../messages/cards.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { dialog, WINDOW } from "../capacity/fingerprints.ts";
import { paused } from "./pause.ts";
import { stopping } from "../squad/cancel.ts";
import { allDone as allDoneIn } from "../squad/retest.ts";
import { STUDIO_SQUAD } from "../squad/studio.ts";

export type WakeStatus = "sent" | "skipped:gone" | "skipped:paused" | "skipped:limited" | "skipped:all_done" | "skipped:busy" | "skipped:tick" | "skipped:capped" | "skipped:backoff";
export type Wake = { status: WakeStatus; actions: Action[] };

export const pokeCap = () => envInt("DS_LOOP_POKE_CAP", 5);
export const pokeGap = () => envInt("DS_LOOP_POKE_GAP_S", 60);

// The pokes sweep-required U16 keeps away from an all-done squad: stale PR and ready-unit pokes.
export function informational(reason: string): boolean { return /^(pr|ready)([-:]|$)/.test(reason); }

// The one all-done rule (U238, retest.ts), shared with the lifecycle's all-done nudge and the board.
export function allDone(store: Store, project: string, squad: string, at = Math.floor(Date.now() / 1000)): boolean { return allDoneIn(store.db, project, squad, at); }

export const POKE_UNANSWERED = "poke_unanswered";
// What a poke of this reason asked for, in words for the operator.
export function pokeAsk(reason: string): string {
  const ask: Record<string, string> = {
    "all-done": "The poke was the loop asking the Lead to wrap up, because every unit looked done.",
    parked: "The poke was the loop asking the Lead to ask the operator once what to do with the squad's held units.",
    "retest-due": "The poke was the loop asking the Lead to request the retest, because the fixes since the last test pass are merged.",
    compact: "The poke asked it to compact its context.",
    reload: "The poke asked it to re-read its instructions and confirm with ds reload ack.",
    limit: "The poke told it its usage limit had passed.",
    "credits-ok": "The poke told it its account works again.",
    held: "The poke told it a held message was waiting.",
    msg: "The poke told it a message was waiting in its ds msg inbox.",
    ready: "The poke told it a unit was ready to start.",
    "stop-checkpoint": "The poke asked it to write a journal checkpoint before a planned restart.",
    "archive-debrief": "The poke asked the Lead to write the final debrief before its squad archives.",
  };
  return ask[reason] ?? (reason.startsWith("pr") ? "The poke told it about a change on its PR." : `The poke was a "${reason}" nudge from the loop.`);
}
export function wake(ctx: TickCtx, member: string, text: string, reason: string, episode: string, opts: { allowLimited?: boolean; allowWorking?: boolean; cap?: number; gapS?: number; handle?: string; payload?: Record<string, unknown> } = {}): Wake {
  const { store, now: t } = ctx;
  const skip = (status: WakeStatus): Wake => ({ status, actions: [] });
  const m = (opts.handle
    ? store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? AND handle = ? ORDER BY id DESC").get(ctx.project, STUDIO_SQUAD, member, opts.handle)
    : store.db.query("SELECT * FROM members WHERE wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC").get(member)) as Row | null;
  if (stopping(store, String(m?.project ?? ctx.project), member)) return skip("skipped:gone");
  if (m && paused(store, m as { project: string })) return skip("skipped:paused");
  const w = !m ? null : opts.handle
    ? store.db.query("SELECT 'idle' AS state, NULL AS limited, tail FROM observed_terminals WHERE project = ? AND handle = ? AND gone_at IS NULL").get(String(m.project), opts.handle) as Row | null
    : store.db.query("SELECT state, limited, tail FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(String(m.project), member) as Row | null;
  // observed_workers.limited is the backend's limit row without the wt: <reset>\t<notice>[\tdialog].
  const limit = w?.limited ? String(w.limited) : "";
  if (!opts.allowLimited && (Number(m?.limited_until ?? 0) > t || limit !== "")) return skip("skipped:limited");
  if (m && informational(reason) && allDone(store, String(m.project), String(m.squad))) return skip("skipped:all_done");
  if (!m || !w || ![...["idle", "done"], ...(opts.allowWorking ? ["working"] : [])].includes(String(w.state)) || limit.split("\t").includes("dialog")
    || dialog(String(w.tail ?? "").replace(/\n$/, "").split("\n").slice(-WINDOW))) return skip("skipped:busy");
  if (ctx.poked.has(member)) return skip("skipped:tick");

  const project = String(m.project), squad = String(m.squad);
  const key = { project, subject: member, kind: `wake:${reason}` };
  return store.tx(() => {
    const ep = store.get("episodes", key);
    const fresh = !ep || ep.episode_key !== episode;
    const count = fresh ? 0 : Number(ep.count ?? 0);
    if (!fresh && ep.state === "capped") return skip("skipped:capped");
    if (!fresh && Number(ep.next_at ?? 0) > t) return skip("skipped:backoff");
    if (count >= (opts.cap ?? pokeCap())) {
      store.upsert("episodes", key, { state: "capped", ended_at: t, next_at: null, observed_at: t });
      return {
        status: "skipped:capped", actions: [{
          project, squad, member, subject: member, kind: "alert", episode: `poke-capped:${reason}:${episode}`,
          payload: reason === "all-done"
            ? { title: "Wrap-up stalled: Lead did not answer", card: POKE_UNANSWERED, reason, episode,
              fields: { pokeEpisode: episode, act: { action: "close", topic: squad, label: "Close squad" } },
              text: `Every unit of ${squad} is done or cancelled and nothing is held. The loop asked its Lead ${count} times to do the test check, write the debrief and mark it done, and got no answer. ` +
                `If ${squad} is finished, press Close squad; if more work is coming, give its Lead the next task.`,
              option: "looked at it", why: "the loop stopped poking it" }
            : { title: "Poke unanswered", card: POKE_UNANSWERED, reason, episode, fields: { pokeEpisode: episode },
              text: `${count} pokes went unanswered; the loop stopped poking ${memberIn(store, project, member, squad)}. ${pokeAsk(reason)} ` +
                "What you can do: its Lead can look at it; this note goes when the agent answers.",
              option: "looked at it", why: "the loop stopped poking it" },
        }],
      } satisfies Wake;
    }
    const n = count + 1;
    store.upsert("episodes", key, { squad, episode_key: episode, count: n, state: "poking", next_at: t + (opts.gapS ?? pokeGap() * 2 ** (n - 1)), source: "loop", observed_at: t,
      ...(fresh ? { started_at: t, ended_at: null } : {}) });
    ctx.poked.add(member);
    return { status: "sent", actions: [{ project, squad, member, subject: member, kind: "poke", episode: `${reason}:${episode}#${n}`, payload: { ...opts.payload, text, reason, attempt: n, ...(opts.handle ? { handle: opts.handle } : {}) } }] } satisfies Wake;
  });
}
