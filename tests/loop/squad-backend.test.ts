// orca-backend-alternatives U9: a squad's backend and worktree tool, chosen once at spawn
// (bin/backend/registry.ts chooseSquadBackend, bin/commands/spawn-squad-ts.ts, migration 0054).
// spawn-squad runs as the Studio runs it, against a temp state root only.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard, limitsJson, renderText } from "../../bin/board/board-data.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { set } from "../../bin/loop/settings/settings.ts";
import { BACKENDS, type BackendEntry, chooseSquadBackend, squadBackendRule } from "../../bin/backend/registry.ts";
import { LoopActuator, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract } from "../../bin/loop/fakes/contract.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";

const ROOT = join(import.meta.dir, "..", "..");

function rig() {
  const root = tempRoot("squad-backend-");
  const store: Store = open(root); onTestEnd(() => store.close());
  store.upsert("projects", { label: "p" }, { home_repo: "path:/fake", observed_at: 1 });
  const spawnWith = async (env: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawn([join(ROOT, "bin/commands/spawn-squad.sh"), "--repo", "p", ...args],
      { env: { ...process.env, DS_STATE_ROOT: root, DS_NOW: "1800000000", ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    return { code: await p.exited, out, err };
  };
  const spawn = (...args: string[]) => spawnWith({}, ...args);
  const row = (topic: string) => store.db.query("SELECT * FROM squads WHERE project = 'p' AND topic = ?").get(topic) as Row | null;
  // A row written straight: these tests are about what spawn refuses; the check at set time (U32) has its own tests.
  const limit = (key: string, value: string) => store.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: 1 });
  // The loop has started the squad: its doc is written and it runs.
  const started = (topic: string) => store.db.run("UPDATE squads SET doc = '{}', status = 'running' WHERE project = 'p' AND topic = ?", [topic]);
  return { store, spawn, spawnWith, row, limit, started, root };
}

// Every backend built and every binary present, so the provider rules can be checked on their own.
const built: Record<string, BackendEntry> = Object.fromEntries(Object.entries(BACKENDS).map(([k, e]) => [k, { ...e, adapter: e.adapter ?? `bin/backend/${k}.sh` }]));
const all = { registry: built, which: (b: string) => `/usr/bin/${b}` };

test("every existing squad reads orca on Orca's own worktrees", () => {
  const { store, row } = rig();
  store.db.run("INSERT INTO squads (project, topic, observed_at, updated_at) VALUES ('p', 'old', 1, 1)");
  expect(row("old")).toMatchObject({ backend: "orca", backend_host: "local", worktree_provider: "orca", host: null });
});

test("no flag: the squad gets the project's default_backend", async () => {
  const { spawn, row } = rig();
  const a = await spawn("--topic", "plain");
  expect(a.code).toBe(0);
  expect(row("plain")).toMatchObject({ backend: "orca", backend_host: "local", worktree_provider: "orca", want: "running" });
  expect(JSON.parse(String(row("plain")!.want_payload))).toMatchObject({ backend: "orca", worktree_provider: "orca" });
  // Every shipped backend has an adapter now: an entry with none is refused, naming where it came from.
  const unbuilt = { x: { ...BACKENDS.tmux, name: "x", adapter: null } };
  const b = chooseSquadBackend({ projectBackend: "x", registry: unbuilt, which: (n: string) => `/usr/bin/${n}` });
  expect(b.ok ? "" : b.error).toContain("backend x (the project's default_backend) is not built yet");
});

test("U30: tmux starts squads only in a project whose default_backend is tmux", async () => {
  const which = (b: string) => `/usr/bin/${b}`;
  expect(BACKENDS.tmux).toMatchObject({ adapter: "bin/backend/tmux.ts" });
  expect(chooseSquadBackend({ flag: "tmux", which })).toEqual({ ok: false, error: `backend tmux is refused: this project's squads start on orca (its default_backend); to change it set the project's default_backend (ds config set <project> limits.conf default_backend <name>) (asked for by --backend)` });
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "orca", which }).ok).toBe(false);
  expect(chooseSquadBackend({ projectBackend: "tmux", which })).toMatchObject({ ok: true, backend: "tmux", provider: "git", providerDefault: true });
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", which })).toMatchObject({ ok: true, backend: "tmux" });
  // One rule: the tmux project cannot start an orca or herdr squad either.
  for (const other of ["orca", "herdr"]) {
    const c = chooseSquadBackend({ flag: other, projectBackend: "tmux", which });
    expect(c.ok).toBe(false);
    expect(c.ok ? "" : c.error).toContain(`backend ${other} is refused: this project's squads start on tmux (its default_backend)`);
  }
  expect(squadBackendRule({ backend: "tmux", projectBackend: "tmux" })).toBeNull();
  expect(squadBackendRule({ backend: "orca" })).toBeNull();
  expect(squadBackendRule({ backend: "orca", host: "far" })).toContain("host 'far' is not supported yet");
  const { store, spawn, row, limit } = rig();
  const a = await spawn("--topic", "flagonly", "--backend", "tmux");
  expect(a.code).toBe(1);
  expect(a.err).toContain("backend tmux is refused: this project's squads start on orca (its default_backend)");
  expect(row("flagonly")).toBeNull();
  if (!Bun.which("tmux")) { console.log("skip: no tmux on PATH, the tmux project's spawn is not run"); return; }
  limit("default_backend", "tmux");
  // The shipped builder row falls back to muse, which has no launch line off Orca: the tmux project's
  // roster drops it (docs/backends/trial-tmux.md, "Before the run").
  const b0 = await spawn("--topic", "ontmux");
  expect(b0.code).toBe(1);
  expect(b0.err).toContain("backend tmux can start only claude; the roster names builder: muse");
  set(store, "p", "roles.conf", "builder", "claude opus ondemand - claude:sonnet", "test");
  const b = await spawn("--topic", "ontmux");
  expect(b.err).toBe("");
  expect(b.code).toBe(0);
  expect(row("ontmux")).toMatchObject({ backend: "tmux", backend_host: "local", worktree_provider: "git", want: "running" });
});

