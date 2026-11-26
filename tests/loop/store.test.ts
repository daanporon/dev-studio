// store.test.ts — U2: the SQLite store, its migrations, the importers, the export and the ds CLI.
// Every test works on a copy of tests/fixtures/loop/state in a temp dir (a hermetic state root).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, open, pendingWishes, type Store } from "../../bin/loop/core/store.ts";
import { discoverProjects } from "../../bin/loop/settings/projects.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { importMarkers, MARKER_KINDS } from "../../bin/loop/db/import-markers.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { exportJson } from "../../bin/loop/db/export-json.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const DS = join(ROOT, "bin", "ds");
const SQUAD = join("fx", "squads", "demo.json");

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed by the test */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(d); return d; }
function fixture(): string { const d = tmp(); cpSync(FIXTURE, d, { recursive: true }); return d; }
function store(root: string, migrations?: string): Store { const s = open(root, { migrations }); stores.push(s); return s; }
function importAll(s: Store) { return { json: importJson(s), markers: importMarkers(s), config: importConfig(s) }; }
function ds(root: string, ...args: string[]) {
  const p = Bun.spawnSync([DS, "--state", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const count = (s: Store, sql: string, ...a: (string | number)[]) => (s.db.query(sql).get(...a) as { n: number }).n;
function tableCounts(s: Store): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { name } of s.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    out[name] = count(s, `SELECT COUNT(*) AS n FROM ${name}`);
  }
  return out;
}

describe("import", () => {
  test("bin/ds import fills loop.db from the fixture; a second import changes nothing", () => {
    const root = fixture();
    const first = ds(root, "import");
    expect(first.code).toBe(0);
    const r1 = JSON.parse(first.out);
    expect(r1.json).toBeGreaterThan(0);
    expect(r1.markers).toBeGreaterThan(0);
    expect(r1.config).toBeGreaterThan(0);
    const s = store(root);
    const before = tableCounts(s);
    for (const t of ["projects", "squads", "members", "units", "requests", "episodes", "config", "documents", "accounts",
      "observed_alerts", "observed_prs", "observed_spend", "observed_accounts", "observed_tokens", "observed_markers"]) {
      expect(before[t], t).toBeGreaterThan(0);
    }
    s.close();
    const second = JSON.parse(ds(root, "import").out);
    expect([second.json, second.markers, second.config]).toEqual([0, 0, 0]);
    expect(tableCounts(store(root))).toEqual(before);
  });

  test("every observed and derived row carries observed_at", () => {
    const root = fixture(), s = store(root);
    importAll(s);
    const tables = (s.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
      .filter((t) => s.columns(t).has("observed_at"));
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) expect(count(s, `SELECT COUNT(*) AS n FROM ${t} WHERE observed_at IS NULL OR observed_at = 0`), t).toBe(0);
  });

  test("project discovery finds dirs with squads/ or dispatcher.json and skips the rest", () => {
    const root = fixture();
    expect(discoverProjects(root)).toEqual(["bare", "fx"]);
    const s = store(root);
    importAll(s);
    expect((s.db.query("SELECT label FROM projects ORDER BY label").all() as { label: string }[]).map((r) => r.label)).toEqual(["bare", "fx"]);
  });

  test("request files become requests rows, done once the file is gone", () => {
    const root = fixture(), s = store(root);
    importAll(s);
    const rows = s.db.query("SELECT kind, squad, done_at FROM requests ORDER BY kind").all();
    expect(rows).toEqual([{ kind: "restart", squad: "demo", done_at: null }, { kind: "switch", squad: null, done_at: null }]);
    rmSync(join(root, "fx", "requests", "demo", "restart-lead-1793100100.txt"));
    importJson(s);
    expect(count(s, "SELECT COUNT(*) AS n FROM requests WHERE kind = 'restart' AND done_at IS NOT NULL")).toBe(1);
  });
});

describe("markers", () => {
  test("one episode per fixture marker (source=sweep), the marker left in place", () => {
    const root = fixture(), s = store(root);
    importMarkers(s);
    const dir = join(root, "fx", "sweep");
    const markers = readdirSync(dir).filter((f) => MARKER_KINDS.some((k) => f.endsWith(`.${k}`)));
    expect(markers.length).toBeGreaterThanOrEqual(MARKER_KINDS.length);
    for (const k of MARKER_KINDS) expect(markers.some((f) => f.endsWith(`.${k}`)), k).toBe(true);
    for (const f of markers) {
      const kind = MARKER_KINDS.find((k) => f.endsWith(`.${k}`))!;
      const subject = f.slice(0, -(kind.length + 1));
      expect(count(s, "SELECT COUNT(*) AS n FROM episodes WHERE project = 'fx' AND subject = ? AND kind = ? AND source = 'sweep'", subject, kind), f).toBe(1);
      expect(existsSync(join(dir, f))).toBe(true);
    }
    // .accounts.episodes (host-wide), compacted.tsv and limited.json: one episode per line / entry.
    expect(count(s, "SELECT COUNT(*) AS n FROM episodes WHERE project = '' AND kind = 'account' AND source = 'sweep'")).toBe(1);
    expect(count(s, "SELECT COUNT(*) AS n FROM episodes WHERE kind = 'compacted'")).toBe(2);
    expect(count(s, "SELECT COUNT(*) AS n FROM episodes WHERE kind = 'limited'")).toBe(2);
    expect(existsSync(join(root, ".accounts.episodes"))).toBe(true);
    // A failed poke (n = -1) and the runaway-unit alert's squad.
    expect(s.db.query("SELECT state, count FROM episodes WHERE subject = 'demo.lead.limit' AND kind = 'poke'").get()).toEqual({ state: "failed", count: -1 });
    expect(s.db.query("SELECT squad FROM episodes WHERE subject = 'unit-tokens.demo.u2'").get()).toEqual({ squad: "demo" });
  });
});

describe("export", () => {
  test("bin/ds export writes the squad JSON byte-equal for an unchanged squad", () => {
    const root = fixture();
    expect(ds(root, "import").code).toBe(0);
    rmSync(join(root, SQUAD));
    const r = ds(root, "export");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).written).toEqual([join(root, SQUAD)]);
    expect(readFileSync(join(root, SQUAD), "utf8")).toBe(readFileSync(join(FIXTURE, SQUAD), "utf8"));
    expect(JSON.parse(ds(root, "export").out)).toEqual({ written: [], unchanged: [join(root, SQUAD)] });
  });

  test("a unit's PR recorded by squad-state.sh set-unit-pr round-trips through import and export", () => {
    const root = fixture();
    const set = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(root, SQUAD), "set-unit-pr", "u3-loop-daemon-skeleton-health", "105"], { stderr: "pipe" });
    expect(set.exitCode).toBe(0);
    const want = readFileSync(join(root, SQUAD), "utf8");
    const s = store(root);
    importAll(s);
    expect(s.db.query("SELECT pr FROM units WHERE slug = 'u3-loop-daemon-skeleton-health'").get()).toEqual({ pr: "105" });
    rmSync(join(root, SQUAD));
    exportJson(s);
    expect(readFileSync(join(root, SQUAD), "utf8")).toBe(want);
  });

  test("a column changed in SQLite lands in the export, the rest of the doc kept", () => {
    const root = fixture(), s = store(root);
    importAll(s);
    const u = s.get("units", { project: "fx", squad: "demo", slug: "u4-orca-state-file-config" })!;
    expect(s.setIf("units", Number(u._rowid), "status", "dispatched", "planned")).toBe(true);
    exportJson(s);
    const doc = JSON.parse(readFileSync(join(root, SQUAD), "utf8"));
    const was = JSON.parse(readFileSync(join(FIXTURE, SQUAD), "utf8"));
    expect(doc.units[3]).toEqual({ ...was.units[3], status: "dispatched" });
    expect(Object.keys(doc)).toEqual(Object.keys(was));
  });

  test("a member the loop started (no squad-state call) is exported with its worktree and assignment; an unowned recorded worktree stays", () => {
    const root = fixture();
    // A worktree recorded with add-worktree and owned by no member.
    const added = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(root, SQUAD), "add-worktree", "wtRecorded::/x"], { stdout: "pipe", stderr: "pipe" });
    expect(added.exitCode).toBe(0);
    const s = store(root);
    importAll(s);
    const at = 1793000001;
    // A loop start writes the member row, never the squad doc (fulfil/member.ts member_started):
    // one Builder with no doc yet, one whose doc carries its unit and Thinker.
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, doc, observed_at, updated_at) VALUES ('fx', 'demo', 'wtB99::/x', 'builder', 'u99', 'running', NULL, ?, ?)", [at, at]);
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, doc, observed_at, updated_at) VALUES ('fx', 'demo', 'wtB98::/x', 'builder', 'u98', 'running', ?, ?, ?)",
      [JSON.stringify({ role: "builder", suffix: "u98", owns: ["u98"], for: "onboarding" }), at, at]);
    rmSync(join(root, SQUAD));
    exportJson(s);
    const doc = JSON.parse(readFileSync(join(root, SQUAD), "utf8"));
    const was = JSON.parse(readFileSync(join(FIXTURE, SQUAD), "utf8"));
    const wts = (was.members as { wt: string }[]).map((m) => m.wt);
    expect(doc.worktrees).toEqual([...wts, "wtB98::/x", "wtB99::/x", "wtRecorded::/x"].sort());
    expect(doc.members.filter((m: { wt: string }) => m.wt === "wtB99::/x").length).toBe(1);
    expect(doc.assignments).toContainEqual({ builder: "u98", unit: "u98", thinker: "onboarding" });
    expect(Object.keys(doc)).toEqual(Object.keys(was));
  });
});

