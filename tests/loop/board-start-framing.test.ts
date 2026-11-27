// board-start-squad-box U1: a brief pasted into the board's Start squad dialog reaches the squad's wish byte for
// byte. board-actions-as-wishes U6: board server (/api/request) -> the loop's squad-start fulfiller (framing file,
// name, running wish), no Studio. A `studio` start filed before the deploy still goes through the studio
// fulfiller. Temp state root only; the name call is a stub that fails, so an unnamed start takes the plain name.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import squadStart from "../../bin/loop/fulfil/squad-start.ts";
import studio from "../../bin/loop/fulfil/studio.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";

const ROOT = join(import.meta.dir, "..", "..");
const servers: ReturnType<typeof Bun.spawn>[] = [];
const nameCmd = process.env.DS_SQUAD_NAME_CMD;
afterEach(async () => {
  for (const p of servers.splice(0)) { p.kill(); await p.exited; }
  if (nameCmd === undefined) delete process.env.DS_SQUAD_NAME_CMD; else process.env.DS_SQUAD_NAME_CMD = nameCmd;
});

async function rig() {
  const root = tempRoot("start-framing-");
  const store: Store = open(root); onTestEnd(() => store.close());
  process.env.DS_SQUAD_NAME_CMD = "false";
  store.upsert("projects", { label: "p" }, { home_repo: "path:/fake", observed_at: 1 });
  const l = Bun.serve({ port: 0, fetch: () => new Response() }); const port = l.port; l.stop(true);
  const url = `http://127.0.0.1:${port}`;
  servers.push(Bun.spawn([process.execPath, join(ROOT, "bin/board/board-server.ts"), "127.0.0.1", String(port),
    join(ROOT, "web/board.html"), join(ROOT, "bin/board/board-data.ts"), "p"], { env: { ...process.env, DS_STATE_ROOT: root }, stdout: "ignore", stderr: "pipe" }));
  for (let i = 0; i < 150; i++) { try { if ((await fetch(url + "/healthz")).ok) break; } catch { /* not up yet */ } await Bun.sleep(20); }
  const post = async (body: unknown) => {
    const r = await fetch(url + "/api/request", { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = { error: t }; }
    return { status: r.status, body: b };
  };
  const action = (id: number, kind: string): any => {
    const r = store.db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row;
    return { project: String(r.project), squad: null, member: null, subject: `req:${id}`, kind, episode: `req:${id}`, payload: { ...JSON.parse(String(r.payload)), request: id } };
  };
  const result = (id: number) => JSON.parse(String((store.db.query("SELECT result FROM requests WHERE id = ?").get(id) as Row).result));
  // The loop's squad-start fulfiller on one request: the request's result {ok, topic, named_by, …} or {ok:false, error}.
  const fulfil = async (id: number) => {
    const o: any = await squadStart.exec(action(id, "squad-start"), { store, now: 1_800_000_000, act: { orca: { run: async () => ({ code: 1, out: "", err: "" }) } } } as any);
    expect(o.done).toBe(true);
    return result(id);
  };
  // The studio fulfiller (a start filed before the deploy): the request file's line.
  const fulfilStudio = async (id: number) => {
    const o: any = await studio.exec(action(id, "studio"), { store, now: 1_800_000_000 } as any);
    expect(o.done).toBe(true);
    return readFileSync(String(o.result), "utf8");
  };
  // chat-image-upload U4: an image for the Start squad dialog (topic _start, no member).
  // markdown-file-upload-support U1: a text file or PDF names its Content-Type and its own name.
  const upload = async (bytes: Uint8Array, type = "image/png", name = "") => {
    const r = await fetch(url + `/api/chat-file?project=p&topic=_start${name ? `&name=${encodeURIComponent(name)}` : ""}`, { method: "POST", headers: { Origin: url, "Content-Type": type }, body: bytes });
    return { status: r.status, body: await r.json() as any };
  };
  const wish = (topic: string) => store.db.query("SELECT want, want_payload FROM squads WHERE project = 'p' AND topic = ?").get(topic) as Row | null;
  return { root, store, post, fulfil, fulfilStudio, wish, upload };
}

// 10 KB of many lines: blank lines, tabs, bullets, paths, shell-special characters and non-ASCII text.
const LINE = "- fix /home/x/y.ts: 'single' \"double\" `tick` $HOME $(rm) \\n \\\\ é ü 日本語 ✓\n\n\t\tindented\n";
const BRIEF = LINE.repeat(Math.ceil(10_240 / Buffer.byteLength(LINE))).slice(0, -1);

test("a 10 KB multi-line brief with a slug reaches the squad wish byte for byte", async () => {
  const f = await rig();
  const r = await f.post({ project: "p", action: "start", text: BRIEF, slug: "my-topic", type: "feature", autonomy: "lfg", start: "plan" });
  expect(r.status).toBe(202);
  expect(await f.fulfil(r.body.id)).toMatchObject({ ok: true, topic: "my-topic", named_by: "operator" });
  const w = f.wish("my-topic")!;
  expect(w.want).toBe("running");
  const p = JSON.parse(String(w.want_payload));
  expect(Buffer.from(p.framing as string).equals(Buffer.from(BRIEF))).toBe(true);
  expect(p).toMatchObject({ type: "feature", autonomy: "lfg", start: "plan" });
});

test("no slug: the squad takes a name from the brief; the wish gets the same bytes", async () => {
  const f = await rig();
  const r = await f.post({ project: "p", action: "start", text: BRIEF });
  expect(r.status).toBe(202);
  const res = await f.fulfil(r.body.id);
  expect(res).toMatchObject({ ok: true, topic: "fix-home-x", named_by: "fallback" });
  const framing = JSON.parse(String(f.wish("fix-home-x")!.want_payload)).framing as string;
  expect(Buffer.from(framing).equals(Buffer.from(BRIEF))).toBe(true);
});

test("a CRLF brief arrives as LF", async () => {
  const f = await rig();
  const r = await f.post({ project: "p", action: "start", text: "a\r\nb\rc\n", slug: "crlf" });
  expect(r.status).toBe(202);
  await f.fulfil(r.body.id);
  expect(JSON.parse(String(f.wish("crlf")!.want_payload)).framing).toBe("a\nb\nc\n");
});

test("every refusal in the contract says why and files nothing", async () => {
  const f = await rig();
  const ok = { project: "p", action: "start", text: "do it" };
  const cases: [string, any, number, string][] = [
    ["empty", { ...ok, text: "  \n\t\n" }, 400, "say what the squad should do: the text is empty"],
    ["missing", { project: "p", action: "start" }, 400, "say what the squad should do: the text is empty"],
    ["over 32 KiB", { ...ok, text: "x".repeat(32 * 1024 + 1) }, 400, "the text is 32.0 KiB; the limit is 32 KiB"],
    ["multibyte over 32 KiB", { ...ok, text: "é".repeat(16 * 1024 + 1) }, 400, "the limit is 32 KiB"],
    ["control character", { ...ok, text: "a\nb\u0007c" }, 400, "the text has a control character on line 2"],
    ["bad slug", { ...ok, slug: "bad slug" }, 400, "topic slug may only use letters, digits, . _ - and must not start with ."],
    ["dot slug", { ...ok, slug: ".x" }, 400, "topic slug may only use letters, digits, . _ - and must not start with ."],
    ["long slug", { ...ok, slug: "a".repeat(65) }, 400, "topic slug may only use"],
    ["bad type", { ...ok, type: "other" }, 400, "type must be one of feature, testing"],
    ["bad autonomy", { ...ok, autonomy: "yolo" }, 400, "autonomy must be one of checkpoints, lfg"],
    ["bad start", { ...ok, start: "later" }, 400, "start must be one of plan, brainstorm, ask, investigate, fix, auto"],
    ["start with testing", { ...ok, type: "testing", start: "plan" }, 400, "a testing squad has no start"],
    ["unknown project", { ...ok, project: "nope" }, 409, "no project nope on this board"],
  ];
  for (const [name, body, status, msg] of cases) {
    const r = await f.post(body);
    expect({ name, status: r.status }).toEqual({ name, status });
    expect(String(r.body.error)).toContain(msg);
  }
  expect((f.store.db.query("SELECT COUNT(*) AS n FROM requests WHERE kind = 'squad-start'").get() as Row).n).toBe(0);
  // auto and testing without start are fine (each its own brief: the same brief while one is open is 409)
  expect((await f.post({ ...ok, start: "auto" })).status).toBe(202);
  expect((await f.post({ ...ok, text: "do it 2", start: "fix" })).status).toBe(202);
  expect((await f.post({ ...ok, text: "do it 3", type: "testing", start: "auto" })).status).toBe(202);
});

test("a 32 KiB brief made mostly of newlines is accepted, not 413", async () => {
  const f = await rig();
  const text = "\n".repeat(32 * 1024 - 1) + "x";
  const r = await f.post({ project: "p", action: "start", text, slug: "newlines" });
  expect(r.status).toBe(202);
  await f.fulfil(r.body.id);
  expect(JSON.parse(String(f.wish("newlines")!.want_payload)).framing).toBe(text);
});

test("an old-shape start (no framing) still writes its one line; the other actions are untouched", async () => {
  const f = await rig();
  const row = f.store.requestAny("studio", { action: "start", topic: null, line: "board: the operator asks you to run: /ds-start-squad fix it" }, { project: "p", by: "board" }).row;
  expect(await f.fulfilStudio(Number(row.id))).toBe("board: the operator asks you to run: /ds-start-squad fix it\n");
  expect(existsSync(join(f.root, "p", "framings"))).toBe(false);
});

// chat-image-upload U4: images uploaded to chat-files/_start/ go with the start; the fulfil copies them next to the
// brief and lists their absolute paths at its end.
const png = (tag: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(tag)]);
const SECTION = "\n## Attached images\n\nThe operator attached these images to the brief. Open each with your file-reading tool:\n";

