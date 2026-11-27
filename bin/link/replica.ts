// replica.ts — side-loop-host U6 (issue #127, KTD8/KTD9): the side database is a one-way copy in each direction.
//   down   main → side: the projects, squads, members, units and worktrees of that host, and the settings its
//          observers read (`config`: the host's projects and the repo defaults). The side replaces its copy whole.
//   up     side → main: the observed_* tables its observers write, each listed with its key. Main forces `host` to
//          the link's host and drops a row about a worktree, unit or project that is not that host's.
// No table is in both lists (a test checks). Table and column names come from these lists and the local schema,
// never from the wire: a wire row's other fields are ignored. Keys that are only unique on one machine are
// rewritten at the boundary (drivers/contract.ts): a worktree id `local::<path>` goes up as `<host>::<path>` and
// comes down the other way, a terminal handle goes up as `<host>:<handle>`, a transcript, rollout or login folder
// path as `<host>::<path>`. Main's own observers write host `local` and scope their deletes to it (migration 0061).
// The side keeps what it last shipped in `link_shipped` (key → content hash), so a sync sends only changed rows and
// the keys that went away; on a new link it ships everything and main drops that host's rows the batch lacks.
// The `rows` channel (channels/rows.ts) answers on main; the side drives it with `RowSync.tick()`.
import type { Row, Store } from "../loop/core/store.ts";
import { handleDown, handleUp, wtDown, wtUp } from "../loop/drivers/contract.ts";

/** The newest migration that changed an up-table: the hello's `up_migration` (KTD15). */
export const UP_MIGRATION = "0063-side-skills";

/** Down: main → side. `where` picks the host's rows on main. */
export const DOWN: readonly string[] = ["projects", "squads", "members", "units", "worktrees", "config"];

type UpSpec = {
  table: string;
  key: readonly string[];
  /** The key is the host itself (observed_machine, observed_host_procs). */
  hostKey?: true;
  /** Worktree-id columns; the first one says which worktree the row is about. */
  wt?: readonly string[];
  /** A row with no worktree is kept (a terminal of no member). */
  wtNull?: true;
  /** A terminal-handle column, rewritten `<host>:<handle>`. */
  handle?: string;
  /** A path key, rewritten `<host>::<path>`. */
  path?: string;
  /** The row is about a unit (project, squad, slug) that must be the host's. */
  unit?: true;
};

/** Up: side → main. observed_cleanup and observed_exposed stay side-local, so main never acts on them. */
export const UP: readonly UpSpec[] = [
  { table: "observed_machine", key: ["host"], hostKey: true },
  { table: "observed_host_procs", key: ["host"], hostKey: true },
  { table: "observed_procs", key: ["project", "wt"], wt: ["wt"] },
  { table: "observed_workers", key: ["project", "wt"], wt: ["wt"] },
  { table: "observed_terminals", key: ["project", "handle"], wt: ["wt"], wtNull: true, handle: "handle" },
  { table: "observed_worktrees", key: ["project", "wt"], wt: ["wt", "parent"] },
  { table: "observed_transcripts", key: ["path"], wt: ["wt"], path: "path" },
  { table: "observed_rollouts", key: ["path"], path: "path" },
  { table: "observed_chat", key: ["project", "wt"], wt: ["wt"] },
  { table: "observed_reviews", key: ["project", "squad", "slug"], unit: true },
  // the side's own login folders (U18); main matches them to accounts by login id (capacity/accounts.ts)
  { table: "observed_account_folders", key: ["dir"], path: "dir" },
];
const UP_BY = new Map(UP.map((s) => [s.table, s]));

/** Bytes of rows per up request, under the link's frame cap. */
const CHUNK_BYTES = 1_500_000;

const pick = (row: Row, cols: Set<string>): Row => {
  const out: Row = {};
  for (const c of cols) if (Object.hasOwn(row, c)) out[c] = row[c];
  return out;
};
const keyOf = (row: Row, key: readonly string[]) => JSON.stringify(key.map((k) => row[k] ?? null));