test("U30: --backend naming another backend than the project's default_backend is refused", async () => {
  const { spawn, row, limit } = rig();
  limit("default_backend", "herdr");
  const a = await spawn("--topic", "flagged", "--backend", "orca");
  expect(a.code).toBe(1);
  expect(a.err).toContain("backend orca is refused: this project's squads start on herdr (its default_backend)");
  expect(a.err).toContain("ds config set <project> limits.conf default_backend");
  expect(row("flagged")).toBeNull();
});

test("a backend on trial elsewhere, missing on the host or unknown is refused, never replaced by orca", async () => {
  const { spawn, row } = rig();
  for (const [b, says] of [["tmux", "backend tmux is refused: this project's squads start on orca (its default_backend)"], ["herdr", "backend herdr is refused: this project's squads start on orca (its default_backend)"], ["orca-lite", "backend orca-lite is refused: this project's squads start on orca (its default_backend)"], ["screen", "backend 'screen' (--backend) is not one of orca, orca-lite, tmux, herdr"]]) {
    const r = await spawn("--topic", `t-${b}`, "--backend", b);
    expect(r.code).toBe(1);
    expect(r.err).toContain(says);
    expect(row(`t-${b}`)).toBeNull();
  }
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", registry: built, which: () => null }))
    .toEqual({ ok: false, error: "backend tmux (--backend) needs 'tmux', which is not on PATH on this host" });
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", ...all })).toMatchObject({ ok: true, backend: "tmux" });
});

