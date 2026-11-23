// fulfil/feedback.ts — the operator's review of the feedback drafts and notes (ds-feedback-github-issues U3).
// One request per press (the board's Feedback panel, U4; `ds feedback dismiss|restore` from the shell):
//
//   feedback-post {draft}             post a draft in review: a new issue, or for an add-to draft a comment on its target
//   feedback-add-to {draft, target}   post it as a comment on issue #target instead (the draft turns add-to)
//   feedback-edit {draft, title?, body?}   new text for a draft in review, checked again
//   feedback-dismiss {draft} | {note} [why]   a draft and its drafted notes, or one note not yet filed
//   feedback-restore {note}           a dismissed note back to `new` (its old draft stays dismissed)
//
// A post refuses while `feedback_repo` is `-`, and runs tests/leak-guard.sh --text on the final title and
// body (bin/loop/feedback/post.ts): a hit marks the draft `blocked` and refuses with no GitHub call. Then
// the draft reads `posting` before the first call, so a replay after a crash looks first: it searches the
// repo's issues (or the target's comments) made since the draft for the body's `ds-key:<key>` line and
// takes the one it finds instead of posting again. A refusal for GitHub's rate limit waits for the reset
// (no try spent); any other failure is a retry, and a post given up puts the draft back in review.
// Filed, the draft keeps repo, issue and URL, and its drafted notes read `filed`.
import { failRequest, finishRequest, requestActions, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Action } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { isRateLimit } from "../io/github-budget.ts";
import { errOf } from "../io/orca.ts";
import { feedbackRepo, finalText, gh as realGh, isOut, leakCheck as realLeak, type Gh, type LeakCheck, type Posted } from "../feedback/post.ts";

export const FEEDBACK_KINDS = ["feedback-post", "feedback-add-to", "feedback-edit", "feedback-dismiss", "feedback-restore"];
const UNFILED = ["new", "drafted", "project-only", "already-fixed", "dismissed"];
// A post is found by its key among the issues made since its draft (less this much for clock skew).
const SKEW_S = 600;
const retryS = () => { const v = Number(process.env.DS_LOOP_FEEDBACK_RETRY_S); return Number.isFinite(v) && v > 0 ? v : 120; };

const draftOf = (s: Store, id: unknown) => (Number.isInteger(id) ? s.get("feedback_drafts", { id: Number(id) }) : null);
const noteOf = (s: Store, id: unknown) => (Number.isInteger(id) ? s.get("feedback_notes", { id: Number(id) }) : null);
const notesOf = (s: Store, draft: number, states: string[]) => (s.db.query(
  `SELECT id FROM feedback_notes WHERE draft_id = ? AND state IN (${states.map(() => "?").join(", ")}) ORDER BY id`).all(draft, ...states) as { id: number }[]).map((r) => r.id);
const draftRow = (id: number, set: Row) => ({ table: "feedback_drafts", key: { id }, set });
const noteRow = (id: number, set: Row) => ({ table: "feedback_notes", key: { id }, set });

/** Done, with the request finished as refused (the draft or note as it was). */
function refuse(x: Exec, a: Action, why: string): Result { failRequest(a, x, why); return { done: true, result: why }; }
function finish(x: Exec, a: Action, result: Record<string, unknown>, line: string): Result {
  finishRequest(x.store, a, { ok: true, ...result }, x.now);
  return { done: true, result: line };
}

