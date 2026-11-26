// board-remove-project.test.ts — remove-project U4: the board's "Remove project" button and its typed-label
// dialog, the step banner, the last view of a board whose server went, and board.json's `removal` block.
// The real page in happy-dom (board-mount); the data on a temp state root.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";
import { mount } from "./board-mount";

const empty = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/board-empty.json"), "utf8"));
const base = { ...empty, project: "acme", project_controls: true, page_version: "v1", removal: null, removal_record_cmd: "cat /s/.removed/acme-*/removed.json" };
const info = { project: "acme", blockers: [], removing: null, archive_hint: "/s/.removed/acme-<YYYY-MM-DD>/", record_cmd: base.removal_record_cmd, boards: [{ project: "other", port: 8790 }] };
const removing = (over: any = {}) => ({ id: 7, label: "acme", state: "removing", step: "check", text: "Checking the project", error: null, command: "ds remove-project acme",
  archive: null, archive_hint: info.archive_hint, record_cmd: info.record_cmd, boards: info.boards, ...over });

const windows: any[] = [];
afterEach(async () => { for (const w of windows.splice(0)) await w.happyDOM.close(); });

// The page on `board`; `net` is what the server answers from now on.
async function rig(board: any = base) {
  const r = await mount(board, false);
  const w = r.window, doc = w.document;
  windows.push(w);
  const net = { board, down: false, info: info as any, hold: null as Promise<void> | null, post: { status: 202, body: { ok: true, id: 7 } as any }, posts: [] as any[] };
  w.fetch = async (url: string, init?: any) => {
    if (net.down) throw new TypeError("Failed to fetch");
    const answer = (status: number, body: any) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (init?.method === "POST") { net.posts.push({ url: String(url), ...JSON.parse(init.body) }); return answer(net.post.status, net.post.body); }
    if (String(url).startsWith("api/remove-project")) { await net.hold; return answer(200, net.info); }
    return answer(200, String(url).startsWith("board.json") ? net.board : {});
  };
  const wait = (ms = 40) => new Promise((x) => setTimeout(x, ms));
  const until = async (ok: () => unknown) => { for (const end = Date.now() + 3000; !ok() && Date.now() < end;) await wait(20); await wait(); };
  const $ = (q: string) => doc.querySelector(q);
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(); };
  const type = async (v: string) => {
    const el = $(".rm-confirm");
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new w.Event("input", { bubbles: true })); await wait();
  };
  const submit = async () => { $("form.rmproj").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await wait(); };
  // A stream event makes the page poll again.
  const poll = async (ok: () => unknown) => { for (const s of w.__streams) s.onmessage?.({ data: "{\"kind\":\"zz\"}" }); await until(ok); };
  const text = () => doc.getElementById("root").textContent as string;
  return { r, w, doc, net, wait, until, $, click, type, submit, poll, text };
}

