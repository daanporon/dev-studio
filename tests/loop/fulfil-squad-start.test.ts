// fulfil-squad-start.test.ts — board-actions-as-wishes U6: the board's Start as the loop's `squad-start` request
// (bin/loop/fulfil/squad-start.ts): the name (the slug, one model call, or the plain name from the brief), the
// running wish, and the request's end. DS_SQUAD_NAME_CMD is a stub run in front of the real argv, so no model runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import squadStart from "../../bin/loop/fulfil/squad-start.ts";
import { BACKGROUND_KINDS, LoopActuator, type Exec } from "../../bin/loop/core/actuator.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { oneShotArgv } from "../../bin/lib/one-shot.ts";
import { fallbackName, freeName, parseName } from "../../bin/loop/squad/squad-name.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const ENV = ["DS_SQUAD_NAME_CMD", "DS_SQUAD_NAME_S", "STUB_MODE", "STUB_ANSWER", "STUB_ARGS"] as const;
const saved: Record<string, string | undefined> = {};
const temps: string[] = [], stores: Store[] = [];
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => {
  for (const s of stores.splice(0)) s.close?.();
  for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true });
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "zzsquadstart-")); temps.push(d);
  const state = join(d, "state"), conv = join(d, "conv");
  mkdirSync(join(state, "realp", "squads"), { recursive: true });
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(state, "accounts.tsv"));
  const s = open(state); stores.push(s);
  importConfig(s, state, conv);
  for (const r of accountRows(state)) s.upsert(r.table, r.key, r.set);
  s.upsert("projects", { label: "realp" }, { home_repo: "path:/fake", observed_at: T });
  // The stub: records its argv and cwd, then answers STUB_ANSWER (into codex's answer file), fails or hangs.
  const stub = join(d, "name-stub"), args = join(d, "args.txt");
  writeFileSync(stub, `#!/usr/bin/env bash
{ printf '%s\\n' "$@"; echo "cwd=$(pwd)"; echo "config=\${CLAUDE_CONFIG_DIR:-}"; } > "$STUB_ARGS"
case "\${STUB_MODE:-}" in fail) exit 3;; hang) exec sleep 5;; esac
out=""; prev=""; for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done
if [ -n "$out" ]; then printf '%s\\n' "$STUB_ANSWER" > "$out"; else printf '%s\\n' "$STUB_ANSWER"; fi
`);
  chmodSync(stub, 0o755);
  process.env.DS_SQUAD_NAME_CMD = stub;
  process.env.STUB_ARGS = args;
  process.env.STUB_ANSWER = "banner-timeout-fix";
  delete process.env.STUB_MODE;
  const configDir = { code: 0, out: "/fake/claude-config\n" };
  const x = () => ({ store: s, project: "realp", tick: 1, now: T, fired: [], poked: new Set(),
    act: { orca: { run: async (op: string) => op === "claude-config-dir" ? { ...configDir, err: "" } : { code: 1, out: "", err: "" } } } } as unknown as Exec);
  const file = (payload: Record<string, unknown>) => Number(s.requestAny("squad-start", { by: "board", ...payload }, { project: "realp", by: "board" }).row.id);
  const action = (id: number): any => {
    const r = s.db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row;
    return { project: "realp", squad: null, member: null, subject: `req:${id}`, kind: "squad-start", episode: `req:${id}`, payload: { ...JSON.parse(String(r.payload)), request: id } };
  };
  const run = async (payload: Record<string, unknown>) => {
    const id = file(payload);
    const o: any = await squadStart.exec(action(id), x());
    expect(o.done).toBe(true);
    return JSON.parse(String((s.db.query("SELECT result FROM requests WHERE id = ?").get(id) as Row).result));
  };
  const wish = (topic: string) => {
    const r = s.db.query("SELECT want, want_by, want_payload FROM squads WHERE project = 'realp' AND topic = ?").get(topic) as Row | null;
    return r ? { want: r.want, by: r.want_by, payload: JSON.parse(String(r.want_payload)) } : null;
  };
  const argv = () => existsSync(args) ? readFileSync(args, "utf8").split("\n") : null;
  const roster = (value: string) => s.upsert("config", { project: "realp", file: "roles.conf", key: "studio" }, { value, observed_at: T });
  return { d, s, x, file, action, run, wish, argv, roster, configDir };
}

const BRIEF = "Why does the banner stay an hour after an update?";

