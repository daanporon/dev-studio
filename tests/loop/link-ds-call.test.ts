// link-ds-call.test.ts — side-loop-host U7 (issue #127, KTD5/KTD6/KTD12): with DS_MAIN_URL set, `bin/ds` hands a
// worker's call to the side relay, which sends it up the link; main checks it and runs the real `bin/ds` as the
// member row. A pure loop.db command (msg, send-role-ts, journal-ts, notes-ts, finish) prints the same output and
// exit code as on main; another host's member, an unlisted command and an old DS_GEN are refused (the last with
// "you were replaced" and no row); --state, --as, --from, another project and a journal, notes or finish target
// outside the member's own unit are refused; a resent request id runs once; a link that stays down gives
// "main unreachable" and the retryable exit code.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { accept, ensureHostKey, requestJoin } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { checkCall, EXIT, kindOf, REPLACED_LINE } from "../../bin/link/forward-table.ts";
import { dsCall } from "../../bin/link/channels/ds-call.ts";
import { mainUrlFor, relayCall, startRelay, type Relay } from "../../bin/link/relay.ts";
import { recordFinish } from "../../bin/loop/squad/finish.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds.ts");
const saved: Record<string, string | undefined> = {};
const ENV = { DS_LINK_PING_MS: "150", DS_LINK_DEAD_MS: "600", DS_LINK_BIND_ANY: undefined, DS_NOW: undefined, DS_LINK_RESEND_MS: undefined,
  DS_MEMBER: undefined, DS_GEN: undefined, DS_WT: undefined, DS_MAIN_URL: undefined, DS_BACKEND: undefined, DS_STATE_ROOT: undefined };
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const temps: string[] = [], stores: Store[] = [], servers: LinkServer[] = [], clients: LinkClient[] = [], relays: Relay[] = [];
afterEach(async () => {
  delete process.env.DS_LINK_RESEND_MS;
  for (const r of relays.splice(0)) r.stop();
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), "zzdscall-")); temps.push(d); return d; };
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

// Main: project realp, squad sq. A local Lead; on host s1 a Builder of u1 (gen g1) and a Tester (gen g2); on s2 a
// Builder of u3 (gen g3). Project otherp exists too.
const B1 = "realp/sq/builder-u1", T1 = "realp/sq/tester", B3 = "realp/sq/builder-u3";
function seedMain(s: Store): void {
  put(s, "projects", { label: "realp", home_repo: "/r/realp" }, { label: "otherp", home_repo: "/r/otherp" });
  put(s, "squads", { id: 1, project: "realp", topic: "sq", status: "active" }, { id: 2, project: "otherp", topic: "quiet", status: "active" });
  put(s, "members",
    { id: 1, project: "realp", squad: "sq", role: "lead", suffix: "", wt: "local::/w/lead", host: "local", status: "running", gen: "g0" },
    { id: 2, project: "realp", squad: "sq", role: "builder", suffix: "u1", wt: "s1::/w/b1", host: "s1", status: "running", gen: "g1" },
    { id: 3, project: "realp", squad: "sq", role: "tester", suffix: "", wt: "s1::/w/t", host: "s1", status: "running", gen: "g2" },
    { id: 4, project: "realp", squad: "sq", role: "builder", suffix: "u3", wt: "s2::/w/b3", host: "s2", status: "running", gen: "g3" });
  put(s, "units", { project: "realp", squad: "sq", slug: "u1", status: "dispatched", builder_wt: "s1::/w/b1" },
    { project: "realp", squad: "sq", slug: "u2", status: "dispatched", builder_wt: "local::/w/lead" },
    { project: "realp", squad: "sq", slug: "u3", status: "dispatched", builder_wt: "s2::/w/b3" });
}

