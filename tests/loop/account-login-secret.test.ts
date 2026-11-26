// account-login-secret.test.ts — issue #125 U6, the proof for R7: the login code an operator pastes on the board
// goes from the drop file (bin/lib/account-login-code.ts) into the login terminal and nowhere else. The fake Orca
// keeps what it was typed in memory, outside the state root; after each case every file under the state root
// (loop.db and its WAL, the account folder, the drop directory) is read byte for byte and must not hold the code.
// Also: the code is typed only while the paste prompt shows, a prompt that comes back returns the add to
// waiting_login, a failed type keeps no error text, and an add that ends removes a code nobody took.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { accountAdd, DEADLINE_S, LATE, NOT_ACCEPTED, NOT_TYPED, PROMPT_BACK_S, type LoginTerm } from "../../bin/loop/fulfil/account-add.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { dropLoginCode, loginCodeFile, loginCodeProblem, takeLoginCode } from "../../bin/lib/account-login-code.ts";

const T = 1_800_000_000;
const URL = "https://claude.ai/oauth/authorize?code=true&client_id=made-up-client&state=abc123";
const PROMPT = "Paste code here if prompted > ";
const CODE = "zqx7SECRETpaste#k2v9";   // made up; distinctive so a byte scan finds any copy
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function rig() {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzaa-"));
  temps.push(d);
  const home = join(d, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: "uuid-sys" } }));
  const state = join(d, "state");
  const s = open(state);
  stores.push(s);
  s.upsert("projects", { label: "fx" }, { studio_wt: "wt-studio", observed_at: T });
  const orca = new FakeBackend();
  const f = accountAdd({ refresh: () => {}, env: { HOME: home, DS_STATE_ROOT: state } });
  const act = new LoopActuator({ orca, fulfillers: [f] });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  const id = Number(s.requestAny("account-add", { agent: "claude", name: "realp", project: "fx" }, { project: "fx", by: "board" }).row.id);
  const res = () => {
    const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
    return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) } as Record<string, unknown>;
  };
  const screen = () => orca.screens.get((res().terminal as LoginTerm).handle)!;
  // The add up to the login link: folder, terminal, then the screen claude shows.
  const toWaiting = async () => {
    await tick(T);
    screen().lines.push("If the browser didn't open, visit:", URL, PROMPT);
    await tick(T + 2);
    expect(res()).toMatchObject({ state: "waiting_login", url: URL });
  };
  const typed = () => orca.of("terminal-type").map((c) => c.args);
  return { s, state, orca, id, tick, res, screen, toWaiting, typed };
}

// Every file under the state root, read as bytes: none holds the code.
function noCopyUnder(root: string, code = CODE) {
  const hits: string[] = [];
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
    noCopyUnder(r.state);
    const folder = String(r.res().folder);
    writeFileSync(join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-a" } }));
    writeFileSync(join(folder, ".credentials.json"), "{}");
    await r.tick(T + 8);
    expect(r.res()).toMatchObject({ done: true, ok: true, state: "done" });
    expect(r.res().url).toBeUndefined();
    noCopyUnder(r.state);
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
    noCopyUnder(r.state);
    noCopyUnder(r.state, "second-made-up-code");
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
    noCopyUnder(r.state);
  });

  test("a failed type keeps no error text (an adapter's error may echo the code)", async () => {
    const r = rig();
    await r.toWaiting();
    r.orca.fail("terminal-type", { code: 1, out: "", err: `orca adapter: terminal-type: terminal send failed: --text ${CODE}\n` });
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + 4);
    expect(r.res()).toMatchObject({ state: "waiting_login", why: NOT_TYPED });
    noCopyUnder(r.state);
  });

  test("an add that ends removes a code nobody took", async () => {
    const r = rig();
    await r.toWaiting();
    dropLoginCode(r.state, r.id, CODE);
    await r.tick(T + DEADLINE_S);
    expect(r.res()).toMatchObject({ done: true, ok: false, state: "failed" });
    expect(r.typed()).toEqual([]);
    expect(existsSync(loginCodeFile(r.state, r.id))).toBe(false);
    noCopyUnder(r.state);
  });
});
