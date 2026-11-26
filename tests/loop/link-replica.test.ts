// link-replica.test.ts — side-loop-host U6 (issue #127, KTD8/KTD9): rows down and observed rows up over the link.
// The side loop holds a copy of its own members, squads, projects, units and worktrees (ids in its own `local::`
// form); its observed rows appear on main tagged with its host, keys rewritten (`<host>::<path>`, `<host>:<handle>`);
// a row about another host's worktree is dropped; no table travels both ways; two hosts' terminals with the same
// pane id keep separate rows; a second sync ships only what changed, a gone row goes, a new link reconciles; and a
// main observer tick (procs, state, chat, reviews, codex) leaves every row uploaded by a side host unchanged.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { accept, ensureHostKey, requestJoin } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { DOWN, RowSync, UP, UP_MIGRATION, applyUp, upBatch } from "../../bin/link/replica.ts";
import { handleDown, handleUp, wtDown, wtUp } from "../../bin/loop/drivers/contract.ts";
import { procsObserver } from "../../bin/loop/observers/procs.ts";
import { stateObserver } from "../../bin/loop/observers/state.ts";
import { chatObserver } from "../../bin/loop/observers/chat.ts";
import { reviewsObserver } from "../../bin/loop/observers/reviews.ts";
import { codexObserver } from "../../bin/loop/observers/codex.ts";

const saved: Record<string, string | undefined> = {};
const ENV = { DS_LINK_PING_MS: "150", DS_LINK_DEAD_MS: "600", DS_LINK_BIND_ANY: undefined, DS_NOW: undefined };
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const temps: string[] = [], stores: Store[] = [], servers: LinkServer[] = [], clients: LinkClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), "zzreplica-")); temps.push(d); return d; };
const store = (root = temp()) => { const s = open(root); stores.push(s); return s; };
const all = (s: Store, sql: string, ...a: string[]) => s.db.query(sql).all(...a) as Row[];

