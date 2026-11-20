// import-json.ts — today's state files into rows (Bun). The install migration runs it once on the
// host switch (R4, KTD13); it is idempotent: rows are upserted by natural key and stamped with
// their source file's mtime, so a second import over unchanged files changes nothing.
//
//   squads/<topic>.json      -> squads, members, units (each keeps its JSON object in `doc`)
//   dispatcher.json          -> projects
//   requests/<dir>/*.txt     -> requests (key file:<label>/<dir>/<name>; done once the file is gone)
//   alerts.json              -> observed_alerts        sweep/pr-health.json -> observed_prs
//   sweep/squad-spent.tsv    -> observed_spend         accounts.tsv, tokens.tsv (host-wide) -> observed_*
//   squads/*.md, journals/*.md, cross-squad.md, archive/*.{json,md} -> documents
// Marker files are import-markers.ts; config files are import-config.ts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { FactRow, Row, Store } from "../core/store.ts";
import { discoverProjects, repoOf } from "../settings/projects.ts";
import { isObj, sync } from "../messages/questions.ts";

export type Kind = "text" | "json" | "bool" | "int";
// The squad JSON fields that have a column of their own (the export overlays them back).
export const SQUAD_COLS: [string, Kind][] = [["status", "text"], ["type", "text"], ["autonomy", "text"], ["repo", "text"],
  ["host", "text"], ["framing", "text"], ["task_id", "text"], ["run_id", "text"], ["lead_wt", "text"]];
export const MEMBER_COLS: [string, Kind][] = [["role", "text"], ["suffix", "text"], ["wt", "text"], ["agent", "text"],
  ["model", "text"], ["effort", "text"], ["account", "text"], ["host", "text"], ["since", "text"], ["started", "text"], ["restarting", "text"]];
export const UNIT_COLS: [string, Kind][] = [["slug", "text"], ["status", "text"], ["pr", "text"], ["tier", "text"],
  ["builder_wt", "text"], ["plan", "text"], ["plan_unit", "text"], ["deps", "json"], ["ext_deps", "json"], ["hold", "bool"],
  ["wait_until", "int"], ["superseded_by", "text"], ["into_merged", "bool"]];

export function toCol(v: unknown, kind: Kind): string | number | null {
  if (v === undefined || v === null) return null;
  switch (kind) {
    case "json": return JSON.stringify(v);
    case "bool": return v ? 1 : 0;
    case "int": return Number.isFinite(Number(v)) ? Number(v) : null;
    default: return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}
export function cols(obj: Row, map: [string, Kind][]): Row {
  const out: Row = {};
  for (const [f, k] of map) out[f] = toCol(obj[f], k);
  return out;
}

export function mtime(p: string): number { try { return Math.floor(statSync(p).mtimeMs / 1000); } catch { return 0; } }
export function readJson(p: string): unknown { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } }
function ls(d: string): string[] { try { return readdirSync(d).sort(); } catch { return []; } }
export function tsv(p: string): string[][] {
  try { return readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => l.split("\t")); } catch { return []; }
}
export const num = (s: string | undefined): number | null => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : null);

export { isObj };
const list = (v: unknown): v is Row[] => v === undefined || v === null || (Array.isArray(v) && v.every(isObj));
// Why a squad file cannot be imported, or null when it can.
export function badSquad(doc: unknown): string | null {
  if (!isObj(doc)) return "not a JSON object";
  if (!list(doc.members)) return "members is not a list of objects";
  if (!list(doc.units)) return "units is not a list of objects";
  // A note saved next to the squads has none of the fields a real squad file carries.
  if (!SQUAD_MARKS.some((k) => doc[k] !== undefined)) return `not a squad file (no ${SQUAD_MARKS[0]})`;
  return null;
}
// Fields squad-state.sh writes into every squad file (state/SCHEMA.json); any one marks a squad.
const SQUAD_MARKS = ["status", "type", "run_id", "task_id", "members", "units"];
// Skips already reported, keyed on file + mtime + reason, so a ticking import warns once per change.
const warned = new Set<string>();

