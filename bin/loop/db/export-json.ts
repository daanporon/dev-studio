// export-json.ts — the per-squad JSON snapshot from SQLite (Bun): state/<label>/squads/<topic>.json for
// old readers and for a rollback to the sweep (R4, R24). Each squads/members/units row keeps the JSON
// object it was imported from (`doc`); the export overlays the real columns onto it, in the field
// order squad-state.sh writes, and prints it as jq does (2-space indent, trailing newline), so an
// unchanged squad exports byte-equal. Written through a temp file and rename; an unchanged file is
// not rewritten.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derive } from "../squad/derive.ts";
import type { Row, Store } from "../core/store.ts";
import { importSquad, MEMBER_COLS, SQUAD_COLS, UNIT_COLS, type Kind } from "./import-json.ts";
import { entryOf, pending } from "../messages/questions.ts";
import { projection } from "../pause/pause.ts";
import { pendingOf } from "../pause/stop-checkpoint.ts";

function same(d: unknown, c: unknown, kind: Kind): boolean {
  if (d === undefined || d === null) return c === null;
  if (c === null) return false;
  switch (kind) {
    case "json": return JSON.stringify(d) === c;
    case "bool": return (d ? 1 : 0) === c;
    case "int": return Number(d) === c;
    default: return (typeof d === "object" ? JSON.stringify(d) : String(d)) === c;
  }
}
function typed(c: unknown, kind: Kind, was: unknown): unknown {
  switch (kind) {
    case "json": return JSON.parse(String(c));
    case "bool": return Boolean(c);
    case "int": return Number(c);
    default: return typeof was === "number" && /^-?\d+$/.test(String(c)) ? Number(c) : String(c); // keep a numeric pr numeric
  }
}

// The row's columns onto its doc: an equal value keeps the doc's own (its type and form), a NULL
// column drops the field, anything else is written in.
export function overlay(doc: Row, row: Row, map: [string, Kind][]): Row {
  for (const [f, kind] of map) {
    const c = row[f] ?? null;
    if (same(doc[f], c, kind)) continue;
    if (c === null) delete doc[f];
    else doc[f] = typed(c, kind, doc[f]);
  }
  return doc;
}