test("herdr: refused outside its project; found by DS_HERDR_BIN or the pinned install, else refused with how to install", async () => {
  const rigged = rig(), { spawnWith, row, limit } = rigged;
  expect(chooseSquadBackend({ flag: "herdr", projectBackend: "orca", ...all })).toEqual({ ok: false, error: `backend herdr is refused: this project's squads start on orca (its default_backend); to change it set the project's default_backend (ds config set <project> limits.conf default_backend <name>) (asked for by --backend)` });
  const herdr = BACKENDS.herdr;
  expect(chooseSquadBackend({ projectBackend: "herdr", registry: { herdr: { ...herdr, find: () => null } } })).toEqual({ ok: false,
    error: "backend herdr (the project's default_backend) needs 'herdr', which is not on PATH on this host; install it with: bun bin/backend/herdr.ts install" });
  expect(chooseSquadBackend({ projectBackend: "herdr", registry: { herdr: { ...herdr, find: () => "/opt/herdr" } } })).toMatchObject({ ok: true, backend: "herdr", provider: "git" });
  // spawn-squad end to end: the project's default_backend is herdr, the binary named by DS_HERDR_BIN,
  // and a roster with Claude alone (off Orca only Claude starts).
  const { store } = rigged;
  limit("default_backend", "herdr");
  for (const role of ["builder", "builder-review", "builder-review-standard"])
    set(store, "p", "roles.conf", role, "claude opus ondemand - claude:sonnet", "test");
  const fake = join(tempRoot("squad-backend-herdr-"), "herdr");
  writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
  const r = await spawnWith({ DS_HERDR_BIN: fake }, "--topic", "onherdr");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(row("onherdr")).toMatchObject({ backend: "herdr", worktree_provider: "git" });
});

test("U30: orca-lite starts squads only on a project whose default_backend names it", async () => {
  const which = (b: string) => `/usr/bin/${b}`;
  expect(BACKENDS["orca-lite"]).toMatchObject({ adapter: "bin/backend/orca-lite.ts" });
  // The trial project: no flag, or the flag naming the same backend.
  expect(chooseSquadBackend({ projectBackend: "orca-lite", which })).toMatchObject({ ok: true, backend: "orca-lite", provider: "orca", providerDefault: true });
  expect(chooseSquadBackend({ flag: "orca-lite", projectBackend: "orca-lite", which })).toMatchObject({ ok: true, backend: "orca-lite" });
  // Any other project, even through --backend, is refused; so is orca on the orca-lite project.
  for (const projectBackend of [undefined, "orca", "tmux"])
    expect(chooseSquadBackend({ flag: "orca-lite", projectBackend, which })).toEqual({ ok: false,
      error: `backend orca-lite is refused: this project's squads start on ${projectBackend ?? "orca"} (its default_backend); to change it set the project's default_backend (ds config set <project> limits.conf default_backend <name>) (asked for by --backend)` });
  expect(chooseSquadBackend({ flag: "orca", projectBackend: "orca-lite", which }).ok).toBe(false);
  // Through spawn-squad, with a stub `orca` first on PATH (the host's own is never reached): the project's
  // default_backend set to orca-lite writes the wish; --backend orca-lite on another project writes none.
  const { store, spawn, spawnWith, row, limit, root } = rig();
  const bin = join(root, "stub-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "orca"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const PATH = `${bin}:${process.env.PATH ?? ""}`;
  const no = await spawnWith({ PATH }, "--topic", "elsewhere", "--backend", "orca-lite");
  expect(no.code).toBe(1);
  expect(no.err).toContain("backend orca-lite is refused: this project's squads start on orca (its default_backend)");
  expect(row("elsewhere")).toBeNull();
  limit("default_backend", "orca-lite");
  // The default builder row falls back to muse, which has no launch line off Orca: refused until the
  // trial project's own row drops it (docs/backends/trial-orca-lite.md, step 1).
  expect((await spawnWith({ PATH }, "--topic", "trial")).err).toContain("backend orca-lite can start only claude; the roster names builder: muse");
  set(store, "p", "roles.conf", "builder", "claude opus ondemand - claude:sonnet", "test");
  const a = await spawnWith({ PATH }, "--topic", "trial");
  expect(a.err).toBe("");
  expect(a.code).toBe(0);
  expect(row("trial")).toMatchObject({ backend: "orca-lite", worktree_provider: "orca" });
  const orcaOn = await spawn("--topic", "plain", "--backend", "orca");
  expect(orcaOn.code).toBe(1);
  expect(orcaOn.err).toContain("start on orca-lite (its default_backend)");
});

test("changing default_backend leaves a running squad alone; its backend is written once", async () => {
  const { store, spawn, row, limit, started } = rig();
  expect((await spawn("--topic", "live")).code).toBe(0);
  started("live");
  limit("default_backend", "tmux");
  limit("worktree_provider", "git");
  const again = await spawn("--topic", "live", "--start", "plan");
  expect(again.code).toBe(0);
  expect(row("live")).toMatchObject({ backend: "orca", worktree_provider: "orca" });
  const other = await spawn("--topic", "live", "--backend", "herdr");
  expect(other.code).toBe(1);
  expect(other.err).toContain("squad live runs on orca; a squad's backend is written once at spawn");
  // The table refuses the change too, whoever writes it.
  expect(() => store.db.run("UPDATE squads SET backend = 'tmux' WHERE topic = 'live'")).toThrow(/written once at spawn/);
  expect(() => store.db.run("UPDATE squads SET worktree_provider = 'git' WHERE topic = 'live'")).toThrow(/written once at spawn/);
  // A closed squad started again under its topic may start elsewhere.
  store.db.run("UPDATE squads SET status = 'closed' WHERE topic = 'live'");
  store.db.run("UPDATE squads SET backend = 'tmux' WHERE topic = 'live'");
  expect(row("live")!.backend).toBe("tmux");
});

test("auto gives the backend's default worktree tool", () => {
  expect(chooseSquadBackend({ flag: "orca", providerSetting: "auto", ...all })).toMatchObject({ ok: true, provider: "orca", providerDefault: true });
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", providerSetting: "auto", ...all })).toMatchObject({ ok: true, provider: "git", providerDefault: true });
  expect(chooseSquadBackend({ projectBackend: "herdr", ...all })).toMatchObject({ ok: true, backend: "herdr", provider: "git" });
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", providerSetting: "treehouse", ...all })).toMatchObject({ ok: true, provider: "treehouse", providerDefault: false });
});

test("treehouse needs its binary at spawn: DS_TREEHOUSE_BIN, else on PATH", () => {
  const none = { registry: built, which: (b: string) => (b === "treehouse" ? null : `/usr/bin/${b}`) };
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", providerSetting: "treehouse", ...none })).toEqual({ ok: false,
    error: "worktree_provider treehouse needs 'treehouse' (DS_TREEHOUSE_BIN, else on PATH), which this host lacks; install treehouse (github.com/kunchenguid/treehouse) or set worktree_provider auto" });
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", providerSetting: "git", ...none })).toMatchObject({ ok: true, provider: "git" });
});

