// close-rescue.test.ts — lavish-docs-not-stored U3: before close.ts's remove phase removes a worktree
// (archive and suspend), the pages a Lavish session names and the working notes under .lavish/,
// .scratch/, docs/plans/ and docs/brainstorms/ are copied to state/<label>/pages/<topic>/rescued/<role>/.
// Copy only, never overwrite, idempotent; a failed copy keeps the worktree as a leftover.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { rescuePages } from "../../bin/loop/io/rescue.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const T = 1_800_000_000;
const ENV = ["DS_CLOSE_ROLE", "BACKEND", "FAKE_LOG", "DS_CLAUDE_TMP_ROOT", "DS_TIDY_WAIT_MS", "DS_RESCUE_FOLDER_MB"];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) { try { chmodSync(join(r, "state", "fx", "pages", "t1"), 0o755); } catch { /* none */ } rmSync(r, { recursive: true, force: true }); }
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const REPO = join(import.meta.dir, "..", "..");
function gitIn(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
const BYTES: Record<string, string> = {
  ".scratch/a/board.html": "<html><link rel=stylesheet href=style.css>board</html>\n",
  ".scratch/a/style.css": "body { color: teal }\n",
  ".scratch/notes.md": "# working notes\n",
  ".lavish/p.html": "<html>page</html>\n",
};

// A pushed git worktree with a tracked file, a gitignored .scratch/ page folder and notes, and a
// Lavish session naming .scratch/a/board.html; the builder u1 of squad t1 wished gone (archived).
function rig(o: { lavish?: boolean; suspend?: boolean } = {}) {
  const t = mkdtempSync(join(tmpdir(), "u3-rescue-")); roots.push(t);
  const S = join(t, "state"), wt = join(t, "wt"), bare = join(t, "remote.git");
  for (const f of ["bin", "conventions", "roles", "AGENTS.md"]) symlinkSync(join(REPO, f), join(t, f));
  mkdirSync(join(S, "fx", "squads"), { recursive: true }); mkdirSync(bare); mkdirSync(wt);
  gitIn(bare, "init", "-q", "--bare"); gitIn(wt, "init", "-q", "-b", "work");
  writeFileSync(join(wt, ".gitignore"), "CLAUDE.local.md\n.scratch/\n");
  mkdirSync(join(wt, "docs", "plans"), { recursive: true });
  writeFileSync(join(wt, "README.md"), "tracked\n"); writeFileSync(join(wt, "docs", "plans", "tracked.md"), "tracked plan\n");
  gitIn(wt, "add", "."); gitIn(wt, "commit", "-qm", "one");
  gitIn(wt, "remote", "add", "origin", bare); gitIn(wt, "push", "-q", "origin", "work");
  for (const [rel, body] of Object.entries(BYTES)) {
    if (rel.startsWith(".lavish/") && !o.lavish) continue;
    mkdirSync(join(wt, rel, ".."), { recursive: true }); writeFileSync(join(wt, rel), body);
  }
  writeFileSync(join(S, "fx", "dispatcher.json"), '{"home_repo":"fx"}');
  writeFileSync(join(S, "fx", "squads", "t1.json"), JSON.stringify({ topic: "t1", repo: "fx", type: "feature", status: "running", run_id: "run1", lead_wt: "wtl",
    worktrees: ["wtl", "wtb"], members: [{ role: "lead", wt: "wtl" }, { role: "builder", suffix: "u1", wt: "wtb" }], units: [{ slug: "u1", status: "done", tier: "hard", builder_wt: "wtb", pr: "7" }] }));
  const s = open(S); stores.push(s); importJson(s); writeFileSync(join(S, ".loop-migrated"), "");
  const fake = join(t, "fakeb");
  writeFileSync(fake, "#!/usr/bin/env bash\ncase \"$1\" in current) echo wt-elsewhere ;; ps) echo '{\"result\":{\"worktrees\":[]}}' ;; *) echo '{}' ;; esac\n"); chmodSync(fake, 0o755);
  Object.assign(process.env, { DS_CLOSE_ROLE: join(t, "bin", "close-role.sh"), BACKEND: fake, FAKE_LOG: join(t, "backend.log"),
    DS_CLAUDE_TMP_ROOT: join(t, "claude-tmp"), DS_TIDY_WAIT_MS: "300" });
  s.upsert("observed_sessions", { project: "", file: join(wt, ".scratch", "a", "board.html") }, { url: "http://127.0.0.1:1/x", status: "running", observed_at: T });
  s.upsert("observed_sessions", { project: "", file: join(t, "elsewhere", "other.html") }, { url: null, status: "running", observed_at: T });
  const orca = new FakeBackend();
  const queue: Action[] = [], emit: Reconciler = { name: "emit", run: () => queue.splice(0) };
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers, emit] }, act, { projects: () => ["fx"] }); loop.boot(T);
  let at = T;
  const send = async (a: Action) => { queue.push(a); at += 1; await loop.tick(at); await act.drain(); };
  const b = s.db.query("SELECT * FROM members WHERE project = 'fx' AND wt = 'wtb' ORDER BY id DESC").get() as Row;
  if (o.suspend) {
    s.upsert("squads", { project: "fx", topic: "t1" }, { status: "suspended", want: "suspended" });
    s.upsert("members", { id: b.id }, { want: "running", status: "running" });
  } else s.upsert("members", { id: b.id }, { want: "gone", status: "running" });
  s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "none", state: "idle", observed_at: T });
  s.upsert("observed_worktrees", { project: "fx", wt: "wtb" }, { path: wt, branch: "work", observed_at: T });
  const why = o.suspend ? "suspended" : "archived";
  const close = () => send({ project: "fx", squad: "t1", member: "wtb", subject: `member:${b.id}`, kind: "member.close", episode: `close:remove:${why}:1`, payload: { id: Number(b.id), phase: "remove", why } });
  const dest = join(S, "fx", "pages", "t1", "rescued", "builder-u1");
  const events = (kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
  const leftovers = () => (JSON.parse(String(s.get("squads", { project: "fx", topic: "t1" })!.doc)).leftovers ?? []) as Row[];
  return { s, t, S, wt, dest, orca, close, events, leftovers, member: () => s.get("members", { id: b.id })! };
}
const copied = (dest: string, rel: string) => existsSync(join(dest, rel)) ? readFileSync(join(dest, rel), "utf8") : null;

