// account-add-host.test.ts — side-loop-host U20 (issue #127): `ds account add <name> --host <h>`. Main's loop runs the
// account-add fulfiller; side host side-a is a real link Peer pair (frames as JSON, each end's frame log on) whose side
// answers host jobs with its own code (runHere, its own HOME and state root) and contract ops with a fake terminal
// backend. The login folder and terminal are on the side, the pasted code is typed there, and the code is in no frame
// log line, no side log line, no request row or event. Never a real claude, tmux or provider.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract } from "../../bin/loop/fakes/contract.ts";
import { accountAdd } from "../../bin/loop/fulfil/account-add.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { Peer, type Channel, type Frame } from "../../bin/link/protocol.ts";
import { CHANNEL as JOBS, runHere } from "../../bin/link/host-jobs.ts";
import { CONTRACT_CHANNEL, remoteBackend, type ContractBody } from "../../bin/backend/remote.ts";
import type { Answer, Backend, Op } from "../../bin/backend/contract.ts";
import { addAccount, syncAccountFolders } from "../../bin/loop/capacity/accounts.ts";
import { dropLoginCode } from "../../bin/lib/account-login-code.ts";
import { scanFolders } from "../../bin/lib/accounts-list.ts";
import { folderOn } from "../../bin/lib/account-dirs.ts";

const T = 1_800_000_000;
const HOST = "side-a";
const URL = "https://claude.ai/oauth/authorize?code=true&client_id=made-up-client&state=abc123";
const CODE = "made-up-code-7Qx9#Zr2Lw";
const ROOT = join(import.meta.dir, "..", "..");
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

// A HOME with a system ~/.claude, as account-add's own test makes one.
function home(d: string): string {
  const h = join(d, "home");
  mkdirSync(join(h, ".claude", "projects"), { recursive: true });
  writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  return h;
}

// The side's terminals: the fake backend, with the login screen (the URL and the paste prompt) under what it echoes.
function sideTerms() {
  const fake = fakeContract();
  const b: Backend = {
    async call<O extends Op>(op: O, req: any): Promise<Answer<O>> {
      const a = await fake.call(op, req) as any;
      return (op === "terminal.read" && a.ok ? { ...a, text: `${a.text}\n${URL}\nPaste code here if prompted >` } : a) as Answer<O>;
    },
  };
  return { fake, b };
}

function rig(o: { online?: boolean } = {}) {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzacctadd-host-"));
  temps.push(d);
  const mainDir = join(d, "main"), sideDir = join(d, "side");
  mkdirSync(mainDir); mkdirSync(sideDir);
  const state = join(mainDir, "state"), sideState = join(sideDir, "state");
  const env = { HOME: home(mainDir), DS_STATE_ROOT: state }, sideEnv = { HOME: home(sideDir), DS_STATE_ROOT: sideState };
  const s = open(state);
  stores.push(s);
  s.upsert("projects", { label: "fx" }, { studio_wt: "wt-studio", observed_at: T });
  s.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at, last_seen_at, unreachable_since) VALUES (?, 'accepted', 'a2V5', 'aaaa', 2, ?, ?, ?, ?)",
    [HOST, T, T, T, o.online === false ? T : null]);

  // The link: two Peers back to back, each frame through JSON; each end's frame log kept.
  const mainLog: string[] = [], sideLog: string[] = [];
  const terms = sideTerms();
  const sideChannels = new Map<string, Channel>([
    [JOBS, { name: JOBS, answers: "side", handle: (body) => runHere(body, { root: sideState, env: sideEnv }) }],
    [CONTRACT_CHANNEL, { name: CONTRACT_CHANNEL, answers: "side", handle: (body) => { const e = (body as ContractBody).envelope; return terms.b.call(e.op, e.req as never); } }],
  ]);
  const wire = (to: () => Peer) => (f: Frame) => { const copy = JSON.parse(JSON.stringify(f)); queueMicrotask(() => { void to().onFrame(copy); }); };
  const main: Peer = new Peer(wire(() => side), new Map(), { host: HOST, end: "main", root: state }, "m", (l) => mainLog.push(l));
  const side: Peer = new Peer(wire(() => main), sideChannels, { host: "main", end: "side", root: sideState }, "s", (l) => sideLog.push(l));

  const orca = new FakeOrca();
  const f = accountAdd({ refresh: () => {}, env });
  const act = new LoopActuator({ orca, fulfillers: [f],
    jobs: (_h, body, ms) => main.request(JOBS, body, ms),
    remote: (host, name, project) => remoteBackend({ root: state, host, backend: name, project, send: (_h, body, ms) => main.request(CONTRACT_CHANNEL, body, ms) }) });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  return { s, state, sideState, env, sideEnv, orca, terms, mainLog, sideLog, tick };
}
type Rig = ReturnType<typeof rig>;

const file = (s: Store, payload: Record<string, unknown>) =>
  Number(s.requestAny("account-add", { agent: "claude", project: "fx", host: HOST, ...payload }, { project: "fx", by: "cli" }).row.id);
