// board-start-squad-box U1: a brief pasted into the board's Start squad dialog reaches spawn-squad.sh and the
// squad's wish byte for byte. Board server (/api/request) -> studio fulfiller (framing file + request line)
// -> spawn-squad.sh with the line's arguments, the way the Studio runs /ds-start-squad. Temp state root only.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import studio from "../../bin/loop/fulfil/studio.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";

const ROOT = join(import.meta.dir, "..", "..");
const servers: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => { for (const p of servers.splice(0)) { p.kill(); await p.exited; } });

async function rig() {
  const root = tempRoot("start-framing-");
  const store: Store = open(root); onTestEnd(() => store.close());
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
  // The loop's studio fulfiller on one request: the request file, and its line.
  const fulfil = async (id: number) => {
    const r = store.db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row;
    const a: any = { project: String(r.project), squad: null, member: null, subject: `req:${id}`, kind: "studio", episode: `req:${id}`, payload: { ...JSON.parse(String(r.payload)), request: id } };
    const o: any = await studio.exec(a, { store, now: 1_800_000_000 } as any);
    expect(o.done).toBe(true);
    return readFileSync(String(o.result), "utf8");
  };
  // spawn-squad.sh with the arguments after `/ds-start-squad `, as the Studio would pass them.
  const spawn = async (args: string[]) => {
    const p = Bun.spawn([join(ROOT, "bin/commands/spawn-squad.sh"), ...args], { env: { ...process.env, DS_STATE_ROOT: root, DS_NOW: "1800000000" }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    expect({ code: await p.exited, err }).toEqual({ code: 0, err: "" }); void out;
  };
  // chat-image-upload U4: an image for the Start squad dialog (topic _start, no member).
  const upload = async (bytes: Uint8Array) => {
    const r = await fetch(url + "/api/chat-file?project=p&topic=_start", { method: "POST", headers: { Origin: url, "Content-Type": "image/png" }, body: bytes });
    return { status: r.status, body: await r.json() as any };
  };
  const wish = (topic: string) => store.db.query("SELECT want, want_payload FROM squads WHERE project = 'p' AND topic = ?").get(topic) as Row | null;
  return { root, store, post, fulfil, spawn, wish, upload };
}
const argsOf = (line: string) => line.trim().replace(/^board: the operator asks you to run: \/ds-start-squad /, "").split(" ");

// 10 KB of many lines: blank lines, tabs, bullets, paths, shell-special characters and non-ASCII text.
const LINE = "- fix /home/x/y.ts: 'single' \"double\" `tick` $HOME $(rm) \\n \\\\ é ü 日本語 ✓\n\n\t\tindented\n";
const BRIEF = LINE.repeat(Math.ceil(10_240 / Buffer.byteLength(LINE))).slice(0, -1);

test("a 10 KB multi-line brief with a slug reaches the squad wish byte for byte", async () => {
  const f = await rig();
  const r = await f.post({ project: "p", action: "start", text: BRIEF, slug: "my-topic", type: "feature", autonomy: "lfg", start: "plan" });
  expect(r.status).toBe(202);
  const line = await f.fulfil(r.body.id);
  expect(line.trimEnd().split("\n")).toHaveLength(1); // one line for watch.sh
  expect(line).not.toContain("fix /home"); // the brief itself is not in the line
  expect(argsOf(line).slice(0, 8)).toEqual(["--repo", "p", "--topic", "my-topic", "--type", "feature", "--autonomy", "lfg"]);
  await f.spawn(argsOf(line));
  const w = f.wish("my-topic")!;
  expect(w.want).toBe("running");
  const framing = JSON.parse(String(w.want_payload)).framing as string;
  expect(Buffer.from(framing).equals(Buffer.from(BRIEF))).toBe(true);
  expect(JSON.parse(String(w.want_payload)).start).toBe("plan");
});

test("no slug: the line has no --topic; the Studio's topic gets the same bytes", async () => {
  const f = await rig();
  const r = await f.post({ project: "p", action: "start", text: BRIEF });
  expect(r.status).toBe(202);
  const line = await f.fulfil(r.body.id);
  expect(line).not.toContain("--topic");
  const args = argsOf(line);
  await f.spawn([...args.slice(0, 2), "--topic", "derived-slug", ...args.slice(2)]);
  const framing = JSON.parse(String(f.wish("derived-slug")!.want_payload)).framing as string;
  expect(Buffer.from(framing).equals(Buffer.from(BRIEF))).toBe(true);
});

test("a CRLF brief arrives as LF", async () => {
  const f = await rig();
  const r = await f.post({ project: "p", action: "start", text: "a\r\nb\rc\n", slug: "crlf" });
  expect(r.status).toBe(202);
  await f.spawn(argsOf(await f.fulfil(r.body.id)));
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
  expect((f.store.db.query("SELECT COUNT(*) AS n FROM requests WHERE kind = 'studio'").get() as Row).n).toBe(0);
  // auto and testing without start are fine
  expect((await f.post({ ...ok, start: "auto" })).status).toBe(202);
  expect((await f.post({ ...ok, start: "fix" })).status).toBe(202);
  expect((await f.post({ ...ok, type: "testing", start: "auto" })).status).toBe(202);
});

test("a 32 KiB brief made mostly of newlines is accepted, not 413", async () => {
  const f = await rig();
  const text = "\n".repeat(32 * 1024 - 1) + "x";
  const r = await f.post({ project: "p", action: "start", text, slug: "newlines" });
  expect(r.status).toBe(202);
  await f.spawn(argsOf(await f.fulfil(r.body.id)));
  expect(JSON.parse(String(f.wish("newlines")!.want_payload)).framing).toBe(text);
});

test("an old-shape start (no framing) still writes its one line; the other actions are untouched", async () => {
  const f = await rig();
  const row = f.store.requestAny("studio", { action: "start", topic: null, line: "board: the operator asks you to run: /ds-start-squad fix it" }, { project: "p", by: "board" }).row;
  expect(await f.fulfil(Number(row.id))).toBe("board: the operator asks you to run: /ds-start-squad fix it\n");
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

test("an image gone before the start ran gets its own line; a brief ending in a newline gets one blank line", async () => {
  const f = await rig();
  const a = await f.upload(png("three")), b = await f.upload(png("four"));
  const [na, nb] = [a.body.id as string, b.body.id as string];
  const r = await f.post({ project: "p", action: "start", text: "brief\n", files: [na, nb] });
  expect(r.status).toBe(202);
  unlinkSync(join(f.root, "p", "chat-files", "_start", nb));
  await f.fulfil(r.body.id);
  const dir = join(f.root, "p", "framings", `board-start-${r.body.id}`);
  expect(readFileSync(join(f.root, "p", "framings", `board-start-${r.body.id}.md`), "utf8"))
    .toBe(`brief\n${SECTION}- ${join(dir, na)}\n- ${nb} (removed before the squad started)\n`);
  expect(existsSync(join(dir, nb))).toBe(false);
});

test("a start's images: nine, a bad name or a missing one is refused and files nothing; no images is byte for byte as before", async () => {
  const f = await rig();
  const a = await f.upload(png("five"));
  const ok = { project: "p", action: "start", text: "do it" };
  const nine = Array.from({ length: 9 }, (_, i) => `${String(i).repeat(16)}.png`);
  const cases: [string, any, number, string][] = [
    ["nine", { ...ok, files: nine }, 400, "files: at most 8 distinct image names"],
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
  expect((f.store.db.query("SELECT COUNT(*) AS n FROM requests WHERE kind = 'studio'").get() as Row).n).toBe(0);
  const r = await f.post({ ...ok, files: [] });
  expect(r.status).toBe(202);
  expect(JSON.parse(String((f.store.db.query("SELECT payload FROM requests WHERE id = ?").get(r.body.id) as Row).payload))).not.toHaveProperty("files");
  await f.fulfil(r.body.id);
  expect(readFileSync(join(f.root, "p", "framings", `board-start-${r.body.id}.md`), "utf8")).toBe("do it");
  expect(existsSync(join(f.root, "p", "framings", `board-start-${r.body.id}`))).toBe(false);
});

// orca-backend-alternatives U33: the project's backend is not a choice; another one is refused with U30's reason.
test("a start naming another backend than the project's default_backend is refused with the reason", async () => {
  const f = await rig();
  f.store.upsert("config", { project: "p", file: "limits.conf", key: "default_backend" }, { value: "tmux", observed_at: 1 });
  const bad = await f.post({ project: "p", action: "start", text: "go", backend: "herdr" });
  expect(bad.status).toBe(409);
  expect(bad.body.error).toContain("backend herdr is refused: this project's squads start on tmux (its default_backend)");
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 });
  const ok = await f.post({ project: "p", action: "start", text: "go", backend: "tmux" });
  expect(ok.status).toBe(202);
  const none = await f.post({ project: "p", action: "start", text: "go again" });
  expect(none.status).toBe(202);
});