// A squad file -> its squads, members and units rows (pure). A file that is not a squad gives no
// rows and its reason in `skip`, so one hand-edited file never blocks the whole import.
export function squadRows(project: string, topic: string, file: string, skip: string[] = []): FactRow[] {
  const doc = readJson(file) as Row | undefined;
  const why = doc === undefined ? "not valid JSON" : badSquad(doc);
  if (why) {
    const key = `${file}\0${mtime(file)}\0${why}`;
    if (!warned.has(key)) { warned.add(key); skip.push(`${file}: ${why}`); }
    return [];
  }
  return docRows(project, topic, doc as Row, mtime(file));
}

// A squad document -> its squads, members and units rows, stamped `at` (squad-state.ts writes them too).
export function docRows(project: string, topic: string, doc: Row, at: number): FactRow[] {
  const rows: FactRow[] = [{ table: "squads", key: { project, topic }, set: { ...cols(doc, SQUAD_COLS), doc: JSON.stringify(doc), observed_at: at, updated_at: at } }];
  ((doc.members as Row[]) ?? []).forEach((m, ord) => {
    rows.push({ table: "members", key: { project, squad: topic, wt: toCol(m.wt, "text") },
      set: { ...cols(m, MEMBER_COLS), suffix: toCol(m.suffix, "text") ?? "", role: toCol(m.role, "text") ?? "", ord, doc: JSON.stringify(m), observed_at: at, updated_at: at } });
  });
  ((doc.units as Row[]) ?? []).forEach((u, ord) => {
    rows.push({ table: "units", key: { project, squad: topic, slug: toCol(u.slug, "text") },
      set: { ...cols(u, UNIT_COLS), ord, doc: JSON.stringify(u), observed_at: at, updated_at: at } });
  });
  return rows;
}

// The projects row from dispatcher.json; `repo` (a squad's repo selector) stands in for a missing home_repo.
export function dispatcherRows(root: string, project: string, repo: string | null = null): FactRow[] {
  const dir = join(root, project), disp = join(dir, "dispatcher.json"), d = readJson(disp) as Row | undefined;
  const gh = repoOf((d?.home_repo as string) ?? repo);
  return [{ table: "projects", key: { label: project }, set: { home_repo: (d?.home_repo as string) ?? null,
    studio_wt: (d?.studio_wt as string) ?? null, owner: gh?.owner ?? null, name: gh?.name ?? null,
    doc: d ? JSON.stringify(d) : null, observed_at: d ? mtime(disp) : mtime(dir) } }];
}

// Request files the sweep wrote for a Lead (requests/<topic>/) or the Studio (requests/_studio/).
export function requestFiles(root: string, project: string): string[] {
  const dir = join(root, project, "requests");
  return ls(dir).flatMap((sub) => ls(join(dir, sub)).filter((x) => x.endsWith(".txt")).map((f) => join(dir, sub, f)));
}
export function requestRows(root: string, project: string): FactRow[] {
  return requestFiles(root, project).map((p) => {
    const sub = basename(dirname(p)), f = basename(p), body = readFileSync(p, "utf8");
    const kind = body.startsWith("switch:") ? "switch" : body.startsWith("restart ") ? "restart" : (body.match(/^[a-z][a-z-]*/)?.[0] ?? "request");
    return { table: "requests", key: { key: `file:${project}/${sub}/${f}` }, set: { project, squad: sub === "_studio" ? null : sub,
      kind, payload: JSON.stringify({ file: relative(root, p), text: body.trimEnd() }), requested_by: "sweep", created_at: mtime(p) } };
  });
}

export function alertRows(root: string, project: string): FactRow[] {
  const f = join(root, project, "alerts.json"), alerts = readJson(f) as { alerts?: unknown } | undefined;
  return (Array.isArray(alerts?.alerts) ? alerts.alerts.filter(isObj) : [])
    .map((a) => ({ table: "observed_alerts", key: { project, id: String(a.id) }, set: { doc: JSON.stringify(a), observed_at: mtime(f) } }));
}

