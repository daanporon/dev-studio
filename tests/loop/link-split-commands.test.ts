// link-split-commands.test.ts — side-loop-host U8 (issue #127, KTD6): the worker commands with a local half. On a
// side host `bin/ds` gathers the worktree facts a split command needs (finish-unit-ts, watch-ts), main checks them
// and runs the command with them and the member row's worktree id; expose, unexpose and the rest forward as rows;
// the review, the contract adapter and the agent hooks stay on the side host. An expose --stop from a side host is
// refused (its host job is u8b). The walk test reads the worker role files and fails on a command they call that
// the forward table does not classify.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { accept, ensureHostKey, requestJoin } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { checkCall, EXIT, kindOf, TABLE, WORKER_ROLES } from "../../bin/link/forward-table.ts";
import { checkFacts, finishFacts, gather, SPLIT_COMMANDS } from "../../bin/link/split.ts";
import { mainUrlFor, startRelay, type Relay } from "../../bin/link/relay.ts";
import { toplevel } from "../../bin/loop/squad/exposed.ts";
import { senderAt, sendMessage } from "../../bin/loop/messages/messages.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds.ts");
const saved: Record<string, string | undefined> = {};
const ENV = { DS_LINK_PING_MS: "150", DS_LINK_DEAD_MS: "600", DS_LINK_BIND_ANY: undefined, DS_NOW: undefined, DS_LINK_RESEND_MS: undefined,
  DS_MEMBER: undefined, DS_GEN: undefined, DS_WT: undefined, DS_MAIN_URL: undefined, DS_BACKEND: undefined, DS_STATE_ROOT: undefined,
  DS_LINK_FORWARDED: undefined, DS_LINK_WT: undefined, DS_LINK_FACTS: undefined };
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const temps: string[] = [], stores: Store[] = [], servers: LinkServer[] = [], clients: LinkClient[] = [], relays: Relay[] = [];
afterEach(async () => {
  for (const k of ["DS_LINK_FORWARDED", "DS_LINK_WT", "DS_LINK_FACTS"]) delete process.env[k];
  for (const r of relays.splice(0)) r.stop();
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), "zzsplit-")); temps.push(d); return d; };
const all = (s: Store, sql: string, ...a: string[]) => s.db.query(sql).all(...a) as Row[];

