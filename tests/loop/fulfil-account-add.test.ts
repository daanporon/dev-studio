// fulfil-account-add.test.ts — issue #125 U5: the `account-add` fulfiller behind `ds account add`. Fake terminals
// (and once the fake Orca), a fake HOME with a system ~/.claude, fake account kinds for a device flow and a one-login
// agent; the "login" is the test writing the credentials into the folder. Never a real claude or provider.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { accountAdd, DEADLINE_S, NO_LINK, NOT_FINISHED, type LoginTerm, type Terminals } from "../../bin/loop/fulfil/account-add.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { KINDS, type AccountKind } from "../../bin/lib/account-kinds/index.ts";
import { MARKER } from "../../bin/lib/account-folder.ts";

const T = 1_800_000_000;
const URL = "https://claude.ai/oauth/authorize?code=true&client_id=made-up-client&state=abc123";
const temps: string[] = [], stores: Store[] = [];

// A device-flow kind and a one-login kind, so U11/U12's kinds take the same path.
const device: AccountKind = {
  agent: "fakedev", systemId: "default", multi: true, envVar: "FAKEDEV_HOME", systemDir: (env) => join(env.HOME || "", ".fakedev"),
  links: [], credentialsFile: "auth.json",
  loginId: (folder) => { try { return JSON.parse(readFileSync(join(folder, "auth.json"), "utf8")).id ?? null; } catch { return null; } },
  login: { command: ["fakedev", "login"], flow: "device", read: (screen) => {
    const url = screen.match(/https:\/\/\S+/)?.[0], code = screen.match(/\b[A-Z]{4}-[0-9]{4}\b/)?.[0];
    return { ...(url ? { url } : {}), ...(code ? { device_code: code } : {}), prompt: false };
  } },
  usage: false, resets: false,
};
const single: AccountKind = { ...device, agent: "fakeone", multi: false, why: "fakeone keeps one login for now" };
beforeAll(() => { (KINDS as AccountKind[]).push(device, single); });
afterAll(() => { (KINDS as AccountKind[]).splice(KINDS.indexOf(device), 2); });
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

// Fake terminals: what was opened and closed, and a screen per terminal the test writes.
function fakeTerms() {
  const opened: { project: string; folder: string; line: string; label: string }[] = [], closed: string[] = [], screens = new Map<string, string>();
  const terms: Terminals = {
    async open(_x, project, req) { opened.push({ project, ...req }); const h = `t${opened.length}`; screens.set(h, ""); return { via: "orca", handle: h, project }; },
    async read(_x, t: LoginTerm) { return screens.has(t.handle) ? screens.get(t.handle)! : null; },
    async close(_x, t: LoginTerm) { closed.push(t.handle); screens.delete(t.handle); },
    async type() { return false; },
  };
  return { terms, opened, closed, screens };
}

function rig(o: { orca?: FakeOrca; terms?: ReturnType<typeof fakeTerms> | null } = {}) {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzaa-"));
  temps.push(d);
  const home = join(d, "home");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  writeFileSync(join(home, ".claude", "history.jsonl"), "");
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "9.9.9", oauthAccount: { accountUuid: "uuid-sys" } }));
  const state = join(d, "state");
  const s = open(state);
  stores.push(s);
  s.upsert("projects", { label: "fx" }, { studio_wt: "wt-studio", observed_at: T });
  const env = { HOME: home, DS_STATE_ROOT: state };
  const orca = o.orca ?? new FakeOrca();
  const t = o.terms === null ? null : o.terms ?? fakeTerms();
  const refreshed: string[] = [];
  const mk = () => accountAdd({ ...(t ? { terminals: t.terms } : {}), refresh: (root) => refreshed.push(root), env });
  let f = mk(), act = new LoopActuator({ orca, fulfillers: [f] });
  let loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  // A loop restart: a new actuator and loop on the same db; a running action goes back to pending.
  const restart = async (at: number) => {
    f = mk(); act = new LoopActuator({ orca, fulfillers: [f] });
    loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
    loop.boot(at);
    await act.boot(s, at);
  };
  return { s, d, home, state, env, orca, t: t!, refreshed, tick, restart };
}

