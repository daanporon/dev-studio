// fulfil-account-move.test.ts — issue #125 U8: the `account-move` fulfiller behind `ds account move`. A fake HOME and
// Orca data folder with one managed profile (links, a plugin registry, made-up credentials), the live agent processes
// faked, the loop driven tick by tick. Never a real claude, Orca or provider.
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { accountMove, type LiveRead } from "../../bin/loop/fulfil/account-move.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { folderOf } from "../../bin/lib/account-dirs.ts";
import { MOVE_MARKER } from "../../bin/lib/account-folder.ts";

const T = 1_800_000_000;
const ID = "6b9a19e7-made-up-profile";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

// Every entry under `dir` (links as their targets, files as their text), so a test can tell a folder did not change.
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n), st = lstatSync(p), rel = relative(dir, p);
      if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(p)}`);
      else if (st.isDirectory()) { out.push(`${rel}/ ${(st.mode & 0o777).toString(8)}`); walk(p); }
      else out.push(`${rel} ${(st.mode & 0o777).toString(8)} ${st.mtimeMs} ${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

function rig(o: { live?: LiveRead } = {}) {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzam-"));
  temps.push(d);
  const home = join(d, "home"), orcaData = join(d, "orca");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  // The Orca profile: a link into ~/.claude, its own plugins dir with a registry (one live path, one dead, one
  // recorded through the profile itself), and a made-up login.
  const prof = join(orcaData, "claude-profiles", ID, "home");
  mkdirSync(join(prof, "plugins", "cache", "p-own", "1.0"), { recursive: true });
  mkdirSync(join(prof, "sessions"), { recursive: true });
  symlinkSync(join(home, ".claude", "projects"), join(prof, "projects"));
  writeFileSync(join(prof, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up-token" } }), { mode: 0o600 });
  writeFileSync(join(prof, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-moved" } }), { mode: 0o600 });
  writeFileSync(join(prof, "sessions", "s1.json"), "{}");
  writeFileSync(join(prof, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {
    "p-own@m": [{ scope: "user", installPath: join(prof, "plugins", "cache", "p-own", "1.0") }],
    "p-gone@m": [{ scope: "user", installPath: join(d, "nowhere", "p-gone") }],
  } }));
  const state = join(d, "state");
  const s = open(state);
  stores.push(s);
  s.db.run("INSERT INTO accounts (agent, account, label, config_dir, source, login_id, orca_listed, observed_at) VALUES ('claude', ?, 'moved@example.com', ?, 'orca', 'uuid-moved', 0, ?)", [ID, prof, T]);
  const env = { HOME: home, DS_STATE_ROOT: state, DS_ORCA_DATA: orcaData, DS_CLAUDE_SYSTEM_JSON_DIR: home };
  const procs: { agent: string; account: string }[] = [];
  const live: LiveRead = o.live ?? (async () => structuredClone(procs));
  const refreshed: string[] = [];
  const orca = new FakeOrca();
  const mk = () => accountMove({ live, refresh: (root) => refreshed.push(root), env });
  let f = mk(), act = new LoopActuator({ orca, fulfillers: [f] });
  let loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => [] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  const restart = async (at: number) => {
    f = mk(); act = new LoopActuator({ orca, fulfillers: [f] });
    loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => [] });
    loop.boot(at);
    await act.boot(s, at);
  };
  const file = (payload: Record<string, unknown> = {}) => Number(s.requestAny("account-move", { agent: "claude", account: ID, by: "test", ...payload }, { by: "test" }).row.id);
  const req = (id: number) => {
    const r = s.get("requests", { id }) as Row;
    return { done: r.done_at != null, ...(JSON.parse(String(r.result ?? "{}")) as Record<string, any>) };
  };
  const row = () => s.get("accounts", { agent: "claude", account: ID }) as Row;
  const target = join(state, "accounts", "claude", ID);
  return { s, d, home, prof, state, env, procs, refreshed, tick, restart, file, req, row, target };
}

test("moves: a whole copy with its links, the same id repointed, Orca's folder unchanged, the launch folder follows", async () => {
  const r = rig();
  const before = snapshot(r.prof);
  expect(folderOf(r.state, "claude", ID, r.env)).toBe(r.prof);
  const id = r.file();
  await r.tick(T + 1);
  const res = r.req(id);
  expect(res).toMatchObject({ done: true, ok: true, account: ID, from: r.prof, folder: r.target, forced: false });
  // The row: the same id, now a dev-studio row on the copy; the label and login stay.
  expect(r.row()).toMatchObject({ account: ID, source: "ds", config_dir: r.target, label: "moved@example.com", login_id: "uuid-moved" });
  expect((r.s.db.query("SELECT COUNT(*) AS n FROM accounts WHERE agent = 'claude'").get() as Row).n).toBe(1);
  // The copy: 0700, links kept as links, files and credentials there, the marker; no staging folder left.
  expect(statSync(r.target).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(r.target, "projects")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(r.target, "projects"))).toBe(join(r.home, ".claude", "projects"));
  expect(readFileSync(join(r.target, ".credentials.json"), "utf8")).toBe(readFileSync(join(r.prof, ".credentials.json"), "utf8"));
  expect(existsSync(join(r.target, "sessions", "s1.json"))).toBe(true);
  expect(readFileSync(join(r.target, MOVE_MARKER), "utf8").trim()).toBe(String(id));
  expect(readdirSync(join(r.state, "accounts", "claude"))).toEqual([ID]);
  // Orca's folder: not one entry, mode, time or byte changed.
  expect(snapshot(r.prof)).toBe(before);
  // The next launch reads the row: the copy, not Orca's folder.
  expect(folderOf(r.state, "claude", ID, r.env)).toBe(r.target);
  // The plugin scan: the dead path and the one recorded through Orca's folder are both reported.
  expect(res.dead_install_paths).toEqual([`p-gone@m (user scope) → ${join(r.d, "nowhere", "p-gone")}`]);
  expect(res.old_install_paths).toEqual([`p-own@m (user scope) → ${join(r.prof, "plugins", "cache", "p-own", "1.0")}`]);
  expect(res.text).toContain(`moved claude:${ID} to ${r.target}`);
  expect(res.text).toContain("Plugin installPath no longer resolves: p-gone@m");
  expect(res.text).toContain("still runs through Orca's folder");
  const ev = r.s.db.query("SELECT payload FROM events WHERE kind = 'account_moved'").all() as Row[];
  expect(ev.map((e) => JSON.parse(String(e.payload)))).toEqual([{ agent: "claude", account: ID, from: r.prof, to: r.target, force: false, by: "test" }]);
  expect(r.refreshed).toEqual([r.state]);
});

test("refuses a busy account: a live member configured or running on it, or a live agent process on it", async () => {
  const r = rig();
  const before = snapshot(r.prof);
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, wt, handle, account, observed_at, updated_at) VALUES ('fx', 'sq', 'builder', 'u1', 'wt-1', 'term-1', ?, ?, ?)", [ID, T, T]);
  r.s.db.run("INSERT INTO observed_workers (project, wt, observed_at) VALUES ('fx', 'wt-1', ?)", [T]);
  const a = r.file();
  await r.tick(T + 1);
  expect(r.req(a)).toMatchObject({ done: true, ok: false });
  expect(r.req(a).error).toContain("in use by fx/sq/builder-u1");
  // Configured elsewhere but running on it (its live account) counts too.
  r.s.db.run("UPDATE members SET account = 'system'");
  r.s.db.run("UPDATE observed_workers SET account = ?", [ID]);
  const b = r.file({ by: "test2" });
  await r.tick(T + 2);
  expect(r.req(b).error).toContain("in use by fx/sq/builder-u1");
  // A gone worker no longer counts; a live process on the account (a non-member, a sub) does.
  r.s.db.run("UPDATE observed_workers SET gone_at = ?", [T + 2]);
  r.procs.push({ agent: "claude", account: ID }, { agent: "codex", account: "default" });
  const c = r.file({ by: "test3" });
  await r.tick(T + 3);
  expect(r.req(c).error).toContain(`1 live claude process runs on claude:${ID}`);
  // Nothing was copied or written.
  expect(existsSync(join(r.state, "accounts"))).toBe(false);
  expect(r.row()).toMatchObject({ source: "orca", config_dir: r.prof });
  expect(snapshot(r.prof)).toBe(before);
  expect(r.s.db.query("SELECT 1 FROM events WHERE kind = 'account_moved'").get()).toBeNull();
});

