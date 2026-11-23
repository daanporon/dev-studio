// store.ts — the one SQLite file of a state root and the only write path into it (Bun).
//
//   import { open } from "./store.ts";  const s = open();  // $DS_STATE_ROOT/loop.db
//
// Every writer goes through one of three paths (KTD15):
//   fact(kind, rows, ctx)            table rows + one `events` row, in one transaction; readable at once
//   want(subject, id, state, opts)   the wish columns of a squads/members row (a no-op when already set)
//   request(kind, payload, opts)     a one-off `requests` row; a known key returns the existing row
// Reconcilers change one column under a condition with setIf(); whole-row upserts (upsert()) are for
// observed tables and the importers only, so a fact written between observe and act is never lost.
//
// open() creates the file (WAL, busy timeout, foreign keys) and applies every migration in
// bin/loop/migrations/*.sql (or $DS_LOOP_MIGRATIONS) not yet recorded in schema_migrations, by
// filename order — a unit that lands out of number order still migrates (KTD14).
// Tests only: $DS_LOOP_DB_TEMPLATE names a loop.db already migrated with the shipped migrations
// (tests/loop/preload-db-template.ts); a new file opened with them starts as a copy (seed()).
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pause, resume, type PauseOptions, type PauseTarget } from "../pause/pause.ts";
import { FACTS, MEMBER_WANTS, ONE_TIME, REQUESTS, RESTART_MODES, SERVICE_WANTS, WANTS, WISH_PAYLOADS, problem, type RequestKind, type RequestPayload } from "./kinds.ts";
export { MEMBER_WANTS, ONE_TIME, RESTART_MODES, SERVICE_WANTS, WANTS };

export const ROOT = dirname(dirname(dirname(import.meta.dir)));
export const MIGRATIONS = join(import.meta.dir, "..", "migrations");

export function stateRoot(): string { return process.env.DS_STATE_ROOT || join(ROOT, "state"); }
export function dbPath(root = stateRoot()): string { return join(root, "loop.db"); }
// Epoch seconds; DS_NOW pins it, as in the shell scripts.
export function now(): number { return Number(process.env.DS_NOW) || Math.floor(Date.now() / 1000); }

export type Row = Record<string, unknown>;
export type Ctx = { project?: string | null; squad?: string | null; unit?: string | null; member?: string | null; payload?: unknown };
export type FactRow = { table: string; key: Row; set: Row };
export type Subject = "squad" | "member" | "service";
// A squad is wanted running, suspended or gone (archived).
// A member is wanted running, stopped (agent closed, worktree, branch and PR kept) or gone, the
// stored word for archived (U151): `archived` is accepted and stored as `gone`. Paused is not a
// member wish: it is the pause intents (pause.ts effective()).
// A service (the web board, U16) is wanted running or stopped.
const TABLE: Record<Subject, string> = { squad: "squads", member: "members", service: "services" };
const STATES: Record<Subject, readonly string[]> = { squad: WANTS, member: MEMBER_WANTS, service: SERVICE_WANTS };
// The stored word for a wished state: a member's `archived` is `gone`.
export function storedWant(subject: Subject, state: string): string { return subject === "member" && state === "archived" ? "gone" : state; }