test("a worktree tool the backend cannot use is refused, naming both", async () => {
  expect(chooseSquadBackend({ flag: "orca-lite", providerSetting: "treehouse", ...all })).toEqual({ ok: false,
    error: "backend orca-lite cannot use worktree_provider treehouse (the project's setting): orca-lite uses orca; set worktree_provider auto, or pick another backend" });
  const { spawn, row, limit } = rig();
  limit("worktree_provider", "git");
  const r = await spawn("--topic", "gitonorca");
  expect(r.code).toBe(1);
  expect(r.err).toContain("backend orca cannot use worktree_provider git");
  expect(row("gitonorca")).toBeNull();
});

test("the board: each squad's backend and tool, the text line only off orca, and the Settings keys", () => {
  const root = tempRoot("squad-backend-board-");
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  for (const t of ["plain", "ontmux", "ontree"])
    writeFileSync(join(root, "p", "squads", `${t}.json`), JSON.stringify({ task_id: t, run_id: `run_${t}`, repo: "path:/r/p", status: "running", members: [], units: [], worktrees: [] }));
  const r = spawnSync(join(ROOT, "bin/ds"), ["import"], { env: { ...process.env, DS_STATE_ROOT: root }, encoding: "utf8" });
  expect(r.status).toBe(0);
  const store = open(root); onTestEnd(() => store.close());
  // A started squad's backend is written once; the fixture writes it while the row reads closed.
  const put = (t: string, backend: string, tool: string) => {
    const st = (store.db.query("SELECT status FROM squads WHERE topic = ?").get(t) as Row).status;
    store.db.run("UPDATE squads SET status = 'closed' WHERE topic = ?", [t]);
    store.db.run("UPDATE squads SET backend = ?, worktree_provider = ? WHERE topic = ?", [backend, tool, t]);
    store.db.run("UPDATE squads SET status = ? WHERE topic = ?", [st, t]);
  };
  put("ontmux", "tmux", "git"); put("ontree", "tmux", "treehouse");
  store.upsert("config", { project: "p", file: "limits.conf", key: "default_backend" }, { value: "tmux", observed_at: 1 });
  const b = buildBoard("p", "", root) as any;
  const sq = (t: string) => b.squads.find((s: any) => s.topic === t);
  expect(sq("plain")).toMatchObject({ backend: "orca", worktree_provider: "orca", provider_default: true });
  expect(sq("ontmux")).toMatchObject({ backend: "tmux", worktree_provider: "git", provider_default: true });
  expect(sq("ontree")).toMatchObject({ backend: "tmux", worktree_provider: "treehouse", provider_default: false });
  expect(b.projects.find((p: any) => p.label === "p").default_backend).toBe("tmux");
  const line = (t: string) => renderText(b).split("\n").find((l: string) => l.startsWith("▣") && l.includes(` ${t} `)) ?? "";
  expect(line("plain")).not.toContain("on:");
  expect(line("ontmux")).toContain("· on:tmux");
  expect(line("ontmux")).not.toContain("on:tmux/");
  expect(line("ontree")).toContain("· on:tmux/treehouse");
  const lim = limitsJson("p", root).limits;
  expect(lim.find((l: any) => l.key === "default_backend")).toMatchObject({ value: "tmux", allowed: ["orca", "orca-lite", "tmux", "herdr"] });
  expect(lim.find((l: any) => l.key === "worktree_provider")).toMatchObject({ value: "auto", allowed: ["auto", "git", "treehouse"] });
});