test("an unreadable process list refuses rather than guessing", async () => {
  const r = rig({ live: async () => ({ error: "agent-accounts: unsupported" }) });
  const id = r.file();
  await r.tick(T + 1);
  expect(r.req(id).error).toContain("cannot tell whether an agent runs on");
  expect(existsSync(join(r.state, "accounts"))).toBe(false);
});

test("Orca still lists it: refused with the rotation risk unless forced; forced, it moves and says the risk", async () => {
  const r = rig();
  r.s.db.run("UPDATE accounts SET orca_listed = 1");
  const a = r.file();
  await r.tick(T + 1);
  expect(r.req(a)).toMatchObject({ done: true, ok: false });
  expect(r.req(a).error).toContain("Orca still lists");
  expect(r.req(a).error).toContain("the first copy to refresh logs the other out");
  expect(r.req(a).error).toContain("--force");
  expect(existsSync(r.target)).toBe(false);
  expect(r.row().source).toBe("orca");
  const b = r.file({ force: true, by: "test2" });
  await r.tick(T + 2);
  expect(r.req(b)).toMatchObject({ done: true, ok: true, forced: true });
  expect(r.req(b).text).toContain("Orca still lists it");
  expect(r.row()).toMatchObject({ source: "ds", config_dir: r.target, orca_listed: 1 });
});

