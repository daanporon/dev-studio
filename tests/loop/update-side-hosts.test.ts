// update-side-hosts.test.ts — side-loop-host U24 (issue #127): main's update reaches every side host. Once an
// `update` request left main on a commit, each online side host gets an `update` host job naming it, a host that was
// away gets it when its link is back, each host's step lands in the request's result, and one still behind 10 minutes
// later is a Needs-you card whose Update sends the job again. The side's half starts one detached
// `update-host --side <commit>` per attempt and answers from its record. No real update runs: the link is a fake
// `send` and the side's launch is faked.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { sideUpdates } from "../../bin/loop/fulfil/side-update.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { runHere, type HostJob, type Send } from "../../bin/link/host-jobs.ts";
import { accept, requestJoin } from "../../bin/link/host-keys.ts";
import { codeRev } from "../../bin/link/client.ts";
import { LINK_VERSION } from "../../bin/link/protocol.ts";
import { UP_MIGRATION } from "../../bin/link/replica.ts";
import { readRecord, writeRecord } from "../../bin/lib/side-update-record.ts";
import type { SideUpdateAnswer, SideUpdateDeps } from "../../bin/lib/side-update-job.ts";
import { buildBoard, hostsJson } from "../../bin/board/board-data.ts";
import { generateKeyPairSync } from "node:crypto";
import { mount } from "./board-mount.ts";

const REPO = join(import.meta.dir, "..", "..");
const T = Math.floor(Date.now() / 1000);
const TARGET = "b".repeat(40), OLD = "a".repeat(12);
const temps: string[] = [], stores: Store[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = (p: string) => { const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), p)); temps.push(d); return d; };

// A main loop with the side-update fulfiller alone, a finished update that left it on TARGET, and fake links.
function rig(hosts: string[] = ["side-a"]) {
  for (const k of Object.keys(process.env)) if (/^(DS_|ORCA_)/.test(k)) delete process.env[k];
  process.env.DS_LINK_BIND = "127.0.0.1 main.example.test";
  process.env.DS_LIMIT_LINK_LISTEN = "off";
  process.env.DS_LOOP_RETRY_S = "1";
  const root = temp("zzsideup-"), conv = temp("zzsideup-conv-");
  cpSync(join(REPO, "conventions"), conv, { recursive: true });
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  const s = open(root); stores.push(s);
  importConfig(s, root, conv);
  s.upsert("projects", { label: "p" }, { observed_at: T });
  for (const name of hosts) {
    expect(requestJoin(s, { name, public_key: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64") }, T - 600).ok).toBe(true);
    expect(accept(s, name, { seats: 2 }, T - 500).ok).toBe(true);
    s.upsert("hosts", { name }, { last_seen_at: T, link_version: LINK_VERSION, up_migration: UP_MIGRATION, code_rev: OLD });
  }
  const update = Number(s.requestAny("update", { by: "test" }, { project: "p", by: "test" }).row.id);
  s.db.run("UPDATE requests SET done_at = ?, result = ? WHERE id = ?", [T, JSON.stringify({ ok: true, state: "done", outcome: "advanced", target: TARGET }), update]);

  const jobs: { host: string; body: HostJob }[] = [];
  // What each host's job answers next: an answer, or the error the link gives.
  const answers: Record<string, SideUpdateAnswer | Error> = {};
  const running: SideUpdateAnswer = { state: "running", rev: "a".repeat(40), line: "updating", log: "" };
  const send: Send = async (host, body) => {
    jobs.push({ host, body });
    const a = answers[host] ?? running;
    if (a instanceof Error) throw a;
    return a;
  };
  let at = T, head = TARGET;
  const f = sideUpdates({ head: () => head });
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [f], jobs: send });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["p"] });
  loop.boot(T);
  const tick = async (after = 15) => { at += after; await loop.tick(at); await act.drain(); };
  const result = () => JSON.parse(String((s.db.query("SELECT result FROM requests WHERE id = ?").get(update) as Row).result));
  const step = (host = "side-a") => result().hosts?.[host];
  const seen = (host: string, more: Row = {}) => s.upsert("hosts", { name: host }, { last_seen_at: at, unreachable_since: null, ...more });
  const away = (host: string) => s.upsert("hosts", { name: host }, { unreachable_since: at });
  const cards = () => (buildBoard("p", "", root) as any).needs_you.filter((n: any) => n.card === "host-update");
  return { root, s, update, jobs, answers, tick, result, step, seen, away, cards, now: () => at, setHead: (h: string) => { head = h; } };
}
const done: SideUpdateAnswer = { state: "done", rev: TARGET, line: `DS-UPDATE: advanced x -> ${TARGET}`, log: "install ok" };

