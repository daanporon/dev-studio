// side-skills.test.ts — side-loop-host U21 (issue #127): a side host checks and installs the role skills of its own
// logins. The install checks the side's logins, its state observer reads each login folder's skills, they come up
// the link, main raises the same card as for its own accounts, naming the host, and the side loop runs
// install-skills.sh in the background for each set of broken folders.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import type { Action, Actuator, Reconciler, TickCtx } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { makeSideActuator, SIDE_SKILLS_RETRY_S, type Installed } from "../../bin/loop/core/side-actuator.ts";
import { stateObserver } from "../../bin/loop/observers/state.ts";
import accountSkills, { skillsOf } from "../../bin/loop/reconcilers/account-skills.ts";
import alerts from "../../bin/loop/reconcilers/alerts.ts";
import sideSkillsR from "../../bin/loop/reconcilers/side-skills.ts";
import { applyUp, upBatch, upRequests } from "../../bin/link/replica.ts";
import { claudeSkillAccounts, ROLE_CE_SKILLS } from "../../bin/lib/account-skills.ts";
import { writeSideConfig } from "../../bin/lib/loop-unit.ts";

const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), "zzsideskills-")); temps.push(d); return d; };
const store = (root = temp()) => { const s = open(root); stores.push(s); return s; };
const all = (s: Store, sql: string) => s.db.query(sql).all() as Row[];

function put(file: string, text = "x\n") { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); }
/** Give a Claude config folder every role skill. */
function heal(cfg: string) {
  const ce = join(cfg, "plugins", "cache", "ce");
  for (const s of ROLE_CE_SKILLS) put(join(ce, "skills", s, "SKILL.md"));
  put(join(cfg, "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "compound-engineering@compound-engineering-plugin": [{ scope: "user", installPath: ce }] } }));
  put(join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: { "compound-engineering@compound-engineering-plugin": true } }));
  for (const s of ["no-mistakes", "lavish"]) put(join(cfg, "skills", s, "SKILL.md"));
}
const folder = () => { const d = join(temp(), "cfg"); mkdirSync(d); return d; };
const line = (dir: string, login: string) => `claude\t${dir}\t${login}\t${login === "-" ? 0 : 1}`;

function observe(s: Store, lines: string[], at: number, role?: "side") {
  const d = temp();
  const o = stateObserver({ tokenDir: join(d, "projects"), lavishDir: join(d, "lavish"), lavishLog: join(d, "lavish.log"),
    refreshAccounts: () => {}, scanFolders: () => lines });
  return o.run({ store: s, project: "", tick: at, now: at, fired: [], poked: new Set(), ...(role ? { role } : {}) } as TickCtx);
}
const ship = (side: Store, main: Store) => { for (const req of upRequests(upBatch(side, true))) applyUp(main, "laptop", req); };

describe("the side's own logins", () => {
  test("on a side root the skills install and check take the folders this host is logged in to", () => {
    const root = temp(), home = temp(), env = { HOME: home, DS_STATE_ROOT: root };
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeSideConfig(root, { main: "100.64.0.1:7790", name: "laptop" });
    // No login yet: the system folder, so a fresh host gets the skills.
    expect(claudeSkillAccounts(root, env)).toEqual([{ account: "system", dir: join(home, ".claude") }]);
    const named = join(root, "accounts", "claude", "work");
    put(join(named, ".credentials.json"), "{}");
    expect(claudeSkillAccounts(root, env)).toEqual([{ account: "work", dir: named }]);
  });
});

