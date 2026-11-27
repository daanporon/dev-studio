// board-review-page.test.ts — lavish-legacy-document-opening U1: GET /review/<key> shows one Lavish session's page in
// a plain view (name, state word, an iframe of /review/<key>/file/<name>), and the file route serves the page and
// the files beside it, sandboxed, refusing anything outside the session's folder. The board server runs on a temp
// DS_STATE_ROOT whose loop.db holds the squads and observed_sessions rows.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const tmp = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardreview-"));
const state = join(tmp, "state"), wt = join(tmp, "wt", "ds-builder-u1"), wt2 = join(tmp, "wt", "ds-builder-u2"), wtOther = join(tmp, "wt", "other");
const NAUGHTY = `a<b"&c.html`;
const K = {
  plan: "a000000000000001", ended: "a000000000000002", top: "a000000000000003", linked: "a000000000000004",
  naughty: "a000000000000005", pages: "a000000000000006", legacy: "a000000000000007", t2: "a000000000000008",
  otherp: "a000000000000009", gone: "a00000000000000a", stray: "a00000000000000b", txt: "a00000000000000c",
};
const servers: { url: string; stop: () => Promise<void> }[] = [];
let board = "", topicBoard = "";

const put = (p: string, body = "x") => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body); };

async function serve(...args: string[]) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port; probe.stop(true);
  const url = `http://127.0.0.1:${port}`;
  const p = Bun.spawn([process.execPath, join(ROOT, "bin/board/board-server.ts"), "127.0.0.1", String(port),
    join(ROOT, "web/board.html"), join(ROOT, "bin/board/board-data.ts"), ...args],
  { env: { ...process.env, DS_STATE_ROOT: state }, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url + "/healthz")).ok) break; } catch { /* not up yet */ } await Bun.sleep(20); }
  servers.push({ url, stop: async () => { p.kill(); await p.exited; } });
  return url;
}

beforeAll(async () => {
  put(join(wt, ".lavish/plan.html"), `<link rel="stylesheet" href="plan.css"><h1>plan</h1>`);
  put(join(wt, ".lavish/plan.css"), "h1 { color: red }");
  put(join(wt, ".lavish/img/dot.png"), "png");
  put(join(wt, ".lavish/ended.html"), "<h1>ended</h1>");
  put(join(wt, ".lavish", NAUGHTY), "<h1>naughty</h1>");
  put(join(wt, ".lavish/.hidden/x.css"), "x");
  put(join(wt, ".lavish/node_modules/x.css"), "x");
  put(join(wt, ".lavish/notes.txt"), "secret");
  put(join(wt, ".lavish/notes.md"), "secret");
  symlinkSync(join(wt, ".lavish/plan.css"), join(wt, ".lavish/link.css"));
  symlinkSync(join(wt, "elsewhere"), join(wt, ".lavish/linkdir"));
  put(join(wt, "elsewhere/x.css"), "x");
  put(join(wt, "top.html"), "<h1>top</h1>");
  put(join(wt, "sibling.css"), "x");
  put(join(wt, "real/linked.html"), "<h1>linked</h1>");
  symlinkSync(join(wt, "real"), join(wt, "linked"));
  put(join(wt2, ".lavish/t2.html"), "<h1>t2</h1>");
  put(join(wtOther, ".lavish/o.html"), "<h1>o</h1>");
  put(join(tmp, "stray/s.html"), "<h1>stray</h1>");
  put(join(state, "realp/pages/t1/doc.html"), "<h1>doc</h1>");
  put(join(state, "realp/pages/t1/doc.css"), "x");
  put(join(state, "realp/squads/t1-board/old.html"), "<h1>old</h1>");

  const s = open(state);
  for (const l of ["realp", "otherp"]) s.upsert("projects", { label: l }, { observed_at: 1 });
  const squad = (project: string, topic: string, w: string) =>
    s.upsert("squads", { project, topic }, { status: "running", observed_at: 1, updated_at: 1, doc: { topic, members: [], worktrees: [`x::${w}`], units: [], waiting_on_you: [] } });
  squad("realp", "t1", wt); squad("realp", "t2", wt2); squad("otherp", "o1", wtOther);
  const sess = (file: string, key: string, status = "open") =>
    s.upsert("observed_sessions", { project: "realp", file }, { url: `http://127.0.0.1:1/session/${key}`, status, doc: JSON.stringify({ key, mtime: 1 }), observed_at: 1 });
  sess(join(wt, ".lavish/plan.html"), K.plan);
  sess(join(wt, ".lavish/ended.html"), K.ended, "ended");
  sess(join(wt, "top.html"), K.top);
  sess(join(wt, "linked/linked.html"), K.linked);
  sess(join(wt, ".lavish", NAUGHTY), K.naughty);
  sess(join(state, "realp/pages/t1/doc.html"), K.pages);
  sess(join(state, "realp/squads/t1-board/old.html"), K.legacy);
  sess(join(wt2, ".lavish/t2.html"), K.t2);
  sess(join(wtOther, ".lavish/o.html"), K.otherp);
  sess(join(wt, ".lavish/gone.html"), K.gone);
  sess(join(tmp, "stray/s.html"), K.stray);
  sess(join(wt, ".lavish/notes.txt"), K.txt);
  s.close();
  board = await serve("realp");
  topicBoard = await serve("realp", "--topic", "t1");
});
afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const get = (path: string, base = board) => fetch(base + path);
const status = async (path: string, base = board) => (await get(path, base)).status;