test("a good model answer names the squad, on the Studio's claude pick with its account's config dir", async () => {
  const f = fixture();
  expect(await f.run({ framing: BRIEF })).toMatchObject({ ok: true, topic: "banner-timeout-fix", named_by: "model", agent: "claude" });
  const a = f.argv()!;
  expect(a.slice(0, 3)).toEqual(["claude", "-p", "--model"]);
  for (const flag of ["--tools", "--strict-mcp-config", "--no-session-persistence", "--effort"]) expect(a).toContain(flag);
  expect(a[a.indexOf("--tools") + 1]).toBe("");
  expect(a.join("\n")).toContain(BRIEF);
  expect(a).toContain("config=/fake/claude-config");
  const cwd = a.find((l) => l.startsWith("cwd="))!.slice(4);
  expect(cwd).toContain("ds-squad-name-");
  expect(existsSync(cwd)).toBe(false);   // the empty folder is removed
  expect(f.wish("banner-timeout-fix")).toMatchObject({ want: "running", by: "board" });
});

test("a bad answer, a non-zero exit, a timeout, no pick and no config dir each give the plain name from the brief", async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    ["bad answer", () => { process.env.STUB_ANSWER = "Sure! Here is a name: banner fix"; }, "the answer is not a name"],
    ["one word", () => { process.env.STUB_ANSWER = "banner"; }, "the answer is not a name"],
    ["too long", () => { process.env.STUB_ANSWER = "a".repeat(30) + "-" + "b".repeat(15); }, "the answer is not a name"],
    ["exit", () => { process.env.STUB_MODE = "fail"; }, "exit 3"],
    ["timeout", () => { process.env.STUB_MODE = "hang"; process.env.DS_SQUAD_NAME_S = "1"; }, "timeout after 1 s"],
    ["no pick", (f) => { f.s.db.run("DELETE FROM config WHERE file = 'roles.conf' AND key = 'studio'"); }, "no pick"],
    ["no config dir", (f) => { f.configDir.code = 1; f.configDir.out = ""; }, "no config dir"],
  ];
  for (const [name, set, why] of cases) {
    const f = fixture();
    set(f);
    const r = await f.run({ framing: BRIEF });
    expect({ name, topic: r.topic, named_by: r.named_by }).toEqual({ name, topic: "banner-hour-after", named_by: "fallback" });
    expect({ name, why: String(r.name_why) }).toEqual({ name, why: expect.stringContaining(why) });
    expect(f.wish("banner-hour-after")).toMatchObject({ want: "running" });
  }
});

test("codex and muse picks build their one-shot argv; codex's answer is read from its answer file", async () => {
  const f = fixture();
  f.roster("codex  gpt-5.4  ondemand");
  const r = await f.run({ framing: BRIEF });
  expect(r).toMatchObject({ topic: "banner-timeout-fix", named_by: "model", agent: "codex" });
  const a = f.argv()!;
  expect(a.slice(0, 2)).toEqual(["codex", "exec"]);
  expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
  const cwd = "/tmp/empty";
  const codex = oneShotArgv("codex", { model: "m", effort: "low", prompt: "P", cwd })!;
  expect(codex).toEqual({ out: `${cwd}/.answer`, argv: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
    "--model", "m", "--config", "model_reasoning_effort=low", "--output-last-message", `${cwd}/.answer`, "P"] });
  const muse = oneShotArgv("muse", { model: "m", effort: "low", prompt: "P", cwd })!;
  expect(muse).toEqual({ out: null, argv: ["muse", "exec", "--model", "m", "--workspace", cwd, "--reasoning-effort", "low",
    "--max-model-steps", "1", "--disable-shell", "--disable-write", "--disable-web-tools", "--disable-request-user-input", "P"] });
  const claude = oneShotArgv("claude", { model: "m", prompt: "P", cwd })!;
  expect(claude.argv).toEqual(["claude", "-p", "--model", "m", "--setting-sources", "user", "--tools", "", "--strict-mcp-config",
    "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", "P"]);
  expect(oneShotArgv("gemini", { model: "m", prompt: "P", cwd })).toBeNull();
});