describe("review cases", () => {
  test("a squad whose file was removed (closed) is not exported again", () => {
    const root = fixture(), s = store(root);
    importAll(s);
    rmSync(join(root, SQUAD));
    importJson(s);
    expect(s.db.query("SELECT status FROM squads WHERE topic = 'demo'").get()).toEqual({ status: "closed" });
    expect(exportJson(s)).toEqual({ written: [], unchanged: [] });
    expect(existsSync(join(root, SQUAD))).toBe(false);
  });

  test("a retired member leaves the export, and a re-import does not bring it back to running", () => {
    const root = fixture(), s = store(root);
    importAll(s);
    const m = s.db.query("SELECT id FROM members WHERE role = 'builder'").get() as { id: number };
    s.want("member", String(m.id), "gone");
    expect(s.setIf("members", m.id, "status", "gone", "running")).toBe(true);
    // The squad file still lists the builder (not exported yet): a re-import keeps it gone.
    importJson(s);
    expect(s.db.query("SELECT status, want FROM members WHERE id = ?").get(m.id)).toEqual({ status: "gone", want: "gone" });
    exportJson(s);
    expect(JSON.parse(readFileSync(join(root, SQUAD), "utf8")).members.map((x: { role: string }) => x.role)).toEqual(["lead", "thinker"]);
    importJson(s);
    expect(s.db.query("SELECT status FROM members WHERE id = ?").get(m.id)).toEqual({ status: "gone" });
  });

  test("a wish follows its slot when the squad file gives it a new worker: no twin in the export", () => {
    const root = fixture(), s = store(root);
    importAll(s);
    const old = s.db.query("SELECT wt FROM members WHERE role = 'thinker'").get() as { wt: string };
    s.want("member", old.wt, "running", { by: "lead" });
    const doc = JSON.parse(readFileSync(join(root, SQUAD), "utf8"));
    doc.members[1].wt = "NEWWT::/x";
    writeFileSync(join(root, SQUAD), JSON.stringify(doc, null, 2) + "\n");
    importJson(s);
    expect(s.db.query("SELECT wt, want FROM members WHERE role = 'thinker'").all()).toEqual([{ wt: "NEWWT::/x", want: "running" }]);
    rmSync(join(root, SQUAD));
    exportJson(s);
    expect(JSON.parse(readFileSync(join(root, SQUAD), "utf8")).members.filter((x: { role: string }) => x.role === "thinker").length).toBe(1);
  });

  test("one-time wishes follow the slot to its new worker, with or without a standing want (U151)", () => {
    const root = fixture(), s = store(root);
    importAll(s);
    const old = s.db.query("SELECT id, wt FROM members WHERE role = 'thinker'").get() as { id: number; wt: string };
    s.wishOnce(String(old.id), "reload", { at: 1000, by: "op" });
    s.wishOnce(String(old.id), "restart", { at: 1100, by: "op", mode: "idle" });
    s.db.run("UPDATE members SET reloaded_at = 900 WHERE id = ?", [old.id]);
    const doc = JSON.parse(readFileSync(join(root, SQUAD), "utf8"));
    doc.members[1].wt = "NEWWT::/x";
    writeFileSync(join(root, SQUAD), JSON.stringify(doc, null, 2) + "\n");
    importJson(s);
    expect(s.db.query("SELECT wt, want, reload_at, reload_by, reloaded_at, restart_at, restart_mode, clear_at FROM members WHERE role = 'thinker'").all())
      .toEqual([{ wt: "NEWWT::/x", want: null, reload_at: 1000, reload_by: "op", reloaded_at: 900, restart_at: 1100, restart_mode: "idle", clear_at: null }]);
  });

  test("a squad file of the wrong shape is skipped and named; the rest still imports", () => {
    const root = fixture();
    writeFileSync(join(root, "fx", "squads", "broken.json"), JSON.stringify({ members: [null], units: [] }));
    writeFileSync(join(root, "fx", "squads", "torn.json"), "{\"members\": [");
    const r = ds(root, "import");
    expect(r.code).toBe(0);
    expect(r.err).toContain("broken.json: members is not a list of objects");
    expect(r.err).toContain("torn.json: not valid JSON");
    expect(JSON.parse(ds(root, "squads", "fx").out).map((x: { topic: string }) => x.topic)).toEqual(["demo"]);
  });

  test("many processes opening one new state root at once all succeed", async () => {
    for (let round = 0; round < 5; round++) {
      const root = tmp();
      const procs = Array.from({ length: 8 }, () => Bun.spawn([DS, "--state", root, "migrate"], { stdout: "pipe", stderr: "pipe" }));
      expect(await Promise.all(procs.map((p) => p.exited))).toEqual(Array(8).fill(0));
    }
  });
});