test("a start with two images: the brief ends with their copies' paths, 0600, and a replay copies nothing twice", async () => {
  const f = await rig();
  const a = await f.upload(png("one")), b = await f.upload(png("two"));
  expect([a.status, b.status]).toEqual([200, 200]);
  const [na, nb] = [a.body.id as string, b.body.id as string];
  expect(existsSync(join(f.root, "p", "chat-files", "_start", na))).toBe(true);
  const r = await f.post({ project: "p", action: "start", text: "look at these", files: [na, nb] });
  expect(r.status).toBe(202);
  const row = f.store.db.query("SELECT payload FROM requests WHERE id = ?").get(r.body.id) as Row;
  expect(JSON.parse(String(row.payload)).files).toEqual([na, nb]);
  await f.fulfil(r.body.id);
  const dir = join(f.root, "p", "framings", `board-start-${r.body.id}`);
  const brief = readFileSync(join(f.root, "p", "framings", `board-start-${r.body.id}.md`), "utf8");
  expect(brief).toBe(`look at these\n${SECTION}- ${join(dir, na)}\n- ${join(dir, nb)}\n`);
  for (const n of [na, nb]) {
    expect(statSync(join(dir, n)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, n)).equals(readFileSync(join(f.root, "p", "chat-files", "_start", n)))).toBe(true);
  }
  expect(existsSync(join(f.root, "p", "chat-files", "_start", na))).toBe(true); // copied, not moved
  const ino = statSync(join(dir, na)).ino;
  // A replay after the upload was pruned: the copy is kept and listed, nothing is copied again.
  unlinkSync(join(f.root, "p", "chat-files", "_start", na));
  await f.fulfil(r.body.id);
  expect(statSync(join(dir, na)).ino).toBe(ino);
  expect(readFileSync(join(f.root, "p", "framings", `board-start-${r.body.id}.md`), "utf8")).toBe(brief);
});