describe("the page", () => {
  test("the button is there with the project controls, and absent without them", async () => {
    expect((await rig()).$(".rm-project").textContent).toBe("Remove project");
    expect((await rig({ ...base, project_controls: false })).$(".rm-project")).toBeNull();
    expect((await rig({ ...base, project: null })).$(".rm-project")).toBeNull();
  });

  test("Remove stays disabled while the blockers load and until the typed name is the label exactly", async () => {
    const t = await rig();
    let release = () => {};
    t.net.hold = new Promise<void>((x) => { release = x; });
    await t.click(t.$(".rm-project"));
    expect(t.$(".rm-go").disabled).toBe(true);
    expect(t.$(".rm-confirm")).toBeNull();
    release(); await t.until(() => t.$(".rm-confirm"));
    expect(t.doc.activeElement).toBe(t.$(".rm-confirm"));
    for (const v of ["acm", "Acme", "acme "]) {
      await t.type(v);
      expect(t.$(".rm-go").disabled).toBe(true);
      await t.submit();
    }
    expect(t.net.posts).toEqual([]);
    await t.type("acme");
    expect(t.$(".rm-go").disabled).toBe(false);
    t.w.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Escape" })); await t.wait();
    expect(t.$("form.rmproj")).toBeNull();
    expect(t.net.posts).toEqual([]);
    expect(t.r.errors).toEqual([]);
  });

  test("a blocked project lists each blocker with its command and offers no field", async () => {
    const t = await rig();
    t.net.info = { ...info, blockers: [{ kind: "open-squad", text: "squad 'one' is not closed (status: running)", clear: "ds close-squad acme one" }, { kind: "live-member", text: "a member is live", clear: null }] };
    await t.click(t.$(".rm-project")); await t.until(() => t.$(".rm-blockers"));
    expect([...t.doc.querySelectorAll(".rm-blockers li")].map((li: any) => li.textContent)).toEqual(["squad 'one' is not closed (status: running)clear: ds close-squad acme one", "a member is live"]);
    expect(t.$(".rm-go").disabled).toBe(true);
    expect(t.$(".rm-confirm")).toBeNull();
    expect(t.r.errors).toEqual([]);
  });

  test("a refusal at the POST (a blocker that came up meanwhile) shows in the dialog", async () => {
    const t = await rig();
    t.net.post = { status: 409, body: { error: "'acme' cannot be removed: the project is paused: resume it first" } };
    await t.click(t.$(".rm-project")); await t.until(() => t.$(".rm-confirm"));
    await t.type("acme"); await t.submit();
    expect(t.$("form.rmproj .qfoot .err").textContent).toBe("'acme' cannot be removed: the project is paused: resume it first");
    expect(t.$("#removal")).toBeNull();
  });

  test("an accepted request closes the dialog; losing the server then shows the stopped view, with the other boards", async () => {
    const t = await rig();
    await t.click(t.$(".rm-project")); await t.until(() => t.$(".rm-confirm"));
    await t.type("acme"); await t.submit();
    expect(t.net.posts).toEqual([{ url: "api/remove-project", project: "acme", confirm: "acme" }]);
    expect(t.$("form.rmproj")).toBeNull();
    expect(t.$("#removal").textContent).toContain("Removing acme.");
    expect(t.$(".rm-project").disabled).toBe(true);
    t.net.down = true; await t.poll(() => t.$("#board-stopped"));
    const gone = t.$("#board-stopped");
    expect(gone.textContent).toContain("This board has stopped.");
    expect(gone.textContent).toContain("/s/.removed/acme-<YYYY-MM-DD>/");
    expect(gone.textContent).toContain("cat /s/.removed/acme-*/removed.json");
    expect([...gone.querySelectorAll("a")].map((a: any) => [a.textContent, a.getAttribute("href")])).toEqual([["other", "http://localhost:8790/"]]);
    expect(t.r.errors).toEqual([]);
  });

  test("an open removal in board.json shows its step; one seen step is enough for the stopped view", async () => {
    const t = await rig({ ...base, removal: removing() });
    expect(t.$("#removal-live").getAttribute("aria-live")).toBe("polite");
    expect(t.$("#removal").textContent).toContain("Checking the project");
    t.net.board = { ...base, removal: removing({ step: "stopping-services", text: "Stopping the project's services", archive: "/s/.removed/acme-2026-11-26", boards: [] }) };
    await t.poll(() => t.text().includes("Stopping the project's services"));
    t.net.down = true; await t.poll(() => t.$("#board-stopped"));
    expect(t.$("#board-stopped").textContent).toContain("/s/.removed/acme-2026-11-26");
    expect(t.$("#board-stopped").textContent).toContain("cat /s/.removed/acme-*/removed.json");
    expect(t.$("#board-stopped a")).toBeNull();
    expect(t.$("#board-stopped").textContent).not.toContain("Other boards");
    expect(t.r.errors).toEqual([]);
  });

  test("another project's board answering on this port counts as this one gone", async () => {
    const t = await rig({ ...base, removal: removing() });
    t.net.board = { ...base, project: "other" };
    await t.poll(() => t.$("#board-stopped"));
    expect(t.$("#board-stopped").textContent).toContain("acme is being removed");
  });

  test("a page that never saw a removal says contact was lost and names the same command", async () => {
    const t = await rig();
    t.net.down = true; await t.poll(() => t.$("#removal-lost"));
    expect(t.$("#board-stopped")).toBeNull();
    expect(t.text()).toContain("Lost contact with the board");
    expect(t.$("#removal-lost code").textContent).toBe("cat /s/.removed/acme-*/removed.json");
  });

  test("a failed removal keeps its error and command, and Remove project works again", async () => {
    const t = await rig({ ...base, removal: removing() });
    t.net.board = { ...base, removal: removing({ state: "failed", error: "the Studio's changes could not be saved; nothing was moved", text: "Closing the Studio" }) };
    await t.poll(() => t.text().includes("failed."));
    expect(t.$("#removal").textContent).toContain("the Studio's changes could not be saved");
    expect(t.$("#removal code").textContent).toBe("ds remove-project acme");
    expect(t.$(".rm-project").disabled).toBe(false);
    // A confirmed retry files a new request; the older failure neither hides it nor ends it.
    t.net.post = { status: 202, body: { ok: true, id: 9 } };
    await t.click(t.$(".rm-project")); await t.until(() => t.$(".rm-confirm"));
    await t.type("acme"); await t.submit();
    await t.poll(() => false);
    expect(t.$("#removal").textContent).toContain("Waiting for the loop");
    t.net.down = true; await t.poll(() => t.$("#board-stopped"));
    expect(t.$("#board-stopped")).not.toBeNull();
    expect(t.r.errors).toEqual([]);
  });

  test("a removal that failed is no reason for the stopped view later", async () => {
    const t = await rig({ ...base, removal: removing() });
    t.net.board = { ...base, removal: removing({ state: "failed", error: "x" }) };
    await t.poll(() => t.text().includes("failed."));
    t.net.down = true; await t.poll(() => t.$("#removal-lost"));
    expect(t.$("#board-stopped")).toBeNull();
  });
});