// put: insert rows, filling the NOT NULL stamps the schema asks for (observed_at, updated_at, created_at, provider).
const STAMPS: Row = { observed_at: 100, updated_at: 100, created_at: 100, provider: "fx" };
function put(s: Store, table: string, ...rows: Row[]): void {
  const cols = s.columns(table);
  for (const r of rows) {
    const row: Row = { ...Object.fromEntries(Object.entries(STAMPS).filter(([k]) => cols.has(k))), ...r };
    const ks = Object.keys(row);
    s.db.run(`INSERT INTO ${table} (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as never));
  }
}

// Main: projects realp and otherp; a main member, two side members on host s1, one on s2 (same pane id %3 as s1's
// builder) and a main member in otherp with that pane id and worktree path too.
function seedMain(s: Store): void {
  put(s, "projects", { label: "realp", home_repo: "/r/realp" }, { label: "otherp", home_repo: "/r/otherp" });
  put(s, "squads", { id: 1, project: "realp", topic: "sq", status: "active" }, { id: 2, project: "otherp", topic: "quiet", status: "active" });
  const m = (id: number, role: string, wt: string, host: string | null, handle: string | null, project = "realp", squad = "sq") =>
    put(s, "members", { id, project, squad, role, wt, host, handle, status: "running" });
  m(1, "lead", "local::/w/lead", null, "%1");
  m(2, "builder", "s1::/w/a", "s1", "s1:%3");
  m(3, "tester", "s1::/w/b", "s1", "s1:%4");
  m(4, "builder", "s2::/w/a", "s2", "s2:%3");
  m(5, "builder", "local::/w/a", "local", "%3", "otherp", "quiet");
  put(s, "units", { project: "realp", squad: "sq", slug: "u1", status: "dispatched", builder_wt: "s1::/w/a" },
    { project: "realp", squad: "sq", slug: "u2", status: "dispatched", builder_wt: "local::/w/lead" });
  put(s, "worktrees", { host: "s1", path: "/w/a", project: "realp", squad: "sq", role: "builder" },
    { host: "s1", path: "/w/b", project: "realp", squad: "sq", role: "tester" }, { host: "local", path: "/w/lead", project: "realp", squad: "sq", role: "lead" });
  put(s, "config", { project: "", file: "limits.conf", key: "machine_load_warn", value: "4" },
    { project: "realp", file: "limits.conf", key: "max_builders", value: "3" }, { project: "otherp", file: "limits.conf", key: "max_builders", value: "9" });
  // main's own rows that share keys with what a side host will send
  put(s, "observed_terminals", { project: "otherp", handle: "%3", wt: "local::/w/a", title: "main pane" });
  put(s, "observed_procs", { project: "otherp", wt: "local::/w/a", procs: 2, rss_kb: 100 });
}

// The side's observers' rows: its own two worktrees, plus rows about worktrees that are not its own.
function seedSide(s: Store, handle = "%3"): void {
  put(s, "observed_machine", { host: "sidebox", cores: 8, load1: 1.5 });
  put(s, "observed_host_procs", { host: "sidebox", procs: 40, rss_kb: 5000 });
  put(s, "observed_procs", { project: "realp", wt: "local::/w/a", procs: 7, rss_kb: 700 }, { project: "realp", wt: "local::/w/b", procs: 3, rss_kb: 300 },
    { project: "realp", wt: "local::/w/lead", procs: 1, rss_kb: 1 }, { project: "realp", wt: "abc123::/w/a", procs: 1, rss_kb: 1 },
    { project: "otherp", wt: "local::/w/a", procs: 1, rss_kb: 1 });
  put(s, "observed_terminals", { project: "realp", handle, wt: "local::/w/a", title: "sq/builder" }, { project: "realp", handle: "%9", wt: null, title: "loose" });
  put(s, "observed_workers", { project: "realp", wt: "local::/w/a", state: "working" });
  put(s, "observed_worktrees", { project: "realp", wt: "local::/w/a", path: "/w/a", branch: "b-u1", parent: "local::/w/lead" });
  put(s, "observed_transcripts", { path: "/home/u/.claude/projects/-w-a/x.jsonl", project: "realp", wt: "local::/w/a", mtime: 50, size: 10 });
  put(s, "observed_rollouts", { path: "/home/u/.codex/sessions/r.jsonl", cwd: "/w/b", mtime: 50, size: 10 });
  put(s, "observed_chat", { project: "realp", wt: "local::/w/a", agent: "claude", source: "transcript", turns: "[]", updated_at: 100 });
  put(s, "observed_reviews", { project: "realp", squad: "sq", slug: "u1", wt: "/w/a", state: "running" },
    { project: "realp", squad: "sq", slug: "u2", wt: "/w/lead", state: "running" });
  // side-local only: never goes up
  put(s, "observed_cleanup_scan", { host: "sidebox", started_at: 1, ms: 1 });
}

async function linked(main: Store, mainRoot: string, name: string): Promise<{ side: Store; sync: RowSync }> {
  const srv = await startLinkServer({ root: mainRoot, store: main, binds: "127.0.0.1", port: 0 });
  servers.push(srv);
  const sideRoot = temp();
  const k = ensureHostKey(sideRoot);
  expect(requestJoin(main, { name, public_key: k.publicKey }).ok).toBe(true);
  expect(accept(main, name).ok).toBe(true);
  const c = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: sideRoot, name });
  clients.push(c);
  await c.start();
  const side = store(sideRoot);
  return { side, sync: new RowSync(side, (ch, body, t) => c.request(ch, body, t)) };
}

describe("lists", () => {
  test("no table travels both ways; up-tables are observed_* with their own primary key; cleanup and exposed stay home", () => {
    const up = UP.map((u) => u.table);
    expect(DOWN.filter((t) => up.includes(t))).toEqual([]);
    expect(up.filter((t) => !t.startsWith("observed_"))).toEqual([]);
    expect(up).not.toContain("observed_cleanup");
    expect(up).not.toContain("observed_exposed");
    const s = store();
    for (const u of UP) {
      const pk = (s.db.query(`PRAGMA table_info(${u.table})`).all() as { name: string; pk: number }[]).filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      expect([u.table, pk]).toEqual([u.table, [...u.key]]);
      expect([u.table, s.columns(u.table).has("host")]).toEqual([u.table, true]);
    }
    expect(UP_MIGRATION).toBe("0061-link-replica");
  });

  test("id helpers rewrite only their own form", () => {
    expect(wtUp("s1", "local::/w/a")).toBe("s1::/w/a");
    expect(wtUp("s1", "abc::/w/a")).toBeNull();
    expect(wtDown("s1", "s1::/w/a")).toBe("local::/w/a");
    expect(wtDown("s1", "s2::/w/a")).toBeNull();
    expect(handleUp("s1", "%3")).toBe("s1:%3");
    expect(handleDown("s1", "s1:%3")).toBe("%3");
    expect(handleDown("s1", "%3")).toBeNull();
  });
});

describe("over a real link", () => {
  test("down: the side holds its own members, squads, projects, units, worktrees and settings, in its own id form", async () => {
    const mainRoot = temp(), main = store(mainRoot);
    seedMain(main);
    const { side, sync } = await linked(main, mainRoot, "s1");
    await sync.tick();
    expect(all(side, "SELECT id, wt, host, handle FROM members ORDER BY id")).toEqual([
      { id: 2, wt: "local::/w/a", host: "local", handle: "%3" },
      { id: 3, wt: "local::/w/b", host: "local", handle: "%4" },
    ]);
    expect(all(side, "SELECT label FROM projects")).toEqual([{ label: "realp" }]);
    expect(all(side, "SELECT topic FROM squads")).toEqual([{ topic: "sq" }]);
    expect(all(side, "SELECT slug, builder_wt FROM units")).toEqual([{ slug: "u1", builder_wt: "local::/w/a" }]);
    expect(all(side, "SELECT host, path FROM worktrees ORDER BY path")).toEqual([{ host: "local", path: "/w/a" }, { host: "local", path: "/w/b" }]);
    expect(all(side, "SELECT project, key, value FROM config ORDER BY project, key")).toEqual([
      { project: "", key: "machine_load_warn", value: "4" }, { project: "realp", key: "max_builders", value: "3" },
    ]);
    // a member that moves off the host leaves the side's copy at the next tick
    main.db.run("UPDATE members SET host = 'local', wt = 'local::/w/b' WHERE id = 3");
    await sync.tick();
    expect(all(side, "SELECT id FROM members")).toEqual([{ id: 2 }]);
  });

  test("up: rows arrive tagged with the host, keys rewritten; rows about another host's worktree are dropped; side-local tables stay home", async () => {
    const mainRoot = temp(), main = store(mainRoot);
    seedMain(main);
    const { side, sync } = await linked(main, mainRoot, "s1");
    seedSide(side);
    const r = await sync.tick();
    expect(r.dropped).toBe(4);   // local::/w/lead, abc123::/w/a, otherp's /w/a, and review u2 (main's unit)
    expect(all(main, "SELECT host, cores FROM observed_machine")).toEqual([{ host: "s1", cores: 8 }]);
    expect(all(main, "SELECT host, procs FROM observed_host_procs")).toEqual([{ host: "s1", procs: 40 }]);
    expect(all(main, "SELECT project, wt, host, procs FROM observed_procs ORDER BY project, wt")).toEqual([
      { project: "otherp", wt: "local::/w/a", host: "local", procs: 2 },
      { project: "realp", wt: "s1::/w/a", host: "s1", procs: 7 },
      { project: "realp", wt: "s1::/w/b", host: "s1", procs: 3 },
    ]);
    expect(all(main, "SELECT project, handle, wt, host FROM observed_terminals ORDER BY project, handle")).toEqual([
      { project: "otherp", handle: "%3", wt: "local::/w/a", host: "local" },
      { project: "realp", handle: "s1:%3", wt: "s1::/w/a", host: "s1" },
      { project: "realp", handle: "s1:%9", wt: null, host: "s1" },
    ]);
    expect(all(main, "SELECT wt, parent, host FROM observed_worktrees")).toEqual([{ wt: "s1::/w/a", parent: null, host: "s1" }]);
    expect(all(main, "SELECT path, wt, host FROM observed_transcripts")).toEqual([{ path: "s1::/home/u/.claude/projects/-w-a/x.jsonl", wt: "s1::/w/a", host: "s1" }]);
    expect(all(main, "SELECT path, host FROM observed_rollouts")).toEqual([{ path: "s1::/home/u/.codex/sessions/r.jsonl", host: "s1" }]);
    expect(all(main, "SELECT wt, host FROM observed_chat")).toEqual([{ wt: "s1::/w/a", host: "s1" }]);
    expect(all(main, "SELECT slug, host FROM observed_reviews")).toEqual([{ slug: "u1", host: "s1" }]);
    expect(all(main, "SELECT COUNT(*) AS n FROM observed_cleanup_scan")).toEqual([{ n: 0 }]);
  });

  test("two hosts' terminals with the same pane id keep separate rows", async () => {
    const mainRoot = temp(), main = store(mainRoot);
    seedMain(main);
    const a = await linked(main, mainRoot, "s1");
    seedSide(a.side);
    await a.sync.tick();
    // s2 dials the same server through a second client
    const sideRoot = temp(), k = ensureHostKey(sideRoot);
    expect(requestJoin(main, { name: "s2", public_key: k.publicKey }).ok).toBe(true);
    expect(accept(main, "s2").ok).toBe(true);
    const c = new LinkClient({ main: `ws://127.0.0.1:${servers[0].port}`, root: sideRoot, name: "s2" });
    clients.push(c);
    await c.start();
    const side2 = store(sideRoot);
    const sync2 = new RowSync(side2, (ch, body, t) => c.request(ch, body, t));
    await sync2.tick();
    seedSide(side2);
    await sync2.tick();
    expect(all(main, "SELECT handle, wt, host FROM observed_terminals WHERE handle LIKE '%:%3' OR handle = '%3' ORDER BY handle")).toEqual([
      { handle: "%3", wt: "local::/w/a", host: "local" },
      { handle: "s1:%3", wt: "s1::/w/a", host: "s1" },
      { handle: "s2:%3", wt: "s2::/w/a", host: "s2" },
    ]);
    expect(all(main, "SELECT host FROM observed_machine ORDER BY host")).toEqual([{ host: "s1" }, { host: "s2" }]);
  });

  test("a second sync ships only what changed; a gone row goes; a new link drops what the side no longer has", async () => {
    const mainRoot = temp(), main = store(mainRoot);
    seedMain(main);
    const { side, sync } = await linked(main, mainRoot, "s1");
    seedSide(side);
    await sync.tick();
    expect((await sync.tick()).up).toBe(0);
    expect(upBatch(side, false).tables).toEqual([]);
    side.db.run("UPDATE observed_procs SET procs = 8 WHERE wt = 'local::/w/a'");
    side.db.run("DELETE FROM observed_procs WHERE wt = 'local::/w/b'");
    expect((await sync.tick()).up).toBe(1);
    expect(all(main, "SELECT wt, procs FROM observed_procs WHERE host = 's1'")).toEqual([{ wt: "s1::/w/a", procs: 8 }]);
    // rows lost while the link was down: the next link's full batch reconciles them
    side.db.run("DELETE FROM observed_terminals");
    side.db.run("DELETE FROM link_shipped");
    sync.linkUp();
    await sync.tick();
    expect(all(main, "SELECT handle FROM observed_terminals WHERE host = 's1'")).toEqual([]);
    expect(all(main, "SELECT handle FROM observed_terminals WHERE host = 'local'")).toEqual([{ handle: "%3" }]);
  });

  test("an up request names a table from the list, never any other", () => {
    const main = store();
    seedMain(main);
    expect(() => applyUp(main, "s1", { table: "members", rows: [{ id: 2, role: "lead" }] })).toThrow(/not an up-table/);
    expect(() => applyUp(main, "s1", { table: "observed_cleanup", rows: [] })).toThrow(/not an up-table/);
    // a wire column main does not have is ignored; host on the wire is overwritten
    expect(applyUp(main, "s1", { table: "observed_procs", rows: [{ project: "realp", wt: "local::/w/a", procs: 1, observed_at: 100, host: "s2", evil: "x" }] })).toEqual({ applied: 1, dropped: 0 });
    expect(all(main, "SELECT host FROM observed_procs WHERE wt = 's1::/w/a'")).toEqual([{ host: "s1" }]);
  });
});