const STAMPS: Row = { observed_at: 100, updated_at: 100, created_at: 100 };
function put(s: Store, table: string, ...rows: Row[]): void {
  const cols = s.columns(table);
  for (const r of rows) {
    const row: Row = { ...Object.fromEntries(Object.entries(STAMPS).filter(([k]) => cols.has(k))), ...r };
    const ks = Object.keys(row);
    s.db.run(`INSERT INTO ${table} (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as never));
  }
}

// ─── the walk test ───────────────────────────────────────────────────────────────────────────────────────────────

// A script a worker role file names that the worker does not call through `bin/ds` on its own; each says why.
const NOT_CALLED: Record<string, string> = {
  "squad-state.sh": "runs squad-state.ts on the state file directly; a side host's copy is the read-only mirror (U9)",
  "reassert-roles.sh": "named for the hooks it arms; the loop runs it when it starts a member, not the worker",
};
// The commands the worker's own agent runs without naming them in its role file: the hooks a role worktree is armed
// with, the contract adapter its backend calls and the start-hook gate.
const HOOKS = ["no-broad-kill-hook-ts", "rewake-hook-ts", "contract-backend", "hook-gate"];
// Commands the table leaves out on purpose until their own unit lands.
const PENDING: Record<string, string> = { "picker-hook-ts": "u8b-side-expose-stop-and-picker" };

/** The ds command a bin script execs (`"$ROOT/bin/ds" <cmd>`), or null when it does not go through bin/ds. */
function dsCommandOf(script: string): string | null {
  const m = /bin\/ds"?\s+([a-z][a-z0-9-]*)/.exec(readFileSync(script, "utf8"));
  return m ? m[1] : null;
}
/** Every bin script under bin/<dir>/ by its base name. */
function binScripts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of ["role", "lib", "commands", "review", "hooks", "board", "backend"]) {
    let names: string[] = [];
    try { names = require("node:fs").readdirSync(join(ROOT, "bin", dir)); } catch { continue; }
    for (const n of names) if (n.endsWith(".sh") && !out.has(n)) out.set(n, join(ROOT, "bin", dir, n));
  }
  return out;
}
/** The commands a role file calls: each `<name>.sh` that is a bin script (not a project's tests/…), and each `ds <cmd>`. */
function calledBy(roleFile: string): { scripts: string[]; ds: string[] } {
  const text = readFileSync(roleFile, "utf8");
  const scripts = new Set<string>(), ds = new Set<string>();
  for (const m of text.matchAll(/(?<![\w./-])(?:bin\/[a-z]+\/)?([a-z][a-z0-9-]*\.sh)\b/g)) scripts.add(m[1]);
  for (const m of text.matchAll(/(?<![\w./-])(?:bin\/)?ds ([a-z][a-z0-9-]*)/g)) ds.add(m[1]);
  return { scripts: [...scripts], ds: [...ds] };
}
/** What `role` calls that the forward table does not classify (empty when every call is classified). */
function unclassified(role: string, roleFile: string): string[] {
  const bins = binScripts(), { scripts, ds } = calledBy(roleFile), missing: string[] = [];
  for (const name of scripts) {
    const path = bins.get(name);
    if (!path) continue;                               // not dev-studio's (a project's tests/ci.sh)
    if (name in NOT_CALLED) continue;
    const cmd = dsCommandOf(path);
    if (cmd === null) { missing.push(`${name} (does not run through bin/ds)`); continue; }
    if (kindOf(role, cmd) === null) missing.push(`${name} -> ds ${cmd}`);
  }
  for (const cmd of [...ds, ...HOOKS]) if (kindOf(role, cmd) === null) missing.push(`ds ${cmd}`);
  return missing;
}

describe("the walk test", () => {
  test("every command a worker role file calls, and every hook its agent runs, is classified", () => {
    for (const role of WORKER_ROLES) expect({ role, missing: unclassified(role, join(ROOT, "roles", `${role}.md`)) }).toEqual({ role, missing: [] });
  });

  test("the walk finds the role scripts and fails on a new unclassified one", () => {
    const { scripts, ds } = calledBy(join(ROOT, "roles", "builder.md"));
    expect(scripts).toEqual(expect.arrayContaining(["finish-unit.sh", "review-unit.sh", "watch.sh", "orch.sh"]));
    expect(ds).toEqual(expect.arrayContaining(["expose", "unexpose", "reload", "msg"]));
    const dir = temp(), f = join(dir, "builder.md");
    writeFileSync(f, `${readFileSync(join(ROOT, "roles", "builder.md"), "utf8")}\nThen run \`ds brand-new-thing\` and \`team.sh\`.\n`);
    expect(unclassified("builder", f)).toEqual(expect.arrayContaining(["ds brand-new-thing"]));
  });

  test("a pending command is not in the table yet, and every split command has a facts check", () => {
    for (const cmd of Object.keys(PENDING)) for (const role of WORKER_ROLES) expect(kindOf(role, cmd)).toBeNull();
    const split = new Set(WORKER_ROLES.flatMap((r) => Object.entries(TABLE[r]).filter(([, k]) => k === "split").map(([c]) => c)));
    expect([...split].sort()).toEqual([...SPLIT_COMMANDS].sort());
    expect(kindOf("builder", "finish-unit-ts")).toBe("split");
    expect(kindOf("tester", "finish-unit-ts")).toBeNull();
    expect(kindOf("builder", "review-unit-ts")).toBe("local");
  });
});

// ─── main's checks ───────────────────────────────────────────────────────────────────────────────────────────────

const B1 = "realp/sq/builder-u1", T1 = "realp/sq/tester";
function seedMain(s: Store, b1wt = "s1::/w/b1"): void {
  put(s, "projects", { label: "realp", home_repo: "/r/realp" });
  put(s, "squads", { id: 1, project: "realp", topic: "sq", status: "active" });
  put(s, "members",
    { id: 1, project: "realp", squad: "sq", role: "lead", suffix: "", wt: "local::/w/lead", host: "local", status: "running", gen: "g0" },
    { id: 2, project: "realp", squad: "sq", role: "builder", suffix: "u1", wt: b1wt, host: "s1", status: "running", gen: "g1" },
    { id: 3, project: "realp", squad: "sq", role: "tester", suffix: "", wt: "s1::/w/t", host: "s1", status: "running", gen: "g2" });
  put(s, "units", { project: "realp", squad: "sq", slug: "u1", status: "dispatched", builder_wt: b1wt },
    { project: "realp", squad: "sq", slug: "u2", status: "dispatched", builder_wt: "local::/w/lead" });
}
const FACTS = { branch: "feat/u1", head: "a".repeat(40), receipt: null, origin_head: "refs/remotes/origin/main", ancestor: null, since: null, short: null };

