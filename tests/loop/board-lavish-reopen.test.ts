// board-lavish-reopen.test.ts — lavish-legacy-document-opening U2: POST /api/lavish-reopen {key}, the page view's
// "Open in Lavish" button. A stub Lavish on a free port records what the board posts to it; the board server runs
// on a temp DS_STATE_ROOT.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const tmp = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "lavishreopen-"));
const state = join(tmp, "state"), wt = join(tmp, "wt", "ds-builder-u1"), wtOther = join(tmp, "wt", "other");
const K = { open: "b000000000000001", ended: "b000000000000002", refused: "b000000000000003", other: "b000000000000004", gone: "b000000000000005", down: "b000000000000006" };

const posts: { path: string; origin: string | null; body: any }[] = [];
let stub: ReturnType<typeof Bun.serve>, proc: ReturnType<typeof Bun.spawn>, board = "", downPort = 0;

const freePort = () => { const p = Bun.serve({ port: 0, fetch: () => new Response() }); const n = p.port!; p.stop(true); return n; };

beforeAll(async () => {
  stub = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    const body: any = await req.json();
    posts.push({ path, origin: req.headers.get("Origin"), body });
    if (body.file.endsWith("refused.html")) return Response.json({ error: "no <such> file" }, { status: 500 });
    return Response.json({ status: "opened", url: `http://lavish.example:${stub.port}/session/reopened` });
  } });
  downPort = freePort();
  for (const [dir, name] of [[wt, "open"], [wt, "ended"], [wt, "refused"], [wt, "down"], [wtOther, "other"]]) {
    mkdirSync(join(dir, ".lavish"), { recursive: true });
    writeFileSync(join(dir, ".lavish", `${name}.html`), `<h1>${name}</h1>`);
  }
  const s = open(state);
  for (const l of ["realp", "otherp"]) s.upsert("projects", { label: l }, { observed_at: 1 });
  const squad = (project: string, topic: string, w: string) =>
    s.upsert("squads", { project, topic }, { status: "running", observed_at: 1, updated_at: 1, doc: { topic, members: [], worktrees: [`x::${w}`], units: [], waiting_on_you: [] } });
  squad("realp", "t1", wt); squad("otherp", "o1", wtOther);
  const sess = (file: string, key: string, status: string, port = stub.port!) =>
    s.upsert("observed_sessions", { project: "realp", file }, { url: `http://127.0.0.1:${port}/session/${key}`, status, doc: JSON.stringify({ key, mtime: 1 }), observed_at: 1 });
  sess(join(wt, ".lavish/open.html"), K.open, "open");
  sess(join(wt, ".lavish/ended.html"), K.ended, "ended");
  sess(join(wt, ".lavish/refused.html"), K.refused, "ended");
  sess(join(wtOther, ".lavish/other.html"), K.other, "ended");
  sess(join(wt, ".lavish/gone.html"), K.gone, "ended");
  sess(join(wt, ".lavish/down.html"), K.down, "ended", downPort);
  s.close();
  const port = freePort();
  board = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, join(ROOT, "bin/board/board-server.ts"), "127.0.0.1", String(port),
    join(ROOT, "web/board.html"), join(ROOT, "bin/board/board-data.ts"), "realp"],
  { env: { ...process.env, DS_STATE_ROOT: state }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(board + "/healthz")).ok) break; } catch { /* not up yet */ } await Bun.sleep(20); }
});
afterAll(async () => {
  proc?.kill(); await proc?.exited;
  stub?.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

const reopen = (key: unknown, headers: Record<string, string> = {}) => fetch(board + "/api/lavish-reopen",
  { method: "POST", headers: { Origin: board, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ key }) });

test("an open session: its own URL, nothing posted to Lavish", async () => {
  posts.length = 0;
  const r = await reopen(K.open);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ url: `http://127.0.0.1:${stub.port}/session/${K.open}` });
  expect(posts).toEqual([]);
});

test("an ended session: Lavish is asked to reopen it, with no Origin header, and its URL comes back", async () => {
  posts.length = 0;
  const r = await reopen(K.ended);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ url: `http://lavish.example:${stub.port}/session/reopened` });
  expect(posts).toEqual([{ path: "/api/sessions", origin: null, body: { file: join(wt, ".lavish/ended.html"), reopen: true } }]);
});

test("a Lavish refusal passes its reason through", async () => {
  const r = await reopen(K.refused);
  expect(r.status).toBe(502);
  expect((await r.json() as any).error).toBe("Lavish would not reopen it: no <such> file");
});

