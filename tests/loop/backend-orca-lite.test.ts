// The orca-lite backend (orca-backend-alternatives U13; bin/backend/orca-lite.ts, conventions/backend.md
// "The orca-lite backend"): the contract v2 conformance suite on the fake Orca (bin/loop/fakes/orca.ts),
// then what the suite does not reach: parents, an unknown folder, a restarted Orca's new handles, the
// agent state of a tab, a submit Orca confirms as a turn, and the adapter calls each op makes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked } from "../../bin/backend/contract.ts";
import { envCommand, keyBytes, orcaLite, stateOf } from "../../bin/backend/orca-lite.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { conformance } from "./backend-conformance.ts";

const root = mkdtempSync(join(tmpdir(), "ds-orca-lite-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let k = 0;
function rig() {
  const dir = join(root, `wt${++k}`), parent = join(root, `lead${k}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(parent, { recursive: true });
  const fake = new FakeBackend();
  fake.wts.set(dir, { id: `R::${dir}`, path: dir, repo: root, branch: `b${k}`, parent: null });
  fake.wts.set(parent, { id: `R::${parent}`, path: parent, repo: root, branch: `l${k}`, parent: null });
  const keep = join(root, `keep${k}.json`);
  let clock = 1000;   // every read of the clock a second later, so a list is after the create before it
  return { fake, dir, parent, keep, b: checked(orcaLite({ orca: fake, keep, now: () => ++clock })) };
}

const shared = rig();
conformance({ name: "orca-lite", make: () => orcaLite({ orca: shared.fake, keep: shared.keep }), cwd: shared.dir, wait: 1000 });

describe("orca-lite", () => {
  test("backend.info: orca-lite, every capability native", async () => {
    expect(await rig().b.call("backend.info", {})).toEqual({
      ok: true, name: "orca-lite", version: "1", capabilities: { parents: "native", state: "native", turn_confirm: "native", keys: "native" },
    });
  });

  test("create opens a tab in the worktree Orca has at the cwd, with the env exported into it", async () => {
    const { fake, dir, b } = rig();
    const a = await b.call("terminal.create", { cwd: dir, label: "builder-u1", env: { DS_GEN: "g1", DS_MEMBER: "p/s/builder-u1", Q: "it's" } });
    expect(a.ok).toBe(true);
    const c = fake.of("terminal-create")[0]!;
    expect(c.args).toEqual([`R::${dir}`, "builder-u1", `export DS_GEN='g1' DS_MEMBER='p/s/builder-u1' Q='it'\\''s'`]);
    expect(fake.screens.get(a.ok ? a.terminal.id : "")?.env).toEqual({ DS_GEN: "g1", DS_MEMBER: "p/s/builder-u1", Q: "it's" });
    expect(a.ok && a.terminal).toMatchObject({ cwd: dir, label: "builder-u1", group: null, parent: null, gen: "g1" });
  });

  test("a folder Orca has no worktree at is failed, and nothing is made", async () => {
    const { fake, b } = rig();
    const a = await b.call("terminal.create", { cwd: join(root, "nowhere"), label: "x" });
    expect(a.ok ? "ok" : a.error.code).toBe("failed");
    expect(a.ok ? "" : a.error.message).toContain("no worktree at");
    expect(fake.of("terminal-create")).toHaveLength(0);
  });

  test("a parent is set with wt-set-parent once, a self parent or the same parent is not", async () => {
    const { fake, dir, parent, b } = rig();
    const one = await b.call("terminal.create", { cwd: dir, label: "a", parent });
    expect(one.ok && one.terminal.parent).toBe(parent);
    expect(fake.of("wt-set-parent").map((c) => c.args)).toEqual([[`R::${dir}`, `R::${parent}`]]);
    await b.call("terminal.create", { cwd: dir, label: "b", parent });
    await b.call("terminal.create", { cwd: dir, label: "c", parent: dir });
    expect(fake.of("wt-set-parent")).toHaveLength(1);
    const none = await b.call("terminal.create", { cwd: dir, label: "d", parent: join(root, "nowhere") });
    // U21f: a parent Orca does not know starts the terminal un-nested (the nesting reconciler moves it later).
    expect(none.ok ? "ok" : none.error.code).toBe("ok");
    expect(fake.of("wt-set-parent")).toHaveLength(1);
  });

  test("worktree.parent reads the parent Orca shows as a folder; worktree.set_parent moves it, once, by folder", async () => {
    const { fake, dir, parent, b } = rig();
    expect(await b.call("worktree.parent", { cwd: dir })).toEqual({ ok: true, parent: null });
    expect((await b.call("worktree.set_parent", { cwd: dir, parent })).ok).toBe(true);
    expect((await b.call("worktree.set_parent", { cwd: dir, parent })).ok).toBe(true);
    expect(fake.of("wt-set-parent")).toHaveLength(1);
    expect(await b.call("worktree.parent", { cwd: dir })).toEqual({ ok: true, parent });
    const gone = await b.call("worktree.set_parent", { cwd: dir, parent: join(root, "nowhere") });
    expect(gone.ok ? "ok" : gone.error.code).toBe("not_found");
    const unknown = await b.call("worktree.parent", { cwd: join(root, "nowhere") });
    expect(unknown.ok ? "ok" : unknown.error.code).toBe("not_found");
  });

  test("an env value with a control character is refused", async () => {
    const { dir, b } = rig();
    const a = await b.call("terminal.create", { cwd: dir, label: "x", env: { A: "1\n rm -rf ~" } });
    expect(a.ok ? "ok" : a.error.code).toBe("bad_request");
    expect(envCommand({ A: "x\ty" })).toBeNull();
    expect(envCommand({})).toBe("");
  });

  test("a restarted Orca's new handle is followed by the pane, and the facts file follows it", async () => {
    const { fake, dir, keep, b } = rig();
    const a = await b.call("terminal.create", { cwd: dir, label: "lead", env: { DS_GEN: "g" } });
    const id = a.ok ? a.terminal.id : "";
    const sc = fake.screens.get(id)!;
    fake.screens.delete(id);
    fake.screens.set("term_new", sc);
    const l = await b.call("terminal.list", {});
    expect(l.ok && l.terminals.map((t) => t.id)).toEqual([id]);
    expect(JSON.parse(readFileSync(keep, "utf8")).terminals[0]).toMatchObject({ id, handle: "term_new", pane: sc.pane });
    expect(await b.call("terminal.send", { id, text: "echo hi", submit: true })).toEqual({ ok: true, delivery: "accepted" });
    expect(fake.of("terminal-type").at(-1)!.args).toEqual(["term_new", "echo hi", "enter"]);
    expect(await b.call("terminal.close", { id })).toEqual({ ok: true, closed: true });
    expect(fake.of("terminal-close").at(-1)!.args).toEqual(["term_new"]);
  });

  test("list leaves out tabs this backend did not make, and drops the facts of a tab Orca no longer lists", async () => {
    const { fake, dir, keep, b } = rig();
    fake.agent(`R::${dir}`, "term_other", "claude");
    const a = await b.call("terminal.create", { cwd: dir, label: "x" });
    const id = a.ok ? a.terminal.id : "";
    fake.screens.delete(id);   // closed in Orca's window, by hand
    const l = await b.call("terminal.list", {});
    expect(l.ok && l.terminals).toEqual([]);
    expect(JSON.parse(readFileSync(keep, "utf8")).terminals).toEqual([]);
    expect(await b.call("terminal.close", { id })).toEqual({ ok: true, closed: false });
  });

  test("list keeps the facts of a terminal made at or after its pane read (a create it raced), until a later list", async () => {
    const { fake, dir, keep } = rig();
    const same = checked(orcaLite({ orca: fake, keep, now: () => 5000 }));
    const a = await same.call("terminal.create", { cwd: dir, label: "x" });
    const id = a.ok ? a.terminal.id : "";
    fake.screens.delete(id);
    const l = await same.call("terminal.list", {});
    expect(l.ok && l.terminals).toEqual([]);
    expect(JSON.parse(readFileSync(keep, "utf8")).terminals.map((t: { id: string }) => t.id)).toEqual([id]);
    const later = checked(orcaLite({ orca: fake, keep, now: () => 5001 }));
    await later.call("terminal.list", {});
    expect(JSON.parse(readFileSync(keep, "utf8")).terminals).toEqual([]);
  });

  test("readOnly (the role scripts): reads follow a new handle in memory, the facts file is never written, create and close refuse", async () => {
    const { fake, dir, keep, b } = rig();
    const a = await b.call("terminal.create", { cwd: dir, label: "lead" });
    const id = a.ok ? a.terminal.id : "";
    const gone = await b.call("terminal.create", { cwd: dir, label: "gone" });
    fake.screens.delete(gone.ok ? gone.terminal.id : "");
    const sc = fake.screens.get(id)!;
    fake.screens.delete(id);
    fake.screens.set("term_moved", sc);
    const before = readFileSync(keep, "utf8");
    const ro = checked(orcaLite({ orca: fake, keep, readOnly: true }));
    const l = await ro.call("terminal.list", {});
    expect(l.ok && l.terminals.map((t) => t.id)).toEqual([id]);
    expect(await ro.call("terminal.send", { id, text: "hi", submit: false })).toEqual({ ok: true, delivery: "accepted" });
    expect(fake.of("terminal-type").at(-1)!.args[0]).toBe("term_moved");
    expect(readFileSync(keep, "utf8")).toBe(before);
    for (const c of [await ro.call("terminal.create", { cwd: dir, label: "y" }), await ro.call("terminal.close", { id })])
      expect(c.ok ? "ok" : c.error.code).toBe("failed");
    expect(fake.of("terminal-close")).toEqual([]);
  });

  test("agent.state reads worktree ps for the tab's pane", async () => {
    const { fake, dir, b } = rig();
    const a = await b.call("terminal.create", { cwd: dir, label: "x" });
    const id = a.ok ? a.terminal.id : "";
    expect(await b.call("agent.state", { id })).toEqual({ ok: true, state: "unknown" });
    const pane = fake.screens.get(id)!.pane;
    for (const [orca, want] of [["working", "working"], ["done", "idle"], ["waiting", "waiting"], ["odd", "unknown"]] as const) {
      fake.paneStates.set(pane, orca);
      expect(await b.call("agent.state", { id })).toEqual({ ok: true, state: want });
    }
    expect(fake.of("pane-state").at(-1)!.args).toEqual([`R::${dir}`, pane]);
    expect(stateOf("blocked")).toBe("waiting");
  });

  test("a submit Orca's receipt confirms is turn_started; keys go as their bytes with no Enter", async () => {
    const { fake, dir, b } = rig();
    const a = await b.call("terminal.create", { cwd: dir, label: "x" });
    const id = a.ok ? a.terminal.id : "";
    fake.answer = (c) => (c.op === "terminal-type" && c.args[2] === "enter" ? { code: 0, out: "turn_started\n", err: "" } : undefined);
    expect(await b.call("terminal.send", { id, text: "go", submit: true })).toEqual({ ok: true, delivery: "turn_started" });
    fake.answer = undefined;
    expect(await b.call("terminal.send", { id, keys: ["Escape", "Up", "Enter", "C-c"] })).toEqual({ ok: true, delivery: "accepted" });
    expect(fake.of("terminal-type").at(-1)!.args).toEqual([fake.of("terminal-type").at(-1)!.args[0], "\x1b\x1b[A\r\x03"]);
    expect(keyBytes("q")).toBe("q");
  });

  test("an adapter that fails answers failed, never throws", async () => {
    const { fake, dir, b } = rig();
    const a = await b.call("terminal.create", { cwd: dir, label: "x" });
    const id = a.ok ? a.terminal.id : "";
    fake.fail("terminal-panes", { code: 1, out: "", err: "orca adapter: terminal-panes could not read the terminal list\n" });
    const l = await b.call("terminal.list", {});
    expect(l.ok ? "ok" : `${l.error.code}: ${l.error.message}`).toBe("failed: orca-lite: the terminal list could not be read: orca adapter: terminal-panes could not read the terminal list");
    fake.fail("terminal-close", { code: 1, out: "", err: "terminal_busy\n" });
    const c = await b.call("terminal.close", { id });
    expect(c.ok ? "ok" : c.error.code).toBe("failed");
  });
});