test("an image gone before the start ran fails the start, naming it; nothing is wished", async () => {
  const f = await rig();
  const a = await f.upload(png("three")), b = await f.upload(png("four"));
  const [na, nb] = [a.body.id as string, b.body.id as string];
  const r = await f.post({ project: "p", action: "start", text: "brief\n", files: [na, nb], slug: "gone-img" });
  expect(r.status).toBe(202);
  unlinkSync(join(f.root, "p", "chat-files", "_start", nb));
  expect(await f.fulfil(r.body.id)).toEqual({ ok: false, error: `image ${nb} is gone — attach it again` });
  expect(f.wish("gone-img")).toBeNull();
});

test("a studio start filed before the deploy: a gone image gets its own line; a brief ending in a newline gets one blank line", async () => {
  const f = await rig();
  const a = await f.upload(png("six")), b = await f.upload(png("seven"));
  const [na, nb] = [a.body.id as string, b.body.id as string];
  const row = f.store.requestAny("studio", { action: "start", topic: null, line: "board: the operator asks you to run: /ds-start-squad --repo p", framing: "brief\n", files: [na, nb] }, { project: "p", by: "board" }).row;
  unlinkSync(join(f.root, "p", "chat-files", "_start", nb));
  expect(await f.fulfilStudio(Number(row.id))).toContain(`--framing-file ${join(f.root, "p", "framings", `board-start-${row.id}.md`)}`);
  const dir = join(f.root, "p", "framings", `board-start-${row.id}`);
  expect(readFileSync(join(f.root, "p", "framings", `board-start-${row.id}.md`), "utf8"))
    .toBe(`brief\n${SECTION}- ${join(dir, na)}\n- ${nb} (removed before the squad started)\n`);
  expect(existsSync(join(dir, nb))).toBe(false);
});