// pr-health.json: {at, units: {<topic>/<slug>: {...}}, merged: {<topic>/<slug>: {pr, at}}}; a unit row's
// doc keeps the file's `at` as file_at (observed_at moves on every tick the file is still there).
export function prRows(root: string, project: string): FactRow[] {
  const phPath = join(root, project, "sweep", "pr-health.json"), ph = readJson(phPath) as Row | undefined, rows: FactRow[] = [];
  if (!isObj(ph)) return rows;
  const at = Number(ph.at) || mtime(phPath);
  for (const [ref, v] of Object.entries(isObj(ph.units) ? ph.units : {}).filter((e): e is [string, Row] => isObj(e[1]))) {
    rows.push({ table: "observed_prs", key: { project, ref }, set: { pr: num(String(v.pr ?? "")), state: "OPEN", verdict: (v.verdict as string) ?? null,
      reasons: v.reasons === undefined ? null : JSON.stringify(v.reasons), merged_at: null, doc: JSON.stringify({ ...v, file_at: at }), observed_at: at } });
  }
  for (const [ref, v] of Object.entries(isObj(ph.merged) ? ph.merged : {}).filter((e): e is [string, Row] => isObj(e[1]))) {
    rows.push({ table: "observed_prs", key: { project, ref }, set: { pr: num(String(v.pr ?? "")), state: "MERGED", verdict: "merged", reasons: null,
      merged_at: num(String(v.at ?? "")), doc: JSON.stringify(v), observed_at: at } });
  }
  return rows;
}

// squad-spent.tsv: topic since total lead thinker builders other frozen
export function spendRows(root: string, project: string): FactRow[] {
  const current = join(root, project, "loop", "squad-spent.tsv");
  const sp = existsSync(current) ? current : join(root, project, "sweep", "squad-spent.tsv");
  return tsv(sp).filter((r) => r[0]).map((r) => ({ table: "observed_spend", key: { project, squad: r[0] }, set: { since: num(r[1]), total: num(r[2]),
    lead: num(r[3]), thinker: num(r[4]), builders: num(r[5]), other: num(r[6]), frozen: num(r[7]), observed_at: mtime(sp) } }));
}

// Plans and brainstorms beside the squad files, journals, the cross-squad log.
export function documentFiles(root: string, project: string): string[] {
  const dir = join(root, project), sq = join(dir, "squads");
  return [...ls(sq).filter((f) => f.endsWith(".md")).map((f) => join(sq, f)),
    ...ls(join(dir, "journals")).filter((f) => f.endsWith(".md")).map((f) => join(dir, "journals", f)),
    ...(existsSync(join(dir, "cross-squad.md")) ? [join(dir, "cross-squad.md")] : []),
    // The Studio's morning briefs (briefings/<YYYY-MM-DD>.md), kept for the board.
    ...ls(join(dir, "briefings")).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => join(dir, "briefings", f)),
    // Closed squads (close-squad.sh moves them to archive/): their JSON and plans, for the board.
    ...ls(join(dir, "archive")).filter((f) => f.endsWith(".json") || f.endsWith(".md")).map((f) => join(dir, "archive", f))];
}
export function documentRow(root: string, project: string, p: string): FactRow {
  return { table: "documents", key: { project, path: relative(root, p) }, set: { mtime: mtime(p), body: readFileSync(p, "utf8"), observed_at: mtime(p) } };
}

// Every row the state files of one project give (pure, apart from the git remote lookup).
export function projectRows(root: string, project: string, skip: string[] = []): FactRow[] {
  const sq = join(root, project, "squads"), rows: FactRow[] = [];
  const topics = ls(sq).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  for (const t of topics) rows.push(...squadRows(project, t, join(sq, `${t}.json`), skip));
  const repo = (rows.find((r) => r.table === "squads" && r.set.repo)?.set.repo as string) ?? null;
  return [...dispatcherRows(root, project, repo), ...rows, ...requestRows(root, project), ...alertRows(root, project),
    ...prRows(root, project), ...spendRows(root, project), ...documentFiles(root, project).map((p) => documentRow(root, project, p))];
}