const file = (s: Store, payload: Record<string, unknown>) =>
  Number(s.requestAny("account-add", { agent: "claude", project: "fx", ...payload }, { project: "fx", by: "cli" }).row.id);
const result = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) } as Record<string, unknown>;
};
const rows = (s: Store, agent = "claude") => s.db.query("SELECT account, label, config_dir, source, login_id, removed_at FROM accounts WHERE agent = ? ORDER BY account").all(agent) as Row[];
const logIn = (folder: string, uuid: string) => {
  writeFileSync(join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
  writeFileSync(join(folder, ".credentials.json"), "{}");
};
// Every path under a folder with its mode (links not followed): moved, copied, written or removed shows here.
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const n of readdirSync(p).sort()) {
      const f = join(p, n), st = lstatSync(f);
      out.push(`${relative(dir, f)} ${st.mode.toString(8)} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(f);
    }
  };
  out.push(`. ${statSync(dir).mode.toString(8)}`);
  walk(dir);
  return out;
}

describe("account-add fulfiller: a new login (paste flow)", () => {
  test("makes a 0700 folder with the kind's links under the state root, opens one terminal, shows the URL, adds the row on login", async () => {
    const r = rig();
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    const folder = join(r.state, "accounts", "claude", "realp");
    expect(result(r.s, id)).toMatchObject({ done: false, state: "terminal_open", folder, started_at: T });
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(folder, MARKER), "utf8").trim()).toBe(String(id));
    for (const l of ["projects", "skills", "history.jsonl"]) expect(readlinkSync(join(folder, l))).toBe(join(r.home, ".claude", l));
    expect(existsSync(join(folder, "plugins"))).toBe(false);              // not in the system folder: no dangling link
    expect(existsSync(join(folder, ".credentials.json"))).toBe(false);    // never the credentials
    expect(r.t.opened).toEqual([{ project: "fx", id, folder, label: "ds-account-add claude:realp",
      line: `exec env CLAUDE_CONFIG_DIR=${folder} DS_LOGIN_DIR=${folder} BROWSER=true sh -c 'claude auth login --claudeai; echo $? > "$DS_LOGIN_DIR/.ds-login-exit"'` }]);

    // The URL, wrapped across two screen lines as a narrow terminal shows it.
    r.t.screens.set("t1", `Opening browser to sign in…\nIf the browser didn't open, visit:\n${URL.slice(0, 50)}\n${URL.slice(50)}\n\nPaste code here if prompted > `);
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ state: "waiting_login", url: URL });
    expect(String(result(r.s, id).text)).toContain(URL);

    logIn(folder, "uuid-a");
    await r.tick(T + 10);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, state: "done", outcome: "added", text: "added claude:realp", folder });
    expect(result(r.s, id).url).toBeUndefined();     // kept only while the add runs
    expect(rows(r.s)).toEqual([{ account: "realp", label: "realp", config_dir: folder, source: "ds", login_id: "uuid-a", removed_at: null }]);
    const cj = JSON.parse(readFileSync(join(folder, ".claude.json"), "utf8"));
    expect(cj).toMatchObject({ hasCompletedOnboarding: true, lastOnboardingVersion: "9.9.9", oauthAccount: { accountUuid: "uuid-a" } });
    expect(r.t.closed).toEqual(["t1"]);
    expect(r.refreshed).toEqual([r.state]);
    expect((r.s.db.query("SELECT payload FROM events WHERE kind = 'account_added'").all() as Row[]).map((e) => JSON.parse(String(e.payload))))
      .toEqual([{ agent: "claude", account: "realp", label: "realp", outcome: "added", by: "cli" }]);
    await r.tick(T + 60);
    expect(r.t.opened).toHaveLength(1);
  });

  test("a loop restart in waiting_login resumes with the same folder and terminal", async () => {
    const r = rig();
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    r.t.screens.set("t1", `visit:\n${URL}\nPaste code here if prompted >`);
    await r.tick(T + 5);
    expect(result(r.s, id).state).toBe("waiting_login");
    await r.restart(T + 6);
    await r.tick(T + 8);
    await r.tick(T + 12);
    expect(r.t.opened).toHaveLength(1);
    expect(readdirSync(join(r.state, "accounts", "claude"))).toEqual(["realp"]);
    expect(result(r.s, id)).toMatchObject({ done: false, state: "waiting_login", url: URL, terminal: { handle: "t1" } });
    logIn(String(result(r.s, id).folder), "uuid-a");
    await r.tick(T + 20);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "added" });
  });

  test("a restart while the terminal was being opened never opens a second one", async () => {
    const r = rig();
    const id = file(r.s, { name: "realp" });
    const folder = join(r.state, "accounts", "claude", "realp");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, MARKER), `${id}\n`);
    r.s.upsert("requests", { id }, { result: JSON.stringify({ state: "opening", folder, started_at: T }) });
    await r.tick(T);
    expect(r.t.opened).toEqual([]);
    expect(result(r.s, id)).toMatchObject({ done: false, state: "terminal_open", terminal: null });
    expect(String(result(r.s, id).line)).toContain("sh -c 'claude auth login --claudeai;");
  });

  test("the same login already listed: 'already there as <label>', the row kept, only this add's folder removed", async () => {
    const r = rig();
    const other = join(r.d, "other");
    mkdirSync(other);
    r.s.db.run("INSERT INTO accounts (agent, account, label, config_dir, source, login_id, observed_at) VALUES ('claude', 'work', 'me@example.test', ?, 'orca', 'uuid-a', ?)", [other, T]);
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    const folder = String(result(r.s, id).folder);
    logIn(folder, "uuid-a");
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "there", label: "me@example.test", text: "already there as me@example.test", folder: other });
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(rows(r.s)).toEqual([{ account: "work", label: "me@example.test", config_dir: other, source: "orca", login_id: "uuid-a", removed_at: null }]);
    expect(r.t.closed).toEqual(["t1"]);
    expect(r.refreshed).toHaveLength(1);
  });

  test("the system login added again is already there as the system row", async () => {
    const r = rig();
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    logIn(String(result(r.s, id).folder), "uuid-sys");
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "there", account: "system" });
    expect(rows(r.s).filter((x) => x.account === "realp")).toEqual([]);
  });

  test("a removed row with the same login comes back: repointed when its folder is gone, else kept and the new folder removed", async () => {
    const r = rig();
    r.s.db.run("INSERT INTO accounts (agent, account, label, config_dir, source, login_id, removed_at, observed_at) VALUES ('claude', 'gone', 'gone', ?, 'ds', 'uuid-a', ?, ?)", [join(r.d, "nowhere"), T - 50, T]);
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    const folder = String(result(r.s, id).folder);
    logIn(folder, "uuid-a");
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "back", text: "back as gone", folder });
    expect(rows(r.s)).toEqual([{ account: "gone", label: "gone", config_dir: folder, source: "ds", login_id: "uuid-a", removed_at: null }]);
    expect(existsSync(folder)).toBe(true);

    const r2 = rig();
    const kept = join(r2.d, "kept");
    mkdirSync(kept);
    r2.s.db.run("INSERT INTO accounts (agent, account, label, config_dir, source, login_id, removed_at, observed_at) VALUES ('claude', 'old', 'old', ?, 'ds', 'uuid-b', ?, ?)", [kept, T - 50, T]);
    const id2 = file(r2.s, { name: "realp" });
    await r2.tick(T);
    const f2 = String(result(r2.s, id2).folder);
    logIn(f2, "uuid-b");
    await r2.tick(T + 5);
    expect(result(r2.s, id2)).toMatchObject({ outcome: "back", text: "back as old", folder: kept });
    expect(rows(r2.s)).toEqual([{ account: "old", label: "old", config_dir: kept, source: "ds", login_id: "uuid-b", removed_at: null }]);
    expect(existsSync(f2)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  test("the login command ending without credentials fails 'login not finished' and keeps the folder", async () => {
    const r = rig();
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    const folder = String(result(r.s, id).folder);
    writeFileSync(join(folder, ".ds-login-exit"), "130\n");
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: false, state: "failed" });
    expect(String(result(r.s, id).error)).toStartWith("login not finished");
    expect(existsSync(folder)).toBe(true);
    expect(r.t.closed).toEqual(["t1"]);
    expect(rows(r.s)).toEqual([]);
    expect(r.refreshed).toEqual([]);
  });

  test("no link on the screen: terminal_open says so; at 30 minutes from the stored start it fails and keeps the folder", async () => {
    const r = rig();
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    r.t.screens.set("t1", "Welcome to Claude Code\n");
    await r.tick(T + 5);
    expect(result(r.s, id).why).toBeUndefined();
    await r.tick(T + 30);
    expect(result(r.s, id)).toMatchObject({ done: false, state: "terminal_open", why: NO_LINK });
    await r.restart(T + 40);
    await r.tick(T + DEADLINE_S - 5);
    expect(result(r.s, id).done).toBe(false);
    await r.tick(T + DEADLINE_S + 1);
    const folder = join(r.state, "accounts", "claude", "realp");
    expect(result(r.s, id)).toMatchObject({ done: true, ok: false, error: `${NOT_FINISHED}: ${folder}` });
    expect(existsSync(folder)).toBe(true);
    expect(r.t.opened).toHaveLength(1);
    expect(r.t.closed).toEqual(["t1"]);
  });

  test("a folder the add did not make is never used or removed; a taken name makes no folder", async () => {
    const r = rig();
    const folder = join(r.state, "accounts", "claude", "realp");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "keep.txt"), "mine");
    const before = snapshot(folder);
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: false });
    expect(String(result(r.s, id).error)).toContain("already exists");
    expect(snapshot(folder)).toEqual(before);
    expect(r.t.opened).toEqual([]);

    r.s.db.run("INSERT INTO accounts (agent, account, source, removed_at, observed_at) VALUES ('claude', 'taken', 'ds', ?, ?)", [T, T]);
    const id2 = file(r.s, { name: "taken" });
    await r.tick(T + 5);
    expect(String(result(r.s, id2).error)).toContain("is taken");
    expect(existsSync(join(r.state, "accounts", "claude", "taken"))).toBe(false);
  });

  test("off a Studio terminal: the result names the line to run, and a login there still adds the row", async () => {
    const r = rig();
    const id = Number(r.s.requestAny("account-add", { agent: "claude", name: "realp" }, { by: "cli" }).row.id);   // no project
    await r.tick(T);
    expect(r.t.opened).toEqual([]);
    const res = result(r.s, id);
    expect(res).toMatchObject({ state: "terminal_open", terminal: null });
    expect(String(res.text)).toContain("run this login yourself: exec env CLAUDE_CONFIG_DIR=");
    logIn(String(res.folder), "uuid-a");
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "added" });
  });
});

