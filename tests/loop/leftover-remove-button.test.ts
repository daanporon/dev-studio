// leftover-remove-button.test.ts — archive-leftovers U4: the board's Remove of a leftover (request kind
// `leftover-remove`). A safe tree is removed as U1 does; a look-first tree only with the fingerprint of the
// check the operator saw, after its changes are saved (patch, untracked tar, refs/ds-leftovers/<folder>); a
// stale fingerprint or a failed save touches nothing. Real git repos with a bare origin, through the real
// actuator with fake Orca, as leftover-remove.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { leftoverCheck, leftoverFingerprint } from "../../bin/loop/io/tidy.ts";
import { CHANGED, saveDir } from "../../bin/loop/fulfil/leftover-remove.ts";

const REPO = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const ENV = ["DS_CLOSE_ROLE", "BACKEND", "FAKE_LOG"];
const temps: string[] = [], stores: Store[] = [];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) { try { chmodSync(t, 0o755); } catch { /* gone */ } rmSync(t, { recursive: true, force: true }); }
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzleftover-btn-")); temps.push(d); return d; };
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
// A bare origin whose main holds a.txt and a .gitignore, and the leftover: a clone on branch work.
function repos() {
  const d = tmp(), bare = join(d, "origin.git"), seed = join(d, "seed"), wt = join(d, "wtfolder");
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
  return { d, bare, wt };
}

// Squad t1 of project fx with one leftover (wtx at path), its member retired.
function rig(path: string) {
  const t = tmp(), S = join(t, "state");
  for (const f of ["bin", "conventions", "roles", "AGENTS.md"]) symlinkSync(join(REPO, f), join(t, f));
  mkdirSync(join(S, "fx", "squads"), { recursive: true });
  writeFileSync(join(S, "fx", "dispatcher.json"), '{"home_repo":"fx"}');
  writeFileSync(join(S, "fx", "squads", "t1.json"), JSON.stringify({
    topic: "t1", repo: "fx", type: "feature", status: "running", run_id: "run1", lead_wt: "wtl", worktrees: ["wtl"],
    members: [{ role: "lead", wt: "wtl" }],
    units: [{ slug: "u1", status: "done", tier: "hard", pr: "7" }], leftovers: [{ wt: "wtx", path, branch: "work", unit: "u1" }],
  }));
  const s = open(S);
  stores.push(s);
  importJson(s);
  writeFileSync(join(S, ".loop-migrated"), "");
  const fake = join(t, "fakeb");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_LOG"\ncase "$1" in current) echo wt-elsewhere ;; ps) echo '{"result":{"worktrees":[]}}' ;; *) echo '{}' ;; esac\n`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, { DS_CLOSE_ROLE: join(t, "bin", "close-role.sh"), BACKEND: fake, FAKE_LOG: join(t, "backend.log") });
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const press = async (fingerprint?: string) => {
    const { row } = s.requestAny("leftover-remove", { wt: "wtx", ...(fingerprint ? { fingerprint } : {}) }, { project: "fx", squad: "t1", by: "board" });
    at += 1; await loop.tick(at); await act.drain();
    return JSON.parse(String(s.get("requests", { id: row.id })!.result ?? "null"));
  };
  return { s, S, orca, press };
}
const leftovers = (s: Store) => (JSON.parse(String(s.get("squads", { project: "fx", topic: "t1" })!.doc)).leftovers ?? []) as Row[];
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const fp = async (path: string) => (await leftoverFingerprint(path, (await leftoverCheck(path))!))!;

