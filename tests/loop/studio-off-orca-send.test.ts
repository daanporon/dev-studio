// studio-off-orca-send.test.ts — U52b (project-start): a Studio on tmux (dispatcher.json studio_backend, a
// `local::` studio_wt) is typed into through the contract: a board chat, a wake-up poke and a menu key reach its
// terminal as `terminal.send`, never as an Orca op, and `ds reload ack` finds it by DS_GEN. The same three on an
// Orca Studio keep their Orca ops (fulfil-chat.test.ts, poke-verify.test.ts, studio-reload.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { sessionOf } from "../../bin/loop/pause/pause.ts";
const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const SAYS = "dev-studio board, the operator says: ";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);

// The fixture project with its Studio on a fake tmux: its terminal (DS_GEN g0) adopted and idle at an empty prompt.
async function tmuxStudio() {
  const d = mkdtempSync(join(tmpdir(), "zzstudiosend-")); temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d); stores.push(s);
  importJson(s);
  s.db.run("UPDATE requests SET done_at = ? WHERE project = 'fx' AND key LIKE 'file:fx/_studio/%'", [T]);
  const path = join(d, "studio"); mkdirSync(path);
  const wt = `local::${path}`, proj = s.get("projects", { label: "fx" })!;
  s.upsert("projects", { label: "fx" }, { studio_wt: wt, doc: JSON.stringify({ ...JSON.parse(String(proj.doc ?? "{}")), studio_backend: "tmux" }), observed_at: T });
  const fake: FakeContract = fakeContract({}, { name: "tmux", now: () => T });
  const made = await fake.call("terminal.create", { cwd: path, env: { DS_GEN: "g0" }, label: "studio" });
  if (!made.ok) throw new Error("fake create");
  const handle = made.terminal.id;
  s.db.run("DELETE FROM members WHERE project = 'fx' AND squad = '_studio'");
  s.upsert("members", { project: "fx", squad: "_studio", wt }, { role: "studio", suffix: "", agent: "claude", model: "opus", account: "acct-a", handle, gen: "g0", status: "running", observed_at: T, updated_at: T });
  s.upsert("observed_terminals", { project: "fx", handle }, { wt, title: "_studio/studio", tail: "│ ❯ │\n", tail_at: T - 20,
    doc: JSON.stringify({ identity: "claude", agent: true, gen: "g0", last_output_at: T - 900, unread: 0 }), gone_at: null, observed_at: T });
  s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", tail: "│ ❯ │\n", tail_at: T - 20, since: T - 900, last_output_at: T - 900, gone_at: null, suspect: 0, observed_at: T });
  const orca = new FakeBackend();
  const act = new LoopActuator({ orca, fulfillers, backends: () => ({ backend: fake, caps: fake.caps }) });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  const sent = () => fake.calls.filter((c) => c.op === "terminal.send").map((c) => c.req as Row);
  return { s, fake, orca, tick, handle, wt, path, sent };
}
const result = (s: Store, id: number): Row => JSON.parse(String(s.get("requests", { id })?.result ?? "{}"));

describe("U52b: a Studio on tmux is typed into", () => {
  test("a board chat is typed into its terminal through terminal.send, not poke-terminal", async () => {
    const r = await tmuxStudio();
    const id = Number(r.s.request("chat", { text: "morning", via: "board" }, { project: "fx", squad: "_studio", member: r.wt }).row.id);
    r.s.db.run("UPDATE requests SET created_at = ? WHERE id = ?", [T, id]);
    await r.tick(T);
    expect(r.sent()).toEqual([{ id: r.handle, text: `${SAYS}morning`, submit: true }]);
    expect(r.orca.of("poke-terminal").length).toBe(0);
    expect(result(r.s, id)).toMatchObject({ ok: true, state: "sent" });
  });

  test("a chat the terminal refuses is queued to retry, with the backend's reason", async () => {
    const r = await tmuxStudio();
    r.fake.terms.delete(r.handle);
    const id = Number(r.s.request("chat", { text: "morning", via: "board" }, { project: "fx", squad: "_studio", member: r.wt }).row.id);
    r.s.db.run("UPDATE requests SET created_at = ? WHERE id = ?", [T, id]);
    await r.tick(T);
    expect(r.orca.of("poke-terminal").length).toBe(0);
    expect(result(r.s, id)).toMatchObject({ state: "queued" });
    expect(String(result(r.s, id).why)).toContain(`no terminal ${r.handle}`);
  });

  test("a menu key is pressed in its terminal as named keys, with no Enter added", async () => {
    const r = await tmuxStudio();
    const id = Number(r.s.request("keys", { keys: ["Down", "2"], via: "board" }, { project: "fx", squad: "_studio", member: r.wt }).row.id);
    r.s.db.run("UPDATE requests SET created_at = ? WHERE id = ?", [T, id]);
    await r.tick(T);
    expect(r.sent()).toEqual([{ id: r.handle, keys: ["Down", "2"] }]);
    expect(r.orca.of("keys").length).toBe(0);
    expect(result(r.s, id)).toMatchObject({ ok: true, state: "sent" });
  });

  test("a backend that types no named keys fails the press with that reason", async () => {
    const r = await tmuxStudio();
    r.fake.caps.keys = "none";
    const id = Number(r.s.request("keys", { keys: ["Escape"], via: "board" }, { project: "fx", squad: "_studio", member: r.wt }).row.id);
    r.s.db.run("UPDATE requests SET created_at = ? WHERE id = ?", [T, id]);
    await r.tick(T);
    expect(r.sent()).toEqual([]);
    expect(result(r.s, id)).toMatchObject({ ok: false, error: "backend tmux cannot press keys" });
  });

  test("a wake-up poke for the adopted handle is typed through terminal.send", async () => {
    const r = await tmuxStudio();
    const poke = fulfillers.find((f) => f.name === "poke")!;
    const a = { project: "fx", squad: "_studio", member: r.wt, subject: r.wt, kind: "poke", episode: "reload:1", payload: { handle: r.handle, text: "re-read AGENTS.md", reason: "reload" } };
    const out = await poke.exec(a as never, { store: r.s, now: T + 1000, act: new LoopActuator({ orca: r.orca, fulfillers, backends: () => ({ backend: r.fake, caps: r.fake.caps }) }) } as never);
    expect(out).toMatchObject({ done: true, result: "sent" });
    expect(r.sent()).toEqual([{ id: r.handle, text: "re-read AGENTS.md", submit: true }]);
    expect(r.orca.of("poke-terminal").length).toBe(0);
  });

  test("/ds-reload's ack from a tmux pane with no Orca handle finds the Studio by DS_GEN and clears the wish", async () => {
    const r = await tmuxStudio();
    r.s.wishOnce("fx/_studio/studio", "reload", { at: T + 100, by: "update-squads" });
    const me = { handle: null, gen: "g0", wt: r.path };
    expect(sessionOf(r.s, me)).toBe(r.handle);
    expect(sessionOf(r.s, { ...me, gen: "g-old" })).toBeNull();
    expect(() => r.s.acknowledgeReload("fx/_studio/studio", undefined, T + 250)).toThrow("instructed agent terminal");
    r.s.acknowledgeReload("fx/_studio/studio", sessionOf(r.s, me) ?? undefined, T + 250);
    expect(Number(r.s.get("members", { project: "fx", squad: "_studio", wt: r.wt })?.reloaded_at)).toBe(T + 250);
  });
});