// ---------------------------------------------------------------- down (main builds, side applies)

export type DownManifest = { host: string; rows: Record<string, Row[]> };

/** What main sends host `host`: its rows of each DOWN table, ids already in the side's form. */
export function downManifest(store: Store, host: string): DownManifest {
  const q = (sql: string, ...a: (string | null)[]) => store.db.query(sql).all(...a) as Row[];
  const members = q("SELECT * FROM members WHERE host = ? ORDER BY id", host);
  const projects = [...new Set(members.map((m) => String(m.project)))];
  const pairs = new Set(members.map((m) => `${m.project}\0${m.squad}`));
  const wts = new Set(members.map((m) => m.wt).filter((w): w is string => typeof w === "string"));
  const inP = JSON.stringify(projects);
  const rows: Record<string, Row[]> = {
    projects: q("SELECT * FROM projects WHERE label IN (SELECT value FROM json_each(?)) ORDER BY label", inP),
    squads: q("SELECT * FROM squads WHERE project IN (SELECT value FROM json_each(?)) ORDER BY id", inP).filter((s) => pairs.has(`${s.project}\0${s.topic}`)),
    members: members.map((m) => ({ ...m, host: "local", wt: wtDown(host, m.wt as string) ?? m.wt, handle: handleDown(host, m.handle as string) ?? m.handle })),
    units: q("SELECT * FROM units WHERE project IN (SELECT value FROM json_each(?)) ORDER BY id", inP)
      .filter((u) => wts.has(String(u.builder_wt))).map((u) => ({ ...u, builder_wt: wtDown(host, u.builder_wt as string) })),
    worktrees: q("SELECT * FROM worktrees WHERE host = ? ORDER BY path", host).map((w) => ({ ...w, host: "local" })),
    config: q("SELECT * FROM config WHERE project = '' OR project IN (SELECT value FROM json_each(?)) ORDER BY project, file, key", inP),
  };
  return { host, rows };
}

/** The side replaces each DOWN table with main's copy (only columns both schemas have). Returns rows written. */
export function applyDown(store: Store, m: DownManifest): number {
  let n = 0;
  store.tx(() => {
    for (const t of DOWN) {
      const got = Array.isArray(m.rows?.[t]) ? m.rows[t] : null;
      if (!got) continue;                        // an older main: leave that copy as it was
      const cols = store.columns(t);
      store.db.run(`DELETE FROM ${t}`);
      for (const raw of got) {
        const r = pick(raw, cols), ks = Object.keys(r);
        if (!ks.length) continue;
        store.db.run(`INSERT OR REPLACE INTO ${t} (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`,
          ks.map((k) => bind(r[k])));
        n++;
      }
    }
  });
  return n;
}

const bind = (v: unknown): string | number | bigint | boolean | null | Uint8Array =>
  v === undefined ? null : v !== null && typeof v === "object" && !(v instanceof Uint8Array) ? JSON.stringify(v) : v as string | number | null;

// ---------------------------------------------------------------- up (side builds, main applies)

export type UpTable = { table: string; rows: Row[]; gone: unknown[][]; keys?: unknown[][] };
export type UpBatch = { full: boolean; tables: UpTable[]; shipped: Map<string, Map<string, string>> };

const hashOf = (r: Row) => Bun.hash(JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).toString(36);

/** The side's rows to ship: with `full` every row of each up-table, else only rows whose hash changed since the
 *  last commit, plus the keys that went away. `shipped` is what `commitShipped` records once main has them. */