describe("main's checks of a split or newly forwarded call", () => {
  const store = () => { const s = open(temp()); stores.push(s); seedMain(s); return s; };
  const call = (s: Store, argv: string[], facts?: unknown, member = B1, gen = member === B1 ? "g1" : "g2") => checkCall(s, "s1", { argv, member, gen, facts });

  test("a split call runs with its facts and the member row's worktree id; its state file is main's", () => {
    const s = store();
    const c = call(s, ["finish-unit-ts", "/home/x/.dev-studio/state/realp/squads/sq.json", "u1", "--check"], FACTS);
    expect(c).toMatchObject({ ok: true, env: { DS_MEMBER: B1, DS_GEN: "g1", DS_WT: "/w/b1", DS_LINK_WT: "s1::/w/b1" } });
    if (!c.ok) return;
    expect(JSON.parse(c.env.DS_LINK_FACTS)).toEqual(FACTS);
    expect(c.argv).toEqual(["finish-unit-ts", join(s.root, "realp", "squads", "sq.json"), "u1", "--check"]);
    // A forward call carries no facts.
    const w = call(s, ["msg", "inbox"]);
    expect(w.ok && w.env.DS_LINK_FACTS).toBe(undefined);
    expect(w.ok && w.env.DS_LINK_WT).toBe("s1::/w/b1");
  });

  test("a split call without good facts, or for another squad's file or unit, is refused", () => {
    const s = store(), st = "/s/realp/squads/sq.json";
    for (const [argv, facts] of [
      [["finish-unit-ts", st, "u1"], undefined],
      [["finish-unit-ts", st, "u1"], { ...FACTS, ancestor: "yes" }],
      [["finish-unit-ts", st, "u1"], { ...FACTS, branch: "x".repeat(5000) }],
      [["finish-unit-ts", "/s/realp/squads/other.json", "u1"], FACTS],
      [["finish-unit-ts", "/s/otherp/squads/sq.json", "u1"], FACTS],
      [["finish-unit-ts", st, "u2"], FACTS],
      [["finish-unit-ts", st], FACTS],
      [["watch-ts", "--worktree", "100"], { instr: "maybe" }],
    ] as [string[], unknown][]) expect({ argv, r: call(s, argv, facts) }).toMatchObject({ argv, r: { ok: false, code: EXIT.refused } });
    expect(call(s, ["finish-unit-ts", st, "u1"], FACTS, T1)).toMatchObject({ ok: false });      // a Tester has no finish-unit
  });

  test("watch-ts only reads the member's own inbox", () => {
    const s = store(), facts = { instr: "unchanged" };
    expect(call(s, ["watch-ts", "--worktree", "100"], facts)).toMatchObject({ ok: true });
    expect(call(s, ["watch-ts", "realp", "sq", "100"], facts)).toMatchObject({ ok: false });
    expect(call(s, ["watch-ts", "--worktree", "--run", "run_1"], facts)).toMatchObject({ ok: false });
    expect(call(s, ["watch-ts", "--worktree", "--requests", "realp"], facts)).toMatchObject({ ok: false });
  });

  test("expose, unexpose and exposed stay in the member's squad; expose --stop is refused (u8b)", () => {
    const s = store();
    expect(call(s, ["expose", "dev", "http://localhost:3000", "--note", "--squad", "--self"])).toMatchObject({ ok: true });
    expect(call(s, ["expose", "dev", "http://localhost:3000", "--squad"])).toMatchObject({ ok: true });
    expect(call(s, ["expose", "dev", "http://x", "--project", "realp", "--topic", "sq"])).toMatchObject({ ok: true });
    expect(call(s, ["expose", "dev", "http://x", "--project", "realp", "--topic", "other"])).toMatchObject({ ok: false });
    const stop = call(s, ["expose", "dev", "http://x", "--stop", "kill 1"]);
    expect(stop).toMatchObject({ ok: false, code: EXIT.refused });
    expect(!stop.ok && stop.why).toContain("never on main");
    expect(call(s, ["expose", "dev", "http://x", "--stop=kill 1"])).toMatchObject({ ok: false });
    expect(call(s, ["unexpose", "dev", "--owner", "builder/u1"])).toMatchObject({ ok: true });
    expect(call(s, ["unexpose", "dev", "--topic", "other"])).toMatchObject({ ok: false });
    expect(call(s, ["exposed"])).toMatchObject({ ok: true, argv: ["exposed", "--project", "realp"] });
    expect(call(s, ["exposed", "--project", "otherp"])).toMatchObject({ ok: false });
  });

  test("reload, the pause checkpoint, ship-mode and orch.sh only name the member itself", () => {
    const s = store();
    expect(call(s, ["reload", "ack", "realp", "sq", "builder", "u1"])).toMatchObject({ ok: true });
    expect(call(s, ["reload", "ack", "realp", "sq", "lead", "-"])).toMatchObject({ ok: false });
    expect(call(s, ["reload", "ack", "realp", "sq", "builder", "u2"])).toMatchObject({ ok: false });
    expect(call(s, ["reload", "ack", "realp", "sq", "tester", "-"], undefined, T1)).toMatchObject({ ok: true });
    expect(call(s, ["pause-checkpoint-ts", "realp", "sq", "builder", "u1", "stop-1", "tried X", "--commands-finished"])).toMatchObject({ ok: true });
    expect(call(s, ["pause-checkpoint-ts", "realp", "sq", "lead", "-", "stop-1", "x"])).toMatchObject({ ok: false });
    expect(call(s, ["ship-mode-ts", "realp"])).toMatchObject({ ok: true });
    expect(call(s, ["ship-mode-ts", "realp", "direct-PR"])).toMatchObject({ ok: false });
    expect(call(s, ["ship-mode-ts", "otherp"])).toMatchObject({ ok: false });
    for (const op of ["send", "send-worker", "reply", "ask"]) expect(call(s, ["orch-ts", op, "x"])).toMatchObject({ ok: true });
    for (const op of ["worker-done", "gate-create", "run-coordinator"]) expect(call(s, ["orch-ts", op])).toMatchObject({ ok: false });
    expect(call(s, ["ds-feedback-ts", "the board was slow"])).toMatchObject({ ok: true });
  });

  test("orch.sh send, send-worker and ask reach only the member's own project", () => {
    const s = store();
    put(s, "squads", { id: 2, project: "otherp", topic: "oq", status: "active", run_id: "run_other" });
    put(s, "members", { id: 4, project: "otherp", squad: "oq", role: "builder", suffix: "x", wt: "local::/w/other", host: "local", status: "running", gen: "g4" });
    s.db.run("UPDATE squads SET run_id = 'run_own' WHERE id = 1");
    expect(call(s, ["orch-ts", "send", "run_own", "subj", "body"])).toMatchObject({ ok: true });
    expect(call(s, ["orch-ts", "send-worker", "/w/lead", "subj", "body"])).toMatchObject({ ok: true });
    expect(call(s, ["orch-ts", "send", "run_other", "subj", "body"])).toMatchObject({ ok: false, code: EXIT.refused });
    expect(call(s, ["orch-ts", "ask", "run_other", "q"])).toMatchObject({ ok: false, code: EXIT.refused });
    expect(call(s, ["orch-ts", "send-worker", "/w/other", "subj", "body"])).toMatchObject({ ok: false, code: EXIT.refused });
  });

  test("what stays on the side host is refused on main", () => {
    const s = store();
    for (const cmd of ["review-unit-ts", "stop-mine", "contract-backend", "hook-gate", "no-broad-kill-hook-ts", "rewake-hook-ts"]) {
      const r = call(s, [cmd]);
      expect({ cmd, r }).toMatchObject({ cmd, r: { ok: false, code: EXIT.refused } });
      expect(!r.ok && r.why).toContain("runs on the side host");
    }
  });
});

