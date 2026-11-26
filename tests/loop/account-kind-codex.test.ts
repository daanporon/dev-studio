// account-kind-codex.test.ts — issue #125 U11: Codex's account kind. A fake HOME with a system ~/.codex, made-up
// auth.json files and a made-up device screen; the `account-add` fulfiller runs the real kind with fake terminals.
// Never a real codex, login or auth.json.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { accountAdd, type Terminals } from "../../bin/loop/fulfil/account-add.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { kindEnv, kindOf } from "../../bin/lib/account-kinds/index.ts";
import { makeAccountFolder } from "../../bin/lib/account-folder.ts";

const T = 1_800_000_000, SENTINEL = "SENTINEL-made-up-token";
const URL = "https://auth.openai.com/codex/device", CODE = "AB12-CD34E";
// The shape `codex login --device-auth` prints, colours included.
const SCREEN = `Welcome to Codex [v0.0.0]
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \x1b[94m${URL}\x1b[0m

2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m
   \x1b[94m${CODE}\x1b[0m
`;
const LINKS = ["config.toml", "hooks.json", "skills", "prompts", "plugins", "rules", "sessions"];
const codex = kindOf("codex");
const temps: string[] = [], stores: Store[] = [];
afterAll(() => {
  for (const s of stores) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function host() {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzck-"));
  temps.push(d);
  const home = join(d, "home"), sys = join(home, ".codex"), state = join(d, "state");
  mkdirSync(sys, { recursive: true });
  for (const l of LINKS) { if (l.includes(".")) writeFileSync(join(sys, l), "x\n"); else mkdirSync(join(sys, l)); }
  writeFileSync(join(sys, "state_5.sqlite"), "x");
  login(sys, "acct-system");
  return { d, home, sys, state, env: { HOME: home, DS_STATE_ROOT: state } };
}
function login(folder: string, accountId: string | null) {
  writeFileSync(join(folder, "auth.json"), JSON.stringify({ OPENAI_API_KEY: accountId ? null : SENTINEL,
    tokens: accountId ? { id_token: SENTINEL, access_token: SENTINEL, refresh_token: SENTINEL, account_id: accountId } : null }));
}

describe("codex account kind", () => {
  test("keeps more than one login, each a CODEX_HOME, by the device flow", () => {
    expect([codex.multi, codex.systemId, codex.envVar, codex.credentialsFile]).toEqual([true, "default", "CODEX_HOME", "auth.json"]);
    expect([codex.login!.command.join(" "), codex.login!.flow]).toEqual(["codex login --device-auth", "device"]);
    expect(codex.links).toEqual(LINKS);
    expect(codex.keyEnv).toContain("OPENAI_API_KEY");
    expect(kindEnv(codex, "/f")).toEqual({ CODEX_HOME: "/f" });
  });

  test("the login screen gives the URL and the one-time code; a screen without them gives neither", () => {
    expect(codex.login!.read(SCREEN)).toEqual({ url: URL, device_code: CODE, prompt: false });
    expect(codex.login!.read(SCREEN.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual({ url: URL, device_code: CODE, prompt: false });
    expect(codex.login!.read("$ exec env CODEX_HOME=/x/y codex login --device-auth\nWARNING: proceeding\n")).toEqual({ prompt: false });
  });

  test("the login id is tokens.account_id; an API-key login, a broken file or none has no id", () => {
    const { sys, d, env } = host();
    expect(codex.loginId(sys, true, env)).toBe("acct-system");
    login(sys, null);
    expect(codex.loginId(sys, true, env)).toBeNull();
    writeFileSync(join(sys, "auth.json"), "{");
    expect(codex.loginId(sys, true, env)).toBeNull();
    expect(codex.loginId(join(d, "none"), false, env)).toBeNull();
  });

  test("a new folder links the system config, hooks, skills and sessions, never auth.json or the sqlite state", () => {
    const { sys, env } = host();
    const f = makeAccountFolder(codex, "work", 1, env);
    expect(statSync(f).mode & 0o777).toBe(0o700);
    for (const l of LINKS) expect(readlinkSync(join(f, l))).toBe(join(sys, l));
    expect(readdirSync(f).filter((n) => !LINKS.includes(n))).toEqual([".ds-account-add"]);
  });
});

describe("account-add with the codex kind", () => {
  function rig() {
    const h = host();
    const s = open(h.state);
    stores.push(s);
    s.db.run("INSERT INTO projects (label, studio_wt, observed_at) VALUES ('fx', 'wt-fx', ?)", [T]);
    let screen = "";
    const terms: Terminals = {
      async open(_x, project) { return { via: "orca", handle: "t1", project }; },
      async read() { return screen; },
      async close() {},
    };
    const f = accountAdd({ terminals: terms, refresh: () => {}, env: h.env });
    const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [f] });
    const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
    const file = (payload: Record<string, unknown>) =>
      Number(s.requestAny("account-add", { agent: "codex", project: "fx", ...payload }, { project: "fx", by: "cli" }).row.id);
    const result = (id: number) => JSON.parse(String((s.db.query("SELECT result FROM requests WHERE id = ?").get(id) as Row).result ?? "{}"));
    const rows = () => s.db.query("SELECT account, config_dir, source, login_id FROM accounts WHERE agent = 'codex' AND source = 'ds'").all() as Row[];
    return { ...h, s, tick, file, result, rows, show: (t: string) => { screen = t; } };
  }

  test("shows the URL and the code, adds the row once auth.json is there, and no token reaches the db", async () => {
    const r = rig(), id = r.file({ name: "work" }), folder = join(r.state, "accounts", "codex", "work");
    await r.tick(T);
    r.show(SCREEN);
    await r.tick(T + 5);
    expect(r.result(id)).toMatchObject({ state: "waiting_login", url: URL, device_code: CODE });
    expect(String(r.result(id).text)).toContain(`enter ${CODE}`);
    expect(String(r.result(id).text)).not.toContain("paste");
    login(folder, "acct-work");
    await r.tick(T + 10);
    expect(r.result(id)).toMatchObject({ state: "done", ok: true, outcome: "added" });
    expect(r.result(id).device_code).toBeUndefined();
    expect(r.rows()).toEqual([{ account: "work", config_dir: folder, source: "ds", login_id: "acct-work" }]);
    const dump = (r.s.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[])
      .map((t) => JSON.stringify(r.s.db.query(`SELECT * FROM "${t.name}"`).all())).join("\n");
    expect(dump).toContain("acct-work");
    expect(dump).not.toContain(SENTINEL);
  });

  test("--dir adds a logged-in folder and leaves it alone; the system login's own folder is 'already there'", async () => {
    const r = rig(), dir = join(r.d, "other");
    mkdirSync(dir);
    login(dir, "acct-other");
    const before = [readFileSync(join(dir, "auth.json"), "utf8"), lstatSync(join(dir, "auth.json")).mtimeMs];
    const id = r.file({ name: "other", dir });
    await r.tick(T);
    expect(r.result(id)).toMatchObject({ ok: true, outcome: "added", folder: dir });
    expect(readdirSync(dir)).toEqual(["auth.json"]);
    expect([readFileSync(join(dir, "auth.json"), "utf8"), lstatSync(join(dir, "auth.json")).mtimeMs]).toEqual(before);
    const again = r.file({ name: "again", dir: r.sys });
    await r.tick(T + 5);
    expect(r.result(again)).toMatchObject({ ok: true, outcome: "there", account: "default" });
    expect(existsSync(join(r.sys, "auth.json"))).toBe(true);
    expect(r.rows().map((x) => x.account)).toEqual(["other"]);
  });
});