test("refused: another origin, a plain form post, a GET", async () => {
  posts.length = 0;
  expect((await reopen(K.ended, { Origin: "http://evil.example" })).status).toBe(403);
  expect((await reopen(K.ended, { Origin: "null" })).status).toBe(403);
  expect((await reopen(K.ended, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await fetch(board + "/api/lavish-reopen")).status).toBe(405);
  expect(posts).toEqual([]);
});

test("refused: a key out of scope, unknown, not a string, or whose file is gone", async () => {
  posts.length = 0;
  for (const key of [K.other, "bfffffffffffffff", 7, K.gone]) expect((await reopen(key)).status).toBe(404);
  expect(posts).toEqual([]);
});

test("Lavish down: 202 starting, one open `lavish` request however often it is asked", async () => {
  for (let i = 0; i < 2; i++) {
    const r = await reopen(K.down);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ starting: true });
  }
  const s = open(state);
  try {
    const rows = s.db.query("SELECT payload FROM requests WHERE kind = 'lavish'").all() as any[];
    expect(rows.map((x) => JSON.parse(x.payload))).toEqual([{ port: downPort }]);
  } finally { s.close(); }
});

test("the page view has the button, under a CSP that lets only its own script post to this board", async () => {
  const r = await fetch(`${board}/review/${K.ended}`);
  const body = await r.text(), csp = r.headers.get("Content-Security-Policy")!;
  const nonce = body.match(/<script nonce="([^"]+)">/)![1];
  expect(csp).toContain(`script-src 'nonce-${nonce}'`);
  expect(csp).toContain("connect-src 'self'");
  expect(body).toContain(`data-key="${K.ended}">Open in Lavish</button>`);
  expect(body).toContain('sandbox="allow-scripts"');
});

// The served script, run against a stub page: its own fetch and fake timers, every answer `starting`.
async function pageScript(hold = false) {
  const script = (await (await fetch(`${board}/review/${K.ended}`)).text()).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!;
  const on: Record<string, (e?: any) => void> = {}, timers = new Map<number, () => void>(), held: (() => void)[] = [];
  let ids = 0, requests = 0;
  const button = { disabled: false, textContent: "Open in Lavish", dataset: { key: K.ended }, addEventListener: (n: string, f: () => void) => { on[n] = f; } };
  const msg = { textContent: "", hidden: true };
  new Function("document", "addEventListener", "fetch", "setTimeout", "clearTimeout", "location", script)(
    { getElementById: (id: string) => (id === "open" ? button : msg) },
    (n: string, f: (e: any) => void) => { on[n] = f; },
    () => {
      requests++;
      const answer = { status: 202, text: async () => JSON.stringify({ starting: true }) };
      return hold ? new Promise((done) => held.push(() => done(answer))) : Promise.resolve(answer);
    },
    (f: () => void) => { timers.set(++ids, f); return ids; },
    (id: number) => { timers.delete(id); },
    { assign: () => {} },
  );
  const settle = () => Bun.sleep(0);
  return {
    button, msg, timers, settle,
    requests: () => requests,
    click: async () => { on.click!(); await settle(); },
    restore: () => on.pageshow!({ persisted: true }),
    // Run every timer pending now, as one 3-second wait would.
    tick: async () => { const due = [...timers.values()]; timers.clear(); due.forEach((f) => f()); await settle(); },
    answer: async () => { held.splice(0).forEach((f) => f()); await settle(); },
  };
}

test("the button retries while Lavish starts, then says it did not start", async () => {
  const p = await pageScript();
  await p.click();
  expect([p.msg.textContent, p.button.disabled, p.timers.size]).toEqual(["Starting Lavish…", true, 1]);
  for (let i = 0; i < 39; i++) await p.tick();
  expect([p.requests(), p.timers.size]).toEqual([40, 0]);
  expect([p.msg.textContent, p.button.disabled, p.button.textContent]).toEqual(["Lavish did not start; try again.", false, "Open in Lavish"]);
});

test("a back/forward restore during the wait, then a click, runs one retry loop", async () => {
  const p = await pageScript();
  await p.click();
  p.restore();
  expect([p.msg.textContent, p.button.disabled, p.timers.size]).toEqual(["", false, 0]);
  await p.click();
  for (let i = 0; i < 3; i++) {
    expect(p.timers.size).toBe(1);
    const before = p.requests();
    await p.tick();
    expect(p.requests() - before).toBe(1);
  }
});

test("a request still in flight at a restore starts no second loop", async () => {
  const p = await pageScript(true);
  await p.click();
  p.restore();
  await p.click();
  await p.answer();
  expect(p.timers.size).toBe(1);
});