export function squadDoc(store: Store, project: string, topic: string): Row | null {
  const s = store.db.query("SELECT * FROM squads WHERE project = ? AND topic = ?").get(project, topic) as Row | null;
  if (!s || s.doc === null) return null;
  const doc = overlay(JSON.parse(String(s.doc)), s, SQUAD_COLS);
  const activity = projection(store, { project, squad: topic });
  if (activity.state !== "active") doc.pause = activity;
  else delete doc.pause;
  // A retired member (status gone) is not in the file; a slot the loop has no worker for yet neither.
  const members = store.db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND COALESCE(status, '') != 'gone' AND (doc IS NOT NULL OR wt IS NOT NULL)
    ORDER BY ord IS NULL, ord, id`).all(project, topic) as Row[];
  const units = store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? ORDER BY ord IS NULL, ord, id").all(project, topic) as Row[];
  if (!("members" in doc) && members.length) doc.members = [];
  if (!("units" in doc) && units.length) doc.units = [];
  if ("members" in doc) {
    // A member the loop added (no doc yet) gets squad-state.sh's member field order.
    doc.members = members.map((m) => {
      const entry = overlay(m.doc ? JSON.parse(String(m.doc)) : { role: null, suffix: "", wt: null, owns: [], for: "", agent: null, model: null, effort: null, host: "", since: null }, m, MEMBER_COLS);
      const activity = projection(store, m as { project: string });
      if (activity.state !== "active" || activity.checkpoint) entry.pause = activity;
      else delete entry.pause;
      // U266: a planned restart waiting on its journal checkpoint (stop-checkpoint.ts).
      const stop = pendingOf(store, Number(m.id));
      if (stop) entry.stop_checkpoint = stop;
      else delete entry.stop_checkpoint;
      return entry;
    });
    // worktrees[]/assignments[] come from the members exported (U94): a member the loop started
    // (no squad-state call) shows up, while a recorded worktree no member owns stays.
    const recorded = Array.isArray(doc.worktrees) ? [...doc.worktrees] : [];
    derive(doc, true, recorded);
  }
  if ("units" in doc) {
    doc.units = units.map((u) => overlay(u.doc ? JSON.parse(String(u.doc)) : { slug: null, status: null, builder_wt: null, plan: null, plan_unit: null, deps: [], hold: false }, u, UNIT_COLS));
  }
  // The queue is the open questions (an answered one is kept in its table, not in the file).
  const open = pending(store, project, topic);
  if (open.length || Array.isArray(doc.waiting_on_you)) doc.waiting_on_you = open.map(entryOf);
  return doc;
}

// jq prints DEL escaped; JSON.stringify leaves it raw.
export function render(doc: Row): string { return JSON.stringify(doc, null, 2).replace(/\x7f/g, "\\u007f") + "\n"; }

// Note the file's mtime as the squad's last export: a later one was written by someone else (U18).
export const fileMs = (path: string): number => Math.floor(statSync(path).mtimeMs);
export function exportedMs(store: Store, project: string, topic: string, path: string, ms = fileMs(path)): void {
  store.db.run("UPDATE squads SET exported_ms = ? WHERE project = ? AND topic = ? AND exported_ms IS NOT ?", [ms, project, topic, ms]);
}

// A file someone else wrote after the loop's last export; one merely touched still says what the rows say.
export function writtenElsewhere(store: Store, project: string, topic: string, path: string): boolean {
  const row = store.get("squads", { project, topic });
  if (row?.exported_ms != null && fileMs(path) <= Number(row.exported_ms)) return false;
  const doc = row ? squadDoc(store, project, topic) : null;
  return !doc || render(doc) !== readFileSync(path, "utf8");
}

// That file over the squad's rows. Its mtime is taken before the read, so a write under this one stays
// newer than the stamp.
export function reimportSquad(store: Store, root: string, project: string, topic: string, warn: (m: string) => void): boolean {
  const path = join(root, project, "squads", `${topic}.json`), ms = fileMs(path);
  if (importSquad(store, root, project, topic, warn) === null) return false;
  exportedMs(store, project, topic, path, ms);
  store.event("squad_reimported", { project, squad: topic });
  return true;
}

// The last export, on the way out of a rollback. main's scripts write these files from the checkout on,
// so a file written since the loop's last export stays as it is and so does one that went, even when the
// rows moved too: the sweep reads the file now, and a re-switch imports it. No stamp, so that re-switch
// still sees the change.
export function exportForRollback(store: Store, root = store.root): { written: string[]; kept: string[] } {
  const out = { written: [] as string[], kept: [] as string[] };
  const rows = store.db.query(`SELECT project, topic, exported_ms FROM squads WHERE doc IS NOT NULL
    AND COALESCE(status, '') != 'closed' ORDER BY project, topic`).all() as { project: string; topic: string; exported_ms: number | null }[];
  for (const { project, topic, exported_ms } of rows) {
    const path = join(root, project, "squads", `${topic}.json`);
    try {
      if (existsSync(path) ? writtenElsewhere(store, project, topic, path) : exported_ms != null) {
        store.event("squad_export_kept", { project, squad: topic });
        out.kept.push(path);
      } else out.written.push(...exportJson(store, root, { project, topic }).written);
    } catch (e) { store.event("tick_error", { project, squad: topic, payload: { error: (e as Error)?.message ?? String(e) } }); }
  }
  return out;
}

// Write every squad of the state root that has a doc and is not closed (its file was removed, see
// import-json.ts prune); returns the paths written and left unchanged.
export function exportJson(store: Store, root = store.root, only?: { project?: string; topic?: string }): { written: string[]; unchanged: string[] } {
  const out = { written: [] as string[], unchanged: [] as string[] };
  const rows = store.db.query(`SELECT project, topic FROM squads WHERE doc IS NOT NULL AND COALESCE(status, '') != 'closed'
    AND (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR topic = ?2) ORDER BY project, topic`).all(only?.project || null, only?.topic || null) as { project: string; topic: string }[];
  for (const { project, topic } of rows) {
    // Read the rows and replace the file in one write transaction: read outside it, two writers can
    // interleave so the older doc's rename lands last and drops the newer one's change (U62: a unit
    // added by one of two concurrent squad-state.sh calls went missing from the file). The one
    // transaction also means the install's check never sees the file without its stamp.
    store.tx(() => {
      const doc = squadDoc(store, project, topic);
      if (!doc) return;
      const dir = join(root, project, "squads"), path = join(dir, `${topic}.json`), text = render(doc);
      let old: string | null = null;
      try { old = readFileSync(path, "utf8"); } catch { /* first export */ }
      if (old === text) { exportedMs(store, project, topic, path); out.unchanged.push(path); return; }
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.squad-state.export.${process.pid}`);
      writeFileSync(tmp, text);
      renameSync(tmp, path);
      exportedMs(store, project, topic, path);
      out.written.push(path);
    });
  }
  return out;
}