export function feedback(opts: { gh?: Gh; leak?: LeakCheck } = {}): Fulfiller {
  const gh = opts.gh ?? realGh, leak = opts.leak ?? realLeak;
  const inFlight = new Set<number>();   // drafts a post of this process is sending

  function filed(x: Exec, a: Action, d: Row, repo: string, p: Posted, found: boolean): Result {
    const id = Number(d.id), notes = notesOf(x.store, id, ["drafted"]);
    x.store.fact("feedback_filed", [
      draftRow(id, { state: "filed", repo, issue: p.issue, url: p.url, leak: "ok", leak_why: null, updated_at: x.now }),
      ...notes.map((n) => noteRow(n, { state: "filed", updated_at: x.now })),
    ], { project: a.project || null, payload: { draft: id, repo, issue: p.issue, url: p.url, notes, found } });
    return finish(x, a, { draft: id, issue: p.issue, url: p.url, found }, `filed #${p.issue}${found ? " (found by its key)" : ""}`);
  }

  async function send(x: Exec, a: Action, d: Row, repo: string, title: string | null, body: string): Promise<Result> {
    const id = Number(d.id), key = String(d.key), on = d.kind === "add-to" ? Number(d.target) : null;
    const failed = async (o: { code: number; out: string; err: string }, what: string): Promise<Result> => {
      const why = errOf(o, what);
      if (isRateLimit(`${o.err}\n${o.out}`)) return { wait: `rate limited, waiting for GitHub's reset: ${why}`, at: (await gh.resetAt(x.now)) ?? x.now + retryS() };
      return { retry: why };
    };
    const hit = await gh.find(repo, key, Number(d.created_at) - SKEW_S, on);
    if (isOut(hit)) return failed(hit, "gh api (find the post by its key)");
    if (hit) return filed(x, a, d, repo, hit, true);
    const p = on == null ? await gh.create(repo, title ?? "", body) : await gh.comment(repo, on, body);
    if (isOut(p)) return failed(p, on == null ? "gh api (create the issue)" : `gh api (comment on #${on})`);
    return filed(x, a, d, repo, p, false);
  }

  async function post(a: Action, x: Exec, target: number | null): Promise<Result> {
    const s = x.store, p = payloadOf<"feedback-post">(a);
    let d = draftOf(s, p.draft);
    if (!d) return refuse(x, a, `no feedback draft ${p.draft}`);
    const id = Number(d.id);
    if (d.state === "filed") return finish(x, a, { draft: id, issue: d.issue, url: d.url, already: true }, `already filed #${d.issue}`);
    if (d.state !== "review" && d.state !== "posting") return refuse(x, a, `draft ${id} is ${d.state}, not in review`);
    if (target !== null && (!Number.isInteger(target) || target < 1)) return refuse(x, a, `add to #${target}: not an issue number`);
    if (d.state === "posting" && target !== null && (d.kind !== "add-to" || Number(d.target) !== target))
      return refuse(x, a, `draft ${id} is being posted ${d.kind === "add-to" ? `to #${d.target}` : "as a new issue"}`);
    if (target === null && d.kind === "add-to" && !(Number(d.target) > 0)) return refuse(x, a, `draft ${id} is an add-to with no issue number: use Add to #N`);
    if (target === null && d.kind === "issue" && !String(d.title ?? "").trim()) return refuse(x, a, `draft ${id} has no title`);
    const repo = feedbackRepo(s);
    if (!repo) return refuse(x, a, "feedback_repo is - (posting is off): name the repo in Settings first");
    if (inFlight.has(id)) return { wait: `draft ${id} is being posted by another request`, at: x.now + 30 };
    const out = target !== null ? { ...d, kind: "add-to", target } : d;
    const { title, body } = finalText(out);
    const l = await leak(title, body);
    if (l.leak === "blocked") {
      // A draft a replay finds posting goes back to review too, so it can be edited and posted again
      // (that post still looks for its key before it creates anything).
      s.fact("feedback_edited", [draftRow(id, { state: "review", leak: "blocked", leak_why: l.why, updated_at: x.now })], { project: a.project || null, payload: { draft: id, leak: "blocked" } });
      return refuse(x, a, `leak check: ${l.why}`);
    }
    if (d.state === "review") {
      s.fact("feedback_posting", [draftRow(id, { state: "posting", kind: out.kind, target: out.kind === "add-to" ? out.target : null, leak: "ok", leak_why: null, updated_at: x.now })],
        { project: a.project || null, payload: { draft: id, repo, kind: String(out.kind), ...(out.kind === "add-to" ? { target: Number(out.target) } : {}) } });
      d = draftOf(s, id) as Row;
    }
    inFlight.add(id);
    const sent = send(x, a, d, repo, title, body).finally(() => inFlight.delete(id));
    return { background: sent };
  }

  async function edit(a: Action, x: Exec): Promise<Result> {
    const s = x.store, p = payloadOf<"feedback-edit">(a);
    const d = draftOf(s, p.draft);
    if (!d) return refuse(x, a, `no feedback draft ${p.draft}`);
    const id = Number(d.id);
    if (d.state !== "review") return refuse(x, a, `draft ${id} is ${d.state}: only a draft in review can be edited`);
    if (p.title === undefined && p.body === undefined) return refuse(x, a, "an edit needs a title or a body");
    if (p.title !== undefined && d.kind === "add-to") return refuse(x, a, `draft ${id} is a comment on #${d.target}: it has no title`);
    if (p.title !== undefined && !p.title.trim()) return refuse(x, a, "the title is empty");
    if (p.body !== undefined && !p.body.trim()) return refuse(x, a, "the body is empty");
    const next = { ...d, ...(p.title !== undefined ? { title: p.title.trim() } : {}), ...(p.body !== undefined ? { body: p.body } : {}) };
    const { title, body } = finalText(next);
    const l = await leak(title, body);
    s.fact("feedback_edited", [draftRow(id, {
      ...(p.title !== undefined ? { title: next.title } : {}), ...(p.body !== undefined ? { body: next.body } : {}),
      leak: l.leak, leak_why: l.why, updated_at: x.now,
    })], { project: a.project || null, payload: { draft: id, leak: l.leak } });
    return finish(x, a, { draft: id, leak: l.leak, ...(l.why ? { leak_why: l.why } : {}) }, `draft ${id} edited, leak check ${l.leak}`);
  }

  function dismiss(a: Action, x: Exec): Result {
    const s = x.store, p = payloadOf<"feedback-dismiss">(a);
    const why = p.why?.trim() || null;
    if ((p.draft == null) === (p.note == null)) return refuse(x, a, "a dismiss names one draft or one note");
    if (p.draft != null) {
      const d = draftOf(s, p.draft);
      if (!d) return refuse(x, a, `no feedback draft ${p.draft}`);
      const id = Number(d.id);
      if (d.state === "dismissed") return finish(x, a, { draft: id, notes: [], already: true }, `draft ${id} already dismissed`);
      if (d.state !== "review") return refuse(x, a, `draft ${id} is ${d.state}: only a draft in review can be dismissed`);
      const notes = notesOf(s, id, ["drafted"]);
      s.fact("feedback_dismissed", [
        draftRow(id, { state: "dismissed", reason: why, updated_at: x.now }),
        ...notes.map((n) => noteRow(n, { state: "dismissed", reason: why, updated_at: x.now })),
      ], { project: a.project || null, payload: { draft: id, notes, why } });
      return finish(x, a, { draft: id, notes }, `draft ${id} dismissed with ${notes.length} note(s)`);
    }
    const n = noteOf(s, p.note);
    if (!n) return refuse(x, a, `no feedback note ${p.note}`);
    const id = Number(n.id);
    if (n.state === "dismissed") return finish(x, a, { note: id, notes: [], already: true }, `note ${id} already dismissed`);
    if (!UNFILED.includes(String(n.state))) return refuse(x, a, `note ${id} is ${n.state}: a filed note cannot be dismissed`);
    s.fact("feedback_dismissed", [noteRow(id, { state: "dismissed", reason: why, updated_at: x.now })],
      { project: a.project || null, payload: { notes: [id], why } });
    return finish(x, a, { note: id, notes: [id] }, `note ${id} dismissed`);
  }

  function restore(a: Action, x: Exec): Result {
    const s = x.store, p = payloadOf<"feedback-restore">(a);
    const n = noteOf(s, p.note);
    if (!n) return refuse(x, a, `no feedback note ${p.note}`);
    const id = Number(n.id);
    if (n.state !== "dismissed") return refuse(x, a, `note ${id} is ${n.state}, not dismissed`);
    // Back to new with no draft: the drafter takes it up again; its old draft stays as it is.
    s.fact("feedback_restored", [noteRow(id, { state: "new", reason: null, draft_id: null, updated_at: x.now })],
      { project: a.project || null, payload: { note: id } });
    return finish(x, a, { note: id }, `note ${id} back to new`);
  }

  return {
    name: "feedback",
    scope: "host",
    kinds: FEEDBACK_KINDS,
    run: (ctx) => requestActions(ctx, FEEDBACK_KINDS),
    exec(a, x) {
      switch (a.kind) {
        case "feedback-post": return post(a, x, null);
        case "feedback-add-to": return post(a, x, Number(payloadOf<"feedback-add-to">(a).target));
        case "feedback-edit": return edit(a, x);
        case "feedback-dismiss": return dismiss(a, x);
        case "feedback-restore": return restore(a, x);
        default: return { failed: `feedback: unknown kind ${a.kind}` };
      }
    },
    // Given up: the request fails, and a draft left posting goes back to review (a later post finds by key first).
    giveUp(a, x, why) {
      const id = (a.payload as { draft?: number } | undefined)?.draft;
      const d = draftOf(x.store, id);
      if (d?.state === "posting" && (a.kind === "feedback-post" || a.kind === "feedback-add-to"))
        x.store.fact("feedback_edited", [draftRow(Number(d.id), { state: "review", updated_at: x.now })], { project: a.project || null, payload: { draft: Number(d.id), leak: String(d.leak) } });
      return failRequest(a, x, why);
    },
  };
}

export default feedback();