test("a name already taken by a squad row, a pending wish or another open squad-start gets -2", async () => {
  for (const take of ["row", "wish", "start"] as const) {
    const f = fixture();
    if (take === "row") f.s.upsert("squads", { project: "realp", topic: "banner-timeout-fix" }, { status: "closed", observed_at: T, updated_at: T });
    if (take === "wish") f.s.want("squad", "realp/banner-timeout-fix", "running", { payload: { repo: "realp" }, by: "test" });
    if (take === "start") f.file({ framing: "another brief", slug: "banner-timeout-fix" });
    expect({ take, topic: (await f.run({ framing: BRIEF })).topic }).toEqual({ take, topic: "banner-timeout-fix-2" });
  }
});

test("the operator's slug skips the call; the wish carries framing, type, autonomy, backend and start", async () => {
  const f = fixture();
  expect(await f.run({ framing: BRIEF, slug: "my-slug", type: "testing", autonomy: "lfg", backend: "orca", start: "investigate" }))
    .toMatchObject({ ok: true, topic: "my-slug", named_by: "operator", agent: null });
  expect(f.argv()).toBeNull();
  expect(f.wish("my-slug")!.payload).toMatchObject({ framing: BRIEF, type: "testing", autonomy: "lfg", backend: "orca", start: "investigate", repo: "realp" });
  // auto (the board sends no start) writes none.
  await f.run({ framing: "second brief", slug: "no-start" });
  expect(f.wish("no-start")!.payload).not.toHaveProperty("start");
  // A taken operator slug fails the request (the board refuses it first).
  expect(await f.run({ framing: "third brief", slug: "my-slug" })).toEqual({ ok: false, error: "squad my-slug already exists in realp" });
});

test("the Studio's handle is the wish's from; with no Studio there is none", async () => {
  const f = fixture();
  await f.run({ framing: BRIEF, slug: "no-studio" });
  expect(f.wish("no-studio")!.payload).not.toHaveProperty("from");
  f.s.upsert("members", { project: "realp", squad: "_studio", role: "studio" }, { handle: "term_studio1", wt: "/wt/studio", observed_at: T, updated_at: T });
  await f.run({ framing: "another", slug: "with-studio" });
  expect(f.wish("with-studio")!.payload.from).toBe("term_studio1");
});

test("an image gone from chat-files/_start fails the request, naming it; a replay of a done request does nothing", async () => {
  const f = fixture();
  const name = "0123456789abcdef.png";
  expect(await f.run({ framing: BRIEF, slug: "img", files: [name] })).toEqual({ ok: false, error: `image ${name} is gone — attach it again` });
  expect(f.wish("img")).toBeNull();
  const id = f.file({ framing: "ok", slug: "once" });
  const a = f.action(id);
  await squadStart.exec(a, f.x());
  expect(await squadStart.exec(a, f.x())).toEqual({ done: true, result: "already done" });
  expect(readFileSync(join(f.s.root, "realp", "framings", `board-start-${id}.md`), "utf8")).toBe("ok");
});

test("markdown-file-upload-support U1 (D7): a gone .md fails the strict start with `file <name> is gone`", async () => {
  const f = fixture();
  const name = "0123456789abcdef-spec.md";
  expect(await f.run({ framing: BRIEF, slug: "md", files: [name] })).toEqual({ ok: false, error: `file ${name} is gone — attach it again` });
  expect(f.wish("md")).toBeNull();
});

test("squad-start is a background kind: one tick dispatches it, the drain finishes the request", async () => {
  expect(BACKGROUND_KINDS.has("squad-start")).toBe(true);
  const f = fixture();
  const id = f.file({ framing: BRIEF });
  const act = new LoopActuator({ fulfillers: [squadStart as any], orca: new FakeOrca() as any });
  const loop = new Loop(f.s, { observers: [], reconcilers: [squadStart as any] }, act, { projects: () => ["realp"] });
  loop.boot(T);
  await loop.tick(T);
  await act.drain();
  const r = f.s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  expect(r.done_at).not.toBeNull();
  expect(JSON.parse(String(r.result))).toMatchObject({ ok: true, named_by: expect.stringMatching(/^(model|fallback)$/) });
});

test("names: the answer's one line only, the fallback skips stop words, -2 -3 past taken ones", () => {
  expect(parseName("`Banner-Fix`.")).toBe("banner-fix");
  expect(parseName("banner-fix\nmore")).toBeNull();
  expect(parseName("rm -rf /")).toBeNull();
  expect(fallbackName("Why does the banner stay an hour?")).toBe("banner-hour");
  expect(fallbackName("the of and")).toBe("squad");
  expect(freeName("x-y", new Set(["x-y", "x-y-2"]))).toBe("x-y-3");
});
