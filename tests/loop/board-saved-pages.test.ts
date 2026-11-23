// board-saved-pages.test.ts — debrief-in-needs-you pages U2: an archived squad's Review pages list what they
// listed before, each opening from the copy the rescue saved; a page saved without a session is listed too; a
// live session is unchanged; nothing twice. Data comes from loop.db and the squad's pages folder (buildBoard).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard } from "../../bin/board/board-data.ts";
import { servePage } from "../../bin/board/saved-pages.ts";
import { open } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const WT = "/gone/orca/workspaces/realp/ds-builder-u1"; // a worktree that no longer exists
// Squad `t1` of project realp, archived; its builder's worktree held .lavish/plan.html and .scratch/b/idea.html.
function fixture(o: { events?: boolean; extraHtml?: string[]; live?: boolean } = {}) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardsaved-")); roots.push(root);
  const dest = join(root, "realp", "pages", "t1", "rescued", "builder-u1");
  const put = (p: string, body = "<html></html>", at?: number) => {
    mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body);
    if (at) utimesSync(p, at, at);
  };
  put(join(dest, ".lavish/plan.html"), "<h1>plan</h1>", 1_700_000_100);
  put(join(dest, ".scratch/b/idea.html"), "<h1>idea</h1>", 1_700_000_200);
  put(join(dest, ".scratch/b/idea.2.html"), "<h1>idea v2</h1>", 1_700_000_300);
  put(join(dest, "docs/plans/notes.md"), "# notes");
  for (const x of o.extraHtml ?? []) put(join(root, "realp", "pages", "t1", x));
  const s = open(root);
  const sess = (file: string, key: string) => s.upsert("observed_sessions", { project: "realp", file }, { url: `http://h:4387/session/${key}`, status: "open", doc: JSON.stringify({ key, mtime: 1_700_000_000 }), observed_at: 1 });
  sess(`${WT}/.lavish/plan.html`, "aaaaaaaaaaaaaaaa");
  sess(`${WT}/.scratch/b/idea.html`, "bbbbbbbbbbbbbbbb");
  if (o.events !== false) s.event("pages_rescued", { project: "realp", squad: "t1", member: `x::${WT}`, payload: { wt: `x::${WT}`, path: WT, dest, count: 3, bytes: 10, same: 0, capped: 0, listed: true, files: [] } });
  s.upsert("documents", { project: "realp", path: "realp/archive/t1.json" }, { mtime: 1, observed_at: 1, body: JSON.stringify({ topic: "t1", status: "done", closed_at: "2026-11-20", units: [], worktrees: [] }) });
  s.close();
  return { root, dest, board: () => buildBoard("realp", "", root) as any };
}
const arch = (b: any) => b.archived.find((a: any) => a.topic === "t1");
const byName = (l: any[]) => Object.fromEntries(l.map((e) => [e.name, e]));

test("an archived squad lists its session pages with their old names, each with its saved copy", () => {
  const f = fixture();
  const l = arch(f.board()).lavish;
  expect(l.map((e: any) => e.name).sort()).toEqual(["idea.html", "plan.html"]);
  const m = byName(l);
  expect(m["plan.html"]).toMatchObject({ key: "aaaaaaaaaaaaaaaa", dir: ".lavish", saved: "realp/pages/t1/rescued/builder-u1/.lavish/plan.html" });
  // the newest copy of a page the rescue wrote twice
  expect(m["idea.html"].saved).toBe("realp/pages/t1/rescued/builder-u1/.scratch/b/idea.2.html");
  expect(m["idea.html"].key).toBe("bbbbbbbbbbbbbbbb");
});

test("a page saved without a session is listed once, with no key", () => {
  const f = fixture({ extraHtml: ["rescued/builder-u1/.scratch/c/orphan.html", "rescued/builder-u1/.scratch/c/orphan.3.html", "top.html"] });
  const l = arch(f.board()).lavish, m = byName(l);
  expect(l).toHaveLength(4);
  expect(m["orphan.html"]).toMatchObject({ key: null, url: null, saved: "realp/pages/t1/rescued/builder-u1/.scratch/c/orphan.3.html" });
  expect(m["top.html"]).toMatchObject({ key: null, saved: "realp/pages/t1/top.html" });
  expect(new Set(l.map((e: any) => e.saved)).size).toBe(4);
});

test("a session whose file is still there is listed unchanged, once, with no saved field", () => {
  const f = fixture({ events: false });
  const file = join(f.root, "realp", "pages", "t1", "live.html"); // Lavish serves it where it is
  writeFileSync(file, "x");
  const s = open(f.root);
  s.upsert("observed_sessions", { project: "realp", file }, { url: "http://h:4387/session/cccccccccccccccc", status: "open", doc: JSON.stringify({ key: "cccccccccccccccc", mtime: 5 }), observed_at: 1 });
  s.close();
  const l = arch(f.board()).lavish.filter((x: any) => x.name === "live.html");
  expect(l).toEqual([{ key: "cccccccccccccccc", name: "live.html", dir: "t1", mtime: 5, url: "http://h:4387/session/cccccccccccccccc", status: "open" }]);
});

test("servePage serves a saved page and its css, and nothing outside the squad's folder", () => {
  const f = fixture({ extraHtml: ["a/index.html"] });
  const pages = join(f.root, "realp", "pages", "t1");
  writeFileSync(join(pages, "a", "s.css"), "body{}");
  writeFileSync(join(pages, "a", "notes.txt"), "no");
  mkdirSync(join(f.root, "realp", "pages", "t2"), { recursive: true }); writeFileSync(join(f.root, "realp", "pages", "t2", "x.html"), "other");
  writeFileSync(join(f.root, "secret.html"), "secret");
  symlinkSync(join(f.root, "secret.html"), join(pages, "link.html"));
  symlinkSync(join(f.root, "realp", "pages", "t2"), join(pages, "dir"));
  const get = (...r: string[]) => servePage(f.root, "realp", "t1", r);
  expect(get("a", "index.html")?.type).toContain("text/html");
  expect(get("a", "s.css")?.type).toContain("text/css");
  expect(get("a", "notes.txt")).toBeNull();
  expect(get("..", "t2", "x.html")).toBeNull();
  expect(get("link.html")).toBeNull();
  expect(get("dir", "x.html")).toBeNull();
  expect(get("a")).toBeNull();
  expect(servePage(f.root, "realp", "t3", ["x.html"])).toBeNull();
});
