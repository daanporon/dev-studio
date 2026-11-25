// feedback/draft.ts — what the feedback reconciler and the drafter share (ds-feedback-github-issues U2).
//
//   (the repo itself comes from post.ts `feedbackRepo`, the one reader the board, drafter, observer and posts share)
//   hostProject(store)        the project the drafter's pick and the Studio card belong to: the first
//                             project the loop ticks (the drafter is host-level; any project's board shows it)
//   dueNotes(store, now, n)   the oldest `n` notes the drafter should see: from a project whose Feedback is on, `new`, and either never kept
//                             or kept longer than DS_FEEDBACK_REDRAFT_S (a day) ago. A dismissed note,
//                             or any other state, is never sent.
//   draftKey(...)             a draft's idempotency key (`fd:` + 16 hex): its kind, target and notes
//   writeVerdicts(...)        one transaction: the new drafts (a key already stored is kept as it is),
//                             each named note moved on only while it is still `new`, and one
//                             `feedback_drafted` event
//
// A stored draft body holds no marker: a post sends finalBody() (prompt.ts), and the leak check here
// ran on that final text with the title.
import { createHash } from "node:crypto";
import { FACTS, problem } from "../core/kinds.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { discoverProjects, loopProjects } from "../settings/projects.ts";
import type { Leak } from "./leak.ts";
import { feedbackProjects } from "./post.ts";
import type { Verdict } from "./prompt.ts";

export function hostProject(store: Store): string | null {
  return loopProjects(store.root)[0] ?? discoverProjects(store.root)[0] ?? null;
}

export const redraftS = () => envInt("DS_FEEDBACK_REDRAFT_S", 86_400);
const DUE = "state = 'new' AND (reason IS NULL OR updated_at <= ?)";

export function dueNotes(store: Store, now: number, n: number, keys?: string[]): Row[] {
  const on = feedbackProjects(store);
  if (!on.length) return [];
  const args: (string | number)[] = [now - redraftS(), ...on];
  let only = ` AND COALESCE(project, '') IN (${on.map(() => "?").join(", ")})`;
  if (keys) { only += ` AND key IN (${keys.map(() => "?").join(", ") || "NULL"})`; args.push(...keys); }
  return store.db.query(`SELECT * FROM feedback_notes WHERE ${DUE}${only} ORDER BY at, id LIMIT ?`).all(...args, n) as Row[];
}

export function draftKey(kind: string, notes: string[], target: number | null): string {
  const h = createHash("sha1").update(`${kind}\0${target ?? ""}\0${[...notes].sort().join(",")}`).digest("hex");
  return `fd:${h.slice(0, 16)}`;
}

export type Checked = Verdict & { key?: string; leak?: Leak };
export type Written = { notes: number; drafts: number; blocked: number; kept: number };
export type PassInfo = { repo: string; head: string; model: string | null; account: string | null; at: number };

// `given`: the notes sent to the drafter; one it left out stays new with that reason.
export function writeVerdicts(store: Store, given: string[], verdicts: Checked[], info: PassInfo): Written {
  const w: Written = { notes: 0, drafts: 0, blocked: 0, kept: 0 };
  const named = new Set(verdicts.flatMap((v) => v.notes));
  const all: Checked[] = [...verdicts];
  const left = given.filter((k) => !named.has(k));
  if (left.length) all.push({ verdict: "keep", notes: left, reason: "the drafter gave no verdict" });
  const at = info.at;
  // The note's new columns, only while it is still `new`; 1 when it was.
  const move = (k: string, set: Record<string, string | number | null>): number => {
    const cols = Object.keys(set);
    return store.db.run(`UPDATE feedback_notes SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE key = ? AND state = 'new'`,
      [...cols.map((c) => set[c]), at, k]).changes;
  };
  return store.tx(() => {
    for (const v of all) {
      if (v.verdict === "issue" || v.verdict === "add-to") {
        const key = v.key ?? draftKey(v.verdict, v.notes, v.verdict === "add-to" ? v.issue : null);
        const blocked = !v.leak || !v.leak.ok;
        const ins = store.db.run(`INSERT INTO feedback_drafts (key, kind, title, body, area, label, target, evidence, checked_at, leak, leak_why, state, repo, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
          [key, v.verdict, v.verdict === "issue" ? v.title : null, v.body, v.area, v.kind, v.verdict === "add-to" ? v.issue : null, v.evidence,
            info.head || null, blocked ? "blocked" : "ok", blocked ? (v.leak && !v.leak.ok ? v.leak.why : "not checked") : null, info.repo, at, at]);
        if (ins.changes) { w.drafts++; if (blocked) w.blocked++; }
        const id = (store.db.query("SELECT id FROM feedback_drafts WHERE key = ?").get(key) as { id: number }).id;
        for (const k of v.notes) w.notes += move(k, { state: "drafted", draft_id: id, reason: null });
      } else if (v.verdict === "already-fixed") {
        for (const k of v.notes) w.notes += move(k, { state: "already-fixed", evidence: v.evidence, reason: null });
      } else if (v.verdict === "project-only") {
        for (const k of v.notes) w.notes += move(k, { state: "project-only", reason: v.reason });
      } else {
        // Stays new: only the reason and the time change, so the note waits DS_FEEDBACK_REDRAFT_S for its next pass.
        for (const k of v.notes) w.kept += move(k, { reason: v.reason });
      }
    }
    const payload = { repo: info.repo, ...w, model: info.model, account: info.account, head: info.head || null };
    const bad = problem("fact", "feedback_drafted", FACTS, payload);
    if (bad) throw new Error(bad);
    if (w.notes || w.drafts || w.kept) store.event("feedback_drafted", { payload });
    return w;
  });
}
