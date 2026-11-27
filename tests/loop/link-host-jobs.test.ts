// link-host-jobs.test.ts — side-loop-host U5 (issue #127): main asks a named host to clone a project, add and remove a
// git worktree, run the remove-safety probe, rescue untracked files, set a ref back and push a branch, each as one
// checked request and answer on the `host-jobs` channel (bin/link/host-jobs.ts). Host `local` runs the same code as
// before (createWorktree, removeWorktree, wtProbe, rescuePages, the same git calls); a side host answers over a real
// link from a second state root and gives the same answers; a bad job is refused at both ends; a malformed answer
// is refused; a rescue uploads up to its cap and leaves the rest on the side; a traversal path writes nothing.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { accept, ensureHostKey, requestJoin } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import {
  addWorktreeOn, CHANNEL, checkJob, cloneOn, exposeStopOn, HostJobError, hostOfWt, probeOn, pushOn, readRefOn, removeWorktreeOn, rescueOn, rescueTarget, setRefOn, writeLaunchOn, type Send,
} from "../../bin/link/host-jobs.ts";
import { createWorktree, git } from "../../bin/loop/io/worktrees.ts";
import { wtProbe } from "../../bin/loop/io/wt-probe.ts";
import { rescueDest } from "../../bin/loop/io/rescue.ts";

const saved: Record<string, string | undefined> = {};
const ENV = { DS_LINK_PING_MS: "150", DS_LINK_DEAD_MS: "3000", DS_LINK_RESCUE_UPLOAD_MB: undefined, DS_NOW: undefined };
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const temps: string[] = [], stores: Store[] = [], servers: LinkServer[] = [], clients: LinkClient[] = [];
afterEach(async () => {
  delete process.env.DS_LINK_RESCUE_UPLOAD_MB;
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string { const d = mkdtempSync(join(tmpdir(), "zzhostjobs-")); temps.push(d); return d; }
const events = (s: Store, kind: string): Row[] => s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[];
const G = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
async function ok(args: string[]): Promise<string> {
  const o = await git(args);
  if (o.code !== 0) throw new Error(`git ${args.join(" ")}: ${o.err}`);
  return o.out.trim();
}

/** A repo with one commit and a bare `origin`, plus the folder worktrees go in. */
async function repo(): Promise<{ dir: string; repo: string; bare: string; wts: string }> {
  const dir = temp(), repo = join(dir, "repo"), bare = join(dir, "origin.git"), wts = join(dir, "wts");
  mkdirSync(repo);
  await ok(["init", "-q", "--bare", "-b", "main", bare]);
  await ok(["-C", repo, "init", "-q", "-b", "main"]);
  await ok(["-C", repo, ...G, "commit", "-q", "--allow-empty", "-m", "init"]);
  await ok(["-C", repo, "remote", "add", "origin", bare]);
  await ok(["-C", repo, "push", "-q", "origin", "main"]);
  return { dir, repo, bare, wts };
}
const spec = (r: { repo: string; wts: string }, name: string) =>
  ({ repo: r.repo, name, branch: `feat/${name}`, base: "main", path: join(r.wts, name), project: "realp", squad: "sq", role: `builder-${name}` });

/** Main with a link server and one accepted side host `side-a` linked from its own state root. */
async function linked(): Promise<{ root: string; store: Store; srv: LinkServer; sroot: string; send: Send }> {
  const root = temp(), store = open(root);
  stores.push(store);
  const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 });
  servers.push(srv);
  const sroot = temp(), k = ensureHostKey(sroot);
  expect(requestJoin(store, { name: "side-a", public_key: k.publicKey }).ok).toBe(true);
  expect(accept(store, "side-a").ok).toBe(true);
  const c = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: sroot, name: "side-a" });
  clients.push(c);
  await c.start();
  expect(c.state).toBe("up");
  return { root, store, srv, sroot, send: (h, body, ms) => srv.request(h, CHANNEL, body, ms) };
}

