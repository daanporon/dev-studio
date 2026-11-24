// leftover-remove.test.ts — archive-leftovers U1: a leftover worktree is removed only when every path it
// changes (commits on no remote, tracked changes, untracked files) is byte for byte the same path on the
// default branch, and a retired member's removal is no longer dropped as "generation changed". Real git
// repos in a temp dir with a bare origin, through the real actuator with fake Orca, as fulfil-actions.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { actionBlock, gateBlock } from "../../bin/loop/pause/pause.ts";

const REPO = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const ENV = ["DS_CLOSE_ROLE", "BACKEND", "FAKE_LOG"];
const temps: string[] = [], stores: Store[] = [];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzleftover-")); temps.push(d); return d; };
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);

// Squad t1 of project fx: a Lead and Builder u1 (wtb, unit done), with one leftover.
function rig(wt: string, path: string) {
  const t = tmp(), S = join(t, "state");
  for (const f of ["bin", "conventions", "roles", "AGENTS.md"]) symlinkSync(join(REPO, f), join(t, f));
  mkdirSync(join(S, "fx", "squads"), { recursive: true });
  writeFileSync(join(S, "fx", "dispatcher.json"), '{"home_repo":"fx"}');
  writeFileSync(join(S, "fx", "squads", "t1.json"), JSON.stringify({
    topic: "t1", repo: "fx", type: "feature", status: "running", run_id: "run1", lead_wt: "wtl", worktrees: ["wtl", "wtb"],
    members: [{ role: "lead", wt: "wtl" }, { role: "builder", suffix: "u1", wt: "wtb" }],
    units: [{ slug: "u1", status: "done", tier: "hard", builder_wt: "wtb", pr: "7" }], leftovers: [{ wt, path, branch: "work", unit: "u1" }],
  }));
  const s = open(S);
  stores.push(s);
  importJson(s);
  writeFileSync(join(S, ".loop-migrated"), "");
  const fake = join(t, "fakeb");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_LOG"\ncase "$1" in current) echo wt-elsewhere ;; ps) echo '{"result":{"worktrees":[]}}' ;; *) echo '{}' ;; esac\n`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, { DS_CLOSE_ROLE: join(t, "bin", "close-role.sh"), BACKEND: fake, FAKE_LOG: join(t, "backend.log") });
  const orca = new FakeOrca(), queue: Action[] = [];
  const emit: Reconciler = { name: "emit", run: () => queue.splice(0) };
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers, emit] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const action: Action = { project: "fx", squad: "t1", subject: wt, kind: "worktree.remove", episode: `leftover:${wt}@1`,
    payload: { label: "fx", topic: "t1", wt, path, branch: "work", unit: "u1", merged: true } };
  const send = async () => { queue.push({ ...action }); at += 1; await loop.tick(at); await act.drain(); };
  return { s, orca, send, action };
}
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const results = (s: Store) => events(s, "action_done").filter((e) => e.kind === "worktree.remove").map((e) => e.result);
const leftovers = (s: Store) => (JSON.parse(String(s.get("squads", { project: "fx", topic: "t1" })!.doc)).leftovers ?? []) as Row[];

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
// A bare origin whose main holds a.txt and a .gitignore (.env), a seed clone that lands work on main (a
// squash merge is a new commit on main with the branch's files), and the leftover: a clone on branch work.
function repos() {
  const d = tmp(), bare = join(d, "origin.git"), seed = join(d, "seed"), wt = join(d, "wt");
  mkdirSync(bare); mkdirSync(seed);
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, ".gitignore"), ".env\nnode_modules/\nCLAUDE.local.md\n");
  writeFileSync(join(seed, "a.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  Bun.spawnSync(["git", "clone", "-q", bare, wt]);
  git(wt, "checkout", "-q", "-b", "work");
  const land = (files: Record<string, string>) => {
    git(seed, "pull", "-q", "--ff-only", "origin", "main");
    for (const [f, c] of Object.entries(files)) writeFileSync(join(seed, f), c);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "squash");
    git(seed, "push", "-q", "origin", "main");
  };
  const commit = (files: Record<string, string>, msg = "work") => {
    for (const [f, c] of Object.entries(files)) writeFileSync(join(wt, f), c);
    git(wt, "add", ".");
    git(wt, "commit", "-qm", msg);
  };
  return { wt, land, commit };
}

