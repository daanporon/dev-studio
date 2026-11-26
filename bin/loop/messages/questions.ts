// questions.ts — a squad's operator questions, kept once answered (U13a, Bun).
//
// An open row is one `waiting_on_you` entry of the squad JSON; the export writes the open rows back in
// `seq` order (export-json.ts), the import and squad-state.sh turn the entries into rows (sync). An
// answer marks the row answered and never deletes it:
//   open(store, project, squad, entry)              a new open row (U15's board asks through it)
//   answer(store, project, squad, id, text, via[, seq]) the open row answered + an events row question_answered
// A question's id stays the same per asking (`plan-<short>` after a revision); two askings are told apart by
// `since`, the entry's timestamp (the row's `asked_at`), which changes only when the question is asked again.
// `seq` moves under unrelated questions (sync re-inserts rows), so it never names an asking across reads.
//   list(store, project, squad, {limit, before})    answered rows, newest first
//   drop(store, project, squad, reason)             every open row dropped (archive) + question_dropped events
import type { Row, Store } from "../core/store.ts";
import { json, now } from "../core/store.ts";

export const VIAS = ["terminal", "picker", "board", "reality"] as const;
export type Via = (typeof VIAS)[number];

export const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
// A Lead-raised question names its affected unit explicitly. A mirrored Builder ask
// already names it in the role label; do not guess from prose or the question id.
export function questionUnit(entry: Row): string | null {
  if (typeof entry.unit === "string" && entry.unit) return entry.unit;
  return typeof entry.asker === "string" && entry.asker.startsWith("builder-") ? entry.asker.slice(8) || null : null;
}

export function blockingForUnit(entries: unknown[], unit: string): Row | null {
  return entries.find((e): e is Row => isObj(e) && e.blocking === true && questionUnit(e) === unit) ?? null;
}

const jsonOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const idOf = (e: unknown): string => (isObj(e) && e.id !== undefined && e.id !== null ? String(e.id) : "");

// A waiting_on_you entry -> its question columns (the entry itself goes in `doc`).
function columns(e: unknown): Row {
  const o = isObj(e) ? e : {};
  const since = typeof o.since === "string" ? Date.parse(o.since) : NaN;
  return { id: idOf(e), asker: json(o.asker), card_wt: json(o.card_wt), title: json(o.title), question: json(o.question),
    options: jsonOrNull(o.options), choices: jsonOrNull(o.choices), suggestion: json(o.suggestion), why: json(o.why), blocking: o.blocking === undefined || o.blocking === null ? null : o.blocking ? 1 : 0,
    asked_at: Number.isNaN(since) ? null : Math.floor(since / 1000), doc: JSON.stringify(e) };
}

function insert(store: Store, project: string, squad: string, c: Row): number {
  const ks = Object.keys(c);
  return Number(store.db.run(`INSERT INTO questions (project, squad, ${ks.join(", ")}) VALUES (?, ?, ${ks.map(() => "?").join(", ")})`,
    [project, squad, ...ks.map((k) => c[k] as string | number | null)]).lastInsertRowid);
}

// The open rows of a squad, in asking order.
export function pending(store: Store, project: string, squad: string): Row[] {
  return store.db.query("SELECT * FROM questions WHERE project = ? AND squad = ? AND status = 'open' ORDER BY seq").all(project, squad) as Row[];
}

// A board answer closes its question before the loop delivers it. The unit still waits
// while that exact answer request is unfinished, including delivery retries.
export function waiting(store: Store, project: string, squad: string): Row[] {
  return store.db.query(`SELECT q.* FROM questions q WHERE q.project = ?1 AND q.squad = ?2
    AND (q.status = 'open' OR (q.status = 'answered' AND q.answered_via = 'board' AND EXISTS (
      SELECT 1 FROM requests r WHERE r.project = q.project AND r.squad = q.squad
        AND r.kind = 'answer' AND r.done_at IS NULL AND json_extract(r.payload, '$.id') = q.id
        AND (json_extract(r.payload, '$.seq') = q.seq OR json_extract(r.payload, '$.seq') IS NULL))))
    ORDER BY q.seq`).all(project, squad) as Row[];
}

// An open row as its waiting_on_you entry: every row keeps the entry it was written from.
export const entryOf = (r: Row): unknown => JSON.parse(String(r.doc));

export function open(store: Store, project: string, squad: string, entry: Row): number {
  return store.tx(() => insert(store, project, squad, columns(entry)));
}

// Answer the open row(s) with this id, or only the open row `seq` when it is given (the board answers the
// asking it chose; another open row with the same id stays open). An unknown or already answered id changes
// nothing (null), so a second answer never overwrites the first.
export function answer(store: Store, project: string, squad: string, id: string, answerText: string, via: Via, seq?: number): Row | null {
  return store.tx(() => {
    const rows = (store.db.query("SELECT * FROM questions WHERE project = ? AND squad = ? AND id = ? AND status = 'open' ORDER BY seq")
      .all(project, squad, id) as Row[]).filter((r) => seq === undefined || r.seq === seq);
    if (!rows.length) return null;
    const at = now();
    for (const r of rows) {
      store.db.run("UPDATE questions SET status = 'answered', answer = ?, answered_via = ?, answered_at = ? WHERE seq = ?", [answerText, via, at, r.seq as number]);
    }
    const r = rows[rows.length - 1];
    store.event("question_answered", { project, squad, payload: { id, title: r.title ?? r.question ?? null, answer: answerText, via } });
    return { ...r, status: "answered", answer: answerText, answered_via: via, answered_at: at };
  });
}