test("refuses what is not an Orca row of Claude: the system login, another agent, a moved or removed row", async () => {
  const r = rig();
  const sys = Number(r.s.requestAny("account-move", { agent: "claude", account: "system" }, {}).row.id);
  const cdx = Number(r.s.requestAny("account-move", { agent: "codex", account: "default" }, {}).row.id);
  await r.tick(T + 1);
  expect(r.req(sys).error).toContain("the agent's own login");
  expect(r.req(cdx).error).toContain("only Claude accounts live in Orca's folders");
  r.s.db.run("UPDATE accounts SET removed_at = ?", [T]);
  const rm = r.file();
  await r.tick(T + 2);
  expect(r.req(rm).error).toContain("is removed");
  r.s.db.run("UPDATE accounts SET removed_at = NULL, source = 'ds'");
  const ds = r.file({ by: "again" });
  await r.tick(T + 3);
  expect(r.req(ds).error).toContain("already in dev-studio's folder");
  expect(existsSync(join(r.state, "accounts"))).toBe(false);
});

test("refused on the re-check after the copy: its own copy is removed, and the next move goes through", async () => {
  // A live member lands on the account while the copy runs (here: during the live-process read, just before it).
  let land = true;
  const r = rig({ live: async () => {
    if (land) {
      land = false;
      r.s.db.run("INSERT INTO members (project, squad, role, suffix, wt, handle, account, observed_at, updated_at) VALUES ('fx', 'sq', 'builder', 'u1', 'wt-1', 'term-1', ?, ?, ?)", [ID, T, T]);
      r.s.db.run("INSERT INTO observed_workers (project, wt, observed_at) VALUES ('fx', 'wt-1', ?)", [T]);
    }
    return [];
  } });
  const a = r.file();
  await r.tick(T + 1);
  expect(r.req(a).error).toContain("in use by fx/sq/builder-u1");
  expect(existsSync(r.target)).toBe(false);
  expect(r.row()).toMatchObject({ source: "orca", config_dir: r.prof });
  r.s.db.run("UPDATE observed_workers SET gone_at = ?", [T + 1]);
  const b = r.file({ by: "again" });
  await r.tick(T + 2);
  expect(r.req(b)).toMatchObject({ done: true, ok: true });
  expect(r.row()).toMatchObject({ source: "ds", config_dir: r.target });
});

test("a loop restart mid-move: a half copy is replaced, a finished copy is kept, and the move ends once", async () => {
  const r = rig();
  const id = r.file();
  // A staging folder an interrupted run left behind.
  mkdirSync(`${r.target}.moving-${id}`, { recursive: true });
  writeFileSync(join(`${r.target}.moving-${id}`, "half"), "x");
  await r.restart(T + 1);
  await r.tick(T + 2);
  expect(r.req(id)).toMatchObject({ done: true, ok: true });
  expect(existsSync(join(r.target, "half"))).toBe(false);
  expect(readdirSync(join(r.state, "accounts", "claude"))).toEqual([ID]);
  // A folder at the target that this request did not copy is never taken over.
  const r2 = rig();
  mkdirSync(r2.target, { recursive: true });
  writeFileSync(join(r2.target, "theirs"), "x");
  const id2 = r2.file();
  await r2.tick(T + 1);
  expect(r2.req(id2).error).toContain("already exists");
  expect(readdirSync(r2.target)).toEqual(["theirs"]);
  expect(r2.row().source).toBe("orca");
});