// Host-wide files: accounts.tsv (with a header line) and tokens.tsv.
export function accountRows(root: string): FactRow[] {
  const rows: FactRow[] = [];
  const ap = join(root, "accounts.tsv"), at = mtime(ap);
  for (const r of tsv(ap)) {
    if (r[0] === "agent" || !r[0] || !r[1]) continue;
    const dash = (s: string | undefined) => (s === undefined || s === "-" ? null : s);
    rows.push({ table: "observed_accounts", key: { agent: r[0], account: r[1] }, set: { session_pct: dash(r[2]), session_reset: dash(r[3]),
      weekly_pct: dash(r[4]), weekly_reset: dash(r[5]), limited_until: dash(r[6]), updated: dash(r[7]), label: dash(r[8]), note: dash(r[9]), skills: dash(r[10]), plan: dash(r[11]), resets: dash(r[12]), observed_at: at } });
    rows.push({ table: "accounts", key: { agent: r[0], account: r[1] }, set: { label: dash(r[8]), observed_at: at } });
  }
  return rows;
}
export function tokenRows(root: string): FactRow[] {
  const tp = join(root, "tokens.tsv"), tt = mtime(tp);
  return tsv(tp).filter((r) => r[0] !== "worker" && r[0]).map((r) => ({ table: "observed_tokens", key: { worker: r[0], model: r[3] ?? "" },
    set: { topic: r[1] ?? null, role: r[2] ?? null, turns: num(r[4]), input: num(r[5]), cache_write: num(r[6]), cache_read: num(r[7]),
      output: num(r[8]), ctx: num(r[9]), cw_1h: num(r[10]), cw_5m: num(r[11]), observed_at: tt } }));
}
export function hostRows(root: string): FactRow[] { return [...accountRows(root), ...tokenRows(root)]; }

// After the upserts: a member first seen in its squad file is running; members and units that left
// the file drop out; its waiting_on_you entries are the open questions (questions.ts sync); a squad
// whose file is gone is closed (the export no longer writes it; U13 retires its rows); request files
// that are gone are done (done-request.sh deletes a handled one).
function prune(store: Store, root: string, project: string): number {
  const db = store.db;
  let n = db.run("UPDATE members SET status = 'running' WHERE project = ? AND doc IS NOT NULL AND status IS NULL", [project]).changes;
  const squads = db.query("SELECT topic, doc, status FROM squads WHERE project = ? AND doc IS NOT NULL").all(project) as { topic: string; doc: string; status: string | null }[];
  for (const s of squads) {
    if (!existsSync(join(root, project, "squads", `${s.topic}.json`))) {
      if (s.status !== "closed") n += db.run("UPDATE squads SET status = 'closed' WHERE project = ? AND topic = ?", [project, s.topic]).changes;
      continue;
    }
    const doc = JSON.parse(s.doc) as Row;
    n += pruneSquad(store, project, s.topic, doc);
    n += sync(store, project, s.topic, Array.isArray(doc.waiting_on_you) ? doc.waiting_on_you : []);
  }
  return n + doneRequests(store, root, project);
}

// Request files that are gone are done (done-request.sh deletes a handled one).
export function doneRequests(store: Store, root: string, project: string, at = mtime(join(root, project))): number {
  let n = 0;
  const open = store.db.query("SELECT id, payload FROM requests WHERE project = ? AND key LIKE 'file:%' AND done_at IS NULL").all(project) as { id: number; payload: string }[];
  for (const r of open) {
    const f = (JSON.parse(r.payload) as { file: string }).file;
    if (!existsSync(join(root, f))) n += store.db.run("UPDATE requests SET done_at = ?, result = 'file removed' WHERE id = ?", [at, r.id]).changes;
  }
  return n;
}