describe("what the side reports, and main's card", () => {
  test("a missing skill on a side login: main shows the account card naming the host, and clears it once healed", async () => {
    const side = store(), main = store(), cfg = folder(), spare = folder();
    mkdirSync(join(main.root, "realp", "squads"), { recursive: true });
    importConfig(main, main.root);
    main.upsert("hosts", { name: "laptop" }, { status: "accepted", public_key: "k", requested_at: T });
    main.upsert("accounts", { agent: "claude", account: "work" }, { label: "Work", source: "ds", config_dir: "/a/work", login_id: "uuid-1", observed_at: T });

    // The side reads each login folder; a folder without a login is not checked.
    await observe(side, [line(cfg, "uuid-1"), line(spare, "-")], T, "side");
    const read = Object.fromEntries(all(side, "SELECT dir, skills FROM observed_account_folders").map((r) => [r.dir, r.skills]));
    expect(String(read[cfg])).toStartWith("broken: compound-engineering is not installed");
    expect(read[spare]).toBeNull();

    ship(side, main);
    await observe(main, [], T + 1);
    expect(skillsOf(main, "work@laptop")).toBe(String(read[cfg]));

    const rec: Actuator = { act() {} };
    const loop = new Loop(main, { observers: [], reconcilers: [accountSkills, alerts as Reconciler] }, rec, { projects: () => ["realp"] });
    const tick = async (at: number) => (await loop.tick(at)).acted;
    const raised = (await tick(T + 2)).filter((a) => a.kind === "alert");
    expect(raised.length).toBe(1);
    const p = raised[0].payload as Row;
    expect(String(p.id)).toMatch(/^sweep-account-skills\.work@laptop-[0-9]+$/);
    expect(String(p.text)).toStartWith("Claude account Work (work) on host laptop cannot load the role skills: compound-engineering is not installed");
    expect(String(p.text)).toContain("Repair: run bin/host/install-skills.sh on host laptop.");
    // The card the Studio shows, as the alerts observer imports it (the state observer re-reads it from files).
    const card = () => main.upsert("observed_alerts", { project: "realp", id: String(p.id) },
      { doc: JSON.stringify({ id: p.id, asker: "sweep", title: p.title, question: p.text, since: new Date((T + 2) * 1000).toISOString() }), observed_at: T });
    card();
    const quiet = await tick(T + 60);
    expect(quiet.filter((a) => a.kind === "alert" || a.kind === "alert-clear")).toEqual([]);

    heal(cfg);
    await observe(side, [line(cfg, "uuid-1")], T + 100, "side");
    ship(side, main);
    await observe(main, [], T + 101);
    expect(skillsOf(main, "work@laptop")).toBe("ok");
    card();
    expect((await tick(T + 102)).filter((a) => a.kind === "alert-clear").map((a) => (a.payload as Row).id)).toEqual([p.id]);
    expect(all(main, "SELECT state FROM episodes WHERE kind = 'account-skills'")).toEqual([{ state: "closed" }]);
  });

  test("a removed host's folders raise nothing", async () => {
    const main = store();
    main.upsert("hosts", { name: "laptop" }, { status: "removed", requested_at: T });
    main.upsert("account_folders", { agent: "claude", account: "work", host: "laptop" }, { dir: "/s/.claude", observed_at: T });
    main.upsert("observed_account_folders", { dir: "laptop::/s/.claude" }, { agent: "claude", host: "laptop", login_id: "uuid-1", logged_in: 1, skills: "broken: no", observed_at: T });
    expect(accountSkills.run({ store: main, project: "realp", tick: 1, now: T, fired: [], poked: new Set() } as TickCtx)).toEqual([]);
    expect(skillsOf(main, "work@laptop")).toBeUndefined();
  });
});

describe("the side loop installs", () => {
  test("once per set of broken folders, in the background, again after a failure, never twice at once", async () => {
    const side = store();
    const broken = (dir: string, value = "broken: no") => side.upsert("observed_account_folders", { dir }, { agent: "claude", host: "local", logged_in: 1, skills: value, observed_at: T });
    const runs: ((r: Installed) => void)[] = [];
    const actuator = makeSideActuator({ skills: () => new Promise<Installed>((done) => { runs.push(done); }) });
    const loop = new Loop(side, { observers: [], reconcilers: [sideSkillsR] }, actuator, { role: "side", projects: () => [] });
    const finish = async (r: Installed) => { runs.at(-1)!(r); await Bun.sleep(1); };
    const facts = () => all(side, "SELECT kind FROM events WHERE kind LIKE 'side_skills%' ORDER BY id").map((r) => r.kind);

    broken("/s/a", "ok");
    await loop.tick(T);
    expect(runs.length).toBe(0);

    broken("/s/a");
    await loop.tick(T + 1);   // returns while the install still runs
    expect(runs.length).toBe(1);
    await loop.tick(T + 2 + SIDE_SKILLS_RETRY_S);
    expect(runs.length, "one run at a time").toBe(1);
    await finish({ ok: false, error: "exit 1: no network" });
    expect(facts()).toEqual(["side_skills_failed"]);

    await loop.tick(T + 3 + SIDE_SKILLS_RETRY_S);
    expect(runs.length, "not before the retry time").toBe(1);
    await loop.tick(T + 3 + 2 * SIDE_SKILLS_RETRY_S);
    expect(runs.length).toBe(2);
    await finish({ ok: true });
    expect(facts()).toEqual(["side_skills_failed", "side_skills_installed"]);

    // Still broken after a run that ended well: main's card asks the operator.
    await loop.tick(T + 3 + 4 * SIDE_SKILLS_RETRY_S);
    expect(runs.length).toBe(2);

    // Another folder breaks: a new set.
    broken("/s/b");
    await loop.tick(T + 4 + 4 * SIDE_SKILLS_RETRY_S);
    expect(runs.length).toBe(3);
    await finish({ ok: true });

    // All healed, then the first set again: a new spell.
    broken("/s/a", "ok"); broken("/s/b", "ok");
    await loop.tick(T + 5 + 4 * SIDE_SKILLS_RETRY_S);
    broken("/s/a");
    await loop.tick(T + 6 + 4 * SIDE_SKILLS_RETRY_S);
    expect(runs.length).toBe(4);
  });

  test("a main loop asks for no install", () => {
    const main = store();
    main.upsert("observed_account_folders", { dir: "/s/a" }, { agent: "claude", logged_in: 1, skills: "broken: no", observed_at: T });
    expect(sideSkillsR.run({ store: main, project: "", tick: 1, now: T, fired: [], poked: new Set() } as TickCtx)).toEqual([]);
  });
});
