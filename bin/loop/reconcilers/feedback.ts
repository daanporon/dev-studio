// reconcilers/feedback.ts — host scope (ds-feedback-github-issues U2): starts the Studio's feedback drafter.
//
// While `feedback_repo` names a repo and notes are due (feedback/draft.ts dueNotes: `new`, not dismissed,
// not kept within DS_FEEDBACK_REDRAFT_S):
//   - with no leak word list (feedback/leak.ts hasWords): no pass; one Studio card on the first ticked
//     project (spell `feedback-words`, subject `feedback.words`, alert `sweep-feedback.words-<n>`) says to
//     add the list. The spell ends, and alertGone clears the card, once the list holds a word, the repo is
//     `-` again or no note is due.
//   - else one `feedback.draft` action (subject `feedback.draft`) for the oldest `feedback_draft_batch`
//     (20) due notes. One pass at a time: none while the last one is open; after a done pass the next
//     waits DS_FEEDBACK_EVERY_S (300) paced to the GitHub budget (github-budget.ts pace), after a failed
//     or dropped one DS_FEEDBACK_RETRY_S (1800). The episode is the notes' keys and the last pass's end,
//     so a replayed action is the same episode and a new batch a new one.
import { createHash } from "node:crypto";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { envInt } from "../core/tick.ts";
import { limitInt } from "../settings/limits.ts";
import { budgetOf, budgetShare, pace } from "../io/github-budget.ts";
import { dueNotes, feedbackRepo, hostProject } from "../feedback/draft.ts";
import { hasWords, wordsPath } from "../feedback/leak.ts";
import { alertAction } from "./alerts.ts";

export const SUBJECT = "feedback.draft";
export const WORDS_KEY = "feedback.words";
export const WORDS_KIND = "feedback-words";

function wordsCard(ctx: TickCtx, project: string, missing: boolean): Action[] {
  const { store, now } = ctx;
  const spell = { project, subject: WORDS_KEY, kind: WORDS_KIND };
  const ep = store.get("episodes", spell), open = !!ep && ep.ended_at == null;
  if (!missing) {
    if (open) store.upsert("episodes", spell, { state: "closed", ended_at: now, observed_at: now });
    return [];
  }
  const started = open ? Number(ep?.started_at ?? now) : now;
  if (!open) store.upsert("episodes", spell, { squad: null, started_at: started, ended_at: null, state: "missing", episode_key: String(started), source: "loop", observed_at: now });
  const title = "Feedback drafter needs the leak word list";
  return alertAction(store, { project, squad: null, key: WORDS_KEY, episode: `words|${started}`, idEpisode: `words|${started}`, title,
    text: `${title}: ds-feedback notes are waiting, but ${wordsPath()} is missing or empty, so the drafter makes no drafts (a draft is checked against it before it can be posted). Add the words that must never reach GitHub, one per line; the card clears once the list holds a word.`,
    option: "Seen", why: "feedback_repo is set and notes are due, but the leak word list is missing or empty" });
}

export function feedback(ctx: TickCtx): Action[] {
  const { store, now } = ctx;
  const project = hostProject(store);
  if (!project) return [];
  const repo = feedbackRepo(store);
  const batch = Math.min(100, Math.max(1, limitInt(store, "", "feedback_draft_batch", 20)));
  const notes = repo ? dueNotes(store, now, batch) : [];
  const words = notes.length ? hasWords() : true;
  const card = wordsCard(ctx, project, notes.length > 0 && !words);
  if (!notes.length || !words) return card;

  const last = store.get("episodes", { project: "", subject: SUBJECT, kind: `action:${SUBJECT}` });
  if (last && last.ended_at == null) return [];
  if (last) {
    const b = budgetOf(store);
    const gap = last.state === "done" ? pace(envInt("DS_FEEDBACK_EVERY_S", 300), b.cost, b.limit, budgetShare(store)) : envInt("DS_FEEDBACK_RETRY_S", 1800);
    if (now < Number(last.ended_at) + gap) return [];
  }
  const keys = notes.map((n) => String(n.key));
  const hash = createHash("sha1").update(`${repo}\0${keys.join(",")}`).digest("hex").slice(0, 12);
  return [{ project: "", squad: null, subject: SUBJECT, kind: SUBJECT, episode: `${hash}|${last?.ended_at ?? 0}`, payload: { repo, keys } }];
}

export default {
  name: "feedback",
  scope: "host",
  run(ctx: TickCtx) { return feedback(ctx); },
} satisfies Reconciler;