type Main = { root: string; store: Store; srv: LinkServer; url: string };
async function mainUp(): Promise<Main> {
  const root = temp(), store = open(root);
  stores.push(store);
  writeFileSync(join(root, ".loop-migrated"), "");
  seedMain(store);
  const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 });
  servers.push(srv);
  return { root, store, srv, url: `ws://127.0.0.1:${srv.port}` };
}
/** Side host `name`, accepted on main, linked, with its relay socket up. */
async function sideUp(m: Main, name = "s1"): Promise<{ root: string; client: LinkClient; relay: Relay }> {
  const root = temp();
  const k = ensureHostKey(root);
  expect(requestJoin(m.store, { name, public_key: k.publicKey }).ok).toBe(true);
  expect(accept(m.store, name).ok).toBe(true);
  const client = new LinkClient({ main: m.url, root, name });
  clients.push(client);
  await client.start();
  const relay = startRelay(root, (ch, body, t) => client.request(ch, body, t));
  relays.push(relay);
  return { root, client, relay };
}

// The environment of a spawned `bin/ds`: this process's, minus any identity or host leak, plus `extra`.
function envWith(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DS_|ORCA_)/.test(k) && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  return { ...env, ...extra };
}
type Out = { code: number; stdout: string; stderr: string };
async function ds(argv: string[], env: Record<string, string>, cwd: string): Promise<Out> {
  const p = Bun.spawn([process.execPath, DS, ...argv], { cwd, env: envWith(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}
/** The call forwarded from the side host, as member `member` with generation `gen`. */
const fwd = (side: { root: string }, argv: string[], member = B1, gen = "g1") =>
  ds(argv, { DS_MAIN_URL: mainUrlFor(side.root), DS_MEMBER: member, DS_GEN: gen }, side.root);
/** The same call run on main directly, with the identity main gives it. */
const direct = (m: Main, argv: string[], member = B1, gen = "g1", wt = "/w/b1") =>
  ds(argv, { DS_STATE_ROOT: m.root, DS_MEMBER: member, DS_GEN: gen, DS_WT: wt }, m.root);

describe("a pure loop.db command runs on main", () => {
  test("msg, journal-ts, notes-ts and finish write main's rows and files as the member row", async () => {
    const m = await mainUp(), side = await sideUp(m);
    const sent = await fwd(side, ["msg", "send", "sq", "lead", "hi", "from the side"]);
    expect(sent).toMatchObject({ code: 0 });
    expect(JSON.parse(sent.stdout)).toMatchObject({ created: true, to: "sq/lead" });
    const msg = all(m.store, "SELECT * FROM messages WHERE subject = 'hi'");
    expect(msg.length).toBe(1);
    expect(msg[0]).toMatchObject({ project: "realp", squad: "sq", to_role: "lead", from_role: "builder", from_suffix: "u1", from_member: "s1::/w/b1" });

    expect(await fwd(side, ["journal-ts", "realp", "sq", "builder-u1", "add", "keep", "tried X", "fails"])).toMatchObject({ code: 0 });
    expect(readFileSync(join(m.root, "realp", "journals", "sq-builder-u1.md"), "utf8")).toContain("tried X");

    expect(await fwd(side, ["notes-ts", "realp", "builder", "add", "a tip", "a why"])).toMatchObject({ code: 0 });
    expect(readFileSync(join(m.root, "realp", "notes", "builder.md"), "utf8")).toContain("a tip");

    const fin = await fwd(side, ["finish", "u1", "--outcome", "ok", "--body", "PR #9"]);
    expect(fin).toMatchObject({ code: 0 });
    expect(fin.stdout).toContain("finish recorded");
    expect(all(m.store, "SELECT member, unit, gen, wt FROM finishes")).toEqual([{ member: B1, unit: "u1", gen: "g1", wt: "/w/b1" }]);
  }, 30_000);

  test("output and exit code are the same as the command run on main", async () => {
    const m = await mainUp(), side = await sideUp(m);
    for (const argv of [
      ["msg", "inbox", "--all"],
      ["msg", "send", "sq", "nobody", "s", "b"],                      // a usage error: exit 2
      ["send-role-ts", "sq"],                                          // too few words: exit 2
      ["journal-ts", "realp", "sq", "builder-u1", "briefing"],
      ["notes-ts", "realp", "builder", "print"],
      ["finish", "list", "--project", "realp"],
    ]) {
      const a = await fwd(side, argv), b = await direct(m, argv);
      expect({ argv, ...a }).toEqual({ argv, ...b });
    }
    // send-role-ts on main: the same row the direct call would write, once (the second call finds the first).
    const s1 = await fwd(side, ["send-role-ts", "sq", "lead", "sr", "send-role body"]);
    const s2 = await direct(m, ["send-role-ts", "sq", "lead", "sr", "send-role body"]);
    expect(s1.code).toBe(s2.code);
    expect(all(m.store, "SELECT from_role, from_suffix FROM messages WHERE subject = 'sr'")).toEqual(s1.code === 0 ? [{ from_role: "builder", from_suffix: "u1" }] : []);
  }, 60_000);
});

describe("refusals", () => {
  test("another host's member, an unlisted command and an old DS_GEN are refused; the last writes no row", async () => {
    const m = await mainUp(), side = await sideUp(m);
    const other = await fwd(side, ["msg", "inbox"], B3, "g3");
    expect(other.code).toBe(EXIT.refused);
    expect(other.stderr).toContain("is not on host s1");
    const unlisted = await fwd(side, ["config", "list"]);
    expect(unlisted.code).toBe(EXIT.refused);
    expect(unlisted.stderr).toContain("'ds config' is not a command a builder may run");
    const old = await fwd(side, ["finish", "u1", "--outcome", "ok", "--body", "late"], B1, "g0-old");
    expect(old.code).toBe(EXIT.replaced);
    expect(old.stderr).toContain(REPLACED_LINE);
    const oldMsg = await fwd(side, ["msg", "send", "sq", "lead", "late", "late"], B1, "g0-old");
    expect(oldMsg.code).toBe(EXIT.replaced);
    expect(all(m.store, "SELECT id FROM finishes")).toEqual([]);
    expect(all(m.store, "SELECT id FROM messages WHERE subject = 'late'")).toEqual([]);
  }, 30_000);

  test("identity and scope: --state, --as, --from, another project, and targets outside the member's own unit", () => {
    const s = open(temp());
    stores.push(s);
    seedMain(s);
    const why = (argv: string[], member = B1, gen = "g1") => { const c = checkCall(s, "s1", { argv, member, gen }); return c.ok ? "ok" : c.why; };
    expect(why(["msg", "inbox", "--state", "/elsewhere"])).toContain("--state");
    expect(why(["msg", "inbox", "--state=/elsewhere"])).toContain("--state");
    expect(why(["msg", "send", "sq", "lead", "s", "b", "--as", "operator"])).toContain("--as");
    expect(why(["finish", "u1", "--outcome", "ok", "--body", "b", "--as=sq/lead", "--project", "realp"])).toContain("--as");
    expect(why(["send-role-ts", "sq", "lead", "s", "b", "--from", "other"])).toContain("--from");
    expect(why(["msg", "send", "quiet", "lead", "s", "b", "--project", "otherp"])).toContain("another project");
    expect(why(["journal-ts", "realp", "sq", "builder-u3", "add", "keep", "x", "y"])).toContain("only realp sq builder-u1");
    expect(why(["journal-ts", "realp", "sq", "lead", "briefing"])).toContain("only realp sq builder-u1");
    expect(why(["journal-ts", "otherp", "quiet", "builder-u1", "briefing"])).toContain("only realp sq builder-u1");
    expect(why(["notes-ts", "realp", "lead", "add", "x", "y"])).toContain("only realp builder");
    expect(why(["notes-ts", "otherp", "builder", "print"])).toContain("only realp builder");
    expect(why(["finish", "u2", "--outcome", "ok", "--body", "b"])).toContain("own unit");
    // Allowed: own targets, own project named, a message body that looks like a flag, the Tester's own notes.
    expect(why(["finish", "u1", "--outcome", "ok", "--body", "--as"])).toBe("ok");
    expect(why(["finish", "-", "--outcome", "no-pr", "--body", "b", "--project", "realp"])).toBe("ok");
    expect(why(["msg", "send", "sq", "lead", "--from", "b"])).toContain("--from");   // msg takes no --from value: a flag
    expect(why(["journal-ts", "realp", "sq", "builder-u1", "briefing"])).toBe("ok");
    expect(why(["notes-ts", "realp", "tester", "print"], T1, "g2")).toBe("ok");
    expect(why(["journal-ts", "realp", "sq", "tester", "briefing"], T1, "g2")).toBe("ok");
    // Lead, Thinker and Studio commands are never listed; local wrappers are not run on main.
    expect(kindOf("lead", "msg")).toBeNull();
    expect(kindOf("builder", "journal")).toBe("local");
    expect(why(["journal", "realp", "sq", "builder-u1", "briefing"])).toContain("runs on the side host");
    // A Lead on main is never a side host's member.
    expect(why(["msg", "inbox"], "realp/sq/lead", "g0")).toContain("is not on host s1");
  });

  test("a stale DS_GEN finish on main itself exits non-zero and writes no row (KTD12)", async () => {
    const m = await mainUp();
    const r = await direct(m, ["finish", "u1", "--outcome", "ok", "--body", "late"], B1, "g-old");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("you were replaced");
    expect(all(m.store, "SELECT id FROM finishes")).toEqual([]);
    expect(() => recordFinish(m.store, { member: { project: "realp", squad: "sq", role: "builder", suffix: "u1" }, unit: "u1", outcome: "ok", body: "x", gen: "g-old" })).toThrow(/you were replaced/);
    expect(recordFinish(m.store, { member: { project: "realp", squad: "sq", role: "builder", suffix: "u1" }, unit: "u1", outcome: "ok", body: "x", gen: "g1" }).created).toBe(true);
  }, 30_000);
});

describe("lost answers and a link that stays down", () => {
  test("a call whose answer was lost and is resent with the same id runs once on main", async () => {
    const m = await mainUp(), side = await sideUp(m);
    let tries = 0;
    // The first try reaches main and runs, but its answer is lost on the way back (the link "drops").
    const lossy = async (ch: string, body: unknown, t: number) => {
      tries++;
      const r = await side.client.request(ch, body, t);
      if (tries === 1) throw new Error("link: main unreachable");
      return r;
    };
    const body = { id: "req-once", argv: ["msg", "send", "sq", "lead", "once", "only once"], stdin: "", member: B1, gen: "g1" };
    const r = await relayCall(lossy, body);
    expect(tries).toBe(2);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ created: true });
    expect(all(m.store, "SELECT id FROM messages WHERE subject = 'once'").length).toBe(1);
    // Main keeps the answer per host and id: the same id again is the same answer, not a second run.
    expect(await dsCall(m.store, m.root, "s1", body)).toEqual(r);
    // Another host's same id is its own call: s2's own Builder runs it.
    const again = await dsCall(m.store, m.root, "s2", { ...body, member: B3, gen: "g3" });
    expect(again.code).toBe(0);
    expect(all(m.store, "SELECT from_suffix FROM messages WHERE subject = 'once' ORDER BY id")).toEqual([{ from_suffix: "u1" }, { from_suffix: "u3" }]);
  }, 30_000);

  test("a link down past the resend window gives 'main unreachable' and exit 75; nothing ran", async () => {
    process.env.DS_LINK_RESEND_MS = "400";
    const m = await mainUp(), side = await sideUp(m);
    side.client.stop();
    const r = await fwd(side, ["msg", "send", "sq", "lead", "down", "down"]);
    expect(r.code).toBe(EXIT.unreachable);
    expect(r.stderr).toContain("main unreachable");
    expect(all(m.store, "SELECT id FROM messages WHERE subject = 'down'")).toEqual([]);
    // No relay at all (the side loop is gone): the same line and code.
    side.relay.stop();
    expect(existsSync(join(side.root, "loop", "link.sock"))).toBe(false);
    const gone = await fwd(side, ["msg", "inbox"]);
    expect(gone.code).toBe(EXIT.unreachable);
    expect(gone.stderr).toContain("main unreachable");
  }, 30_000);

  test("the relay socket is the side root's loop/link.sock, mode 0600, and help stays local", async () => {
    const m = await mainUp(), side = await sideUp(m);
    expect(side.relay.socket).toBe(join(side.root, "loop", "link.sock"));
    expect(statSync(side.relay.socket).mode & 0o777).toBe(0o600);
    const h = await fwd(side, ["help"]);
    expect(h.code).toBe(0);
    expect(h.stderr).toContain("usage: ds");
    void m;
  }, 30_000);
});