// A look-first tree: one commit not on main, an uncommitted edit, a new untracked file and a .env.
function lookFirst(wt: string) {
  writeFileSync(join(wt, "a.txt"), "base\nmine\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "my work");
  writeFileSync(join(wt, "a.txt"), "base\nmine\nmore\n");
  writeFileSync(join(wt, "new.txt"), "new\n");
  writeFileSync(join(wt, ".env"), "K=1\n");
}

describe("the board's Remove of a leftover (archive-leftovers U4)", () => {
  test("a look-first tree with the current fingerprint is saved, then removed", async () => {
    const g = repos(), r = rig(g.wt);
    lookFirst(g.wt);
    const head = git(g.wt, "rev-parse", "HEAD").trim();
    const res = await r.press(await fp(g.wt));
    const dir = saveDir(r.S, "fx", "t1", "wtx");
    expect(res).toEqual({ ok: true, state: "removed", saved: dir, ref: `refs/ds-leftovers/${basename(g.wt)}` });
    expect(r.orca.of("worktree-rm").map((c) => c.args)).toEqual([["id:wtx", "force"]]);
    expect(leftovers(r.s)).toEqual([]);
    // The ref holds the old HEAD; the patch applies to a fresh checkout of it; the tar holds the untracked files.
    expect(git(g.wt, "rev-parse", `refs/ds-leftovers/${basename(g.wt)}`).trim()).toBe(head);
    const fresh = join(g.d, "fresh");
    Bun.spawnSync(["git", "clone", "-q", g.wt, fresh]);
    git(fresh, "checkout", "-q", head);
    git(fresh, "apply", "--check", join(dir, "changes.patch"));
    git(fresh, "apply", join(dir, "changes.patch"));
    expect(readFileSync(join(fresh, "a.txt"), "utf8")).toBe("base\nmine\nmore\n");
    const list = Bun.spawnSync(["tar", "-tf", join(dir, "untracked.tar")]).stdout.toString().split("\n").filter(Boolean).sort();
    expect(list).toEqual([".env", "new.txt"]);
    const ev = events(r.s, "leftover_removed");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ wt: "wtx", by: "board", safe: false, commits: 1, saved: dir });
  });

  test("a stale fingerprint is refused and the tree is untouched", async () => {
    const g = repos(), r = rig(g.wt);
    lookFirst(g.wt);
    const old = await fp(g.wt);
    writeFileSync(join(g.wt, "new.txt"), "changed since\n");
    const res = await r.press(old);
    expect(res).toEqual({ ok: false, state: "refused", error: CHANGED });
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(r.orca.of("terminal-close-worktree")).toEqual([]);
    expect(leftovers(r.s)).toHaveLength(1);
    expect(existsSync(saveDir(r.S, "fx", "t1", "wtx"))).toBe(false);
    expect(git(g.wt, "for-each-ref", "refs/ds-leftovers/")).toBe("");
    expect(events(r.s, "leftover_removed")).toEqual([]);
  });

  test("a safe tree is removed with no fingerprint and nothing saved", async () => {
    const g = repos(), r = rig(g.wt);
    const res = await r.press();
    expect(res).toEqual({ ok: true, state: "removed", saved: null, ref: null });
    expect(r.orca.of("worktree-rm").map((c) => c.args)).toEqual([["id:wtx", "force"]]);
    expect(leftovers(r.s)).toEqual([]);
    expect(existsSync(saveDir(r.S, "fx", "t1", "wtx"))).toBe(false);
  });

  test("a look-first tree with no fingerprint is refused", async () => {
    const g = repos(), r = rig(g.wt);
    lookFirst(g.wt);
    const res = await r.press();
    expect(res.ok).toBe(false);
    expect(res.state).toBe("refused");
    expect(r.orca.of("worktree-rm")).toEqual([]);
  });

  test("a failed patch write removes nothing", async () => {
    const g = repos(), r = rig(g.wt);
    lookFirst(g.wt);
    // The save folder's parent cannot be written: no patch, so no removal.
    const parent = join(r.S, "fx", "pages", "t1");
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o500);
    try {
      const res = await r.press(await fp(g.wt));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^left: save failed: /);
      expect(r.orca.of("worktree-rm")).toEqual([]);
      expect(leftovers(r.s)).toHaveLength(1);
      expect(git(g.wt, "for-each-ref", "refs/ds-leftovers/")).toBe("");
    } finally { chmodSync(parent, 0o755); }
  });

  test("a press for no such leftover fails and touches nothing", async () => {
    const g = repos(), r = rig(g.wt);
    const { row } = r.s.requestAny("leftover-remove", { wt: "nope" }, { project: "fx", squad: "t1", by: "board" });
    expect(row.id).toBeGreaterThan(0);
    await r.press();   // the wtx press runs too; the "nope" one fails
    expect(JSON.parse(String(r.s.get("requests", { id: row.id })!.result))).toEqual({ ok: false, error: "no such leftover" });
  });
});
