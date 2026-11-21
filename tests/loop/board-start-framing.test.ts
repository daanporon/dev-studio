// board-start-squad-box U1: a brief pasted into the board's Start squad dialog reaches spawn-squad.sh and the
// squad's wish byte for byte. Board server (/api/request) -> studio fulfiller (framing file + request line)
// -> spawn-squad.sh with the line's arguments, the way the Studio runs /ds-start-squad. Temp state root only.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
  const wish = (topic: string) => store.db.query("SELECT want, want_payload FROM squads WHERE project = 'p' AND topic = ?").get(topic) as Row | null;
  return { root, store, post, fulfil, spawn, wish };
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
