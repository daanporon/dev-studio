// fulfil/answer.ts — kind `answer`: the operator's answer to a question, which the board filed
// (bin/board/board-server.ts POST /api/answer). Payload {id, answer, seq?, card_wt?, choices?, transcript?, tool_use_id?, via?}.
// With `choices` the question is a live picker: the option's digit (no Enter), or for free text the
// digit after the last option, then the text + Enter after DS_LOOP_PICKER_TYPE_MS (default 600) — a
// picker with more than nine options can't be answered by keystroke. Keys typed after the picker
// closed would land in the agent's prompt, so its transcript is checked before each send. Without
// `choices`, the answer is poked as the board's message. Once it landed, the asker's "NEEDS YOU" card
// note (ask-operator.sh) on card_wt is cleared unless another open question sits on that card: the board already
// closed the question, so the agent's resolve-question no longer finds the card to clear.
import { failRequest, finishRequest, memberAt, requestActions, type Fulfiller } from "../core/actuator.ts";
import { pickerClosed } from "../observers/state.ts";
import type { Action } from "../core/plugins.ts";
import { askState, expectedChecks, headOf, humanCheckNames, prQuestionKey } from "../squad/pr-ready.ts";
import { reopen } from "../messages/questions.ts";
import type { Row } from "../core/store.ts";
import type { Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

const pickerTypeMs = () => envInt("DS_LOOP_PICKER_TYPE_MS", 600);
function message(id: string, ans: string): string {
  return `dev-studio board: the operator answered question ${id}: ${ans} — apply it now the way /ds-q does `
    + "(Lead: orch.sh reply + resolve-question; Thinker: act on it, then resolve-question).";
}
type P = ActionPayload<"answer">;
const closed = (p: P) => pickerClosed(p.transcript, p.tool_use_id) !== false;
const cardFree = (store: Store, a: Action, wt: string | undefined): wt is string =>
  !!wt && !store.db.query("SELECT 1 FROM questions WHERE project = ? AND card_wt = ? AND status = 'open'").get(a.project, wt);

const answer: Fulfiller = {
  name: "answer",
  scope: "host",
  kinds: ["answer"],
  run: (ctx) => requestActions(ctx, ["answer"]),
  async exec(a, x) {
    const p = payloadOf<"answer">(a);
    const wt = a.member, ans = p.answer ?? "";
    if (!wt || !p.id || !ans) return { failed: "an answer needs a member, a question id and the answer" };
    const seat = x.act.seat(x.store, a.project, a.squad ?? null, `${a.subject}:${a.episode}`, wt, x.now);
    // The loop's own PR question: "Done" hands the PR back to the loop (no poke; the lifecycle
    // reconciler reads the PR again), "Send back" and free text go to the unit's Builder with the
    // operator's words (the Lead gets a one-line copy; a gone Builder's share goes to the Lead).
    if (!Array.isArray(p.choices) && a.squad) {
      const q = x.store.db.query("SELECT * FROM questions WHERE project = ? AND squad = ? AND id = ? ORDER BY seq DESC LIMIT 1").get(a.project, a.squad, p.id) as Row | null;
      let entry: Row = {}; try { entry = JSON.parse(String(q?.doc ?? "{}")) as Row; } catch { /* not loop's */ }
      if (entry.asker === "loop" && typeof entry.pr === "number") {
        const prN = entry.pr as number, slug = String(entry.unit ?? "");
        const unit = slug ? x.store.get("units", { project: a.project, squad: a.squad, slug }) as Row | null
          : x.store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? AND CAST(pr AS INTEGER) = ?").get(a.project, a.squad, prN) as Row | null;
        const squadRow = x.store.get("squads", { project: a.project, topic: a.squad });
        const leadWt = (squadRow?.lead_wt as string) || (x.store.db.query("SELECT wt FROM members WHERE project = ? AND squad = ? AND role = 'lead' AND COALESCE(status, '') != 'gone' ORDER BY id DESC").get(a.project, a.squad) as Row | null)?.wt as string | undefined;
        const bwt = unit?.builder_wt ? String(unit.builder_wt) : "";
        const bMember = bwt ? x.store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC").get(a.project, a.squad, bwt) as Row | null : null;
        if (/^done\W*$/i.test(ans.trim()) || ans.trim() === "Done — I cleared the gates") {
          const nwo = squadRow?.repo ? (x.store.get("config", { project: a.project, file: "github", key: `repo:${squadRow.repo}` })?.value as string) || "" : "";
          const row = (nwo ? x.store.get("observed_prs", { project: a.project, ref: `${nwo}#${prN}` }) : null)
            ?? (slug ? x.store.db.query("SELECT * FROM observed_prs WHERE project = ? AND ref = ? AND pr = ?").get(a.project, `${a.squad}/${slug}`, prN) as Row | null : null)
            ?? x.store.db.query("SELECT * FROM observed_prs WHERE project = ? AND pr = ? AND gone_at IS NULL ORDER BY observed_at DESC").get(a.project, prN) as Row | null;
          const key = row ? prQuestionKey(prN, row, humanCheckNames(x.store, a.project), expectedChecks(x.store, a.project)) : `${prN}||`;
          x.store.upsert("episodes", { project: a.project, subject: `${a.squad}/${slug}`, kind: "lifecycle:pr-question" },
            { squad: a.squad, episode_key: key, state: "done-wait", next_at: x.now + 86400, source: "loop", observed_at: x.now });
          finishRequest(x.store, a, { ok: true, delivered: "loop" }, x.now);
          return { done: true, result: "loop" };
        }
        // A sent-back PR follows the same quiet-day path as Done: reminder, then an alert.
        const nwo2 = squadRow?.repo ? (x.store.get("config", { project: a.project, file: "github", key: `repo:${squadRow.repo}` })?.value as string) || "" : "";
        const row2 = (nwo2 ? x.store.get("observed_prs", { project: a.project, ref: `${nwo2}#${prN}` }) : null)
          ?? (slug ? x.store.db.query("SELECT * FROM observed_prs WHERE project = ? AND ref = ? AND pr = ?").get(a.project, `${a.squad}/${slug}`, prN) as Row | null : null)
          ?? x.store.db.query("SELECT * FROM observed_prs WHERE project = ? AND pr = ? AND gone_at IS NULL ORDER BY observed_at DESC").get(a.project, prN) as Row | null;
        x.store.upsert("episodes", { project: a.project, subject: `${a.squad}/${slug}`, kind: "lifecycle:pr-question" },
          { squad: a.squad, episode_key: `${prN}|${row2 ? headOf(row2) : ""}|${row2 ? (askState(row2, humanCheckNames(x.store, a.project), expectedChecks(x.store, a.project))?.gates ?? []).join(",") : ""}`, state: "done-wait", next_at: x.now + 86400, source: "loop", observed_at: x.now });
        const target = bMember ? bwt : (leadWt ?? "");
        if (!target) return { failed: `answer ${p.id}: no Builder or Lead to send it to` };
        const text = `dev-studio loop: the operator answered the PR #${prN} question (${a.squad}/${slug}): ${ans} — act on it and stop at your prompt; the loop pokes you when the PR changes.`;
        const m2 = memberAt(x.store, a, target);
        const seat2 = x.act.seat(x.store, a.project, a.squad ?? null, `${a.subject}:${a.episode}`, target, x.now);
        const r = await x.act.driver(seat2, m2.agent).poke(m2, text);
        if (r === "failed") return { retry: `answer ${p.id}: not sent to ${target}` };
        if (bMember && leadWt && leadWt !== target) {
          const lm = memberAt(x.store, a, leadWt);
          const seat3 = x.act.seat(x.store, a.project, a.squad ?? null, `${a.subject}:${a.episode}`, leadWt, x.now);
          await x.act.driver(seat3, lm.agent).poke(lm, `dev-studio loop: the operator sent PR #${prN} (${a.squad}/${slug}) back to its Builder: ${ans}`);
        }
        if (cardFree(x.store, a, p.card_wt)) await seat.send("ping", [p.card_wt, ""]);
        finishRequest(x.store, a, { ok: true, delivered: r }, x.now);
        return { done: true, result: r };
      }
    }
    if (!Array.isArray(p.choices)) {
      const m = memberAt(x.store, a, wt);
      const r = await x.act.driver(seat, m.agent).poke(m, message(p.id, ans));
      if (r === "failed") return { retry: `answer ${p.id}: not sent to ${wt}` };
      if (cardFree(x.store, a, p.card_wt)) await seat.send("ping", [p.card_wt, ""]);   // best-effort, like resolve-question
      finishRequest(x.store, a, { ok: true, delivered: r }, x.now);
      return { done: true, result: r };
    }
    const labels = p.choices.map((c) => String((c as { label?: unknown })?.label ?? c));
    const i = labels.indexOf(ans), digit = i >= 0 ? i + 1 : labels.length + 1;
    if (digit > 9) return { failed: "the picker has too many options to answer by keystroke" };
    if (closed(p)) return { failed: "the picker is closed (or its transcript unreadable) — answer it in the terminal" };
    const k = await seat.send("keys", [wt, String(digit)]);
    if (k.code !== 0) return { retry: (k.err || k.out).trim() || "keys failed" };
    if (i < 0) {
      await Bun.sleep(pickerTypeMs());   // let the picker open its text field before the text lands
      if (closed(p)) return { failed: "the picker closed before the text was typed" };
      const t = await seat.send("keys", [wt, ans, "enter"]);
      if (t.code !== 0) return { failed: `typed ${digit} but not the text: ${(t.err || t.out).trim()}` };
    }
    if (cardFree(x.store, a, p.card_wt)) await seat.send("ping", [p.card_wt, ""]);
    finishRequest(x.store, a, { ok: true, picked: digit }, x.now);
    return { done: true, result: digit };
  },
  // A board answer that never landed reopens its question, so the board asks again.
  giveUp(a, x, why) {
    failRequest(a, x, why);
    const store = x.store;
    const p = payloadOf<"answer">(a);
    if (p.via === "board" && p.id && a.project && a.squad) reopen(store, a.project, a.squad, p.id, p.seq);
    return true;
  },
};
export default answer;