// A member's one-time wishes (U151): `<kind>_at` (epoch s) and `<kind>_by`; restart also has a mode.
export type OneTime = (typeof ONE_TIME)[number];
export type RestartMode = (typeof RESTART_MODES)[number];
export type Pending = { wish: OneTime; at: number; age_s: number; by: string | null; mode?: string | null };
// The one-time wishes a member row still has open, oldest first. Reload and clear are met by the
// role's confirmation (reloaded_at, cleared_at; U156); a restart by the member's next start, read
// from placed_at until U149 observes the process start.
export function pendingWishes(m: Row, at = now()): Pending[] {
  const met: Record<OneTime, unknown> = { restart: m.placed_at, reload: m.reloaded_at, clear: m.cleared_at };
  const out: Pending[] = [];
  for (const k of ONE_TIME) {
    if (m[`${k}_at`] == null) continue;
    const wished = Number(m[`${k}_at`]);
    if (wished <= Number(met[k] ?? 0)) continue;
    out.push({ wish: k, at: wished, age_s: Math.max(0, at - wished), by: (m[`${k}_by`] as string | null) ?? null,
      ...(k === "restart" ? { mode: (m.restart_mode as string | null) ?? null } : {}) });
  }
  return out.sort((a, b) => a.at - b.at);
}
// Every key an overrides row may name a member by: its id, its worktree, project/squad/role[/suffix].
export const memberIds = (m: Row): string[] =>
  [String(m.id), m.wt ? String(m.wt) : "", `${m.project}/${m.squad}/${m.role}${m.suffix ? `/${m.suffix}` : ""}`].filter(Boolean);
// The events context of a member row.
function memberCtx(m: Row): Ctx {
  return { project: (m.project as string) || null, squad: (m.squad as string) || null, member: (m.wt as string | null) ?? `${m.role}${m.suffix ? `/${m.suffix}` : ""}` };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`store: bad identifier '${s}'`);
  return s;
}
// SQLite binds only primitives: objects and arrays are stored as JSON text, booleans as 0/1.
function bind(v: unknown): string | number | bigint | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number;
}
export function json(v: unknown): string | null { return v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v); }
// The key of a lifecycle script's replay payload ({kind, key, argv, …}; bin/loop/messages/replay.ts), or null.
function replayKey(p: unknown): string | null {
  try { const r = typeof p === "string" ? JSON.parse(p) : p; return Array.isArray(r?.argv) && typeof r.key === "string" ? r.key : null; } catch { return null; }
}

export function migrate(db: Database, dir = process.env.DS_LOOP_MIGRATIONS || MIGRATIONS): { applied: string[]; all: string[] } {
  // U243: the write lock only for a file still to apply. The table is created only when missing
  // (CREATE TABLE IF NOT EXISTS takes the lock even when it exists) and the list is read first, outside any transaction.
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get())
    db.run("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((db.query("SELECT filename FROM schema_migrations").all() as { filename: string }[]).map((r) => r.filename));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    // Checked again under the write lock: two processes opening a new file apply each migration once.
    const ran = db.transaction(() => {
      if (db.query("SELECT 1 FROM schema_migrations WHERE filename = ?").get(f)) return false;
      db.run(readFileSync(join(dir, f), "utf8"));
      db.run("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)", [f, now()]);
      return true;
    }).immediate();
    if (ran) applied.push(f);
  }
  return { applied, all: (db.query("SELECT filename FROM schema_migrations ORDER BY filename").all() as { filename: string }[]).map((r) => r.filename) };
}