test("an online host gets the job naming main's commit, is asked until it is done, and its step is in the update's record", async () => {
  const r = rig();
  await r.tick();
  expect(r.jobs[0]).toEqual({ host: "side-a", body: { job: "update", commit: TARGET, run: `${r.update}.1` } });
  expect(r.step()).toMatchObject({ state: "running", attempt: 1, line: "updating" });
  r.answers["side-a"] = done;
  await r.tick();
  expect(r.step()).toMatchObject({ state: "done", rev: TARGET.slice(0, 12) });
  expect(r.s.get("hosts", { name: "side-a" })!.code_rev).toBe(TARGET.slice(0, 12));
  const sent = r.jobs.length;
  await r.tick(); await r.tick(900);
  expect(r.jobs.length).toBe(sent);   // done is the end
  expect(r.result()).toMatchObject({ ok: true, outcome: "advanced", target: TARGET });
  expect(r.cards()).toEqual([]);
});

test("a host already on the commit is still sent the job: its reinstall repairs it", async () => {
  const r = rig();
  r.seen("side-a", { code_rev: TARGET.slice(0, 12) });
  r.answers["side-a"] = { ...done, line: `DS-UPDATE: already current (${TARGET}) — nothing new` };
  await r.tick();
  expect(r.jobs.length).toBe(1);
  expect(r.step()).toMatchObject({ state: "done" });
});

test("a host that is away gets the same job once its link is back behind main; one that came back current needs none", async () => {
  const r = rig(["side-a", "side-b"]);
  r.away("side-a"); r.away("side-b");
  await r.tick();
  expect(r.jobs).toEqual([]);
  expect(r.step("side-a")).toMatchObject({ state: "waiting", attempt: 1 });
  r.seen("side-a");
  r.seen("side-b", { code_rev: TARGET.slice(0, 12) });
  await r.tick();
  expect(r.jobs.map((j) => j.host)).toEqual(["side-a"]);
  expect(r.jobs[0]!.body).toEqual({ job: "update", commit: TARGET, run: `${r.update}.1` });
  expect(r.step("side-b")).toMatchObject({ state: "done" });
});

test("nothing is sent while main's checkout is not on the finished update's commit", async () => {
  const r = rig();
  r.setHead("c".repeat(40));
  await r.tick();
  expect(r.jobs).toEqual([]);
});

test("a failed update is a card 10 minutes after its job, with the log's tail; Update sends the job again", async () => {
  const r = rig();
  r.answers["side-a"] = { state: "failed", rev: "a".repeat(40), line: "DS-UPDATE: failed — install did not finish", log: "bun: not found\nDS-UPDATE: failed — install did not finish" };
  await r.tick();
  expect(r.step()).toMatchObject({ state: "failed", error: "DS-UPDATE: failed — install did not finish" });
  await r.tick(500);
  expect(r.cards()).toEqual([]);
  await r.tick(120);
  const [card, ...more] = r.cards();
  expect(more).toEqual([]);
  expect(card).toMatchObject({ host: "side-a", kind: "studio", title: "Host side-a is behind main" });
  expect(card.text).toContain("bun: not found");
  expect(card.text).toContain(TARGET.slice(0, 12));
  const sent = r.jobs.length;
  await r.tick(900);
  expect(r.jobs.length).toBe(sent);   // a failed host is not asked again by itself
  expect(r.cards().length).toBe(1);

  const page = await mount(buildBoard("p", "", r.root), true);
  const doc = page.window.document;
  const posts: any[] = [];
  page.window.fetch = async (url: string, o: any) => { posts.push({ url: String(url), body: JSON.parse(o.body) }); return new Response("{}", { status: 202 }); };
  const button = [...doc.querySelectorAll("#root button")].find((b: any) => b.textContent.trim() === "Update") as any;
  expect(button).toBeTruthy();
  button.click();
  await Bun.sleep(50);
  expect(page.errors).toEqual([]);
  expect(posts).toEqual([{ url: "api/host", body: { host: "side-a", action: "update" } }]);

  r.answers["side-a"] = done;
  const press = Number(r.s.requestAny("host-update", { host: "side-a", action: "update" }, { project: null, by: "board" }).row.id);
  await r.tick(); await r.tick();
  expect(r.jobs.at(-1)!.body).toEqual({ job: "update", commit: TARGET, run: `${r.update}.2` });
  expect(r.step()).toMatchObject({ state: "done", attempt: 2 });
  expect(r.s.db.query("SELECT done_at IS NOT NULL AS done FROM requests WHERE id = ?").get(press)).toEqual({ done: 1 });
  expect(r.cards()).toEqual([]);
});