// ─── the local half ──────────────────────────────────────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}
/** A git worktree on branch feat/u1 with two commits; a review receipt for the first when `receipt`. */
async function worktree(receipt: boolean): Promise<{ dir: string; first: string; head: string }> {
  const dir = temp();
  await git(dir, "init", "-q", "-b", "feat/u1");
  writeFileSync(join(dir, "a"), "1");
  await git(dir, "add", "a");
  await git(dir, "commit", "-q", "-m", "one");
  const first = await git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "a"), "2");
  await git(dir, "commit", "-q", "-am", "two");
  if (receipt) writeFileSync(join(dir, ".git", "ds-review"), `${first}\t1\t2\t3\tclaude\tproof=1\n`);
  return { dir, first, head: await git(dir, "rev-parse", "HEAD") };
}

describe("the local half", () => {
  test("finishFacts reads the branch, HEAD and the receipt's place on the branch", async () => {
    const w = await worktree(true);
    const f = await finishFacts(w.dir);
    expect(f).toMatchObject({ branch: "feat/u1", head: w.head, ancestor: true, since: "1", short: w.first.slice(0, f.short?.length ?? 7) });
    expect(f.receipt?.startsWith(w.first)).toBe(true);
    expect(checkFacts("finish-unit-ts", f)).toBeNull();
    const none = await finishFacts((await worktree(false)).dir);
    expect(none).toMatchObject({ receipt: null, ancestor: null, since: null, short: null });
  });

  test("watch-ts facts are the instructions' state, none for a --poll peek; checkFacts takes only the right shape", async () => {
    expect(await gather("watch-ts", ["--worktree", "--poll"])).toEqual({ instr: null });
    expect(checkFacts("watch-ts", { instr: "changed" })).toBeNull();
    expect(checkFacts("watch-ts", ["changed"])).not.toBeNull();
    expect(checkFacts("msg", {})).not.toBeNull();
    expect(checkFacts("finish-unit-ts", { ...FACTS, junk: "x".repeat(20_000) })).toContain("too big");
  });

  test("inside a forwarded call toplevel() is the member row's worktree id, and senderAt matches it exactly", () => {
    const s = open(temp());
    stores.push(s);
    seedMain(s);
    put(s, "members", { id: 9, project: "realp", squad: "sq", role: "builder", suffix: "u2", wt: "local::/w/b1", host: "local", status: "running", gen: "g9" });
    process.env.DS_LINK_FORWARDED = "1";
    process.env.DS_LINK_WT = "s1::/w/b1";
    expect(toplevel()).toBe("s1::/w/b1");
    expect(senderAt(s, toplevel())).toMatchObject({ role: "builder", suffix: "u1" });
    delete process.env.DS_LINK_FORWARDED;
    expect(toplevel()).not.toBe("s1::/w/b1");
  });
});