test("U11: off Orca only claude has a launch line: a roster role or fallback on codex or muse is named; elevate roles are not", async () => {
  const { noLaunchLine } = await import("../../bin/commands/spawn-squad-ts.ts");
  const roster = new Map([
    ["lead", "claude  sonnet always"],
    ["thinker-deep", "codex gpt elevate"],
    ["builder", "claude  opus   ondemand -  claude:sonnet,muse:muse-spark-1.3"],
    ["tester", "codex gpt-5 ondemand"],
  ]);
  expect(noLaunchLine(roster)).toEqual(["builder: muse", "tester: codex"]);
  expect(noLaunchLine(new Map([["lead", "claude sonnet always"], ["builder", "claude opus ondemand - claude:sonnet"]]))).toEqual([]);
});

// U50 (project-start): the Studio has no squads row; its seat follows dispatcher.json's studio_backend.
describe("the Studio's seat", () => {
  const T = 1_800_000_000, WT = "local::/work/p-studio";
  const pick: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "system" });
  function studioRig(doc: Record<string, unknown> | null, studioWt = WT) {
    const { store, limit } = rig();
    store.upsert("projects", { label: "p" }, { studio_wt: studioWt, doc: doc ? JSON.stringify(doc) : null, observed_at: 1 });
    const made: string[] = [], fake = fakeContract({}, { name: "tmux", now: () => T });
    const act = new LoopActuator({ orca: new FakeOrca(), pick, fulfillers: [], backends: (name) => { made.push(name); return { backend: fake, caps: fake.caps }; } });
    return { store, limit, act, made, fake };
  }

  test("studio_backend tmux and a local:: studio_wt: a Studio action gets a tmux seat on the project's tool", async () => {
    const { store, act, made, limit } = studioRig({ studio_backend: "tmux" });
    for (const s of [act.seat(store, "p", null, "studio.move:e1", WT, T), act.seat(store, "p", "_studio", "chat:e1", null, T)]) {
      expect(s.contract?.backend).toBe("tmux");
      expect(s.contract?.provider).toBe("git");
      expect(s.squad).toEqual({ project: "p", topic: "_studio", run_id: null, repo: null, lead_wt: null, studio_wt: WT });
      expect((await s.call("studio-start", [])).err).toContain("the Studio is on backend tmux: no Orca op (studio-start)");
    }
    limit("worktree_provider", "treehouse");
    expect(act.seat(store, "p", null, "k", WT, T).contract?.provider).toBe("treehouse");
    limit("worktree_provider", "auto");
    expect(act.seat(store, "p", null, "k", WT, T).contract?.provider).toBe("git");
    // A start on it goes to the backend, marked with the backend and the Studio's identity and generation.
    const s = act.seat(store, "p", null, "studio.move:e2", WT, T, "p/_studio/studio");
    const r = await s.contract!.start({ cwd: "/work/p-studio", env: {} }, { line: "claude" } as never);
    expect(r.ok).toBe(true);
    expect(made).toContain("tmux");
    const row = store.db.query("SELECT op, project, squad, member, sender FROM orca_calls WHERE key = 'studio.move:e2'").get() as Row;
    expect(row).toEqual({ op: "terminal.create", project: "p", squad: null, member: WT, sender: "contract:tmux" });
    expect(s.gen()).toBeTruthy();
  });

  test("a project-level seat with no Studio member (a poke to a sender terminal) stays on Orca", () => {
    const { store, act } = studioRig({ studio_backend: "tmux" });
    expect(act.seat(store, "p", null, "k", null, T).contract).toBeUndefined();
    expect(act.seat(store, "p", null, "k", "local::/elsewhere", T).contract).toBeUndefined();
  });

  test("studio_backend empty, orca or missing: the seat is today's Orca seat", () => {
    for (const doc of [null, {}, { studio_backend: "" }, { studio_backend: "orca" }]) {
      const { store, act, made } = studioRig(doc, "repo1::/work/p-studio");
      const s = act.seat(store, "p", null, "k", "repo1::/work/p-studio", T);
      expect(s.contract).toBeUndefined();
      expect(s.squad).toEqual({ project: "p", topic: "", run_id: null, repo: null, lead_wt: null, studio_wt: "repo1::/work/p-studio" });
      expect(made).toEqual([]);
    }
  });
});