describe("board.json removal", () => {
  const T = 1_800_000_000;
  const temps: string[] = [];
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function db() {
    const root = mkdtempSync(join(tmpdir(), "zzboard-removal-"));
    temps.push(root);
    const s = open(root);
    const project = (at: number) => s.db.run("INSERT INTO projects (label, observed_at) VALUES ('acme', ?)", [at]);
    const request = (done: number | null, result: unknown, label = "acme") => s.db.run(
      "INSERT INTO requests (key, kind, payload, result, created_at, done_at) VALUES (?, 'remove-project', ?, ?, ?, ?)",
      [`k${Math.random()}`, JSON.stringify({ label, by: "board" }), result === null ? null : JSON.stringify(result), T, done]);
    const board = (p: string, port: number, status: string) => s.db.run("INSERT INTO services (name, project, port, status, observed_at, updated_at) VALUES ('board', ?, ?, ?, ?, ?)", [p, port, status, T, T]);
    const read = () => { return buildBoard("acme", "", root, false) as any; };
    return { root, s, project, request, board, read };
  }

  test("an open removal carries its step, the archive's place and the other running boards", () => {
    const d = db();
    d.project(T);
    d.request(null, { step: "stopping-board", label: "acme", archive: null, text: "Stopping the project's board" });
    d.board("acme", 8787, "running"); d.board("", 8788, "running"); d.board("other", 8789, "running"); d.board("idle", 8790, "stopped");
    d.s.close();
    const got = d.read();
    expect(got.removal).toMatchObject({ state: "removing", step: "stopping-board", text: "Stopping the project's board", error: null, archive: null,
      archive_hint: `${d.root}/.removed/acme-<YYYY-MM-DD>/`, command: "ds remove-project acme", boards: [{ project: "", port: 8788 }, { project: "other", port: 8789 }] });
    expect(got.removal_record_cmd).toBe(`cat ${d.root}/.removed/acme-*/removed.json`);
  });

  test("a failure shows its error; another label's removal does not show", () => {
    const d = db();
    d.project(T);
    d.request(null, null, "other");
    d.request(T + 5, { ok: false, step: "check", text: "Checking the project", error: "blocked" });
    d.s.close();
    expect(d.read().removal).toMatchObject({ state: "failed", error: "blocked" });
  });

  test("a failure stays after the state observer restamps the projects row, as it does every tick", () => {
    const d = db();
    d.project(T);
    d.request(T + 5, { ok: false, step: "check", error: "blocked" });
    d.s.db.run("UPDATE projects SET observed_at = ? WHERE label = 'acme'", [T + 100]);
    d.s.close();
    expect(d.read().removal).toMatchObject({ state: "failed", error: "blocked" });
  });

  test("a removal that worked shows while the label has no projects row", () => {
    const d = db();
    d.request(T, { ok: true, step: "removed", archive: "/a", text: "Removed" });
    d.s.close();
    expect(d.read().removal).toMatchObject({ state: "removed", archive: "/a" });
  });

  test("a reused label, with a projects row again, shows no removal that worked", () => {
    const d = db();
    d.request(T - 100, { ok: true, step: "removed", archive: "/a", text: "Removed" });
    d.project(T);
    d.s.close();
    expect(d.read().removal).toBeNull();
  });
});