describe("host local runs today's code", () => {
  test("worktree add and remove, probe, ref read and set, push and clone, all in place", async () => {
    const r = await repo();
    const s = open(temp()); stores.push(s);
    const sp = spec(r, "one");
    const { row } = await addWorktreeOn(s, "local", "git", sp);
    expect(row).toMatchObject({ host: "local", path: sp.path, branch: "feat/one", provider: "git", gone_at: null });
    expect(events(s, "worktree_created")).toHaveLength(1);
    expect(JSON.parse(String(events(s, "worktree_created")[0].payload)).host).toBeUndefined();
    // The same spec through createWorktree is the same row, adopted: the local path is that function.
    expect((await createWorktree(s, "git", sp)).adopted).toBe(true);

    expect(await probeOn("local", sp.path, 30_000)).toEqual(await wtProbe(sp.path, 30_000));
    const head = await readRefOn("local", sp.path, "HEAD");
    expect(head).toMatchObject({ code: 0, missing: false });
    expect((await setRefOn("local", sp.path, "HEAD", head.out.trim(), true)).code).toBe(0);
    expect(await ok(["-C", sp.path, "symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe("detached");
    expect((await readRefOn("local", join(r.dir, "nope"), "HEAD")).missing).toBe(true);

    await ok(["-C", sp.path, "checkout", "-q", "feat/one"]);
    await ok(["-C", sp.path, ...G, "commit", "-q", "--allow-empty", "-m", "work"]);
    expect((await pushOn("local", sp.path, "feat/one")).code).toBe(0);
    expect(await ok(["-C", r.bare, "rev-parse", "refs/heads/feat/one"])).toBe(await ok(["-C", sp.path, "rev-parse", "HEAD"]));

    const dest = join(r.dir, "clone");
    expect(await cloneOn("local", { project: "realp", url: r.bare, dest })).toEqual({ path: dest, cloned: true });
    expect(await cloneOn("local", { project: "realp", url: r.bare, dest })).toEqual({ path: dest, cloned: false });
    await expect(cloneOn("local", { project: "realp", url: r.repo, dest })).rejects.toThrow(/not a clone of/);

    const { gone } = await removeWorktreeOn(s, "local", sp.path, { force: true });
    expect(gone.removed).toBe(true);
    expect(existsSync(sp.path)).toBe(false);
    expect(s.get("worktrees", { host: "local", path: sp.path })!.gone_at).not.toBeNull();
  });
});

describe("the same jobs on a side host over the link", () => {
  test("clone, worktree add, probe, ref read and set, push and worktree remove give today's answers", async () => {
    const m = await linked();
    const r = await repo();
    const o = { send: m.send };

    const dest = join(r.dir, "side-clone");
    expect(await cloneOn("side-a", { project: "realp", url: r.bare, dest }, o)).toEqual({ path: dest, cloned: true });
    expect(existsSync(join(dest, ".git"))).toBe(true);

    const sp = spec(r, "two");
    const { row, adopted } = await addWorktreeOn(m.store, "side-a", "git", sp, o);
    expect(adopted).toBe(false);
    expect(row).toMatchObject({ host: "side-a", path: sp.path, branch: "feat/two", provider: "git", repo: r.repo, squad: "sq", gone_at: null });
    expect(m.store.get("worktrees", { host: "local", path: sp.path })).toBeNull();
    expect(JSON.parse(String(events(m.store, "worktree_created")[0].payload))).toMatchObject({ path: sp.path, host: "side-a", adopted: false });
    expect(await ok(["-C", sp.path, "branch", "--show-current"])).toBe("feat/two");

    writeFileSync(join(sp.path, "loose.txt"), "x\n");
    const local = await wtProbe(sp.path, 30_000);
    expect(await probeOn("side-a", sp.path, 30_000, undefined, o)).toEqual(local);
    rmSync(join(sp.path, "loose.txt"));

    await ok(["-C", sp.path, ...G, "commit", "-q", "--allow-empty", "-m", "work"]);
    const head = await readRefOn("side-a", sp.path, "HEAD", o);
    expect(head).toMatchObject({ code: 0, missing: false });
    expect(head.out.trim()).toBe(await ok(["-C", sp.path, "rev-parse", "HEAD"]));
    expect((await readRefOn("side-a", join(r.dir, "nope"), "HEAD", o)).missing).toBe(true);
    // A ref set back over the link: the branch moves to the first commit.
    const first = await ok(["-C", r.repo, "rev-parse", "main"]);
    expect((await setRefOn("side-a", sp.path, "refs/heads/feat/two", first, false, o)).code).toBe(0);
    expect(await ok(["-C", sp.path, "rev-parse", "refs/heads/feat/two"])).toBe(first);
    await ok(["-C", sp.path, ...G, "commit", "-q", "--allow-empty", "-m", "again"]);

    expect((await pushOn("side-a", sp.path, "feat/two", undefined, o)).code).toBe(0);
    expect(await ok(["-C", r.bare, "rev-parse", "refs/heads/feat/two"])).toBe(await ok(["-C", sp.path, "rev-parse", "HEAD"]));

    const { gone } = await removeWorktreeOn(m.store, "side-a", sp.path, { force: true }, o);
    expect(gone).toMatchObject({ removed: true, branch: "kept" });
    expect(existsSync(sp.path)).toBe(false);
    expect(m.store.get("worktrees", { host: "side-a", path: sp.path })!.gone_at).not.toBeNull();
    expect(JSON.parse(String(events(m.store, "worktree_removed")[0].payload))).toMatchObject({ path: sp.path, host: "side-a" });
  });

  test("a process on main reaches the side through the link server's socket", async () => {
    const m = await linked();
    const r = await repo();
    const head = await readRefOn("side-a", r.repo, "HEAD", { root: m.root });
    expect(head.out.trim()).toBe(await ok(["-C", r.repo, "rev-parse", "HEAD"]));
  });

  test("the member's host picks where the job runs", async () => {
    const s = open(temp()); stores.push(s);
    s.db.run("INSERT INTO members (project, squad, role, wt, host, observed_at, updated_at) VALUES ('realp', 'sq', 'builder', 'side-a::/x', 'side-a', 1, 1)");
    expect(hostOfWt(s, "realp", "side-a::/x")).toBe("side-a");
    expect(hostOfWt(s, "realp", "local::/y")).toBe("local");
  });

  test("an expose stop runs on the side host, in the owner's worktree, with its log in the side's state root (u8b)", async () => {
    const m = await linked();
    const r = await repo();
    const got = await exposeStopOn("side-a", { project: "realp", squad: "sq", cmd: "echo stopped-here; pwd", cwd: r.repo, low: 7, timeout_s: 10 }, { send: m.send });
    expect(got).toMatchObject({ code: 0, timed_out: false, cwd: r.repo, cwd_fallback: false });
    expect(got.tail).toContain("stopped-here");
    expect(existsSync(join(m.sroot, "realp", "loop", "cleanup", "expose-stop-7.log"))).toBe(true);
    expect(existsSync(join(m.root, "realp", "loop", "cleanup", "expose-stop-7.log"))).toBe(false);
    // The owner's worktree is gone there: the side's project folder, and the exit code comes back.
    const gone = await exposeStopOn("side-a", { project: "realp", squad: "sq", cmd: "exit 3", cwd: join(r.dir, "nope"), low: 8, timeout_s: 10 }, { send: m.send });
    expect(gone).toMatchObject({ code: 3, cwd: join(m.sroot, "realp"), cwd_fallback: true });
  });

  test("a rescue uploads files up to the cap; the rest stay in the side host's rescue folder", async () => {
    const m = await linked();
    const r = await repo();
    const sp = spec(r, "three");
    await addWorktreeOn(m.store, "side-a", "git", sp, { send: m.send });
    mkdirSync(join(sp.path, ".scratch"));
    writeFileSync(join(sp.path, ".scratch", "notes.md"), "small notes\n");
    writeFileSync(join(sp.path, ".scratch", "big.bin"), Buffer.alloc(5000, 7));
    process.env.DS_LINK_RESCUE_UPLOAD_MB = "0.001";   // ~1 KB per answer
    const got = await rescueOn(m.store, "side-a", "realp", "sq", "builder-three", sp.path, { send: m.send });
    const dest = rescueDest(m.root, "realp", "sq", "builder-three");
    expect(got).toMatchObject({ ok: true, dest, count: 1, files: [".scratch/notes.md"], host_files: [".scratch/big.bin"] });
    expect(got.host_dest).toBe(rescueDest(m.sroot, "realp", "sq", "builder-three"));
    expect(readFileSync(join(dest, ".scratch", "notes.md"), "utf8")).toBe("small notes\n");
    expect(existsSync(join(dest, ".scratch", "big.bin"))).toBe(false);
    expect(readFileSync(join(got.host_dest!, ".scratch", "big.bin")).length).toBe(5000);
    expect(got.secured.sort()).toEqual([".scratch/big.bin", ".scratch/notes.md"]);
    // Replayed: the same bytes are already there, so nothing new is written.
    const again = await rescueOn(m.store, "side-a", "realp", "sq", "builder-three", sp.path, { send: m.send });
    expect(again).toMatchObject({ ok: true, count: 0, same: 1 });
  });
});

describe("checks", () => {
  test("a bad job is refused before it is sent, and by the side when sent raw", async () => {
    const bads: unknown[] = [
      { job: "probe", path: "rel/path", timeout_ms: 1000 },
      { job: "push", path: "/x", branch: "--force" },
      { job: "push", path: "/x", branch: "a..b" },
      { job: "push", path: "/x", branch: "main", remote: "-u" },
      { job: "ref.set", path: "/x", ref: "HEAD", sha: "abc" },
      { job: "ref.read", path: "/x", ref: "refs/../x" },
      { job: "ref.read", path: "/x", ref: "--all" },
      { job: "clone", project: "p", url: "--upload-pack=evil" },
      { job: "clone", project: "../p", url: "/x" },
      { job: "worktree.add", provider: "git", spec: { repo: "/r", name: "a/b", branch: "b", base: "main" } },
      { job: "worktree.add", provider: "git", spec: { repo: "/r", name: "a", branch: "b", base: "main", host: "other" } },
      { job: "probe", path: "/x", timeout_ms: 1000, secured: ["../out"] },
      { job: "launch.write", project: "../p", member: "m", gen: "g", line: "claude" },
      { job: "launch.write", project: "p", member: "m", gen: "g", line: "" },
      { job: "expose.stop", project: "p", squad: "sq", cmd: "", low: 1, timeout_s: 10 },
      { job: "expose.stop", project: "p", squad: "sq", cmd: "a\nb", low: 1, timeout_s: 10 },
      { job: "expose.stop", project: "p", squad: "sq", cmd: "make down", low: 1, timeout_s: 101 },
      { job: "expose.stop", project: "p", squad: "sq", cmd: "make down", low: 0, timeout_s: 10 },
      { job: "expose.stop", project: "p", squad: "sq", cmd: "make down", cwd: "rel", low: 1, timeout_s: 10 },
      { job: "rm -rf" },
      null,
    ];
    for (const b of bads) expect(() => checkJob(b)).toThrow(HostJobError);
    await expect(pushOn("side-a", "/x", "--force", undefined, { send: async () => ({ code: 0, out: "", err: "" }) })).rejects.toThrow(HostJobError);

    const m = await linked();
    await expect(m.srv.request("side-a", CHANNEL, { job: "push", path: "/x", branch: "--force" })).rejects.toThrow(/branch name/);
    await expect(m.srv.request("side-a", CHANNEL, { job: "nope" })).rejects.toThrow(/unknown job/);
  });

  test("a malformed answer is refused", async () => {
    const send = (v: unknown): Send => async () => v;
    await expect(probeOn("side-a", "/x", 1000, undefined, { send: send({ code: "0", out: "", err: "" }) })).rejects.toThrow(/malformed/);
    await expect(readRefOn("side-a", "/x", "HEAD", { send: send({ code: 0, out: "", err: "" }) })).rejects.toThrow(/missing flag/);
    await expect(cloneOn("side-a", { project: "p", url: "/x" }, { send: send({ path: "rel", cloned: true }) })).rejects.toThrow(/malformed/);
    const s = open(temp()); stores.push(s);
    await expect(addWorktreeOn(s, "side-a", "git", { repo: "/r", name: "a", branch: "b", base: "main" }, { send: send({ path: "/r/a" }) })).rejects.toThrow(/malformed/);
    expect(s.db.query("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 0 });
    const bad = await rescueOn(s, "side-a", "p", "sq", "b", "/x", { send: send({ listed: true, files: "no" }) });
    expect(bad.ok).toBe(false);
    expect(bad.why).toMatch(/malformed/);
    await expect(exposeStopOn("side-a", { project: "p", squad: "sq", cmd: "x", low: 1, timeout_s: 5 }, { send: send({ code: 0 }) })).rejects.toThrow(/malformed/);
    await expect(writeLaunchOn("side-a", s.root, { project: "p", member: "m", gen: "g", line: "claude" }, { send: send({ text: "rm -rf /" }) })).rejects.toThrow(/malformed/);
  });

  test("a rescued path that leaves the member's folder is refused and nothing is written", async () => {
    const s = open(temp()); stores.push(s);
    const dest = rescueDest(s.root, "p", "sq", "b");
    const file = (rel: string) => ({ rel, size: 2, data: Buffer.from("hi").toString("base64") });
    for (const rel of ["../evil.md", "../../../evil.md", ".scratch/../../evil.md", "/tmp/evil.md", "a\0b.md", "./x.md", ""]) {
      const got = await rescueOn(s, "side-a", "p", "sq", "b", "/x",
        { send: async () => ({ listed: true, capped: 0, files: [file(".scratch/fine.md"), file(rel)], kept_dest: null, kept: [] }) });
      expect(got.ok).toBe(false);
      expect(got.why).toMatch(/refused rescued path/);
      expect(got.count).toBe(0);
    }
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(s.root, "p", "pages", "sq", "rescued", "evil.md"))).toBe(false);
    expect(existsSync(join(s.root, "p", "pages", "sq", "evil.md"))).toBe(false);

    // A folder inside the rescue folder that is a symlink out, or a target that is not a regular file.
    const outside = temp();
    mkdirSync(dest, { recursive: true });
    symlinkSync(outside, join(dest, "link"));
    mkdirSync(join(dest, "dir.md"));
    expect(rescueTarget(dest, "link/evil.md")).toEqual({ why: "link is not a folder" });
    expect(rescueTarget(dest, "dir.md")).toEqual({ why: "it is not a regular file here" });
    const got = await rescueOn(s, "side-a", "p", "sq", "b", "/x",
      { send: async () => ({ listed: true, capped: 0, files: [file("link/evil.md")], kept_dest: null, kept: [] }) });
    expect(got.ok).toBe(false);
    expect(existsSync(join(outside, "evil.md"))).toBe(false);
    // A size that does not match its bytes is refused too.
    const short = await rescueOn(s, "side-a", "p", "sq", "b", "/x",
      { send: async () => ({ listed: true, capped: 0, files: [{ rel: "a.md", size: 9, data: "aGk=" }], kept_dest: null, kept: [] }) });
    expect(short.ok).toBe(false);
    expect(existsSync(join(dest, "a.md"))).toBe(false);
  });
});