describe("units", () => {
  test("bin/ds units --ready prints the units squad-state.sh ready-units prints", () => {
    const root = fixture();
    expect(ds(root, "import").code).toBe(0);
    const sh = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(root, SQUAD), "ready-units"], { stdout: "pipe", stderr: "pipe" });
    const want = sh.stdout.toString().split("\n").filter(Boolean);
    expect(want).toEqual(["u3-loop-daemon-skeleton-health", "u6-takes-u5", "u9-ext-archived"]);
    expect(JSON.parse(ds(root, "units", "fx", "demo", "--ready").out)).toEqual(want);
    const all = JSON.parse(ds(root, "units", "fx", "demo").out);
    expect(all).toEqual(JSON.parse(readFileSync(join(FIXTURE, SQUAD), "utf8")).units);
  });
});

describe("migrations", () => {
  test("bin/ds migrate applies an unapplied migration even when it sorts below an applied one", () => {
    const root = tmp(), dir = join(tmp(), "migrations");
    mkdirSync(dir);
    copyFileSync(join(MIGRATIONS, "0001-init.sql"), join(dir, "0001-init.sql"));
    writeFileSync(join(dir, "0003-later.sql"), "CREATE TABLE zz_three (id INTEGER PRIMARY KEY);");
    const env = { ...process.env, DS_LOOP_MIGRATIONS: dir };
    const run = () => {
      const p = Bun.spawnSync([DS, "--state", root, "migrate"], { env, stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode).toBe(0);
      return JSON.parse(p.stdout.toString());
    };
    expect(run()).toEqual({ applied: ["0001-init.sql", "0003-later.sql"], all: ["0001-init.sql", "0003-later.sql"] });
    writeFileSync(join(dir, "0002-landed-late.sql"), "CREATE TABLE zz_two (id INTEGER PRIMARY KEY);");
    expect(run()).toEqual({ applied: ["0002-landed-late.sql"], all: ["0001-init.sql", "0002-landed-late.sql", "0003-later.sql"] });
    expect(run()).toEqual({ applied: [], all: ["0001-init.sql", "0002-landed-late.sql", "0003-later.sql"] });
  });
});

describe("U204: the avoid column", () => {
  test("the migration drops members.avoid (and any mark set before it); the store opens and writes", () => {
    const root = tmp(), dir = join(tmp(), "migrations");
    mkdirSync(dir);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0026-u204-no-avoid.sql")) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    const env = { ...process.env, DS_LOOP_MIGRATIONS: dir };
    expect(Bun.spawnSync([DS, "--state", root, "migrate"], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    const old = open(root, { migrations: dir });
    old.db.run("INSERT INTO members (project, squad, role, suffix, avoid, observed_at, updated_at) VALUES ('fx', 'demo', 'lead', '', 'claude:sonnet', 1, 1)");
    old.close();
    const s = store(root);   // the real migrations: 0026 runs
    const cols = (s.db.query("PRAGMA table_info(members)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("avoid");
    expect(s.db.query("SELECT COUNT(*) AS n FROM members WHERE project = 'fx'").get()).toEqual({ n: 1 });
  });
});

describe("issue #125 U1: migration 0059, the accounts own the list", () => {
  test("system and non-claude rows become system rows, claude rows in accounts.tsv orca rows Orca lists, the rest unlisted", () => {
    const root = tmp(), dir = join(tmp(), "migrations");
    mkdirSync(dir);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0059-accounts-own-list.sql")) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    const env = { ...process.env, DS_LOOP_MIGRATIONS: dir };
    expect(Bun.spawnSync([DS, "--state", root, "migrate"], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    const old = open(root, { migrations: dir });
    for (const [agent, account] of [["claude", "system"], ["claude", "listed"], ["claude", "unlisted"], ["codex", "default"], ["muse", "default"]])
      old.db.run("INSERT INTO accounts (agent, account, label, observed_at) VALUES (?, ?, ?, 1)", [agent, account, `${account} label`]);
    old.db.run("INSERT INTO observed_accounts (agent, account, observed_at) VALUES ('claude', 'listed', 1), ('claude', 'system', 1)");
    old.close();
    const s = store(root);
    const got = s.db.query("SELECT agent, account, source, orca_listed, is_default, removed_at, label FROM accounts ORDER BY agent, account").all();
    expect(got).toEqual([
      { agent: "claude", account: "listed", source: "orca", orca_listed: 1, is_default: 0, removed_at: null, label: "listed label" },
      { agent: "claude", account: "system", source: "system", orca_listed: 0, is_default: 0, removed_at: null, label: "system label" },
      { agent: "claude", account: "unlisted", source: null, orca_listed: 0, is_default: 0, removed_at: null, label: "unlisted label" },
      { agent: "codex", account: "default", source: "system", orca_listed: 0, is_default: 0, removed_at: null, label: "default label" },
      { agent: "muse", account: "default", source: "system", orca_listed: 0, is_default: 0, removed_at: null, label: "default label" },
    ]);
    // One default per agent, and the source is checked.
    s.db.run("UPDATE accounts SET is_default = 1 WHERE agent = 'claude' AND account = 'system'");
    expect(() => s.db.run("UPDATE accounts SET is_default = 1 WHERE agent = 'claude' AND account = 'listed'")).toThrow();
    expect(() => s.db.run("UPDATE accounts SET source = 'elsewhere' WHERE account = 'listed'")).toThrow();
    expect(s.db.query("SELECT COUNT(*) AS n FROM observed_account_folders").get()).toEqual({ n: 0 });
  });
});

describe("write paths", () => {
  test("a fact is readable at once in the same process, with its event", () => {
    const s = store(tmp());
    const ev = s.fact("unit-status", [{ table: "units", key: { project: "fx", squad: "demo", slug: "u1" }, set: { status: "done", observed_at: 1, updated_at: 1 } }],
      { project: "fx", squad: "demo", unit: "u1", payload: { status: "done" } });
    expect(s.get("units", { project: "fx", squad: "demo", slug: "u1" })!.status).toBe("done");
    expect(s.db.query("SELECT kind, unit, payload FROM events WHERE id = ?").get(ev)).toEqual({ kind: "unit-status", unit: "u1", payload: '{"status":"done"}' });
  });

  test("setIf after a fact returns false and the fact survives", () => {
    const s = store(tmp());
    s.fact("unit_dispatched", [{ table: "units", key: { project: "fx", squad: "demo", slug: "u1" }, set: { status: "planned", observed_at: 1, updated_at: 1 } }]);
    const id = Number(s.get("units", { project: "fx", squad: "demo", slug: "u1" })!._rowid);
    // A reconciler observed "planned"; a fact moves the unit on before it acts.
    s.fact("unit-status", [{ table: "units", key: { project: "fx", squad: "demo", slug: "u1" }, set: { status: "dispatched" } }]);
    expect(s.setIf("units", id, "status", "cancelled", "planned")).toBe(false);
    expect(s.get("units", { project: "fx", squad: "demo", slug: "u1" })!.status).toBe("dispatched");
  });

  test("the same wish twice leaves one row and one event", () => {
    const root = tmp(), s = store(root);
    const a = s.want("member", "fx/demo/builder/u3", "running", { by: "lead" });
    const b = s.want("member", "fx/demo/builder/u3", "running", { by: "lead" });
    expect([a.changed, b.changed]).toEqual([true, false]);
    expect(a.row.id).toBe(b.row.id);
    expect(count(s, "SELECT COUNT(*) AS n FROM members")).toBe(1);
    expect(count(s, "SELECT COUNT(*) AS n FROM events WHERE kind = 'want'")).toBe(1);
    const c = JSON.parse(ds(root, "want", "member", "fx/demo/builder/u3", "running").out);
    expect([c.id, c.changed]).toEqual([a.row.id, false]);
    expect(count(s, "SELECT COUNT(*) AS n FROM events WHERE kind = 'want'")).toBe(1);
  });

  // U151: a member's state wish and its one-time wishes.
  test("a member is wanted running, stopped or archived (stored gone); an unknown state is refused", () => {
    const s = store(tmp());
    s.want("member", "fx/demo/builder/u3", "running", { by: "lead" });
    expect(s.want("member", "fx/demo/builder/u3", "stopped", { by: "op", why: "park it" }).row.want).toBe("stopped");
    expect(s.want("member", "fx/demo/builder/u3", "archived", { by: "op" }).row.want).toBe("gone");
    expect(() => s.want("member", "fx/demo/builder/u3", "suspended")).toThrow(/running\|stopped\|archived/);
    expect(() => s.want("member", "fx/demo/builder/u3", "paused")).toThrow();
    expect(() => s.want("squad", "fx/demo", "stopped")).toThrow();
    const ev = (s.db.query("SELECT payload FROM events WHERE kind = 'want' ORDER BY id").all() as { payload: string }[]).map((e) => JSON.parse(e.payload));
    expect(ev.map((p) => [p.field, p.old, p.new, p.by])).toEqual([["want", null, "running", "lead"], ["want", "running", "stopped", "op"], ["want", "stopped", "gone", "op"]]);
    expect(ev[1].why).toBe("park it");
  });

  test("a one-time wish keeps the newer stamp: a repeat collapses, an older stamp is ignored", () => {
    const s = store(tmp());
    s.want("member", "fx/demo/builder/u3", "running");
    const id = "fx/demo/builder/u3", wishes = () => count(s, "SELECT COUNT(*) AS n FROM events WHERE kind = 'wish'");
    expect(s.wishOnce(id, "reload", { at: 1000, by: "op", why: "new notes" }).changed).toBe(true);
    expect(s.wishOnce(id, "reload", { at: 1000, by: "op" }).changed).toBe(false);
    expect(s.wishOnce(id, "reload", { at: 900, by: "lead" }).changed).toBe(false);
    let m = s.resolve("member", id, false)!;
    expect([m.reload_at, m.reload_by]).toEqual([1000, "op"]);
    expect(wishes()).toBe(1);
    expect(s.wishOnce(id, "reload", { at: 1100, by: "lead" }).changed).toBe(true);
    m = s.resolve("member", id, false)!;
    expect([m.reload_at, m.reload_by]).toEqual([1100, "lead"]);
    const last = JSON.parse((s.db.query("SELECT payload FROM events WHERE kind = 'wish' ORDER BY id DESC").get() as { payload: string }).payload);
    expect([last.field, last.old, last.new, last.by]).toEqual(["reload_at", 1000, 1100, "lead"]);
    // A restart: idle, then a `now` at the same second lifts it; an `idle` at that second does not lower it.
    expect(s.wishOnce(id, "restart", { at: 2000, mode: "idle" }).changed).toBe(true);
    expect(s.wishOnce(id, "restart", { at: 2000, mode: "now" }).changed).toBe(true);
    expect(s.wishOnce(id, "restart", { at: 2000, mode: "idle" }).changed).toBe(false);
    expect(s.resolve("member", id, false)!.restart_mode).toBe("now");
    // A later idle restart (a pin's) keeps a pending `now`; once the member restarted, idle is idle.
    expect(s.wishOnce(id, "restart", { at: 2100, mode: "idle" }).row.restart_mode).toBe("now");
    s.db.run("UPDATE members SET placed_at = 2200 WHERE id = ?", [Number(s.resolve("member", id, false)!.id)]);
    expect(s.wishOnce(id, "restart", { at: 2300, mode: "idle" }).row.restart_mode).toBe("idle");
    expect(() => s.wishOnce(id, "restart", { mode: "later" as never })).toThrow();
    expect(() => s.wishOnce("fx/demo/builder/nobody", "clear")).toThrow(/no member/);
  });

  test("pending one-time wishes: open until the member restarts, reloads or is cleared after them", () => {
    const s = store(tmp());
    const id = "fx/demo/builder/u3";
    s.want("member", id, "running");
    s.wishOnce(id, "restart", { at: 1000, by: "op", mode: "now" });
    s.wishOnce(id, "clear", { at: 1500, by: "lead" });
    s.wishOnce(id, "reload", { at: 1200, by: "op" });
    const r = s.resolve("member", id, false)!;
    expect(pendingWishes(r, 2000).map((p) => [p.wish, p.age_s, p.by])).toEqual([["restart", 1000, "op"], ["reload", 800, "op"], ["clear", 500, "lead"]]);
    expect(pendingWishes(r, 2000)[0].mode).toBe("now");
    expect(pendingWishes({ ...r, placed_at: 1001, reloaded_at: 1100, cleared_at: 1400 }, 2000).map((p) => p.wish)).toEqual(["reload", "clear"]);
  });

  test("a pin writes the overrides row and a restart once idle in one transaction; unpin clears it", () => {
    const s = store(tmp());
    const id = "fx/demo/builder/u3";
    s.want("member", id, "running", { fill: { wt: "fx-builder-u3" } });
    process.env.DS_NOW = "5000";
    try {
      const { row, override } = s.pin(id, { model: "sonnet" }, { by: "op", why: "cheaper" });
      expect([row.restart_at, row.restart_mode, row.restart_by]).toEqual([5000, "idle", "op"]);
      expect(s.db.query("SELECT member, model, account, set_by FROM overrides WHERE id = ?").get(override)).toEqual({ member: "fx-builder-u3", model: "sonnet", account: null, set_by: "op" });
      // A second pin replaces the first.
      s.pin(id, { account: "work" }, { by: "op" });
      expect(count(s, "SELECT COUNT(*) AS n FROM overrides WHERE cleared_at IS NULL")).toBe(1);
      expect(s.unpin(id, { by: "op" }).changed).toBe(true);
      expect(s.unpin(id, { by: "op" }).changed).toBe(false);
      expect(count(s, "SELECT COUNT(*) AS n FROM overrides WHERE cleared_at IS NULL")).toBe(0);
    } finally { delete process.env.DS_NOW; }
    // One transaction: a restart that cannot land rolls the pin back.
    const before = count(s, "SELECT COUNT(*) AS n FROM overrides");
    s.db.run("CREATE TRIGGER no_restart BEFORE UPDATE OF restart_at ON members BEGIN SELECT RAISE(ABORT, 'no'); END");
    expect(() => s.pin(id, { model: "opus" })).toThrow();
    expect(count(s, "SELECT COUNT(*) AS n FROM overrides")).toBe(before);
    expect(() => s.pin(id, {})).toThrow(/model or an account/);
  });

  test("ds want member: --restart [now|idle], --reload, --clear, --model, --unpin; ds members shows them", () => {
    const root = tmp();
    const want = (...a: string[]) => ds(root, "want", "member", "fx/demo/builder/u3", ...a);
    expect(want("running", "--by", "lead").code).toBe(0);
    const r1 = JSON.parse(want("--restart", "idle", "--by", "op", "--why", "stuck").out);
    expect([r1.restart_mode, r1.restart_by, r1.changed, r1.effective]).toEqual(["idle", "op", true, "running"]);
    expect(JSON.parse(want("--restart", "--by", "op").out).restart_mode).toBe("now");
    const r2 = JSON.parse(want("stopped", "--reload", "--clear", "--by", "op").out);
    expect([r2.want, r2.effective, r2.pending.map((p: { wish: string }) => p.wish)]).toEqual(["stopped", "stopped", ["restart", "reload", "clear"]]);
    expect(JSON.parse(want("--model", "sonnet", "--by", "op").out).changed).toBe(true);
    expect(JSON.parse(want("--unpin").out).changed).toBe(true);
    expect(want("suspended").code).not.toBe(0);
    expect(want().code).toBe(2);
    expect(ds(root, "want", "squad", "fx/demo", "--reload").code).toBe(2);
    expect(want("--model", "sonnet", "--unpin").code).toBe(2);
    // A pin on a disabled account is refused before anything is written (no state, pin or restart).
    { const a = store(root); a.db.run("INSERT INTO accounts (agent, account, state, observed_at) VALUES ('claude', 'work', 'disabled', 1)"); a.close(); }
    const before = JSON.parse(ds(root, "members").out)[0];
    const refused = want("running", "--account", "work", "--model", "opus");
    expect([refused.code, refused.err]).toEqual([2, expect.stringContaining("disabled")]);
    const after = JSON.parse(ds(root, "members").out)[0];
    expect([after.want, after.restart_at, after.pending.length]).toEqual([before.want, before.restart_at, before.pending.length]);
    const [m] = JSON.parse(ds(root, "members").out);
    expect([m.effective, m.pending.length, m.pending[0].by]).toEqual(["stopped", 3, "op"]);
    expect(JSON.parse(want("archived").out).effective).toBe("archived");
  });

  // The spawn env with the identity variables a role worktree sets removed, so a run inside one cannot leak them.
  const scrubbed = (extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of ["ORCA_TERMINAL_HANDLE", "DS_MEMBER", "DS_GEN", "DS_WT"]) delete env[k];
    return { ...env, ...extra } as Record<string, string>;
  };

  // A terminal with no Orca handle (tmux) confirms by DS_GEN and DS_WT.
  test("ds reload ack confirms from an off-Orca terminal by DS_GEN and DS_WT", () => {
    const root = tmp();
    const ack = (extra: Record<string, string>) => {
      const p = Bun.spawnSync([DS, "--state", root, "reload", "ack", "fx", "demo", "lead"], { stdout: "pipe", stderr: "pipe", env: scrubbed(extra) });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const s = store(root);
    s.want("member", "fx/demo/lead", "running", { fill: { wt: "local::/w/lead" } });
    s.wishOnce("fx/demo/lead", "reload", { at: 1000, by: "op" });
    s.upsert("observed_terminals", { project: "fx", handle: "tmux_1" }, { wt: "local::/w/lead", doc: JSON.stringify({ gen: "g1" }), observed_at: 1000 });
    s.close();
    const old = ack({ DS_GEN: "g-old", DS_WT: "/w/lead" });
    expect(old.code).not.toBe(0);
    expect(old.err).toContain("instructed agent terminal");
    const ok = ack({ DS_GEN: "g1", DS_WT: "/w/lead" });
    expect(ok.code).toBe(0);
    const t = store(root);
    expect(Number(t.get("members", { project: "fx", squad: "demo", role: "lead", suffix: "" })!.reloaded_at)).toBeGreaterThan(1000);
    expect(count(t, "SELECT COUNT(*) AS n FROM events WHERE kind = 'reload_ack'")).toBe(1);
    expect(String(t.db.query("SELECT payload FROM events WHERE kind = 'reload_ack'").get()!["payload" as never])).toContain("tmux_1");
    t.close();
  });

  // U156: the member confirms its reload from its own live agent terminal.
  test("ds reload ack confirms from the member's live terminal; an old session's ack does not count", () => {
    const savedHandle = process.env.ORCA_TERMINAL_HANDLE;
    delete process.env.ORCA_TERMINAL_HANDLE;
    const root = tmp();
    const ack = (...a: string[]) => {
      // Explicit env: a spawn without one inherits the process-start environment, not
      // this test's ORCA_TERMINAL_HANDLE assignments.
      const p = Bun.spawnSync([DS, "--state", root, "reload", ...a], { stdout: "pipe", stderr: "pipe", env: scrubbed(process.env.ORCA_TERMINAL_HANDLE ? { ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE } : {}) });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    expect(ack().code).toBe(2);
    expect(ack("ack", "fx", "demo").code).toBe(2);
    const s = store(root);
    s.want("member", "fx/demo/lead", "running", { fill: { wt: "id::/w/lead" } });
    s.wishOnce("fx/demo/lead", "reload", { at: 1000, by: "op" });
    s.upsert("observed_terminals", { project: "fx", handle: "term_live" }, { wt: "id::/w/lead", observed_at: 1000 });
    s.close();
    process.env.ORCA_TERMINAL_HANDLE = "term_live";
    try {
      const ok = ack("ack", "fx", "demo", "lead");
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.out).pending).toEqual([]);
      const t = store(root);
      expect(Number(t.get("members", { project: "fx", squad: "demo", role: "lead", suffix: "" })!.reloaded_at)).toBeGreaterThan(1000);
      expect(count(t, "SELECT COUNT(*) AS n FROM events WHERE kind = 'reload_ack'")).toBe(1);
      t.close();
      // Stale: nothing pending.
      const stale = ack("ack", "fx", "demo", "lead");
      expect(stale.code).not.toBe(0);
      expect(stale.err).toContain("stale");
    } finally { delete process.env.ORCA_TERMINAL_HANDLE; }
    // An old session's terminal (gone) does not count, nor does a foreign one.
    const s2 = store(root);
    s2.wishOnce("fx/demo/lead", "reload", { at: 2000, by: "op" });
    s2.upsert("observed_terminals", { project: "fx", handle: "term_old" }, { wt: "id::/w/lead", gone_at: 1500, observed_at: 1500 });
    s2.close();
    process.env.ORCA_TERMINAL_HANDLE = "term_old";
    try {
      const old = ack("ack", "fx", "demo", "lead");
      expect(old.code).not.toBe(0);
      expect(old.err).toContain("old session");
    } finally { delete process.env.ORCA_TERMINAL_HANDLE; }
    process.env.ORCA_TERMINAL_HANDLE = "term_elsewhere";
    try {
      const foreign = ack("ack", "fx", "demo", "lead", "-");
      expect(foreign.code).not.toBe(0);
      expect(foreign.err).toContain("live agent terminal");
    } finally { delete process.env.ORCA_TERMINAL_HANDLE; }
    const noHandle = ack("ack", "fx", "demo", "lead");
    expect(noHandle.code).not.toBe(0);
    expect(noHandle.err).toContain("instructed agent terminal");
    if (savedHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
    else process.env.ORCA_TERMINAL_HANDLE = savedHandle;
  });

  // U156: the ack command the reload text carries (suffix rendered as "-" when empty)
  // resolves back to the member, including a suffixed Builder.
  test("ds reload ack resolves a suffixed Builder", () => {
    const savedHandle = process.env.ORCA_TERMINAL_HANDLE;
    const root = tmp();
    const s = store(root);
    s.want("member", "fx/demo/builder/u3", "running", { fill: { wt: "id::/w/u3" } });
    s.wishOnce("fx/demo/builder/u3", "reload", { at: 1000, by: "op" });
    s.upsert("observed_terminals", { project: "fx", handle: "term_u3" }, { wt: "id::/w/u3", observed_at: 1000 });
    s.close();
    process.env.ORCA_TERMINAL_HANDLE = "term_u3";
    try {
      const p = Bun.spawnSync([DS, "--state", root, "reload", "ack", "fx", "demo", "builder", "u3"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      expect(p.exitCode).toBe(0);
      const t = store(root);
      expect(Number(t.get("members", { project: "fx", squad: "demo", role: "builder", suffix: "u3" })!.reloaded_at)).toBeGreaterThan(1000);
      t.close();
    } finally {
      if (savedHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE;
      else process.env.ORCA_TERMINAL_HANDLE = savedHandle;
    }
  });

  test("a keyed request twice exists once", () => {
    const root = tmp(), s = store(root);
    const a = s.request("poke", { text: "ping" }, { key: "poke:fx/demo/lead:1", project: "fx", squad: "demo" });
    const b = s.request("poke", { text: "ping again" }, { key: "poke:fx/demo/lead:1", project: "fx", squad: "demo" });
    expect([a.created, b.created, a.row.id]).toEqual([true, false, b.row.id]);
    const c = JSON.parse(ds(root, "nudge", "poke", "--json", '{"text":"ping"}', "--key", "poke:fx/demo/lead:1").out);
    expect([c.id, c.created]).toEqual([a.row.id, false]);
    expect(count(s, "SELECT COUNT(*) AS n FROM requests")).toBe(1);
    const d = JSON.parse(ds(root, "nudge", "keys", "--json", '{"text":"Escape"}', "--project", "fx").out);
    expect([d.kind, d.payload, d.created]).toEqual(["keys", { text: "Escape" }, true]);
  });

  test("ds want --wait with no loop exits non-zero and says asking again is a no-op", () => {
    const root = tmp();
    const r = ds(root, "want", "member", "fx/demo/builder/u3", "running", "--wait", "1");
    expect(r.code).not.toBe(0);
    const id = JSON.parse(r.out).id;
    expect(r.err).toContain(`still wanted (row ${id}); asking again is a no-op`);
  });

  test("ds want --wait returns once the loop makes the wish true", async () => {
    const root = tmp(), s = store(root);
    const { row } = s.want("member", "fx/demo/builder/u3", "running");
    const p = Bun.spawn([DS, "--state", root, "want", "member", String(row.id), "running", "--wait", "10"], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(300);
    expect(s.setIf("members", Number(row.id), "status", "running", null)).toBe(true);
    expect(await p.exited).toBe(0);
  });

  test("a lifecycle script's wish waits for the loop's result, not the status, and exits 1 once the loop gave up", async () => {
    const root = tmp(), s = store(root);
    const replay = { kind: "restart-role", key: "restart-role:fx/demo/builder-u3@k", argv: ["bin/commands/restart-role.sh", "fx", "demo", "builder", "u3"] };
    const { row } = s.want("member", "fx/demo/builder/u3", "running", { payload: replay });
    const id = Number(row.id), set = (sql: string) => s.db.run(`UPDATE members SET ${sql} WHERE id = ?`, [id]);
    set("status = 'running'");
    const p = Bun.spawn([DS, "--state", root, "want", "member", String(id), "running", "--payload", JSON.stringify(replay), "--wait", "10"], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(300);
    set("want_result = 'retrying: restart-role.sh exit 1: boom'");
    await Bun.sleep(300);
    set("want_result = 'failed: restart-role.sh exit 1: boom'");
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain(`the loop gave up (row ${id}): failed: restart-role.sh exit 1: boom`);
  });

  test("a wish for another state without a payload drops the old payload", () => {
    const root = tmp(), s = store(root);
    const replay = { kind: "add-role", key: "add-role:fx/demo/builder-u3", argv: ["bin/commands/add-role.sh", "fx", "demo", "builder", "u3"] };
    const { row } = s.want("member", "fx/demo/builder/u3", "running", { payload: replay });
    expect(s.want("member", String(row.id), "running").row.want_payload).toBe(JSON.stringify(replay));
    expect(s.want("member", String(row.id), "gone").row.want_payload).toBeNull();
  });

  test("a keyed request the loop gave up on is made anew; ds nudge --wait exits 1 on a given-up request", async () => {
    const root = tmp(), s = store(root);
    const a = s.request("finish-unit", { argv: ["x"] }, { key: "finish-unit:fx/demo/u1@abc", project: "fx" });
    s.db.run("UPDATE requests SET done_at = 1, result = ? WHERE id = ?", [JSON.stringify({ ok: false, error: "boom" }), Number(a.row.id)]);
    const b = s.request("finish-unit", { argv: ["x"] }, { key: "finish-unit:fx/demo/u1@abc", project: "fx" });
    expect(b.created).toBe(true);
    expect(b.row.id).not.toBe(a.row.id);
    expect(s.db.query("SELECT key FROM requests WHERE id = ?").get(Number(a.row.id))).toEqual({ key: null });
    expect(s.request("finish-unit", { argv: ["x"] }, { key: "finish-unit:fx/demo/u1@abc" }).created).toBe(false);
    const p = Bun.spawn([DS, "--state", root, "nudge", "poke", "--json", '{"text":"x"}', "--key", "poke:k", "--wait", "10"], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(300);
    s.db.run("UPDATE requests SET done_at = 2, result = ? WHERE key = 'poke:k'", [JSON.stringify({ ok: false, error: "boom" })]);
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("the loop gave up");
  });

  test("two processes creating, migrating and writing one new file at once both succeed", async () => {
    const root = tmp();
    const script = (tag: string) => `
      import { open } from ${JSON.stringify(join(ROOT, "bin", "loop", "core", "store.ts"))};
      const s = open(${JSON.stringify(root)});
      for (let i = 0; i < 100; i++) s.fact("unit_dispatched", [{ table: "units", key: { project: "fx", squad: "${tag}", slug: "u" + i }, set: { status: "planned", observed_at: i, updated_at: i } }]);
      s.close();`;
    const procs = ["a", "b"].map((t) => Bun.spawn(["bun", "-e", script(t)], { stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0]);
    const s = store(root);
    expect(count(s, "SELECT COUNT(*) AS n FROM units")).toBe(200);
    expect(count(s, "SELECT COUNT(*) AS n FROM events")).toBe(200);
    expect(count(s, "SELECT COUNT(*) AS n FROM schema_migrations")).toBe(readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).length);
  });
});

describe("ds reads", () => {
  test("squads, members, events, health and observed print JSON", () => {
    const root = fixture();
    expect(ds(root, "import").code).toBe(0);
    expect(JSON.parse(ds(root, "squads", "fx").out).map((r: { topic: string }) => r.topic)).toEqual(["demo"]);
    expect(JSON.parse(ds(root, "members", "fx", "demo").out).map((r: { role: string }) => r.role)).toEqual(["lead", "thinker", "builder"]);
    expect(JSON.parse(ds(root, "health").out)).toBeNull();
    expect(JSON.parse(ds(root, "observed").out)).toContain("prs");
    const prs = JSON.parse(ds(root, "observed", "prs", "--project", "fx").out);
    expect(prs.map((r: { ref: string; state: string }) => [r.ref, r.state])).toEqual([["demo/u2-sqlite-store-migrations-and", "OPEN"], ["demo/u1-spike-loop-as-coordinator", "MERGED"]]);
    expect(ds(root, "observed", "nope").code).toBe(2);
    store(root).want("squad", "fx/demo", "suspended");
    const ev = JSON.parse(ds(root, "events", "--since", "0").out);
    expect(ev.map((e: { kind: string }) => e.kind)).toEqual(["want"]);
    expect(JSON.parse(ds(root, "events", "--since", String(ev[0].id)).out)).toEqual([]);
  });

  test("ds events --kind --last prints only the newest event of that kind (U234: loop.sh --status)", () => {
    const root = fixture();
    const s = open(root); stores.push(s);
    for (const [at, kind, n] of [[1, "tick_slow", 1], [2, "other", 2], [3, "tick_slow", 3]] as const) s.db.run("INSERT INTO events (at, kind, payload) VALUES (?, ?, ?)", [at, kind, JSON.stringify({ n })]);
    s.close();
    const last = JSON.parse(ds(root, "events", "--kind", "tick_slow", "--last").out);
    expect(last.map((e: { payload: { n: number } }) => e.payload.n)).toEqual([3]);
    expect(JSON.parse(ds(root, "events", "--kind", "tick_slow").out).length).toBe(2);
  });
});