export function upBatch(store: Store, full: boolean): UpBatch {
  const tables: UpTable[] = [], shipped = new Map<string, Map<string, string>>();
  for (const s of UP) {
    const cols = store.columns(s.table);
    const rows = store.db.query(`SELECT * FROM ${s.table}${cols.has("host") && !s.hostKey ? " WHERE host = 'local'" : ""}`).all() as Row[];
    const before = full ? new Map<string, string>() : new Map((store.db.query("SELECT key, hash FROM link_shipped WHERE tbl = ?").all(s.table) as { key: string; hash: string }[]).map((r) => [r.key, r.hash]));
    const now = new Map<string, string>(), send: Row[] = [];
    for (const r of rows) {
      const k = keyOf(r, s.key), h = hashOf(r);
      now.set(k, h);
      if (before.get(k) !== h) send.push(r);
    }
    const gone = full ? [] : [...before.keys()].filter((k) => !now.has(k)).map((k) => JSON.parse(k) as unknown[]);
    shipped.set(s.table, now);
    if (!full && !send.length && !gone.length) continue;
    tables.push({ table: s.table, rows: send, gone, ...(full ? { keys: [...now.keys()].map((k) => JSON.parse(k) as unknown[]) } : {}) });
  }
  return { full, tables, shipped };
}

/** Main has the batch: record what was shipped, so the next batch sends only what changed. */
export function commitShipped(store: Store, b: UpBatch): void {
  store.tx(() => {
    for (const [t, rows] of b.shipped) {
      store.db.run("DELETE FROM link_shipped WHERE tbl = ?", [t]);
      for (const [key, hash] of rows) store.db.run("INSERT INTO link_shipped (tbl, key, hash) VALUES (?, ?, ?)", [t, key, hash]);
    }
  });
}

/** The batch as up requests, each under CHUNK_BYTES of rows; a table's `gone` and `keys` ride on its last chunk. */
export function upRequests(b: UpBatch): { op: "up"; table: string; rows: Row[]; gone: unknown[][]; keys?: unknown[][] }[] {
  const out: ReturnType<typeof upRequests> = [];
  for (const t of b.tables) {
    let chunk: Row[] = [], size = 0;
    for (const r of t.rows) {
      const n = JSON.stringify(r).length;
      if (chunk.length && size + n > CHUNK_BYTES) { out.push({ op: "up", table: t.table, rows: chunk, gone: [] }); chunk = []; size = 0; }
      chunk.push(r); size += n;
    }
    out.push({ op: "up", table: t.table, rows: chunk, gone: t.gone, ...(t.keys ? { keys: t.keys } : {}) });
  }
  return out;
}

/** What main knows is host `host`'s: its members' projects, worktree ids and units. */
function hostScope(store: Store, host: string) {
  const members = store.db.query("SELECT project, wt FROM members WHERE host = ?").all(host) as { project: string; wt: string | null }[];
  const wts = new Set(members.map((m) => m.wt).filter((w): w is string => !!w));
  for (const w of store.db.query("SELECT path FROM worktrees WHERE host = ? AND gone_at IS NULL").all(host) as { path: string }[]) wts.add(`${host}::${w.path}`);
  const units = new Set((store.db.query("SELECT project, squad, slug, builder_wt FROM units WHERE COALESCE(builder_wt, '') != ''").all() as Row[])
    .filter((u) => wts.has(String(u.builder_wt))).map((u) => `${u.project}\0${u.squad}\0${u.slug}`));
  return { projects: new Set(members.map((m) => m.project)), wts, units };
}

/** One row in main's form, or null when it is not about this host. Mutates nothing. */
function rowUp(s: UpSpec, raw: Row, host: string, cols: Set<string>, scope: ReturnType<typeof hostScope> | null): Row | null {
  const r = pick(raw, cols);
  r.host = host;
  if (s.hostKey) return r;
  for (const c of s.wt ?? []) {
    if (r[c] == null) continue;
    const up = wtUp(host, String(r[c]));
    if (up === null && c === s.wt![0]) return null;   // another host's (or Orca's) worktree
    r[c] = up;
  }
  if (s.handle && r[s.handle] != null) r[s.handle] = handleUp(host, String(r[s.handle]));
  if (s.path && r[s.path] != null) r[s.path] = `${host}::${String(r[s.path])}`;
  if (!scope) return r;
  if (cols.has("project") && r.project != null && !scope.projects.has(String(r.project))) return null;
  if (s.wt) {
    const w = r[s.wt[0]];
    if (w == null ? !s.wtNull : !scope.wts.has(String(w))) return null;
    // a secondary id (a worktree's parent) that is not the host's own names a worktree on main: left out
    for (const c of s.wt.slice(1)) if (r[c] != null && !scope.wts.has(String(r[c]))) r[c] = null;
  }
  if (s.unit && !scope.units.has(`${r.project}\0${r.squad}\0${r.slug}`)) return null;
  return r;
}

