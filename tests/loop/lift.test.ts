// lift.test.ts — U107: `ds limit-lift <agent> <account>` clears one account's block everywhere the
// picker reads it (account episodes, observed_accounts.limited_until + accounts.tsv, members), logs
// one account_limit_lifted event, and a new real notice blocks the account again.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import lift from "../../bin/loop/fulfil/lift.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { accountEpisodeRows } from "../../bin/loop/db/import-markers.ts";
import { accountBlock, pick } from "../../bin/loop/capacity/pick.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { run as dsLift } from "../../bin/commands/limit-lift.ts";
import { since } from "../../bin/loop/core/events.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000, UNTIL = T + 3 * 86400 + 17;
const temps: string[] = [], stores: Store[] = [];
const prevRoot = process.env.DS_STATE_ROOT;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (prevRoot === undefined) delete process.env.DS_STATE_ROOT; else process.env.DS_STATE_ROOT = prevRoot;
});

// accounts.tsv with acct-a blocked by an imported episode and the tsv's own limited_until.
function fixture(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzlift-")), conv = mkdtempSync(join(tmpdir(), "zzconv-"));
  temps.push(d, conv);
  mkdirSync(join(d, "fx", "squads"), { recursive: true });
  const tsv = readFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), "utf8").replace(/^(claude\tacct-a(?:\t[^\t]*){5})\t-\t/m, `$1\t${UNTIL}\t`);
  writeFileSync(join(d, "accounts.tsv"), tsv);
  writeFileSync(join(d, ".accounts.episodes"), `wt-1|You've hit your weekly limit · resets Nov 9, 1am\t${UNTIL}\tclaude\tacct-a\nwt-2|other\t${UNTIL}\tclaude\tacct-b\n`);
  const s = open(d);
  stores.push(s);
  copyFileSync(join(ROOT, "conventions", "roles.conf"), join(conv, "roles.conf"));
  importConfig(s, d, join(ROOT, "conventions"));
  for (const r of [...accountRows(d), ...accountEpisodeRows(d)]) s.upsert(r.table, r.key, r.set);
  s.upsert("episodes", { project: "", subject: "limit|claude/acct-a", kind: "account" }, { state: "claude/acct-a", ended_at: UNTIL, started_at: T, source: "loop", observed_at: T });
  s.db.run("INSERT INTO members (project, squad, role, suffix, status, wt, agent, model, account, limited_until, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', '', 'running', 'wt-1', 'claude', 'opus', 'acct-a', ?, ?, ?)", [UNTIL, T, T]);
  return s;
}
async function tick(s: Store, at = T) {
  const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [lift] });
  const loop = new Loop(s, { observers: [], reconcilers: [lift] }, act, { projects: () => ["fx"] });
  loop.boot(at);
  await loop.tick(at); await act.drain();
}
const blockOf = (s: Store, account = "acct-a") => accountBlock(s, "claude", account, T + 60);
const col = (s: Store) => (s.db.query("SELECT limited_until FROM observed_accounts WHERE agent = 'claude' AND account = 'acct-a'").get() as Row).limited_until;

describe("ds limit-lift", () => {
  test("clears every source the picker reads, only for that account, with one event", async () => {
    const s = fixture();
    expect(blockOf(s)).toBe("limited");
    expect(blockOf(s, "acct-b")).toBe("limited");
    process.env.DS_STATE_ROOT = s.root;
    expect(await dsLift(["claude", "acct-a"])).toBe(0);
    await tick(s);
    expect(blockOf(s)).toBeNull();
    expect(blockOf(s, "acct-b")).toBe("limited");
    expect(col(s) ?? null).toBeNull();
    expect((s.db.query("SELECT limited_until FROM members WHERE wt = 'wt-1'").get() as Row).limited_until ?? null).toBeNull();
    expect(s.db.query("SELECT subject FROM episodes WHERE kind = 'account' AND state = 'claude/acct-a'").all()).toEqual([]);
    expect(readFileSync(join(s.root, ".accounts.episodes"), "utf8")).toBe(`wt-2|other\t${UNTIL}\tclaude\tacct-b\n`);
    expect(readFileSync(join(s.root, "accounts.tsv"), "utf8")).not.toContain(String(UNTIL));
    expect(readFileSync(join(s.root, "accounts.tsv"), "utf8")).toContain("claude\tacct-a\t50");
    const ev = since(s, 0, { kinds: ["account_limit_lifted"] });
    expect(ev.length).toBe(1);
    expect(JSON.parse(String(ev[0].payload))).toMatchObject({ agent: "claude", account: "acct-a" });
    // pick() uses the account again.
    const p = pick(s, { project: "fx", role: "builder", tier: "hard", phase: "build", agent: "claude" }, T + 60);
    expect(p).not.toHaveProperty("wait");
  });

  test("accounts-refresh.sh does not bring the block back", async () => {
    const s = fixture();
    process.env.DS_STATE_ROOT = s.root;
    await dsLift(["claude", "acct-a"]);
    await tick(s);
    // The list is the accounts table's (issue #125): two dev-studio logins with their folders.
    for (const a of ["acct-a", "acct-b"]) {
      mkdirSync(join(s.root, "accounts", "claude", a), { recursive: true });
      s.upsert("accounts", { agent: "claude", account: a }, { source: "ds", config_dir: join(s.root, "accounts", "claude", a) });
    }
    const be = join(s.root, "backend");
    writeFileSync(be, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(be, 0o755);
    const r = Bun.spawnSync([join(ROOT, "bin", "lib", "accounts-refresh.sh")], { env: { ...process.env, BACKEND: be, DS_STATE_ROOT: s.root, DS_NOW: String(T), HOME: s.root } });
    expect(r.exitCode).toBe(0);
    const rows = readFileSync(join(s.root, "accounts.tsv"), "utf8").split("\n").map((l) => l.split("\t"));
    expect(rows.find((c) => c[1] === "acct-a")![6]).toBe("-");
    expect(rows.find((c) => c[1] === "acct-b")![6]).toBe(String(UNTIL));
  });

  test("a new real notice blocks the account again", async () => {
    const s = fixture();
    process.env.DS_STATE_ROOT = s.root;
    await dsLift(["claude", "acct-a"]);
    await tick(s);
    expect(blockOf(s)).toBeNull();
    s.upsert("episodes", { project: "", subject: "limit|claude/acct-a", kind: "account" }, { state: "claude/acct-a", ended_at: T + 7200, started_at: T + 30, source: "loop", observed_at: T + 30 });
    expect(blockOf(s)).toBe("limited");
  });

  test("usage and unknown arguments are refused", async () => {
    expect(await dsLift(["claude"])).toBe(2);
  });
});
