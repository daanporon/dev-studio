// account-login-secret.test.ts — issue #125 U6, the proof for R7: the login code an operator pastes on the board
// goes from the drop file (bin/lib/account-login-code.ts) into the login terminal and nowhere else. The fake Orca
// and the fake contract backend keep what they were typed in memory, outside the state root; after each case a dump
// of every loop.db table, every file under the state root (loop.db and its WAL, the account folder, the drop
// directory) read byte for byte, and everything the test process printed must not hold the code. One case per
// backend posts the code through the board server and checks its stdout and stderr too.
// Also: the code is typed only while the paste prompt shows, a prompt that comes back returns the add to
// waiting_login, a failed type keeps no error text, and an add that ends removes a code nobody took.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { fakeContract } from "../../bin/loop/fakes/contract.ts";
import { accountAdd, DEADLINE_S, LATE, NOT_ACCEPTED, NOT_TYPED, PROMPT_BACK_S, type LoginTerm } from "../../bin/loop/fulfil/account-add.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { dropLoginCode, loginCodeFile, loginCodeProblem, takeLoginCode } from "../../bin/lib/account-login-code.ts";

const T = 1_800_000_000;
const URL = "https://claude.ai/oauth/authorize?code=true&client_id=made-up-client&state=abc123";
const PROMPT = "Paste code here if prompted > ";
const CODE = "zqx7SECRETpaste#k2v9";   // made up; distinctive so a byte scan finds any copy
const temps: string[] = [], stores: Store[] = [], servers: ReturnType<typeof Bun.spawn>[] = [];
// What this process prints while a case runs (the fulfiller runs in it).
let printed: string[] = [];
const keep = { log: console.log, error: console.error, warn: console.warn, out: process.stdout.write, err: process.stderr.write };
beforeEach(() => {
  printed = [];
  const grab = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); };
  console.log = console.error = console.warn = grab;
  process.stdout.write = process.stderr.write = ((c: unknown) => { printed.push(String(c)); return true; }) as never;
});
afterEach(async () => {
  Object.assign(console, { log: keep.log, error: keep.error, warn: keep.warn });
  process.stdout.write = keep.out; process.stderr.write = keep.err;
  for (const p of servers.splice(0)) { p.kill(); await p.exited; }
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function rig(via: "orca" | "contract" = "orca") {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzaa-"));
  temps.push(d);
  const home = join(d, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: "uuid-sys" } }));
  const state = join(d, "state");
  const s = open(state);
  stores.push(s);
  s.upsert("projects", { label: "fx" }, { studio_wt: "wt-studio", observed_at: T, ...(via === "contract" ? { doc: JSON.stringify({ studio_backend: "tmux" }) } : {}) });
  const orca = new FakeBackend(), fake = fakeContract({}, { name: "tmux", now: () => T });
  const f = accountAdd({ refresh: () => {}, env: { HOME: home, DS_STATE_ROOT: state } });
  const act = new LoopActuator({ orca, fulfillers: [f], backends: () => ({ backend: fake, caps: fake.caps }) });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  const id = Number(s.requestAny("account-add", { agent: "claude", name: "realp", project: "fx" }, { project: "fx", by: "board" }).row.id);
  const res = () => {
    const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
    return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) } as Record<string, unknown>;
  };
  const handle = () => (res().terminal as LoginTerm).handle;
  const screen = (): { lines: string[] } => via === "orca" ? orca.screens.get(handle())! : fake.terms.get(handle())!;
  // The add up to the login link: folder, terminal, then the screen claude shows.
  const toWaiting = async () => {
    await tick(T);
    screen().lines.push("If the browser didn't open, visit:", URL, PROMPT);
    await tick(T + 2);
    expect(res()).toMatchObject({ state: "waiting_login", url: URL, terminal: { via } });
  };
  // What reached the login terminal after its login line: Orca's terminal-type calls, or the contract's sends.
  const typed = () => via === "orca" ? orca.of("terminal-type").map((c) => c.args)
    : fake.calls.filter((c) => c.op === "terminal.send").slice(1).map((c) => { const r = c.req as { id: string; text: string }; return [r.id, r.text]; });
  return { s, state, orca, fake, id, tick, res, screen, toWaiting, typed };
}