test("the wrapper shows the page's name, its state word and an iframe of the page", async () => {
  const r = await get(`/review/${K.plan}`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(r.headers.get("cache-control")).toBe("no-store");
  const body = await r.text();
  expect(body).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  expect(body).toContain(`<title>plan.html</title>`);
  expect(body).toContain(`<span class="state">review running</span>`);
  expect(body).toContain(`<iframe src="/review/${K.plan}/file/plan.html" title="plan.html"`);
  expect(body).toContain("text-overflow: ellipsis");
  expect(await (await get(`/review/${K.ended}`)).text()).toContain(`<span class="state">review ended</span>`);
});

test("the page and its stylesheet are served sandboxed, read-only, never cached", async () => {
  const page = await get(`/review/${K.plan}/file/plan.html`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toContain(`href="plan.css"`);
  const css = await get(`/review/${K.plan}/file/plan.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toContain("text/css");
  expect(css.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  expect(await css.text()).toBe("h1 { color: red }");
  expect(await status(`/review/${K.plan}/file/img/dot.png`)).toBe(200);
});

test("pages folders put a session in scope too, siblings included", async () => {
  expect(await status(`/review/${K.pages}`)).toBe(200);
  expect(await status(`/review/${K.pages}/file/doc.css`)).toBe(200);
  expect(await status(`/review/${K.legacy}/file/old.html`)).toBe(200);
});

test("a name with <, \" and & comes out escaped", async () => {
  const body = await (await get(`/review/${K.naughty}`)).text();
  expect(body).toContain(`<title>a&lt;b&quot;&amp;c.html</title>`);
  expect(body).not.toContain(NAUGHTY);
  expect(body).toContain(`src="/review/${K.naughty}/file/a%3Cb%22%26c.html"`);
  expect(await status(`/review/${K.naughty}/file/${encodeURIComponent(NAUGHTY)}`)).toBe(200);
});

test("refused: .., a symlink, a symlinked folder, dot-folders, node_modules, other types, outside the folder", async () => {
  const p = `/review/${K.plan}/file`;
  expect(await status(`${p}/..%2Ftop.html`)).toBe(404); // a separator inside a segment
  expect(await status(`${p}/%2e%2e/top.html`)).toBe(404);
  expect(await status(`${p}/link.css`)).toBe(404);
  expect(await status(`${p}/linkdir/x.css`)).toBe(404);
  expect(await status(`${p}/.hidden/x.css`)).toBe(404);
  expect(await status(`${p}/node_modules/x.css`)).toBe(404);
  expect(await status(`${p}/notes.txt`)).toBe(404);
  expect(await status(`${p}/notes.md`)).toBe(404);
  expect(await status(`${p}/missing.css`)).toBe(404);
  expect(await status(`/review/${K.plan}/other/plan.html`)).toBe(404);
  // A session folder reached through a symlink: neither the wrapper nor its file.
  expect(await status(`/review/${K.linked}`)).toBe(404);
  expect(await status(`/review/${K.linked}/file/linked.html`)).toBe(404);
  // A page at a worktree's root serves itself alone.
  expect(await status(`/review/${K.top}`)).toBe(200);
  expect(await status(`/review/${K.top}/file/top.html`)).toBe(200);
  expect(await status(`/review/${K.top}/file/sibling.css`)).toBe(404);
  expect(await status(`/review/${K.top}/file/.lavish/plan.html`)).toBe(404);
  // A session of a type the page view does not serve.
  expect(await status(`/review/${K.txt}`)).toBe(404);
});

test("refused: unknown key, gone file, no squad lists it, another project's or another squad's session", async () => {
  expect(await status(`/review/ffffffffffffffff`)).toBe(404);
  expect(await status(`/review/not-a-key`)).toBe(404);
  expect(await status(`/review/${K.gone}`)).toBe(404);
  expect(await status(`/review/${K.stray}`)).toBe(404);
  expect(await status(`/review/${K.otherp}`)).toBe(404);
  // t2 is realp's: the project board serves it, t1's topic board does not.
  expect(await status(`/review/${K.t2}`)).toBe(200);
  expect(await status(`/review/${K.t2}`, topicBoard)).toBe(404);
  expect(await status(`/review/${K.t2}/file/t2.html`, topicBoard)).toBe(404);
  expect(await status(`/review/${K.plan}`, topicBoard)).toBe(200);
});