describe("the remove phase copies pages and notes out first (lavish-docs-not-stored U3)", () => {
  test("a clean worktree: the session page, its folder and the ignored notes are copied, the tracked files are not, the worktree goes", async () => {
    const r = rig();
    await r.close();
    for (const rel of [".scratch/a/board.html", ".scratch/a/style.css", ".scratch/notes.md"]) expect(copied(r.dest, rel)).toBe(BYTES[rel]);
    expect(copied(r.dest, "README.md")).toBeNull();
    expect(copied(r.dest, "docs/plans/tracked.md")).toBeNull();
    expect(r.orca.of("worktree-rm")).toHaveLength(1);
    expect(r.leftovers()).toEqual([]);
    const ev = r.events("pages_rescued");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ wt: "wtb", path: r.wt, dest: r.dest, count: 3, same: 0, capped: 0, listed: true });
    expect(ev[0].bytes).toBe([".scratch/a/board.html", ".scratch/a/style.css", ".scratch/notes.md"].reduce((n, f) => n + BYTES[f].length, 0));
    expect(r.events("wish_done").at(-1)).toMatchObject({ want: "gone", result: "archived: worktree removed", rescued: r.dest });
    // Never deletes or edits the worktree's own files.
    for (const rel of [".scratch/a/board.html", ".scratch/a/style.css", ".scratch/notes.md"]) expect(readFileSync(join(r.wt, rel), "utf8")).toBe(BYTES[rel]);
  });

  test("an untracked .lavish page: the worktree is kept as a leftover and all four files are copied anyway", async () => {
    const r = rig({ lavish: true });
    await r.close();
    for (const rel of Object.keys(BYTES)) expect(copied(r.dest, rel)).toBe(BYTES[rel]);
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(r.leftovers()).toHaveLength(1);
    expect(r.leftovers()[0]).toMatchObject({ reason: "uncommitted changes" });
    expect(r.events("leftover_recorded").at(-1)).toMatchObject({ rescued: r.dest });
    expect(r.events("pages_rescued")[0]).toMatchObject({ count: 4 });
    expect(existsSync(join(r.wt, ".lavish", "p.html"))).toBe(true);
  });

  test("a suspend copies too, and names the folder on member_suspended", async () => {
    const r = rig({ suspend: true });
    await r.close();
    expect(copied(r.dest, ".scratch/notes.md")).toBe(BYTES[".scratch/notes.md"]);
    expect(r.member()).toMatchObject({ status: "suspended", wt: null });
    expect(r.events("member_suspended").at(-1)).toMatchObject({ result: "archived: worktree removed", rescued: r.dest });
  });

  test("a read-only destination: leftover `rescue failed`, no worktree-rm, the worktree still on disk", async () => {
    const r = rig();
    mkdirSync(join(r.S, "fx", "pages", "t1"), { recursive: true }); chmodSync(join(r.S, "fx", "pages", "t1"), 0o555);
    await r.close();
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(r.orca.of("terminal-close-worktree")).toEqual([]);
    expect(r.leftovers()).toHaveLength(1);
    expect(String(r.leftovers()[0].reason)).toStartWith("rescue failed: EACCES");
    expect(r.events("wish_done").at(-1)).toMatchObject({ result: "leftover kept (rescue failed)" });
    expect(r.events("pages_rescued")).toEqual([]);
    expect(existsSync(join(r.wt, ".scratch", "a", "board.html"))).toBe(true);
  });
});