// No copy of the code: not in a dump of every loop.db table, not in any file under the state root read as bytes,
// not in what this process printed.
function noCopyUnder(root: string, code = CODE, s?: Store) {
  const hits: string[] = [];
  if (s) for (const t of s.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[])
    if (JSON.stringify(s.db.query(`SELECT * FROM "${String(t.name)}"`).all()).includes(code)) hits.push(`loop.db ${t.name}`);
  if (printed.some((p) => p.includes(code))) hits.push("printed");
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && readFileSync(f).includes(Buffer.from(code))) hits.push(f);
    }
  };
  walk(root);
  expect(hits).toEqual([]);
}

describe("the drop file", () => {
  test("0600 in a 0700 directory, removed as it is read, a newer code replaces an older one", () => {
    const d = mkdtempSync(join(tmpdir(), "zzaa-"));
    temps.push(d);
    dropLoginCode(d, 7, "old-code");
    dropLoginCode(d, 7, `  ${CODE}\n`);
    expect(statSync(join(d, "account-login")).mode & 0o777).toBe(0o700);
    expect(statSync(loginCodeFile(d, 7)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(d, "account-login"))).toEqual(["7"]);
    expect(takeLoginCode(d, 7)).toBe(CODE);
    expect(existsSync(loginCodeFile(d, 7))).toBe(false);
    expect(takeLoginCode(d, 7)).toBeNull();
  });

  test("a code is one line of 1-512 printable characters, and no refusal repeats it", () => {
    for (const bad of ["", "   ", "two\nlines", "tab\there", "x".repeat(513), "é-not-ascii", 42]) {
      const why = loginCodeProblem(bad);
      expect(why).not.toBeNull();
      if (typeof bad === "string" && bad.trim()) expect(why).not.toContain(bad.trim());
    }
    expect(loginCodeProblem(CODE)).toBeNull();
    expect(loginCodeProblem("x".repeat(512))).toBeNull();
  });
});

describe("the code reaches the terminal and nothing else", () => {
  test("typed while the prompt shows, then the login: no copy in loop.db, the result or any state file", async () => {
    const r = rig();
    await r.toWaiting();
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + 4);
    const h = (r.res().terminal as LoginTerm).handle;
    expect(r.typed()).toEqual([[h, CODE], [h, "\r"]]);
    expect(r.res()).toMatchObject({ state: "code_typed", url: URL });
    expect(existsSync(loginCodeFile(r.state, r.id))).toBe(false);
    // The terminal echoed it (the fake's screen holds "$ <code>"), and the add read that screen: still no copy.
    expect(r.screen().lines.join("\n")).toContain(CODE);
    await r.tick(T + 6);
    noCopyUnder(r.state, CODE, r.s);
    const folder = String(r.res().folder);
    writeFileSync(join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-a" } }));
    writeFileSync(join(folder, ".credentials.json"), "{}");
    await r.tick(T + 8);
    expect(r.res()).toMatchObject({ done: true, ok: true, state: "done" });
    expect(r.res().url).toBeUndefined();
    noCopyUnder(r.state, CODE, r.s);
  });

  test("the prompt still up after the wait: not accepted, back to waiting_login, the URL as first read; a new code is typed", async () => {
    const r = rig();
    await r.toWaiting();
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + 4);
    await r.tick(T + 4 + PROMPT_BACK_S - 2);
    expect(r.res().state).toBe("code_typed");
    // A later screen's URL-looking text must not replace the first read.
    r.screen().lines.push("That doesn't look like the full code", "https://claude.ai/oauth/authorize?state=after-typing", PROMPT);
    await r.tick(T + 4 + PROMPT_BACK_S);
    expect(r.res()).toMatchObject({ state: "waiting_login", why: NOT_ACCEPTED, url: URL });
    await r.tick(T + 30);
    expect(r.res().url).toBe(URL);
    dropLoginCode(r.state, r.id, "second-made-up-code");
    await r.tick(T + 32);
    expect(r.res().state).toBe("code_typed");
    expect(r.typed().map((a) => a[1])).toEqual([CODE, "\r", "second-made-up-code", "\r"]);
    noCopyUnder(r.state, CODE, r.s);
    noCopyUnder(r.state, "second-made-up-code", r.s);
  });

  test("the prompt gone after the wait (claude is logging in): the add stays code_typed", async () => {
    const r = rig();
    await r.toWaiting();
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + 4);
    r.screen().lines.splice(0, r.screen().lines.length, "Logging in…");
    await r.tick(T + 4 + PROMPT_BACK_S);
    await r.tick(T + 4 + PROMPT_BACK_S + 2);
    expect(r.res()).toMatchObject({ state: "code_typed", why: null, url: URL });
  });

  test("a code after the prompt has gone is dropped untyped, and the add says so", async () => {
    const r = rig();
    await r.toWaiting();
    r.screen().lines.splice(0, r.screen().lines.length, "If the browser didn't open, visit:", URL, "Logging in…");
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + 4);
    expect(r.typed()).toEqual([]);
    expect(r.res()).toMatchObject({ state: "waiting_login", why: LATE });
    expect(existsSync(loginCodeFile(r.state, r.id))).toBe(false);
    noCopyUnder(r.state, CODE, r.s);
  });

  test("a failed type keeps no error text (an adapter's error may echo the code)", async () => {
    const r = rig();
    await r.toWaiting();
    r.orca.fail("terminal-type", { code: 1, out: "", err: `orca adapter: terminal-type: terminal send failed: --text ${CODE}\n` });
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + 4);
    expect(r.res()).toMatchObject({ state: "waiting_login", why: NOT_TYPED });
    noCopyUnder(r.state, CODE, r.s);
  });

  test("an add that ends removes a code nobody took", async () => {
    const r = rig();
    await r.toWaiting();
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + DEADLINE_S);
    expect(r.res()).toMatchObject({ done: true, ok: false, state: "failed" });
    expect(r.typed()).toEqual([]);
    expect(existsSync(loginCodeFile(r.state, r.id))).toBe(false);
    noCopyUnder(r.state, CODE, r.s);
  });
});