/** Main's half of an up request from host `host`: upsert the host's rows, delete its gone keys, and with `keys`
 *  (a full batch) delete the host's rows the batch lacks. Returns rows applied and rows dropped. */
export function applyUp(store: Store, host: string, body: { table?: unknown; rows?: unknown; gone?: unknown; keys?: unknown }): { applied: number; dropped: number } {
  const s = UP_BY.get(String(body.table));
  if (!s) throw new Error(`rows: '${String(body.table)}' is not an up-table`);
  const cols = store.columns(s.table);
  const scope = hostScope(store, host);
  const keyRow = (k: unknown): Row | null => {
    if (!Array.isArray(k) || k.length !== s.key.length) return null;
    const r = rowUp(s, Object.fromEntries(s.key.map((c, i) => [c, k[i]])), host, cols, null);
    return r && s.key.every((c) => r[c] !== undefined) ? r : null;
  };
  const where = s.key.map((k) => `${k} IS ?`).join(" AND ");
  let applied = 0, dropped = 0;
  store.tx(() => {
    for (const raw of Array.isArray(body.rows) ? body.rows : []) {
      const r = raw && typeof raw === "object" ? rowUp(s, raw as Row, host, cols, scope) : null;
      if (!r) { dropped++; continue; }
      const key = Object.fromEntries(s.key.map((k) => [k, r[k] ?? null])), set: Row = {};
      for (const [c, v] of Object.entries(r)) if (!s.key.includes(c)) set[c] = bind(v);
      store.upsert(s.table, key, set);
      applied++;
    }
    for (const k of Array.isArray(body.gone) ? body.gone : []) {
      const r = keyRow(k);
      if (r) store.db.run(`DELETE FROM ${s.table} WHERE ${where} AND host = ?`, [...s.key.map((c) => bind(r[c])), host]);
    }
    if (Array.isArray(body.keys)) {
      const keep = new Set(body.keys.map(keyRow).filter((r): r is Row => !!r).map((r) => keyOf(r, s.key)));
      for (const r of store.db.query(`SELECT ${s.key.join(", ")} FROM ${s.table} WHERE host = ?`).all(host) as Row[]) {
        if (!keep.has(keyOf(r, s.key))) store.db.run(`DELETE FROM ${s.table} WHERE ${where} AND host = ?`, [...s.key.map((c) => bind(r[c])), host]);
      }
    }
  });
  return { applied, dropped };
}

// ---------------------------------------------------------------- the side's driver

type Request = (ch: string, body: unknown, timeoutMs?: number) => Promise<unknown>;

/** The side's sync over the link: each tick pulls the down copy, then ships the up rows that changed. Call
 *  `linkUp()` on each new link, so the next tick ships everything and main drops what the side no longer has. */
export class RowSync {
  private full = true;
  constructor(private store: Store, private request: Request) {}

  linkUp(): void { this.full = true; }

  async tick(): Promise<{ down: number; up: number; dropped: number }> {
    const m = await this.request("rows", { op: "down" }) as DownManifest;
    const down = applyDown(this.store, m);
    const b = upBatch(this.store, this.full);
    let up = 0, dropped = 0;
    for (const req of upRequests(b)) {
      const r = await this.request("rows", req) as { applied: number; dropped: number };
      up += r.applied; dropped += r.dropped;
    }
    commitShipped(this.store, b);
    this.full = false;
    return { down, up, dropped };
  }
}
