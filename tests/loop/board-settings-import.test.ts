// board-settings-import.test.ts — settings-export-import U3: the Import and Export buttons in the board's
// Settings window. The real page runs in happy-dom on a fixture loop.db with two projects; the preview the
// page shows is the real planImport over that db (what POST api/settings-import/preview returns), and the
// apply the page files is captured and run through the real `settings-import` fulfiller.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mount } from "./board-mount";
import config from "../../bin/loop/fulfil/config.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { exportTransfer, planImport } from "../../bin/loop/settings/settings.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const SRC = "dev-studio", DST = "dst";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzsboard-")); temps.push(d); return d; };
const raw = (s: Store, project: string, file: string, key: string, value: string) => s.upsert("config", { project, file, key }, { value, comment: null, observed_at: T });
const val = (s: Store, project: string, file: string, key: string) =>
  (s.db.query("SELECT value FROM config WHERE project = ? AND file = ? AND key = ?").get(project, file, key) as { value: string } | null)?.value ?? null;

function fixture() {
  const root = join(tmp(), "state"), conventions = tmp();
  for (const p of [SRC, DST]) mkdirSync(join(root, p, "squads"), { recursive: true });
  cpSync(join(ROOT, "conventions"), conventions, { recursive: true });
  const s = open(root);
  stores.push(s);
  raw(s, SRC, "limits.conf", "hooks_ts", "1");
  raw(s, SRC, "limits.conf", "auto_merge", "merge");
  raw(s, SRC, "limits.conf", "limit_pct", "80");
  raw(s, SRC, "limits.conf", "cleanup_on_close", "rm -rf node_modules/.cache");
  return { s, o: { conventions, now: T, board: true } };
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test("Settings → Import: pick a project, read the plan, tick, Apply files the settings-import request", async () => {
  const { s, o } = fixture();
  const board = { ...JSON.parse(readFileSync(join(ROOT, "tests/fixtures/board-empty.json"), "utf8")), project: DST, page_version: "v1" };
  const r = await mount(board, false, { "api/limits": { limits: [], groups: [] }, "api/roles": { roles: [] }, "api/skills": { roles: [] }, "api/settings-import?": { projects: [SRC] } });
  const w = r.window, doc = w.document;
  const posts: { url: string; body: any }[] = [];
  const base = w.fetch;
  w.fetch = async (url: string, init?: any) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      const ok = (b: any) => ({ ok: true, status: 200, json: async () => b });
      if (url === "api/settings-import/preview") return ok({ project: DST, rows: planImport(s, DST, { project: body.from }, o) });
      return ok({ ok: true });
    }
    return base(url, init);
  };
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(); };
  const change = async (el: any, value: string) => { el.value = value; el.dispatchEvent(new w.Event("change", { bubbles: true })); await tick(); };
  try {
    await click([...doc.querySelectorAll("button")].find((b: any) => b.textContent.includes("Settings")));
    // Export is a download link to the export route; Import sits next to it.
    const exp = doc.getElementById("settings-export");
    expect(exp.getAttribute("href")).toBe(`api/settings-export?project=${DST}`);
    expect(exp.getAttribute("download")).toBe(`${DST}-settings.txt`);
    await click(doc.getElementById("settings-import"));
    expect([...doc.querySelectorAll("#imp-from option")].map((x: any) => x.value)).toEqual(["", SRC]);
    await change(doc.getElementById("imp-from"), SRC);
    await click(doc.getElementById("imp-preview"));
    const rows = () => Object.fromEntries([...doc.querySelectorAll(".imp-row")].map((tr: any) => [tr.dataset.key, tr]));
    const t = rows();
    // hooks_ts: unknown key, greyed and can't be ticked; auto_merge: project-specific, unticked but tickable;
    // cleanup_on_close: shell only, greyed; limit_pct: an add, ticked.
    expect(t.hooks_ts.textContent).toContain("unknown key");
    expect(t.hooks_ts.className).toContain("dim");
    expect(t.hooks_ts.querySelector("input").disabled).toBe(true);
    expect(t.auto_merge.textContent).toContain("project-specific");
    expect(t.auto_merge.querySelector("input").checked).toBe(false);
    expect(t.auto_merge.querySelector("input").disabled).toBe(false);
    expect(t.cleanup_on_close.textContent).toContain("shell only");
    expect(t.cleanup_on_close.className).toContain("dim");
    expect(t.cleanup_on_close.querySelector("input").disabled).toBe(true);
    expect(t.limit_pct.querySelector("input").checked).toBe(true);
    expect(posts[0]).toEqual({ url: "api/settings-import/preview", body: { project: DST, from: SRC } });
    // Also tick auto_merge, then Apply.
    await click(t.auto_merge.querySelector("input"));
    expect(doc.getElementById("imp-apply").textContent).toBe("Apply 2 rows");
    await click(doc.getElementById("imp-apply"));
    const apply = posts.find((p) => p.url === "api/settings-import")!;
    expect(apply.body.project).toBe(DST);
    expect(apply.body.from).toBe(SRC);
    expect(apply.body.picks).toEqual([
      { file: "limits.conf", key: "auto_merge", expect: null },
      { file: "limits.conf", key: "limit_pct", expect: null },
    ]);
    expect(r.errors).toEqual([]);

    // The loop's fulfiller writes exactly those rows as `board`, and answers with the result.
    const done: any[] = [];
    const req = s.requestAny("settings-import", { from: SRC, picks: apply.body.picks }, { project: DST, by: "board" }).row;
    expect(req).toBeTruthy();
    const a: any = { kind: "settings-import", project: DST, payload: { from: SRC, picks: apply.body.picks, request: Number(req.id) }, id: 1, subject: "x" };
    const out = await (config as any).exec(a, { store: s, now: T, done });
    expect(out).toEqual({ done: true });
    expect(val(s, DST, "limits.conf", "auto_merge")).toBe("merge");
    expect(val(s, DST, "limits.conf", "limit_pct")).toBe("80");
    expect(val(s, DST, "limits.conf", "hooks_ts")).toBeNull();
    expect(val(s, DST, "limits.conf", "cleanup_on_close")).toBeNull();
    const hist = s.db.query("SELECT actor FROM config_history WHERE project = ? ORDER BY id").all(DST) as { actor: string }[];
    expect(hist.map((h) => h.actor)).toEqual(["board", "board"]);
  } finally { await w.happyDOM.close(); }
});

test("a settings-import with no source or picks fails the request, and a hand-made shell-only pick is refused", async () => {
  const { s } = fixture();
  const bad: any = { kind: "settings-import", project: DST, payload: { picks: [] }, id: 1, subject: "x" };
  expect(await (config as any).exec(bad, { store: s, now: T })).toEqual({ failed: expect.stringContaining("needs a project, a source") });
  const shell: any = { kind: "settings-import", project: DST, payload: { from: SRC, picks: [{ file: "limits.conf", key: "cleanup_on_close" }] }, id: 2, subject: "x" };
  expect(await (config as any).exec(shell, { store: s, now: T })).toEqual({ done: true });
  expect(val(s, DST, "limits.conf", "cleanup_on_close")).toBeNull();
});

test("the export text a download carries reads back as the same rows", () => {
  const { s, o } = fixture();
  const text = exportTransfer(s, SRC, o);
  expect(text.split("\n")[0]).toMatch(/^#! ds-settings 1 from=dev-studio /);
  const plan = planImport(s, DST, { text }, o);
  expect(plan.find((r) => r.key === "limit_pct")!.action).toBe("add");
});