const result = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) } as Record<string, any>;
};
const logIn = (folder: string, uuid: string) => {
  writeFileSync(join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
  writeFileSync(join(folder, ".credentials.json"), "{}");
};
// Every text value of every table in main's loop.db, in one string.
const dbText = (s: Store) => (s.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[])
  .map((t) => JSON.stringify(s.db.query(`SELECT * FROM "${String(t.name)}"`).all())).join("\n");

// File the add, open the side's terminal, paste the code from the board and log in on the side.
async function addOnSide(r: Rig, uuid: string) {
  const id = file(r.s, { name: "realp" });
  await r.tick(T);
  const folder = join(r.sideState, "accounts", "claude", "realp");
  expect(result(r.s, id)).toMatchObject({ done: false, state: "waiting_login", folder, url: URL });
  dropLoginCode(r.state, id, CODE);
  await r.tick(T + 3);
  expect(result(r.s, id)).toMatchObject({ state: "code_typed" });
  logIn(folder, uuid);
  await r.tick(T + 6);
  return { id, folder };
}

describe("ds account add --host: a login on a side host", () => {
  test("the folder and the terminal are on the side; the code is typed there; no accounts row for a new login", async () => {
    const r = rig();
    const { id, folder } = await addOnSide(r, "uuid-side");
    // The folder: made on the side under its own accounts root, 0700; none on main.
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(existsSync(join(r.state, "accounts", "claude", "realp"))).toBe(false);
    // The terminal: one, on the side, in that folder, running the login line there; the code typed into it; closed.
    const ops = r.terms.fake.calls.map((c) => c.op);
    expect(ops.filter((o) => o === "terminal.create")).toHaveLength(1);
    expect(r.terms.fake.calls[0].req).toMatchObject({ cwd: folder, label: "ds-account-add claude:realp" });
    const sends = r.terms.fake.calls.filter((c) => c.op === "terminal.send").map((c) => (c.req as any).text);
    expect(sends).toEqual([expect.stringContaining(`CLAUDE_CONFIG_DIR=${folder}`), CODE]);
    expect(ops.at(-1)).toBe("terminal.close");
    // A login no account on main has: OK, no row, the folder stays, and the add says what to run on main.
    expect(result(r.s, id)).toMatchObject({ done: true, ok: true, state: "done", outcome: "side_only", host: HOST, folder });
    expect(result(r.s, id).text).toContain(`run ds account add realp on main`);
    expect(r.s.db.query("SELECT COUNT(*) AS n FROM accounts WHERE agent = 'claude' AND account = 'realp'").get()).toEqual({ n: 0 });
    expect(existsSync(join(folder, ".credentials.json"))).toBe(true);
  });

  test("the pasted code is in no frame log, no side log, no row and no event", async () => {
    const r = rig();
    await addOnSide(r, "uuid-side");
    // The frames went (the logs are on) and the typed text shows only as its length.
    expect(r.mainLog.some((l) => l.includes(`"op":"terminal.send"`) && l.includes(`[redacted ${CODE.length} chars]`))).toBe(true);
    expect(r.sideLog.some((l) => l.includes("terminal.read"))).toBe(true);
    for (const line of [...r.mainLog, ...r.sideLog]) expect(line).not.toContain(CODE);
    // The fake echoed it onto the screen, which the side read back: still not in a log.
    expect(r.terms.fake.calls.some((c) => c.op === "terminal.read")).toBe(true);
    expect(dbText(r.s)).not.toContain(CODE);
  });

  test("an answer that echoes the code is scrubbed before it leaves the side", async () => {
    const out: Frame[] = [];
    const echo: Channel = { name: "echo", answers: "side", handle: (b: any) => { throw new Error(`could not type ${b.envelope.req.text}`); } };
    const p = new Peer((f) => out.push(f), new Map([["echo", echo]]), { host: "main", end: "side", root: "/none" }, "s");
    await p.onFrame({ t: "req", id: "m1", ch: "echo", body: { envelope: { op: "terminal.send", req: { id: "t", text: CODE } } } });
    expect(out).toEqual([{ t: "res", id: "m1", ok: false, error: "could not type [redacted]" }]);
    const ok: Channel = { name: "ok", answers: "side", handle: (b: any) => ({ screen: `$ ${b.envelope.req.text}`, lines: [b.envelope.req.text] }) };
    const q = new Peer((f) => out.push(f), new Map([["ok", ok]]), { host: "main", end: "side", root: "/none" }, "s");
    await q.onFrame({ t: "req", id: "m2", ch: "ok", body: { envelope: { op: "terminal.send", req: { id: "t", text: CODE } } } });
    expect(out[1]).toEqual({ t: "res", id: "m2", ok: true, body: { screen: "$ [redacted]", lines: ["[redacted]"] } });
  });

  test("a login an account on main already has: 'logged in on side-a as <label>' and U18's sync links the folder", async () => {
    const r = rig();
    const mainFolder = join(r.state, "accounts", "claude", "work");
    mkdirSync(mainFolder, { recursive: true });
    logIn(mainFolder, "uuid-work");
    addAccount(r.s, { agent: "claude", account: "work", folder: mainFolder, loginId: "uuid-work", by: "test" }, r.env, T - 10);
    const { id, folder } = await addOnSide(r, "uuid-work");
    expect(result(r.s, id)).toMatchObject({ ok: true, outcome: "there", account: "work", host: HOST });
    expect(result(r.s, id).text).toContain(`logged in on ${HOST} as`);
    expect((r.s.db.query("SELECT account FROM accounts WHERE agent = 'claude' AND removed_at IS NULL ORDER BY account").all() as Row[]).map((x) => x.account)).not.toContain("realp");
    expect(existsSync(folder)).toBe(true);   // main never removes a side folder
  });

  test("follow-through: after `ds account add` on main with the same login, the side's folder links with no second login there", async () => {
    const r = rig();
    const { folder } = await addOnSide(r, "uuid-later");
    // The side's own scan sees the folder with its login id; it goes up the link as observed_account_folders.
    const line = scanFolders(r.sideEnv).find((l) => l.split("\t")[1] === folder)!;
    expect(line.split("\t")).toEqual(["claude", folder, "uuid-later", "1"]);
    r.s.db.run("INSERT INTO observed_account_folders (host, dir, agent, login_id, logged_in, observed_at) VALUES (?, ?, 'claude', 'uuid-later', 1, ?)", [HOST, `${HOST}::${folder}`, T + 10]);
    syncAccountFolders(r.s, T + 10);
    expect(folderOn(r.state, HOST, "claude", "realp", r.env)).toBeNull();   // not an account yet
    // The operator adds it on main, logged in as the same login.
    const mainFolder = join(r.state, "accounts", "claude", "realp");
    mkdirSync(mainFolder, { recursive: true });
    logIn(mainFolder, "uuid-later");
    addAccount(r.s, { agent: "claude", account: "realp", folder: mainFolder, loginId: "uuid-later", by: "test" }, r.env, T + 20);
    syncAccountFolders(r.s, T + 20);
    expect(folderOn(r.state, HOST, "claude", "realp", r.env)).toBe(folder);
    expect(r.terms.fake.calls.filter((c) => c.op === "terminal.create")).toHaveLength(1);   // no second login on side-a
  });

  test("refused before anything is made: the host's link down, or --dir with --host", async () => {
    const down = rig({ online: false });
    const a = file(down.s, { name: "realp" });
    await down.tick(T);
    expect(result(down.s, a)).toMatchObject({ done: true, ok: false, error: expect.stringContaining(`host ${HOST} is not online`) });
    expect(existsSync(join(down.sideState, "accounts"))).toBe(false);
    expect(down.terms.fake.calls).toEqual([]);

    const r = rig();
    const b = file(r.s, { name: "realp", dir: "/somewhere" });
    await r.tick(T);
    expect(result(r.s, b)).toMatchObject({ done: true, ok: false, error: expect.stringContaining("--dir names a folder on main") });
    expect(r.terms.fake.calls).toEqual([]);
  });

  test("the side's account.check reads only a login folder under its own accounts root", async () => {
    const r = rig();
    await expect(runHere({ job: "account.check", agent: "claude", folder: join(r.sideEnv.HOME, ".claude") }, { root: r.sideState, env: r.sideEnv }))
      .rejects.toThrow("is not a login folder");
  });
});

describe("ds account add --host on the CLI", () => {
  const cli = (r: Rig, ...args: string[]) => {
    r.s.db.run("INSERT OR REPLACE INTO health (id, tick_at, started_at) VALUES (1, ?, ?)", [Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]);
    const p = Bun.spawnSync([join(ROOT, "bin/ds"), "account", "add", "realp", "--project", "fx", "--no-wait", ...args],
      { env: { PATH: process.env.PATH ?? "", HOME: r.env.HOME, DS_STATE_ROOT: r.state } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  test("files the add with its host; refuses an unknown host, a host whose link is down, and --dir", () => {
    const r = rig();
    const ok = cli(r, "--host", HOST);
    expect(ok).toMatchObject({ code: 0, out: expect.stringContaining(`on host ${HOST}`) });
    const q = r.s.db.query("SELECT payload FROM requests WHERE kind = 'account-add'").get() as Row;
    expect(JSON.parse(String(q.payload))).toMatchObject({ agent: "claude", name: "realp", project: "fx", host: HOST });
    expect(cli(r, "--host", "nope")).toMatchObject({ code: 2, err: expect.stringContaining("no accepted host 'nope'") });
    expect(cli(r, "--host", HOST, "--dir", "/tmp")).toMatchObject({ code: 2, err: expect.stringContaining("--dir names a folder on main") });
    r.s.db.run("UPDATE hosts SET unreachable_since = ? WHERE name = ?", [T, HOST]);
    expect(cli(r, "--host", HOST)).toMatchObject({ code: 2, err: expect.stringContaining(`host ${HOST} is not online`) });
  });
});
