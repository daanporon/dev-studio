// U50 (project-start): a Studio off Orca (dispatcher.json studio_backend, a `local::` studio_wt). In its own
// shell only the member verbs go to bin/backend/contract.sh; every other verb backend() sends stays on the
// host's adapter (bin/lib/shared.ts backendFor). With studio_backend empty everything is Orca's, as today.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { ROOT, backendFor, backendPath } from "../../bin/lib/shared.ts";
import { MEMBER_VERBS, contractHere, contractProjects, projectContracts, studioContract } from "../../bin/lib/contract-here.ts";
import { worktreePath, writeRoleFile } from "../../bin/lib/lib.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";

const KEYS = ["BACKEND", "DS_BACKEND", "DS_MEMBER", "DS_STATE_ROOT", "DS_WT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const CONTRACT = join(ROOT, "bin", "backend", "contract.sh"), ORCA = join(ROOT, "bin", "backend", "orca.sh");
// Every verb a backend() caller in bin/ sends today, plus the host's account and Orca verbs.
const HOST_VERBS = ["ps", "worktree-ensure", "repo-ensure", "loop-terminals", "studio-start", "preflight", "account-list", "inbox-wait-self", "send"];

function rig(doc: Record<string, unknown> | null) {
  const root = tempRoot("studio-backend-");
  const store: Store = open(root); onTestEnd(() => store.close());
  const wt = join(root, "p-studio");
  mkdirSync(wt);
  store.upsert("projects", { label: "p" }, { studio_wt: `local::${wt}`, doc: doc ? JSON.stringify(doc) : null, observed_at: 1 });
  store.upsert("projects", { label: "q" }, { studio_wt: "repo1::/work/q-studio", observed_at: 1 });
  for (const k of KEYS) delete process.env[k];
  process.env.DS_STATE_ROOT = root;
  return { root, store, wt };
}
const asStudio = (wt: string, backend?: string) => {
  process.env.DS_MEMBER = "p/_studio/studio"; process.env.DS_WT = `local::${wt}`;
  if (backend) process.env.DS_BACKEND = backend;
};

test("a tmux Studio's shell: the member verbs go to contract.sh, every other verb to the host's adapter", () => {
  const { root, wt } = rig({ studio_backend: "tmux" });
  for (const viaEnv of [false, true]) {   // DS_MEMBER alone (loop.db's studio_backend), or with the start's DS_BACKEND
    asStudio(wt, viaEnv ? "tmux" : undefined);
    expect(contractHere(root)).toBe("tmux");
    expect(backendPath()).toBe(CONTRACT);
    for (const v of MEMBER_VERBS) expect(backendFor(v)).toBe(CONTRACT);
    for (const v of HOST_VERBS) expect(backendFor(v)).toBe(ORCA);
    delete process.env.DS_BACKEND;
  }
  // BACKEND (a test, a swap) still wins over both.
  process.env.BACKEND = "/stub/backend.sh";
  for (const v of [...MEMBER_VERBS, ...HOST_VERBS]) expect(backendFor(v)).toBe("/stub/backend.sh");
});

test("studio_backend empty or orca: the Studio's shell reaches Orca for every verb, as today", () => {
  for (const doc of [null, {}, { studio_backend: "" }, { studio_backend: "orca" }]) {
    const { root, wt } = rig(doc);
    asStudio(wt);
    expect(contractHere(root)).toBeNull();
    expect(studioContract(root, "p")).toBeNull();
    for (const v of [...MEMBER_VERBS, ...HOST_VERBS]) expect(backendFor(v)).toBe(ORCA);
  }
});

test("a member of a squad off Orca keeps every verb on contract.sh (the Studio rule is the Studio's only)", () => {
  const { root, store } = rig({ studio_backend: "tmux" });
  store.db.run("INSERT INTO squads (project, topic, backend, observed_at, updated_at) VALUES ('p', 'ontmux', 'tmux', 1, 1)");
  process.env.DS_MEMBER = "p/ontmux/builder-u1";
  expect(contractHere(root)).toBe("tmux");
  for (const v of [...MEMBER_VERBS, ...HOST_VERBS]) expect(backendFor(v)).toBe(CONTRACT);
});

test("a project whose only contract member is its Studio counts as a contract project", () => {
  const { root } = rig({ studio_backend: "tmux" });
  expect(contractProjects(root)).toEqual(["p"]);   // no DS_MEMBER: every project with a Studio or squad off Orca
  expect(projectContracts(root, "p")).toEqual(["tmux"]);
  expect(projectContracts(root, "q")).toEqual([]);
});

test("a local:: worktree is its own path: the role file and the rewake hook are written there, no `ps`", async () => {
  const { wt } = rig({ studio_backend: "tmux" });
  asStudio(wt);
  process.env.BACKEND = "/nonexistent/backend.sh";   // a `ps` would fail: the path must not come from it
  expect(await worktreePath(`local::${wt}`)).toBe(wt);
  await writeRoleFile(`local::${wt}`, "studio", "p", "", "");
  expect(readFileSync(join(wt, "CLAUDE.local.md"), "utf8")).toContain("studio");
  const arm = spawnSync(join(ROOT, "bin", "ds"), ["arm-rewake-ts", `local::${wt}`, "--", "p", "_studio"], { env: { ...process.env }, encoding: "utf8" });
  expect(arm.status).toBe(0);
  expect(existsSync(join(wt, ".claude", "settings.local.json"))).toBe(true);
});

test("in the Studio's shell: `current` names its local:: worktree and `ds account list` answers", () => {
  const { wt } = rig({ studio_backend: "tmux" });
  asStudio(wt);
  const env = { ...process.env } as Record<string, string>;
  const cur = spawnSync(join(ROOT, "bin", "backend", "contract.sh"), ["current"], { env, encoding: "utf8" });
  expect(cur.status).toBe(0);
  expect(cur.stdout.trim()).toBe(`local::${wt}`);
  const acc = spawnSync(join(ROOT, "bin", "ds"), ["account", "list"], { env, encoding: "utf8" });
  expect(acc.status).toBe(0);
});