describe("on the contract backend", () => {
  test("typed with terminal.send while the prompt shows, a rejected code then a second one: no copy anywhere", async () => {
    const r = rig("contract");
    await r.toWaiting();
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + 4);
    const h = (r.res().terminal as LoginTerm).handle;
    expect(r.typed()).toEqual([[h, CODE]]);
    expect(r.fake.calls.at(-1)?.req).toMatchObject({ submit: true });
    expect(r.res()).toMatchObject({ state: "code_typed", url: URL });
    expect(r.screen().lines.join("\n")).toContain(CODE);
    r.screen().lines.push("That doesn't look like the full code", PROMPT);
    await r.tick(T + 4 + PROMPT_BACK_S);
    expect(r.res()).toMatchObject({ state: "waiting_login", why: NOT_ACCEPTED, url: URL });
    dropLoginCode(r.state, r.id, "second-made-up-code");
    await r.tick(T + 4 + PROMPT_BACK_S + 2);
    expect(r.typed().map((a) => a[1])).toEqual([CODE, "second-made-up-code"]);
    expect(r.res().state).toBe("code_typed");
    noCopyUnder(r.state, CODE, r.s);
    noCopyUnder(r.state, "second-made-up-code", r.s);
  });
});

// The whole way: the code posted to the board server, then one loop tick types it. The server's own stdout and
// stderr join the scan.
describe("through the board server", () => {
  async function serve(state: string) {
    const listener = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = listener.port; listener.stop(true);
    const url = `http://127.0.0.1:${port}`, here = import.meta.dir;
    const p = Bun.spawn([process.execPath, join(here, "../../bin/board/board-server.ts"), "127.0.0.1", String(port),
      join(here, "../../web/board.html"), join(here, "../../bin/board/board-data.ts"), "fx"],
      { env: { ...process.env, DS_STATE_ROOT: state }, stdout: "pipe", stderr: "pipe" });
    servers.push(p);
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/healthz")).ok) break; } catch { /* starting */ } await Bun.sleep(20); }
    const post = async (body: unknown) => {
      const res = await fetch(url + "/api/account-login-code", { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, text: await res.text() };
    };
    const output = async () => { p.kill(); await p.exited; return (await new Response(p.stdout).text()) + (await new Response(p.stderr).text()); };
    return { post, output };
  }

  for (const via of ["orca", "contract"] as const) {
    test(`${via}: posted, typed on the next tick, and no copy in loop.db, the state root or either process's output`, async () => {
      const r = rig(via);
      const b = await serve(r.state);
      const early = await b.post({ request: r.id, code: CODE });
      expect(early.status).toBe(409);
      await r.toWaiting();
      const sent = await b.post({ request: r.id, code: `${CODE}\n` });
      expect(sent.status).toBe(202);
      expect(early.text + sent.text).not.toContain(CODE);
      await r.tick(T + 4);
      expect(r.typed()[0]?.[1]).toBe(CODE);
      expect(existsSync(loginCodeFile(r.state, r.id))).toBe(false);
      expect(await b.output()).not.toContain(CODE);
      noCopyUnder(r.state, CODE, r.s);
    });
  }
});