describe("account-add fulfiller: --dir", () => {
  const loggedIn = (r: ReturnType<typeof rig>) => {
    const dir = join(r.d, "mine");
    mkdirSync(join(dir, "sub"), { recursive: true, mode: 0o750 });
    writeFileSync(join(dir, ".credentials.json"), "{}", { mode: 0o600 });
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-d" } }), { mode: 0o644 });
    return dir;
  };

  test("adds a ds row on the folder as it is: no terminal, nothing moved, copied, written or removed", async () => {
    const r = rig();
    const dir = loggedIn(r), before = snapshot(dir);
    const id = file(r.s, { name: "realp", dir });
    await r.tick(T);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "added", folder: dir });
    expect(rows(r.s)).toEqual([{ account: "realp", label: "realp", config_dir: dir, source: "ds", login_id: "uuid-d", removed_at: null }]);
    expect(snapshot(dir)).toEqual(before);
    expect(r.t.opened).toEqual([]);
    expect(existsSync(join(r.state, "accounts"))).toBe(false);
    expect(r.refreshed).toEqual([r.state]);
  });

  test("an already listed login is already there and the folder is left alone", async () => {
    const r = rig();
    const dir = loggedIn(r), before = snapshot(dir);
    r.s.db.run("INSERT INTO accounts (agent, account, label, source, login_id, observed_at) VALUES ('claude', 'work', 'work', 'orca', 'uuid-d', ?)", [T]);
    const id = file(r.s, { name: "realp", dir });
    await r.tick(T);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, text: "already there as work" });
    expect(snapshot(dir)).toEqual(before);
  });

  test("a folder with no credentials fails and is left alone", async () => {
    const r = rig();
    const dir = join(r.d, "empty");
    mkdirSync(dir);
    writeFileSync(join(dir, "x"), "1");
    const before = snapshot(dir);
    const id = file(r.s, { name: "realp", dir });
    await r.tick(T);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: false });
    expect(String(result(r.s, id).error)).toContain("not logged in");
    expect(snapshot(dir)).toEqual(before);
    expect(rows(r.s)).toEqual([]);
  });
});