describe("rescuePages", () => {
  test("run twice: the second copies nothing", async () => {
    const r = rig({ lavish: true });
    const one = await rescuePages(r.s, "fx", "t1", "builder-u1", r.wt);
    expect([one.ok, one.count, one.same]).toEqual([true, 4, 0]);
    const two = await rescuePages(r.s, "fx", "t1", "builder-u1", r.wt);
    expect([two.ok, two.count, two.same, two.files]).toEqual([true, 0, 4, []]);
    expect(existsSync(join(r.dest, ".scratch", "a", "board.1.html"))).toBe(false);
  });

  test("a different copy already there: written as <name>.1.<ext>, the earlier copy untouched; then skipped", async () => {
    const r = rig();
    mkdirSync(join(r.dest, ".scratch", "a"), { recursive: true });
    writeFileSync(join(r.dest, ".scratch", "a", "board.html"), "an older board\n");
    const one = await rescuePages(r.s, "fx", "t1", "builder-u1", r.wt);
    expect(one.count).toBe(3);
    expect(copied(r.dest, ".scratch/a/board.html")).toBe("an older board\n");
    expect(copied(r.dest, ".scratch/a/board.1.html")).toBe(BYTES[".scratch/a/board.html"]);
    const two = await rescuePages(r.s, "fx", "t1", "builder-u1", r.wt);
    expect([two.count, two.same]).toEqual([0, 3]);
    expect(copied(r.dest, ".scratch/a/board.2.html")).toBeNull();
  });

  test("the folder cap: the page is always copied, a neighbour over the cap is counted, not copied", async () => {
    const r = rig();
    writeFileSync(join(r.wt, ".scratch", "a", "big.png"), "x".repeat(4096));
    process.env.DS_RESCUE_FOLDER_MB = String(1024 / (1024 * 1024));   // 1 KB
    const one = await rescuePages(r.s, "fx", "t1", "builder-u1", r.wt);
    expect(one.capped).toBe(1);
    expect(copied(r.dest, ".scratch/a/board.html")).toBe(BYTES[".scratch/a/board.html"]);
    expect(copied(r.dest, ".scratch/a/style.css")).toBe(BYTES[".scratch/a/style.css"]);
    expect(existsSync(join(r.dest, ".scratch", "a", "big.png"))).toBe(false);
  });

  test("node_modules, symlinks, other extensions under the note folders and pages of other worktrees are skipped", async () => {
    const r = rig();
    mkdirSync(join(r.wt, ".scratch", "node_modules", "x"), { recursive: true });
    writeFileSync(join(r.wt, ".scratch", "node_modules", "x", "readme.md"), "dep\n");
    writeFileSync(join(r.wt, ".scratch", "log.txt"), "log\n");
    symlinkSync("/etc/hostname", join(r.wt, ".scratch", "link.md"));
    const one = await rescuePages(r.s, "fx", "t1", "builder-u1", r.wt);
    expect(one.files.sort()).toEqual([".scratch/a/board.html", ".scratch/a/style.css", ".scratch/notes.md"]);
    expect(existsSync(join(r.S, "fx", "pages", "t1", "rescued", "builder-u1", "other.html"))).toBe(false);
  });
});