describe("main's observers leave uploaded rows alone", () => {
  test("a main tick of procs, state, chat, reviews and codex leaves every row uploaded by a side host unchanged", async () => {
    const mainRoot = temp(), main = store(mainRoot);
    seedMain(main);
    const { side, sync } = await linked(main, mainRoot, "s1");
    seedSide(side);
    await sync.tick();
    const uploaded = () => Object.fromEntries(UP.map((u) => [u.table, all(main, `SELECT * FROM ${u.table} WHERE host = 's1' ORDER BY ${u.key.join(", ")}`)]));
    const before = uploaded();
    expect(before.observed_procs.length).toBe(2);
    // a main /proc with a process in /w/a: main's own worktree row has that path too
    const proc = temp();
    writeFileSync(join(proc, "stat"), "cpu  1 2 3 4\ncpu0 1 2 3 4\nbtime 1700000000\n");
    // one process, in no worktree: a scan with no process at all stops before it writes
    mkdirSync(join(proc, "1"));
    writeFileSync(join(proc, "1", "stat"), "1 (init) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1001 0 0\n");
    writeFileSync(join(proc, "1", "statm"), "100 25 0 0 0 0 0\n");
    symlinkSync(temp(), join(proc, "1", "cwd"));
    put(main, "observed_worktrees", { project: "otherp", wt: "local::/w/a", path: "/w/a" });
    const tokens = temp(), codex = temp();
    mkdirSync(join(tokens, "-w-a"), { recursive: true });
    writeFileSync(join(tokens, "-w-a", "main.jsonl"), "{}\n");
    const l = new Loop(main, {
      observers: [
        procsObserver({ proc, inspect: async () => null, cgroupRoot: temp() }),
        stateObserver({ tokenDir: tokens, lavishDir: temp(), lavishLog: join(temp(), "none.log"), refreshAccounts: () => {} }),
        chatObserver(),
        reviewsObserver(proc),
        codexObserver({ dir: codex }),
      ], reconcilers: [],
    }, { act() {} }, { projects: () => ["realp", "otherp"] });
    l.boot(2000);
    await l.tick(2000);
    await l.tick(2100);
    expect(uploaded()).toEqual(before);
    // and main's own rows still move: its procs scan saw no process, so its own procs row is gone
    expect(all(main, "SELECT wt FROM observed_procs WHERE host = 'local'")).toEqual([]);
  });
});