test("a start's images: nine, a bad name or a missing one is refused and files nothing; no images is byte for byte as before", async () => {
  const f = await rig();
  const a = await f.upload(png("five"));
  const ok = { project: "p", action: "start", text: "do it" };
  const nine = Array.from({ length: 9 }, (_, i) => `${String(i).repeat(16)}.png`);
  const cases: [string, any, number, string][] = [
    ["nine", { ...ok, files: nine }, 400, "files: at most 8 distinct file names"],
    ["bad name", { ...ok, files: ["../x.png"] }, 400, "files: at most 8"],
    ["twice", { ...ok, files: [a.body.id, a.body.id] }, 400, "files: at most 8"],
    ["not a list", { ...ok, files: "x" }, 400, "files: at most 8"],
    ["missing", { ...ok, files: ["0123456789abcdef.png"] }, 409, "image 0123456789abcdef.png is gone — attach it again"],
  ];
  for (const [name, body, status, msg] of cases) {
    const r = await f.post(body);
    expect({ name, status: r.status }).toEqual({ name, status });
    expect(String(r.body.error)).toContain(msg);
  }
  expect((f.store.db.query("SELECT COUNT(*) AS n FROM requests WHERE kind = 'squad-start'").get() as Row).n).toBe(0);
  const r = await f.post({ ...ok, files: [] });
  expect(r.status).toBe(202);
  expect(JSON.parse(String((f.store.db.query("SELECT payload FROM requests WHERE id = ?").get(r.body.id) as Row).payload))).not.toHaveProperty("files");
  await f.fulfil(r.body.id);
  expect(readFileSync(join(f.root, "p", "framings", `board-start-${r.body.id}.md`), "utf8")).toBe("do it");
  expect(existsSync(join(f.root, "p", "framings", `board-start-${r.body.id}`))).toBe(false);
});