// A test hook (squad-cpu-usage U3): with $DS_LOOP_DB_TEMPLATE set (not "0"), a loop.db that does not exist
// yet starts as a copy of that template instead of replaying every migration; migrate() then applies any it
// lacks. Only for the shipped migrations: a store with its own dir (opts.migrations, $DS_LOOP_MIGRATIONS)
// always migrates from scratch. The copy goes to a temp name and is hard-linked into place, so a second
// opener never sees half a file and an existing file is never replaced. Unset (production), nothing changes.
function seed(path: string, migrations?: string): boolean {
  const tpl = process.env.DS_LOOP_DB_TEMPLATE;
  if (!tpl || tpl === "0" || migrations || process.env.DS_LOOP_MIGRATIONS) return false;
  if (existsSync(path) || existsSync(`${path}-wal`) || !existsSync(tpl)) return false;
  const tmp = `${path}.seed-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    copyFileSync(tpl, tmp);
    linkSync(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

type RequestOpts = { key?: string | null; project?: string | null; squad?: string | null; member?: string | null; tier?: string | null; by?: string | null };

export class Store {
  readonly db: Database;
  readonly root: string;
  readonly migrated: { applied: string[]; all: string[] };
  private cols = new Map<string, Set<string>>();

  constructor(root = stateRoot(), opts: { migrations?: string; readonly?: boolean } = {}) {
    this.root = root;
    if (opts.readonly) {
      // A reader (the board): no create, no journal-mode switch, no migrations; a missing file throws.
      this.db = new Database(dbPath(root), { readonly: true });
      this.db.run("PRAGMA busy_timeout = 5000");
      this.migrated = { applied: [], all: [] };
      return;
    }
    mkdirSync(root, { recursive: true });
    const seeded = seed(dbPath(root), opts.migrations);
    this.db = new Database(dbPath(root), { create: true });
    this.db.run("PRAGMA busy_timeout = 5000");
    // SQLite does not call the busy handler for the journal-mode switch, so two processes opening a
    // new file at once can see SQLITE_BUSY here: retry it within the same 5 s.
    for (const end = Date.now() + 5000; ;) {
      try {
        if ((this.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "wal") this.db.run("PRAGMA journal_mode = WAL");
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "SQLITE_BUSY" || Date.now() > end) throw e;
        Bun.sleepSync(25);
      }
    }
    this.db.run("PRAGMA foreign_keys = ON");
    const m = migrate(this.db, opts.migrations);
    // A seeded file is as new as one migrated here: every migration it holds counts as applied by this open.
    this.migrated = seeded ? { applied: m.all, all: m.all } : m;
  }

  close(): void { this.db.close(); }

  pause(target: PauseTarget, opts: PauseOptions = {}): Row { return pause(this, target, opts, now()); }
  resume(target: PauseTarget): Row { return resume(this, target, now()); }

  // A write transaction. BEGIN IMMEDIATE takes the write lock up front, so a second writer waits out
  // the busy timeout instead of failing with SQLITE_BUSY when its read would turn into a write.
  tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }

  columns(table: string): Set<string> {
    let c = this.cols.get(table);
    if (!c) {
      c = new Set((this.db.query(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]).map((r) => r.name));
      if (c.size === 0) throw new Error(`store: no table '${table}'`);
      this.cols.set(table, c);
    }
    return c;
  }

  private check(table: string, row: Row): string[] {
    const have = this.columns(table);
    const ks = Object.keys(row);
    for (const k of ks) if (!have.has(k)) throw new Error(`store: ${table} has no column '${k}'`);
    return ks;
  }

  get(table: string, key: Row): Row | null {
    const ks = this.check(table, key);
    const where = ks.map((k) => `${k} IS ?`).join(" AND ");
    return (this.db.query(`SELECT rowid AS _rowid, * FROM ${ident(table)} WHERE ${where}`).get(...ks.map((k) => bind(key[k]))) as Row) ?? null;
  }

  // UPDATE … WHERE key, else INSERT key ∪ set. Returns true when a row changed or was added.
  // Internal to fact() and the importers/observers; never a reconciler's write (use setIf).
  upsert(table: string, key: Row, set: Row): boolean {
    const kk = this.check(table, key), sk = this.check(table, set);
    const where = kk.map((k) => `${k} IS ?`).join(" AND ");
    if (sk.length) {
      const changed = sk.map((k) => `${k} IS NOT ?`).join(" OR ");
      const r = this.db.run(`UPDATE ${ident(table)} SET ${sk.map((k) => `${k} = ?`).join(", ")} WHERE ${where} AND (${changed})`,
        [...sk.map((k) => bind(set[k])), ...kk.map((k) => bind(key[k])), ...sk.map((k) => bind(set[k]))]);
      if (r.changes > 0) return true;
    }
    if (this.get(table, key)) return false;
    const all = { ...key, ...set }, ak = Object.keys(all);
    this.db.run(`INSERT INTO ${ident(table)} (${ak.join(", ")}) VALUES (${ak.map(() => "?").join(", ")})`, ak.map((k) => bind(all[k])));
    return true;
  }

  event(kind: string, ctx: Ctx = {}): number {
    const r = this.db.run("INSERT INTO events (at, project, squad, unit, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [now(), ctx.project ?? null, ctx.squad ?? null, ctx.unit ?? null, ctx.member ?? null, kind, json(ctx.payload)]);
    return Number(r.lastInsertRowid);
  }

  // A fact: the rows and one events row in one transaction. Rows not changed by it still get the event.
  fact(kind: string, rows: FactRow[], ctx: Ctx = {}): number {
    const bad = problem("fact", kind, FACTS, ctx.payload);   // U43: before any write
    if (bad) throw new Error(bad);
    return this.tx(() => {
      for (const r of rows) this.upsert(r.table, r.key, r.set);
      return this.event(kind, ctx);
    });
  }

  // A reconciler's write: one column, only while it still holds `expected`. True when it applied.
  setIf(table: string, id: number, column: string, value: unknown, expected: unknown): boolean {
    this.check(table, { [column]: null });
    const r = this.db.run(`UPDATE ${ident(table)} SET ${ident(column)} = ? WHERE rowid = ? AND ${ident(column)} IS ?`, [bind(value), id, bind(expected)]);
    return r.changes > 0;
  }

  // Resolve a wish subject: a row id, a member's worktree id, `<project>/<topic>` (squad),
  // `<project>/<topic>/<role>[/<suffix>]` (member) or `<name>[/<project>[/<topic>]]` (service, one
  // row per scope: all, a project, a project + topic). A slot that has no row yet gets one.
  resolve(subject: Subject, id: string, create: boolean): Row | null {
    const table = TABLE[subject];
    if (/^\d+$/.test(id)) return this.db.query(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id)) as Row | null;
    const parts = id.split("/");
    const t = now();
    if (subject === "service") {
      const [name, project = "", topic = ""] = parts;
      if (!name || parts.length > 3 || (topic && !project)) throw new Error(`store: service id is a row id or <name>[/<project>[/<topic>]], not '${id}'`);
      const q = () => this.db.query("SELECT * FROM services WHERE name = ? AND project = ? AND topic = ?").get(name, project, topic) as Row | null;
      if (!q() && create) this.db.run("INSERT INTO services (name, project, topic, observed_at, updated_at) VALUES (?, ?, ?, ?, ?)", [name, project, topic, t, t]);
      return q();
    }
    if (subject === "squad") {
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`store: squad id is a row id or <project>/<topic>, not '${id}'`);
      const [project, topic] = parts;
      const q = () => this.db.query("SELECT * FROM squads WHERE project = ? AND topic = ?").get(project, topic) as Row | null;
      if (!q() && create) this.db.run("INSERT INTO squads (project, topic, observed_at, updated_at) VALUES (?, ?, ?, ?)", [project, topic, t, t]);
      return q();
    }
    const byWt = this.db.query("SELECT * FROM members WHERE wt = ? ORDER BY id DESC").get(id) as Row | null;
    if (byWt || parts.length < 3 || parts.length > 4) return byWt;
    const [project, squad, role, suffix = ""] = parts;
    // The live slot: a row not yet gone (a gone member's slot can be wanted again as a new row).
    const q = () => this.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
      .get(project, squad, role, suffix) as Row | null;
    if (!q() && create) this.db.run("INSERT INTO members (project, squad, role, suffix, observed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [project, squad, role, suffix, t, t]);
    return q();
  }

  // A wish. Asking for the same wish twice leaves one row and one event; returns the row. A wish the
  // loop gave up on or dropped (want_result `failed: …` or `dropped: …`) is asked again. `rearm` writes it again even so, with a
  // later want_at (a new episode) and want_result cleared. A wish for another state without a payload
  // drops the old payload, so a lifecycle script's replay never runs for a later wish. `fill` sets the
  // row's own columns (repo, type, tier, …) along with a wish that changed, so readers see a wished
  // row like any other. Two replays with one key are the same ask, from whichever cwd or terminal.
  want(subject: Subject, id: string, state: string, opts: { payload?: unknown; by?: string; why?: string; rearm?: boolean; fill?: Row } = {}): { row: Row; changed: boolean } {
    state = storedWant(subject, state);
    if (!STATES[subject].includes(state)) {
      const say = subject === "member" ? ["running", "stopped", "archived"] : STATES[subject];
      throw new Error(`store: a ${subject} want is one of ${say.join("|")}, not '${state}'`);
    }
    const table = TABLE[subject];
    if (opts.payload !== undefined && opts.payload !== null && typeof opts.payload !== "string") {
      const m = WISH_PAYLOADS[subject].check(opts.payload, "payload");   // U43
      if (m) throw new Error(`store: ${subject} wish '${state}': ${m}`);
    }
    const fill = Object.entries(opts.fill ?? {}).filter(([k]) => !k.startsWith("want"));
    this.check(table, Object.fromEntries(fill));
    return this.tx(() => {
      const row = this.resolve(subject, id, true);
      if (!row) throw new Error(`store: no ${subject} '${id}'`);
      const payload = json(opts.payload);
      const same = opts.payload === undefined || row.want_payload === payload || (replayKey(payload) !== null && replayKey(payload) === replayKey(row.want_payload));
      if (!opts.rearm && row.want === state && same && !/^(failed|dropped)/.test(String(row.want_result ?? ""))) return { row, changed: false };
      const t = opts.rearm ? Math.max(now(), Number(row.want_at ?? 0) + 1) : now();
      this.db.run(`UPDATE ${table} SET want = ?, want_payload = CASE WHEN ? IS NULL AND want IS NOT ? THEN NULL ELSE COALESCE(?, want_payload) END, want_by = ?, want_at = ?, want_result = NULL, updated_at = ?${fill.map(([k]) => `, ${ident(k)} = ?`).join("")} WHERE id = ?`,
        [state, payload, state, payload, opts.by ?? null, t, t, ...fill.map(([, v]) => bind(v)), row.id as number]);
      const out = this.db.query(`SELECT * FROM ${table} WHERE id = ?`).get(row.id as number) as Row;
      this.event("want", { ...(subject === "member" ? memberCtx(out) : { project: (out.project as string) || null, squad: (out.topic as string) || null }),
        payload: { subject, id: out.id, want: state, by: opts.by ?? null, field: "want", old: row.want ?? null, new: state, why: opts.why ?? null } });
      return { row: out, changed: true };
    });
  }

  // A member's one-time wish (U151): `<kind>_at` = the newer of the stored and the given stamp (default
  // now), so a repeat, or an older stamp, changes nothing and logs nothing. A restart also takes its
  // mode; at the same second a `now` lifts a pending `idle`. One `wish` event per write: field, old,
  // new, who and why. Nothing acts on these yet (the decider does).
  wishOnce(id: string, kind: OneTime, opts: { at?: number; by?: string; why?: string; mode?: RestartMode } = {}): { row: Row; changed: boolean } {
    if (!ONE_TIME.includes(kind)) throw new Error(`store: a one-time wish is one of ${ONE_TIME.join("|")}, not '${kind}'`);
    let mode = kind === "restart" ? opts.mode ?? "idle" : null;
    if (mode !== null && !RESTART_MODES.includes(mode)) throw new Error(`store: a restart is ${RESTART_MODES.join("|")}, not '${mode}'`);
    return this.tx(() => {
      const row = this.resolve("member", id, false);
      if (!row) throw new Error(`store: no member '${id}'`);
      const at = opts.at ?? now(), old = row[`${kind}_at`] == null ? null : Number(row[`${kind}_at`]);
      const newer = old === null || at > old || (at === old && mode === "now" && row.restart_mode !== "now");
      if (!newer) return { row, changed: false };
      // A later idle restart (a pin's) does not slow a `now` restart still pending.
      if (mode === "idle" && row.restart_mode === "now" && old !== null && old > Number(row.placed_at ?? 0)) mode = "now";
      const set: Row = { [`${kind}_at`]: at, [`${kind}_by`]: opts.by ?? null, ...(mode ? { restart_mode: mode } : {}) };
      const ks = Object.keys(set);
      this.db.run(`UPDATE members SET ${ks.map((k) => `${ident(k)} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...ks.map((k) => bind(set[k])), now(), Number(row.id)]);
      this.event("wish", { ...memberCtx(row), payload: { id: row.id, field: `${kind}_at`, old, new: at, ...(mode ? { mode, old_mode: row.restart_mode ?? null } : {}),
        by: opts.by ?? null, why: opts.why ?? null } });
      return { row: this.wish("member", Number(row.id))!, changed: true };
    });
  }

  // Pin a member to a model and/or an account (an `overrides` row, the only source of pins) and ask
  // for a restart once idle, in one transaction: the pin takes effect on the restart's pick. A new pin
  // replaces the member's open one. One event per field written.
  pin(id: string, p: { model?: string | null; account?: string | null }, opts: { by?: string; why?: string } = {}): { row: Row; override: number } {
    if (!p.model && !p.account) throw new Error("store: a pin needs a model or an account");
    return this.tx(() => {
      const row = this.resolve("member", id, false);
      if (!row) throw new Error(`store: no member '${id}'`);
      const at = now(), by = opts.by ?? null, key = row.wt ? String(row.wt) : memberIds(row).at(-1)!;
      const old = this.unpinIn(row, at, by, opts.why ?? "replaced");
      const r = this.db.run("INSERT INTO overrides (member, model, account, scope, set_by, set_at) VALUES (?, ?, ?, 'member', ?, ?)", [key, p.model || null, p.account || null, by, at]);
      const override = Number(r.lastInsertRowid);
      this.event("override_set", { ...memberCtx(row), payload: { id: override, model: p.model || null, account: p.account || null, by,
        field: "pin", old, new: { model: p.model || null, account: p.account || null }, why: opts.why ?? null } });
      return { row: this.wishOnce(String(row.id), "restart", { at, by: by ?? undefined, why: opts.why ?? "pin", mode: "idle" }).row, override };
    });
  }

  // Back to auto: clear the member's open pin. No restart: the pick moves it on its next restart.
  unpin(id: string, opts: { by?: string; why?: string } = {}): { row: Row; changed: boolean } {
    return this.tx(() => {
      const row = this.resolve("member", id, false);
      if (!row) throw new Error(`store: no member '${id}'`);
      return { row, changed: this.unpinIn(row, now(), opts.by ?? null, opts.why ?? "back to auto") !== null };
    });
  }

  // Clear the member's open overrides; the newest one cleared ({model, account}), or null for none.
  private unpinIn(row: Row, at: number, by: string | null, why: string): Row | null {
    const ids = JSON.stringify(memberIds(row));
    const open = this.db.query("SELECT model, account FROM overrides WHERE cleared_at IS NULL AND COALESCE(scope, 'member') = 'member' AND member IN (SELECT value FROM json_each(?)) ORDER BY id DESC").get(ids) as Row | null;
    const cleared = this.db.run("UPDATE overrides SET cleared_at = ? WHERE cleared_at IS NULL AND COALESCE(scope, 'member') = 'member' AND member IN (SELECT value FROM json_each(?))", [at, ids]).changes;
    if (!cleared) return null;
    this.event("override_cleared", { ...memberCtx(row), payload: { by, cleared, reason: why, field: "pin", old: open, new: null, why } });
    return open;
  }

  // A member's confirmation that it re-read its instructions after a reload wish (U156):
  // `ds reload ack` from the member's own live agent terminal. Session-checked like the pause
  // ack: the caller's terminal must be a live (not gone) terminal of the member's worktree, and
  // a reload must still be pending. An old session's ack does not count, and a stale one (nothing
  // pending) is refused. A fresh session after reload_at satisfies the wish without an ack (the
  // decider records it from the observed process start; for the Studio, reconcilers/studio.ts from
  // its adoption). The Studio's ack must come from its adopted handle (members.handle).
  acknowledgeReload(id: string, handle: string | undefined, at = now()): Row {
    return this.tx(() => {
      const row = this.resolve("member", id, false);
      if (!row) throw new Error(`store: no member '${id}'`);
      if (!handle) throw new Error("reload: acknowledgment must come from the instructed agent terminal");
      if (!row.wt) throw new Error("reload: the member has no worktree yet");
      const live = this.db.query("SELECT 1 FROM observed_terminals WHERE project = ? AND handle = ? AND wt = ? AND gone_at IS NULL")
        .get(row.project, handle, row.wt);
      if (!live) throw new Error("reload: acknowledgment must come from the member's live agent terminal (an old session's ack does not count)");
      // The Studio's worktree also holds ds-loop panes and shells: only its adopted terminal counts.
      if (row.squad === "_studio" && row.handle !== handle) throw new Error(`reload: acknowledgment must come from the Studio's adopted terminal (${row.handle ?? "none adopted"})`);
      if (row.reload_at == null || Number(row.reloaded_at ?? 0) >= Number(row.reload_at)) throw new Error("reload: no reload pending for this member (stale ack)");
      this.db.run("UPDATE members SET reloaded_at = ?, updated_at = ? WHERE id = ?", [at, at, Number(row.id)]);
      this.event("reload_ack", { ...memberCtx(row), payload: { id: row.id, at, by: handle } });
      return this.wish("member", Number(row.id))!;
    });
  }

  wish(subject: Subject, id: number): Row | null {
    return this.db.query(`SELECT * FROM ${TABLE[subject]} WHERE id = ?`).get(id) as Row | null;
  }

  // A one-off request. A known key returns the existing row (created=false) and adds nothing, unless
  // the loop gave up on that row ({ok: false}): it gives up its key and the request is made anew.
  request<K extends RequestKind>(kind: K, payload: RequestPayload<K>, opts: RequestOpts = {}): { row: Row; created: boolean } {
    return this.requestAny(kind, payload, opts);
  }

  // The same for a kind and payload only known at run time (a CLI, the board): checked when written, so
  // an unknown kind or a wrong payload throws, naming the kind and the field, and writes no row and no event.
  requestAny(kind: string, payload: unknown, opts: RequestOpts = {}): { row: Row; created: boolean } {
    const bad = problem("request", kind, REQUESTS, payload);
    if (bad) throw new Error(bad);
    return this.tx(() => {
      if (opts.key) {
        const hit = this.db.query("SELECT * FROM requests WHERE key = ?").get(opts.key) as Row | null;
        const gaveUp = hit?.done_at != null && /"ok":\s*false/.test(String(hit.result ?? ""));
        if (hit && !gaveUp) return { row: hit, created: false };
        if (hit) this.db.run("UPDATE requests SET key = NULL WHERE id = ?", [Number(hit.id)]);
      }
      const r = this.db.run("INSERT INTO requests (project, squad, member, kind, payload, tier, key, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [opts.project ?? null, opts.squad ?? null, opts.member ?? null, kind, json(payload), opts.tier ?? null, opts.key ?? null, opts.by ?? null, now()]);
      const row = this.db.query("SELECT * FROM requests WHERE id = ?").get(Number(r.lastInsertRowid)) as Row;
      this.event("request", { project: opts.project, squad: opts.squad, member: opts.member, payload: { id: row.id, kind, key: opts.key ?? null } });
      return { row, created: true };
    });
  }
}

export function open(root = stateRoot(), opts: { migrations?: string } = {}): Store { return new Store(root, opts); }
// loop.db for reading only (the board): WAL readers never block the loop's writer.
export function openReadOnly(root = stateRoot()): Store { return new Store(root, { readonly: true }); }