// One squad's members and units that left its document drop out (squad-state.ts calls it on every write).
export function pruneSquad(store: Store, project: string, topic: string, doc: Row): number {
  const db = store.db;
  let n = 0;
  const wts = ((doc.members as Row[]) ?? []).map((m) => String(m.wt));
  const slugs = ((doc.units as Row[]) ?? []).map((u) => String(u.slug));
  const left = "project = ? AND squad = ? AND doc IS NOT NULL AND wt NOT IN (SELECT value FROM json_each(?))";
  const args = [project, topic, JSON.stringify(wts)];
  // A wish follows its slot (role, suffix), as Store.resolve() reads it: when the file gave the slot a
  // new worker (a restart, rekey-member), the wish moves to that row; with no new worker the old row
  // is retired (gone, no doc) so the export never writes a twin.
  // Its one-time wishes (U151) move with it, each kind with its met stamp, the newer stamp winning.
  const wished = "(want IS NOT NULL OR restart_at IS NOT NULL OR reload_at IS NOT NULL OR clear_at IS NOT NULL)";
  for (const m of db.query(`SELECT * FROM members WHERE ${left} AND ${wished}`).all(...args) as Row[]) {
    const heir = db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? AND id != ? AND want IS NULL
      AND wt IN (SELECT value FROM json_each(?)) ORDER BY id DESC`).get(project, topic, m.role as string, m.suffix as string, m.id as number, JSON.stringify(wts)) as Row | null;
    if (heir) {
      const set: Row = { want: m.want, want_payload: m.want_payload, want_by: m.want_by, want_at: m.want_at, want_result: m.want_result };
      for (const cols of [["restart_at", "restart_mode", "restart_by"], ["reload_at", "reload_by"], ["clear_at", "clear_by"]])
        if (m[cols[0]] != null && !(Number(heir[cols[0]] ?? -Infinity) >= Number(m[cols[0]]))) for (const c of cols) set[c] = m[c];
      for (const c of ["reloaded_at", "cleared_at"]) if (m[c] != null && !(Number(heir[c] ?? -Infinity) >= Number(m[c]))) set[c] = m[c];
      db.run(`UPDATE members SET ${Object.keys(set).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...Object.values(set) as (string | number | null)[], heir.id as number]);
      n += db.run("DELETE FROM members WHERE id = ?", [m.id as number]).changes;
    } else n += db.run("UPDATE members SET status = 'gone', doc = NULL WHERE id = ?", [m.id as number]).changes;
  }
  n += db.run(`DELETE FROM members WHERE ${left} AND NOT ${wished}`, args).changes;
  n += db.run(`DELETE FROM units WHERE project = ? AND squad = ? AND doc IS NOT NULL AND slug NOT IN (SELECT value FROM json_each(?))`,
    [project, topic, JSON.stringify(slugs)]).changes;
  return n;
}

// One squad's file again, whole (U18's re-switch); the rows that changed, or null when the file
// cannot be imported.
export function importSquad(store: Store, root: string, project: string, topic: string, warn: (m: string) => void): number | null {
  return store.tx(() => {
    const skip: string[] = [], rows = squadRows(project, topic, join(root, project, "squads", `${topic}.json`), skip);
    skip.forEach(warn);
    if (!rows.length) return null;
    let n = 0;
    for (const r of rows) n += store.upsert(r.table, r.key, r.set) ? 1 : 0;
    n += store.db.run("UPDATE members SET status = 'running' WHERE project = ? AND squad = ? AND doc IS NOT NULL AND (status IS NULL OR status = 'gone')", [project, topic]).changes;
    const doc = JSON.parse(String(rows[0].set.doc)) as Row;
    n += pruneSquad(store, project, topic, doc);
    return n + sync(store, project, topic, Array.isArray(doc.waiting_on_you) ? doc.waiting_on_you : []);
  });
}

// Apply every state-file row of the state root; returns the number of rows that changed.
// A squad file that cannot be imported is skipped and reported through `warn`.
export function importJson(store: Store, root = store.root, warn: (m: string) => void = (m) => console.error(`ds import: skipped ${m}`)): number {
  return store.tx(() => {
    let n = 0;
    const skip: string[] = [];
    for (const r of hostRows(root)) n += store.upsert(r.table, r.key, r.set) ? 1 : 0;
    for (const p of discoverProjects(root)) {
      for (const r of projectRows(root, p, skip)) n += store.upsert(r.table, r.key, r.set) ? 1 : 0;
      n += prune(store, root, p);
    }
    skip.forEach(warn);
    return n;
  });
}