// morning-brief-stale-items U2: an archived squad's open rows are dropped, never answered: status
// `dropped`, the reason in `answer`, via `archive`. They stay in the table (nothing is deleted), out of
// `pending`, `list` (answered history) and `answer`. One `question_dropped` event per row; returns the
// rows as they were (still open), so the caller can name them.
export function drop(store: Store, project: string, squad: string, reason: string): Row[] {
  return store.tx(() => {
    const rows = pending(store, project, squad), at = now();
    for (const r of rows) {
      store.db.run("UPDATE questions SET status = 'dropped', answer = ?, answered_via = 'archive', answered_at = ? WHERE seq = ? AND status = 'open'", [reason, at, r.seq as number]);
      store.event("question_dropped", { project, squad, payload: { id: r.id, title: r.title ?? r.question ?? null, blocking: r.blocking === 1, reason } });
    }
    return rows;
  });
}

// A board answer that never reached the agent (its `answer` request gave up): the question goes back
// to open so the operator can answer it again. Only a row the board answered is reopened: the row
// `seq` (the one the board answered), else the newest with this id — never an earlier asking of a
// re-asked id, whose answer is history.
export function reopen(store: Store, project: string, squad: string, id: string, seq?: number): boolean {
  return store.tx(() => {
    const row = seq ?? (store.db.query("SELECT MAX(seq) AS s FROM questions WHERE project = ? AND squad = ? AND id = ?").get(project, squad, id) as { s: number | null }).s;
    const n = row == null ? 0 : store.db.run("UPDATE questions SET status = 'open', answer = NULL, answered_via = NULL, answered_at = NULL "
      + "WHERE seq = ? AND project = ? AND squad = ? AND id = ? AND status = 'answered' AND answered_via = 'board'", [row, project, squad, id]).changes;
    if (n) store.event("question_reopened", { project, squad, payload: { id } });
    return n > 0;
  });
}

// permission-prompt-needs-you U2: the board's answer to this permission prompt (the picker id and its tool call)
// was not pressed because the screen no longer matched; it is answered in the terminal from then on. The
// reason, or null. A new prompt has a new tool call, so it starts answerable again.
export function pressRefused(store: Store, project: string, squad: string, id: string, toolUseId: unknown): string | null {
  if (typeof toolUseId !== "string" || !toolUseId) return null;
  const r = store.db.query(`SELECT json_extract(result, '$.why') AS why FROM requests WHERE project = ? AND squad = ? AND kind = 'answer'
    AND done_at IS NOT NULL AND json_extract(result, '$.prompt_changed') = 1 AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.tool_use_id') = ?
    ORDER BY id DESC LIMIT 1`).get(project, squad, id, toolUseId) as { why: string | null } | null;
  return r ? String(r.why ?? "the prompt changed") : null;
}

// Make the open rows match a squad's waiting_on_you entries; returns the number of rows changed. An open
// row whose entry left is answered by `reality` (cancel-unit, a hand edit); a kept entry updates its row
// in place; from the first entry out of order on (a re-asked id moves to the end) rows are replaced.
export function sync(store: Store, project: string, squad: string, entries: unknown[]): number {
  const ids = new Set(entries.map(idOf));
  const keep: Row[] = [];
  let n = 0;
  for (const r of pending(store, project, squad)) {
    if (ids.has(String(r.id))) { keep.push(r); continue; }
    n += store.db.run("UPDATE questions SET status = 'answered', answered_via = 'reality', answered_at = ? WHERE seq = ?", [now(), r.seq as number]).changes;
  }
  let i = 0;
  for (; i < Math.min(keep.length, entries.length) && keep[i].id === idOf(entries[i]); i++) {
    const c = columns(entries[i]);
    if (keep[i].doc === c.doc) continue;
    const ks = Object.keys(c);
    n += store.db.run(`UPDATE questions SET ${ks.map((k) => `${k} = ?`).join(", ")} WHERE seq = ?`, [...ks.map((k) => c[k] as string | number | null), keep[i].seq as number]).changes;
  }
  for (const r of keep.slice(i)) n += store.db.run("DELETE FROM questions WHERE seq = ?", [r.seq as number]).changes;
  for (const e of entries.slice(i)) { insert(store, project, squad, columns(e)); n++; }
  return n;
}

// Answered rows, newest answer first; `before` is a row's seq and pages past it in the same order.
export function list(store: Store, project: string, squad: string, opts: { limit?: number; before?: number } = {}): Row[] {
  return store.db.query(`SELECT * FROM questions q WHERE project = ?1 AND squad = ?2 AND status = 'answered'
    AND (?3 IS NULL OR EXISTS (SELECT 1 FROM questions b WHERE b.seq = ?3
      AND (COALESCE(q.answered_at, 0) < COALESCE(b.answered_at, 0) OR (COALESCE(q.answered_at, 0) = COALESCE(b.answered_at, 0) AND q.seq < b.seq))))
    ORDER BY COALESCE(answered_at, 0) DESC, seq DESC LIMIT ?4`).all(project, squad, opts.before ?? null, opts.limit ?? -1) as Row[];
}