// U54 (project-start): one backend per project. A squad on a backend other than the Studio's is refused with the
// reason and the command that moves the whole project, whatever default_backend says.
test("U54: on a project whose Studio runs on tmux, an Orca squad wish is refused, naming ds up --backend", async () => {
  const which = (b: string) => `/usr/bin/${b}`;
  const why = "backend orca is refused: this project's Studio runs on tmux, and a project keeps one backend for its Studio and squads; to move the whole project: ds up realp --backend orca";
  expect(squadBackendRule({ backend: "orca", projectBackend: "orca", studioBackend: "tmux", project: "realp" })).toBe(why);
  expect(chooseSquadBackend({ projectBackend: "orca", studioBackend: "tmux", project: "realp", which })).toEqual({ ok: false, error: `${why} (asked for by the project's default_backend)` });
  expect(squadBackendRule({ backend: "tmux", projectBackend: "tmux", studioBackend: "tmux" })).toBeNull();
  expect(squadBackendRule({ backend: "orca", projectBackend: "orca", studioBackend: null })).toBeNull();
  const { spawn, row, root } = rig();
  mkdirSync(join(root, "p"), { recursive: true });
  writeFileSync(join(root, "p", "dispatcher.json"), JSON.stringify({ home_repo: "path:/fake", studio_wt: "local::/fake/studio", studio_backend: "tmux" }));
  const a = await spawn("--topic", "orcawish");
  expect(a.code).toBe(1);
  expect(a.err).toContain("backend orca is refused: this project's Studio runs on tmux");
  expect(a.err).toContain("ds up p --backend orca");
  expect(row("orcawish")).toBeNull();
});