// ─── end to end over the link ────────────────────────────────────────────────────────────────────────────────────

type Main = { root: string; store: Store; url: string };
async function mainUp(b1wt: string): Promise<Main> {
  const root = temp(), store = open(root);
  stores.push(store);
  writeFileSync(join(root, ".loop-migrated"), "");
  mkdirSync(join(root, "realp", "squads"), { recursive: true });
  writeFileSync(join(root, "realp", "squads", "sq.json"), JSON.stringify({ topic: "sq", status: "active", units: [{ slug: "u1" }, { slug: "u2" }],
    members: [{ role: "lead", suffix: "", wt: "/w/lead" }] }));
  seedMain(store, b1wt);
  const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 });
  servers.push(srv);
  return { root, store, url: `ws://127.0.0.1:${srv.port}` };
}
async function sideUp(m: Main): Promise<{ root: string }> {
  const root = temp(), k = ensureHostKey(root);
  expect(requestJoin(m.store, { name: "s1", public_key: k.publicKey }).ok).toBe(true);
  expect(accept(m.store, "s1").ok).toBe(true);
  const client = new LinkClient({ main: m.url, root, name: "s1" });
  clients.push(client);
  await client.start();
  relays.push(startRelay(root, (ch, body, t) => client.request(ch, body, t)));
  return { root };
}
type Out = { code: number; stdout: string; stderr: string };
/** `bin/ds argv` on the side host, in the Builder's worktree `cwd`, as builder-u1 (gen g1). */
async function onSide(side: { root: string }, cwd: string, argv: string[], extra: Record<string, string> = {}): Promise<Out> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DS_|ORCA_)/.test(k) && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  Object.assign(env, { DS_MAIN_URL: mainUrlFor(side.root), DS_MEMBER: B1, DS_GEN: "g1", DS_STATE_ROOT: side.root, ...extra });
  const p = Bun.spawn([process.execPath, DS, ...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

describe("on a side host", () => {
  test("finish-unit reads the worktree there and writes main's finish row with the side worktree id; no worker_done", async () => {
    const w = await worktree(true);
    const m = await mainUp(`s1::${w.dir}`), side = await sideUp(m);
    const r = await onSide(side, w.dir, ["finish-unit-ts", join(side.root, "realp", "squads", "sq.json"), "u1", "--no-pr"]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toContain("member on a side host: no worker_done");
    expect(r.stdout).toContain("finish-unit: unit 'u1' finished (no PR)");
    const rows = all(m.store, "SELECT member, unit, gen, wt, outcome FROM finishes");
    expect(rows).toEqual([{ member: B1, unit: "u1", gen: "g1", wt: `s1::${w.dir}`, outcome: "no-pr" }]);
    expect(rows.length).toBe(1);
    expect(readFileSync(join(m.root, "realp", "journals", "sq-builder-u1.md"), "utf8")).toContain("unit finished without a PR");
    // Another unit, from the same worktree, is refused before anything runs on main.
    const other = await onSide(side, w.dir, ["finish-unit-ts", join(side.root, "realp", "squads", "sq.json"), "u2", "--no-pr"]);
    expect(other.code).toBe(EXIT.refused);
    expect(all(m.store, "SELECT 1 FROM finishes").length).toBe(1);
  }, 30_000);

  test("expose writes main's row owned by the side member; --stop is refused and writes none; unexpose ends it", async () => {
    const w = await worktree(false);
    const m = await mainUp(`s1::${w.dir}`), side = await sideUp(m);
    const e = await onSide(side, w.dir, ["expose", "dev", "http://localhost:3000", "--note", "preview"]);
    expect(e).toMatchObject({ code: 0 });
    expect(all(m.store, "SELECT name, owner_wt, role, suffix FROM exposed WHERE gone_at IS NULL")).toEqual([
      { name: "dev", owner_wt: `s1::${w.dir}`, role: "builder", suffix: "u1" }]);
    const s = await onSide(side, w.dir, ["expose", "web", "http://localhost:4000", "--stop", "echo stop"]);
    expect(s.code).toBe(EXIT.refused);
    expect(all(m.store, "SELECT 1 FROM exposed WHERE name = 'web'")).toEqual([]);
    expect(await onSide(side, w.dir, ["unexpose", "dev"])).toMatchObject({ code: 0 });
    expect(all(m.store, "SELECT 1 FROM exposed WHERE gone_at IS NULL")).toEqual([]);
  }, 30_000);

  test("watch.sh --worktree reads main's rows for the member and the side's instructions state", async () => {
    const w = await worktree(false);
    const m = await mainUp(`s1::${w.dir}`), side = await sideUp(m);
    sendMessage(m.store, { to: { project: "realp", squad: "sq", role: "builder", suffix: "u1" },
      from: { project: "realp", squad: "sq", role: "lead", suffix: "", member: "local::/w/lead" }, subject: "rebase", body: "base moved" });
    const seen = join(side.root, "seen");
    const r = await onSide(side, w.dir, ["watch-ts", "--worktree", "2000"], { DS_INSTR_SEEN: seen });
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toContain("INSTRUCTIONS: changed");
    expect(r.stdout).toContain("base moved");
    // The seen mark is the side host's, written by its half; the next tick there says unchanged.
    const again = await onSide(side, w.dir, ["watch-ts", "--worktree", "200"], { DS_INSTR_SEEN: seen });
    expect(again.stdout).toContain("INSTRUCTIONS: unchanged");
  }, 30_000);

  test("reload ack from the side terminal settles main's reload wish", async () => {
    const w = await worktree(false);
    const m = await mainUp(`s1::${w.dir}`), side = await sideUp(m);
    const at = Math.floor(Date.now() / 1000);
    m.store.db.run("UPDATE members SET reload_at = ? WHERE id = 2", [at - 5]);
    m.store.db.run("INSERT INTO observed_terminals (project, handle, wt, doc, observed_at) VALUES ('realp', 's1:h1', ?, ?, ?)",
      [`s1::${w.dir}`, JSON.stringify({ gen: "g1" }), at]);
    const r = await onSide(side, w.dir, ["reload", "ack", "realp", "sq", "builder", "u1"]);
    expect(r.stderr).toBe("");
    expect(r).toMatchObject({ code: 0 });
    expect(all(m.store, "SELECT reloaded_at IS NOT NULL AS done FROM members WHERE id = 2")).toEqual([{ done: 1 }]);
  }, 30_000);
});