describe("leftover rule (archive-leftovers U1)", () => {
  const removed = (r: ReturnType<typeof rig>, wt = "wtx") => {
    expect(r.orca.of("worktree-rm").map((c) => c.args)).toEqual([[`id:${wt}`]]);
    expect(results(r.s)).toEqual(["removed: all on main"]);
    expect(leftovers(r.s)).toEqual([]);
  };
  const kept = (r: ReturnType<typeof rig>, why: string) => {
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(results(r.s)).toEqual([why]);
    expect(leftovers(r.s)).toHaveLength(1);
  };

  test("(a) an unpushed commit with a line not on main is kept, its PR merged or not", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    g.commit({ "a.txt": "base\nmine\n" });
    await r.send();
    kept(r, "left: 1 commit, 1 file not on main");
  });

  test("(b) uncommitted edits not on main are kept", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    writeFileSync(join(g.wt, "a.txt"), "edited\n");
    await r.send();
    kept(r, "left: 0 commits, 1 file not on main");
  });

  test("(c) unpushed commits whose files main holds after a squash merge are removed", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    g.commit({ "b.txt": "one\n" }, "first");
    g.commit({ "b.txt": "two\n", "c.txt": "c\n" }, "second");
    g.land({ "b.txt": "two\n", "c.txt": "c\n" });
    await r.send();
    removed(r);
  });

  test("(d) dirty files whose content main holds are removed", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    g.land({ "b.txt": "same\n", "a.txt": "new\n" });
    writeFileSync(join(g.wt, "b.txt"), "same\n");
    writeFileSync(join(g.wt, "a.txt"), "new\n");
    await r.send();
    removed(r);
  });

  test("(e) a clean, pushed tree is removed", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    g.commit({ "b.txt": "b\n" });
    git(g.wt, "push", "-q", "origin", "work");
    await r.send();
    removed(r);
  });

  test("a symlink counts as equal only when main has the same link", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    g.commit({ "t.txt": "t\n" });
    symlinkSync("a.txt", join(g.wt, "same"));
    symlinkSync("t.txt", join(g.wt, "other"));
    g.land({ "t.txt": "t\n" });
    git(join(g.wt, "..", "seed"), "pull", "-q", "--ff-only", "origin", "main");
    symlinkSync("a.txt", join(g.wt, "..", "seed", "same"));
    symlinkSync("a.txt", join(g.wt, "..", "seed", "other"));
    git(join(g.wt, "..", "seed"), "add", ".");
    git(join(g.wt, "..", "seed"), "commit", "-qm", "links");
    git(join(g.wt, "..", "seed"), "push", "-q", "origin", "main");
    await r.send();
    kept(r, "left: 0 commits, 1 file not on main");
  });

  test("(f) an untracked .env is kept", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    writeFileSync(join(g.wt, ".env"), "SECRET=1\n");
    await r.send();
    kept(r, "left: ignored files");
  });

  test("(g) a retired member's removal passes both later gates and the child gate", async () => {
    const g = repos(), r = rig("wtb", g.wt);
    r.s.db.run("UPDATE members SET status = 'gone', want = 'gone', want_payload = NULL WHERE wt = 'wtb'");
    expect(actionBlock(r.s, { ...r.action, pauseVersion: undefined })).toBeNull();
    await r.send();
    removed(r, "wtb");
    for (const c of r.orca.of("worktree-rm")) {
      const env = (c as unknown as { via: { env: Record<string, string> } }).via.env;
      expect(gateBlock(r.s, JSON.parse(env.DS_LOOP_ACTIVITY))).toBeNull();
    }
  });

  test("(h) a live or restarting member on the tree still blocks it", async () => {
    const g = repos(), r = rig("wtb", g.wt);
    r.s.db.run("UPDATE members SET status = 'running', want = 'gone', want_payload = NULL WHERE wt = 'wtb'");
    await r.send();
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(r.orca.of("terminal-close-worktree")).toEqual([]);
    expect(r.s.get("episodes", { project: "fx", subject: "wtb", kind: "action:worktree.remove" })!.state).toBe("dropped");
  });

  test("(i) a failed fetch with a stale local main keeps a squash-merged tree", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    g.commit({ "b.txt": "two\n" });
    g.land({ "b.txt": "two\n" });
    const url = git(g.wt, "remote", "get-url", "origin").trim();
    git(g.wt, "remote", "set-url", "origin", `${url}-gone`);
    git(g.wt, "config", "remote.origin.pushurl", url);
    await r.send();
    kept(r, "left: 1 commit, 1 file not on main");
  });

  test("(j) a plain merge of origin/main as the only unpushed commit is removed, main moved on", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    g.land({ "c.txt": "1\n" });
    git(g.wt, "fetch", "-q", "origin");
    git(g.wt, "merge", "-q", "--no-ff", "--no-edit", "origin/main");
    g.land({ "c.txt": "2\n", "a.txt": "moved\n" });
    await r.send();
    removed(r);
  });

  test("(k) a removed tree's .lavish page is rescued first", async () => {
    const g = repos(), r = rig("wtx", g.wt);
    mkdirSync(join(g.wt, ".lavish"));
    writeFileSync(join(g.wt, ".lavish", "review.html"), "<p>page</p>");
    await r.send();
    removed(r);
    const copy = join(r.s.root, "fx", "pages", "t1", "rescued", "builder-u1", ".lavish", "review.html");
    expect(readFileSync(copy, "utf8")).toBe("<p>page</p>");
    expect(events(r.s, "pages_rescued").map((e) => e.count)).toEqual([1]);
    expect(existsSync(g.wt)).toBe(true);   // fake Orca's worktree-rm leaves the folder: the copy came first
  });
});
