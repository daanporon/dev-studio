// orca-backend-alternatives U9: a squad's backend and worktree tool, chosen once at spawn
// (bin/backend/registry.ts chooseSquadBackend, bin/commands/spawn-squad-ts.ts, migration 0054).
// spawn-squad runs as the Studio runs it, against a temp state root only.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard, limitsJson, renderText } from "../../bin/board/board-data.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { set } from "../../bin/loop/settings/settings.ts";
import { BACKENDS, type BackendEntry, chooseSquadBackend } from "../../bin/backend/registry.ts";
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
  const limit = (key: string, value: string) => set(store, "p", "limits.conf", key, value, "test");
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
  const { spawn, row, limit } = rig();
  const a = await spawn("--topic", "plain");
  expect(a.code).toBe(0);
  expect(row("plain")).toMatchObject({ backend: "orca", backend_host: "local", worktree_provider: "orca", want: "running" });
  expect(JSON.parse(String(row("plain")!.want_payload))).toMatchObject({ backend: "orca", worktree_provider: "orca" });
  limit("default_backend", "tmux");
  const b = await spawn("--topic", "ontmux");
  expect(b.code).toBe(1);
  expect(b.err).toContain("backend tmux (the project's default_backend) is not built yet");
  expect(row("ontmux")).toBeNull();
});

test("--backend wins over the project's default_backend", async () => {
  const { spawn, row, limit } = rig();
  limit("default_backend", "herdr");
  const a = await spawn("--topic", "flagged", "--backend", "orca");
  expect(a.code).toBe(0);
  expect(row("flagged")).toMatchObject({ backend: "orca", worktree_provider: "orca" });
});

test("a backend not built, missing on the host or unknown is refused, never replaced by orca", async () => {
  const { spawn, row } = rig();
  for (const [b, says] of [["tmux", "backend tmux (--backend) is not built yet"], ["herdr", "backend herdr (--backend) is on trial: only a project whose default_backend is herdr starts squads on it"], ["orca-lite", "backend orca-lite (--backend) is on trial: only a project whose default_backend is orca-lite starts squads on it"], ["screen", "backend 'screen' (--backend) is not one of orca, orca-lite, tmux, herdr"]]) {
    const r = await spawn("--topic", `t-${b}`, "--backend", b);
    expect(r.code).toBe(1);
    expect(r.err).toContain(says);
    expect(row(`t-${b}`)).toBeNull();
  }
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", registry: built, which: () => null }))
    .toEqual({ ok: false, error: "backend tmux (--backend) needs 'tmux', which is not on PATH on this host" });
  expect(chooseSquadBackend({ flag: "tmux", projectBackend: "tmux", ...all })).toMatchObject({ ok: true, backend: "tmux" });
});

test("herdr: on trial outside its project; found by DS_HERDR_BIN or the pinned install, else refused with how to install", async () => {
  const rigged = rig(), { spawnWith, row, limit } = rigged;
  expect(chooseSquadBackend({ flag: "herdr", projectBackend: "orca", ...all })).toEqual({ ok: false,
    error: "backend herdr (--backend) is on trial: only a project whose default_backend is herdr starts squads on it; set default_backend herdr on the trial project" });
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

test("a backend on trial starts squads only on a project whose default_backend names it (U16a)", async () => {
  const which = (b: string) => `/usr/bin/${b}`;
  expect(BACKENDS.orca.trial).toBe(false);
  expect(BACKENDS["orca-lite"]).toMatchObject({ adapter: "bin/backend/orca-lite.ts", trial: true });
  // The trial project: no flag, or the flag naming the same backend.
  expect(chooseSquadBackend({ projectBackend: "orca-lite", which })).toMatchObject({ ok: true, backend: "orca-lite", provider: "orca", providerDefault: true });
  expect(chooseSquadBackend({ flag: "orca-lite", projectBackend: "orca-lite", which })).toMatchObject({ ok: true, backend: "orca-lite" });
  // Any other project, even through --backend, is refused; orca stays open to the trial project.
  for (const projectBackend of [undefined, "orca", "tmux"])
    expect(chooseSquadBackend({ flag: "orca-lite", projectBackend, which })).toEqual({ ok: false,
      error: "backend orca-lite (--backend) is on trial: only a project whose default_backend is orca-lite starts squads on it; set default_backend orca-lite on the trial project" });
  expect(chooseSquadBackend({ flag: "orca", projectBackend: "orca-lite", which })).toMatchObject({ ok: true, backend: "orca" });
  // Through spawn-squad, with a stub `orca` first on PATH (the host's own is never reached): the project's
  // default_backend set to orca-lite writes the wish; --backend orca-lite on another project writes none.
  const { store, spawn, spawnWith, row, limit, root } = rig();
  const bin = join(root, "stub-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "orca"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const PATH = `${bin}:${process.env.PATH ?? ""}`;
  const no = await spawnWith({ PATH }, "--topic", "elsewhere", "--backend", "orca-lite");
  expect(no.code).toBe(1);
  expect(no.err).toContain("backend orca-lite (--backend) is on trial");
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
  expect((await spawn("--topic", "plain", "--backend", "orca")).code).toBe(0);
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
  set(store, "p", "limits.conf", "default_backend", "tmux", "test");
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