test("a host that never answers is a card too, and it clears once the host reports main's commit", async () => {
  const r = rig();
  r.answers["side-a"] = new Error("the link dropped");
  await r.tick();
  await r.tick(610);
  await r.tick();
  expect(r.step()).toMatchObject({ state: "running", error: expect.stringContaining("the link dropped") });
  expect(r.cards().length).toBe(1);
  r.seen("side-a", { code_rev: TARGET.slice(0, 12) });
  expect(r.cards()).toEqual([]);
});

test("a host on code without this job fails at once and says to update it by hand", async () => {
  const r = rig();
  r.answers["side-a"] = new Error("unknown job 'update'");
  await r.tick(); await r.tick(); await r.tick();
  expect(r.jobs.length).toBe(1);
  expect(r.step().state).toBe("failed");
  expect(r.step().error).toContain("update it by hand once");
});

test("the Hosts rows give each host's commit next to main's", () => {
  const r = rig();
  const rows = (hostsJson("p", r.root) as any).hosts;
  expect(rows.map((h: any) => [h.name, h.commit, h.main_commit])).toEqual([["local", codeRev(), codeRev()], ["side-a", OLD, codeRev()]]);
});

// The side's half.
function side() {
  const root = temp("zzsidejob-");
  const launched: { commit: string }[] = [];
  let alive = true, rev = "a".repeat(40), now = T;
  const deps: SideUpdateDeps = { now: () => now, head: () => rev, inService: () => false, alive: () => alive,
    launch: (j) => { launched.push(j); writeFileSync(j.log, "line one\nline two\n"); return { pid: 4242 }; } };
  const ask = (run = "7.1", commit = TARGET) => runHere({ job: "update", commit, run }, { root, update: deps }) as Promise<SideUpdateAnswer> | SideUpdateAnswer;
  const finish = (state: "done" | "failed", line: string) => writeRecord(root, { ...readRecord(root)!, state, line });
  return { root, launched, ask, finish, die: () => { alive = false; }, setRev: (v: string) => { rev = v; }, later: (s: number) => { now += s; } };
}

test("the side starts one run per attempt, answers from its record, and starts the next attempt", async () => {
  const f = side();
  expect(await f.ask()).toMatchObject({ state: "running", line: "started" });
  expect(await f.ask()).toMatchObject({ state: "running", log: "line one\nline two" });
  expect(f.launched.map((j) => j.commit)).toEqual([TARGET]);
  expect(await f.ask("7.2")).toMatchObject({ state: "running" });   // waits for the one that runs
  expect(f.launched.length).toBe(1);
  f.setRev(TARGET); f.finish("done", "DS-UPDATE: advanced");
  expect(await f.ask()).toMatchObject({ state: "done", rev: TARGET, line: "DS-UPDATE: advanced" });
  expect(f.launched.length).toBe(1);
  expect(await f.ask("7.2")).toMatchObject({ state: "running" });
  expect(f.launched.length).toBe(2);
});

test("a run that ends with no result is failed", async () => {
  const f = side();
  await f.ask();
  f.die(); f.later(120);
  expect(await f.ask()).toMatchObject({ state: "failed", line: "the update ended with no result" });
  expect(f.launched.length).toBe(1);
});

test("the link refuses a job whose commit or run is not one", async () => {
  const f = side();
  for (const [run, commit] of [["7.1", "main"], ["7.1", "--hard"], ["a b", TARGET], ["../x", TARGET]] as const) {
    await expect((async () => f.ask(run, commit))()).rejects.toThrow();
  }
  expect(f.launched).toEqual([]);
});