describe("account-add fulfiller: other kinds", () => {
  test("a device-flow kind takes the same path: the URL and the device code in the result, the row on login", async () => {
    const r = rig();
    const id = Number(r.s.requestAny("account-add", { agent: "fakedev", name: "realp", project: "fx" }, { project: "fx" }).row.id);
    await r.tick(T);
    const folder = join(r.state, "accounts", "fakedev", "realp");
    expect(r.t.opened[0].line).toStartWith(`exec env FAKEDEV_HOME=${folder} DS_LOGIN_DIR=${folder} BROWSER=true sh -c 'fakedev login;`);
    r.t.screens.set("t1", "Open https://example.test/device and enter WXYZ-1234\n");
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ state: "waiting_login", url: "https://example.test/device", device_code: "WXYZ-1234" });
    expect(String(result(r.s, id).text)).toBe("waiting for login: open https://example.test/device and enter WXYZ-1234");
    writeFileSync(join(folder, "auth.json"), JSON.stringify({ id: "dev-1" }));
    await r.tick(T + 10);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "added" });
    expect(result(r.s, id).device_code).toBeUndefined();
    expect(rows(r.s, "fakedev")).toEqual([{ account: "realp", label: "realp", config_dir: folder, source: "ds", login_id: "dev-1", removed_at: null }]);
  });

  test("a one-login kind is refused with its why before any folder is made", async () => {
    const r = rig();
    const id = Number(r.s.requestAny("account-add", { agent: "fakeone", name: "realp", project: "fx" }, { project: "fx" }).row.id);
    await r.tick(T);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: false, error: "fakeone keeps one login for now" });
    expect(existsSync(join(r.state, "accounts"))).toBe(false);
    expect(r.t.opened).toEqual([]);
  });
});

describe("account-add fulfiller: the Orca tab", () => {
  test("opens a tab in the project's Studio worktree, reads its screen, and closes it on login", async () => {
    const orca = new FakeOrca();
    const r = rig({ orca, terms: null });
    const id = file(r.s, { name: "realp" });
    await r.tick(T);
    const create = orca.of("terminal-create");
    expect(create.map((c) => c.args.slice(0, 2))).toEqual([["wt-studio", "ds-account-add claude:realp"]]);
    expect(create[0].args[2]).toContain("sh -c 'claude auth login --claudeai;");
    const h = String(result(r.s, id).terminal && (result(r.s, id).terminal as LoginTerm).handle);
    expect(String(result(r.s, id).text)).toContain("Orca tab");
    orca.screens.get(h)!.lines.push("If the browser didn't open, visit:", URL, "Paste code here if prompted > ");
    await r.tick(T + 5);
    expect(result(r.s, id)).toMatchObject({ state: "waiting_login", url: URL });
    logIn(String(result(r.s, id).folder), "uuid-a");
    await r.tick(T + 10);
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true });
    expect(orca.of("terminal-close").map((c) => c.args)).toEqual([[h]]);
    expect(orca.of("terminal-create")).toHaveLength(1);
  });
});
