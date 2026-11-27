// link-mirror.test.ts — side-loop-host U9 (issue #127, KTD14): plans and notes appear on a side state root at the
// same relative path, mode 0444; a copy edited there is overwritten at the next sync and logged; nothing
// travels up. Over a real link on loopback, with two temp state roots.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { accept, ensureHostKey, requestJoin } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { MAX_FILE_BYTES, mirrorable, MirrorSync, type MirrorList } from "../../bin/link/mirror.ts";

const temps: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "ds-mirror-")); temps.push(d); return d; };
const servers: LinkServer[] = [], clients: LinkClient[] = [], stores: Store[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) s.db.close();
});
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const mode = (root: string, rel: string) => statSync(join(root, rel)).mode & 0o777;
/** Overwrite a read-only copy the way an agent on the side could. */
function edit(root: string, rel: string, text: string): void {
  chmodSync(join(root, rel), 0o644);
  writeFileSync(join(root, rel), text);
}
/** Every file under `<root>/alpha` and `<root>/beta` with its text. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  for (const l of ["alpha", "beta"]) if (existsSync(join(root, l))) walk(join(root, l));
  return out;
}

async function linked() {
  const root = temp(), store = open(root);
  stores.push(store);
  const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 });
  servers.push(srv);
  const side = temp(), key = ensureHostKey(side);
  expect(requestJoin(store, { name: "side-a", public_key: key.publicKey }).ok).toBe(true);
  expect(accept(store, "side-a").ok).toBe(true);
  const member = (project: string, host: string) => store.db.run(
    "INSERT INTO members (project, squad, role, suffix, host, observed_at, updated_at) VALUES (?, 'sq', 'builder', ?, ?, 0, 0)", [project, host, host]);
  member("alpha", "side-a");
  member("beta", "local");
  put(root, "alpha/squads/sq-plan.md", "the plan\n");
  put(root, "alpha/squads/sq-plan.approved.md", "approved\n");
  put(root, "alpha/notes/builder.md", "a tip\n");
  put(root, "alpha/notes/reviews/r1.md", "a review\n");
  const client = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: side, name: "side-a" });
  clients.push(client);
  await client.start();
  const lines: string[] = [];
  const sync = () => new MirrorSync(side, (ch, body, ms) => client.request(ch, body, ms), (l) => lines.push(l));
  return { root, side, client, lines, sync, mirror: sync() };
}

const MIRRORED = ["alpha/notes/builder.md", "alpha/notes/reviews/r1.md", "alpha/squads/sq-plan.approved.md", "alpha/squads/sq-plan.md"];

describe("the mirror", () => {
  test("plans and notes appear at the same path, mode 0444; a second sync writes nothing", async () => {
    const m = await linked();
    expect(await m.mirror.tick()).toEqual({ written: 4, removed: 0, failed: 0 });
    expect(Object.keys(tree(m.side)).sort()).toEqual(MIRRORED);
    for (const rel of MIRRORED) {
      expect(read(m.side, rel)).toBe(read(m.root, rel));
      expect(mode(m.side, rel)).toBe(0o444);
    }
    expect(await m.mirror.tick()).toEqual({ written: 0, removed: 0, failed: 0 });
    expect(m.lines).toEqual([]);
  });

  test("only squads/*.md and notes/ of this host's projects, and no symlink or hidden file", async () => {
    const m = await linked();
    put(m.root, "alpha/squads/sq.json", "{}");
    put(m.root, "alpha/squads/sub/deep.md", "x");
    put(m.root, "alpha/journals/sq-lead.md", "x");
    put(m.root, "alpha/notes/.hidden", "x");
    put(m.root, "beta/squads/other.md", "another host's project");
    const secret = join(temp(), "secret");
    writeFileSync(secret, "private");
    symlinkSync(secret, join(m.root, "alpha/notes/link.md"));
    symlinkSync(dirname(secret), join(m.root, "alpha/notes/linked-folder"));
    await m.mirror.tick();
    expect(Object.keys(tree(m.side)).sort()).toEqual(MIRRORED);
    for (const path of ["beta/squads/other.md", "alpha/notes/link.md", "alpha/notes/linked-folder/secret", "alpha/squads/sq.json", "alpha/notes/../../loop.db"]) {
      await expect(m.client.request("mirror", { op: "read", path })).rejects.toThrow(/mirror:/);
    }
  });

  test("a file edited on the side is overwritten at the next sync and logged; main is untouched", async () => {
    const m = await linked();
    await m.mirror.tick();
    const before = tree(m.root);
    edit(m.side, "alpha/notes/builder.md", "edited here\n");
    put(m.side, "alpha/notes/side-only.md", "made on the side\n");
    expect(await m.mirror.tick()).toEqual({ written: 1, removed: 0, failed: 0 });
    expect(read(m.side, "alpha/notes/builder.md")).toBe("a tip\n");
    expect(mode(m.side, "alpha/notes/builder.md")).toBe(0o444);
    expect(m.lines).toEqual(["mirror: alpha/notes/builder.md was changed on this host; overwritten with main's copy"]);
    // nothing travels up, and a file the mirror did not write stays
    expect(tree(m.root)).toEqual(before);
    expect(read(m.side, "alpha/notes/side-only.md")).toBe("made on the side\n");
    await expect(m.client.request("mirror", { op: "write", path: "alpha/notes/builder.md", data: "eA==" })).rejects.toThrow(/unknown op/);
  });

  test("a change on main arrives without an edit line; an edit is still told apart after a restart", async () => {
    const m = await linked();
    await m.mirror.tick();
    put(m.root, "alpha/squads/sq-plan.md", "the plan, v2\n");
    expect((await m.sync().tick()).written).toBe(1);
    expect(read(m.side, "alpha/squads/sq-plan.md")).toBe("the plan, v2\n");
    expect(m.lines).toEqual([]);
    edit(m.side, "alpha/squads/sq-plan.md", "mine\n");
    await m.sync().tick();
    expect(read(m.side, "alpha/squads/sq-plan.md")).toBe("the plan, v2\n");
    expect(m.lines.length).toBe(1);
  });

  test("a changed mode is set back; a symlink in a copy's place is replaced, not written through", async () => {
    const m = await linked();
    await m.mirror.tick();
    chmodSync(join(m.side, "alpha/notes/builder.md"), 0o644);
    const target = join(temp(), "target");
    writeFileSync(target, "keep me");
    rmSync(join(m.side, "alpha/squads/sq-plan.md"), { force: true });
    symlinkSync(target, join(m.side, "alpha/squads/sq-plan.md"));
    expect((await m.mirror.tick()).written).toBe(1);
    expect(mode(m.side, "alpha/notes/builder.md")).toBe(0o444);
    expect(read(m.side, "alpha/squads/sq-plan.md")).toBe("the plan\n");
    expect(readFileSync(target, "utf8")).toBe("keep me");
    expect(m.lines.length).toBe(2);
  });

  test("a folder that is a symlink on the side is not written into", async () => {
    const m = await linked();
    const outside = temp();
    mkdirSync(join(m.side, "alpha"), { recursive: true });
    symlinkSync(outside, join(m.side, "alpha/notes"));
    expect(await m.mirror.tick()).toEqual({ written: 2, removed: 0, failed: 2 });
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a file main removed leaves the side; one too big is logged once and not mirrored", async () => {
    const m = await linked();
    await m.mirror.tick();
    rmSync(join(m.root, "alpha/notes/reviews/r1.md"), { force: true });
    put(m.root, "alpha/notes/big.md", "x".repeat(MAX_FILE_BYTES + 1));
    expect(await m.mirror.tick()).toEqual({ written: 0, removed: 1, failed: 0 });
    await m.mirror.tick();
    expect(existsSync(join(m.side, "alpha/notes/reviews/r1.md"))).toBe(false);
    expect(existsSync(join(m.side, "alpha/notes/big.md"))).toBe(false);
    expect(m.lines.filter((l) => l.includes("big.md")).length).toBe(1);
    expect(m.lines.filter((l) => l.includes("r1.md")).length).toBe(1);
  });

  test("a path main should not send is refused on the side", async () => {
    const side = join(temp(), "state");
    mkdirSync(side);
    const lines: string[] = [];
    const bad = ["../escape.md", "alpha/notes/../../../escape.md", "/etc/x/notes/y", "loop/link/key"];
    const list: MirrorList = { files: bad.map((path) => ({ path, sha: "0" })), skipped: [] };
    const sync = new MirrorSync(side, async () => list, (l) => lines.push(l));
    expect(await sync.tick()).toEqual({ written: 0, removed: 0, failed: 0 });
    expect(lines.length).toBe(bad.length);
    for (const p of bad) expect(mirrorable(p)).toBe(false);
    expect(readdirSync(dirname(side))).toEqual(["state"]);
  });
});