// markdown-file-upload-support U1 (D7): a text file or PDF is copied like an image and listed under its own section.
const FILES = "\n## Attached files\n\nThe operator attached these files to the brief. Read each with your file-reading tool:\n";
test("a start with a .md, a .pdf and a .png writes both sections; a gone .md fails a strict start with file", async () => {
  const f = await rig();
  const i = await f.upload(png("eight")), m = await f.upload(Buffer.from("# Spec\n"), "text/plain", "My Spec (v2).md");
  const d = await f.upload(Buffer.from("%PDF-1.4 x"), "application/pdf", "report.pdf");
  expect([i.status, m.status, d.status]).toEqual([200, 200, 200]);
  const [ni, nm, nd] = [i.body.id as string, m.body.id as string, d.body.id as string];
  expect(nm).toMatch(/^[0-9a-f]{16}-My-Spec-v2\.md$/);
  const r = await f.post({ project: "p", action: "start", text: "read", files: [nm, ni, nd] });
  expect(r.status).toBe(202);
  await f.fulfil(r.body.id);
  const dir = join(f.root, "p", "framings", `board-start-${r.body.id}`);
  expect(readFileSync(join(f.root, "p", "framings", `board-start-${r.body.id}.md`), "utf8"))
    .toBe(`read\n${SECTION}- ${join(dir, ni)}\n${FILES}- ${join(dir, nm)}\n- ${join(dir, nd)}\n`);
  expect(readFileSync(join(dir, nm), "utf8")).toBe("# Spec\n");
  const g = await f.post({ project: "p", action: "start", text: "again", files: [nm], slug: "gone-md" });
  expect(g.status).toBe(202);
  unlinkSync(join(f.root, "p", "chat-files", "_start", nm));
  expect(await f.fulfil(g.body.id)).toEqual({ ok: false, error: `file ${nm} is gone — attach it again` });
  expect(f.wish("gone-md")).toBeNull();
  const late = await f.post({ project: "p", action: "start", text: "late", files: [nm] });
  expect([late.status, late.body.error]).toEqual([409, `file ${nm} is gone — attach it again`]);
});

// orca-backend-alternatives U33: the project's backend is not a choice; another one is refused with U30's reason.
test("a start naming another backend than the Studio's is refused with the reason", async () => {
  const f = await rig();
  f.store.upsert("projects", { label: "p" }, { studio_wt: "local::/fake/studio", doc: JSON.stringify({ studio_backend: "tmux" }), observed_at: 1 });
  f.store.upsert("config", { project: "p", file: "limits.conf", key: "default_backend" }, { value: "herdr", observed_at: 1 });   // stale: never read
  const bad = await f.post({ project: "p", action: "start", text: "go", backend: "herdr" });
  expect(bad.status).toBe(409);
  expect(bad.body.error).toContain("backend herdr is refused: this project's Studio runs on tmux, and a project keeps one backend for its Studio and squads; to move the whole project: ds up p --backend herdr");
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 });
  const ok = await f.post({ project: "p", action: "start", text: "go", backend: "tmux" });
  expect(ok.status).toBe(202);
  const none = await f.post({ project: "p", action: "start", text: "go again" });
  expect(none.status).toBe(202);
});

// board-actions-as-wishes U6: a second Start with the same brief while one is open, and a taken slug, are 409s.
test("the same brief twice while the first is open, or a taken slug, is 409 and files nothing", async () => {
  const f = await rig();
  expect((await f.post({ project: "p", action: "start", text: "same brief" })).status).toBe(202);
  const twice = await f.post({ project: "p", action: "start", text: "same brief", slug: "other-name" });
  expect([twice.status, twice.body.error]).toEqual([409, "already starting a squad with this brief"]);
  f.store.want("squad", "p/taken", "running", { payload: { repo: "p" }, by: "test" });
  const taken = await f.post({ project: "p", action: "start", text: "new brief", slug: "taken" });
  expect(taken.status).toBe(409);
  expect(taken.body.error).toContain("squad taken already exists in p");
  expect((f.store.db.query("SELECT COUNT(*) AS n FROM requests WHERE kind = 'squad-start'").get() as Row).n).toBe(1);
});
