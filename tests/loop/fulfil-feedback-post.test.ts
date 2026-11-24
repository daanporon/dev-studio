// fulfil-feedback-post.test.ts — ds-feedback-github-issues U3: the feedback fulfiller posts a reviewed draft
// to GitHub through a stub `gh` (DS_GH; nothing reaches GitHub), runs the real leak guard on the final text
// with a temp word list (DS_LEAK_WORDS), and edits, dismisses and restores drafts and notes.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { feedback } from "../../bin/loop/fulfil/feedback.ts";
import { feedbackOn, feedbackProjects, feedbackRepo, finalText } from "../../bin/loop/feedback/post.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const ENV = ["DS_GH", "DS_LEAK_WORDS", "DS_LIMIT_FEEDBACK_REPO", "DS_LIMIT_FEEDBACK", "DS_FEEDBACK_ORIGIN", "STUB_DIR", "DS_STATE_ROOT"];
const saved: Record<string, string | undefined> = {};
const base = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzfb-"));
const temps: string[] = [], stores: Store[] = [];
afterAll(() => rmSync(base, { recursive: true, force: true }));

// The stub gh: logs each call's argv (one line) to calls, and answers like GitHub's REST API.
//   find (GET issues / comments): the newest posted file whose body holds the jq filter's ds-key, else nothing
//   POST issues / comments: the input kept as posted-<n>.json; rate-limited while $STUB_DIR/limited exists
//   rate_limit: the core bucket used up, reset at $STUB_DIR/reset
const STUB = `#!/usr/bin/env bash
set -u
echo "$*" >> "$STUB_DIR/calls"
[ "$1" = api ] || exit 9; shift
if [ "$1" = rate_limit ]; then printf '{"limit":5000,"remaining":0,"reset":%s}' "$(cat "$STUB_DIR/reset")"; exit 0; fi
if [ "$1" = -X ]; then
  path="$3"; input=""; while [ $# -gt 0 ]; do [ "$1" = --input ] && input="$2"; shift; done
  if [ -e "$STUB_DIR/limited" ]; then echo "gh: API rate limit exceeded for user ID 1. (HTTP 403)" >&2; exit 1; fi
  if [ -e "$STUB_DIR/broken" ]; then echo "gh: HTTP 502: Bad Gateway" >&2; exit 1; fi
  n=$(( $(ls "$STUB_DIR" | grep -c '^posted-') + 1 )); cp "$input" "$STUB_DIR/posted-$n.json"
  case "$path" in
    */comments) issue="\${path%/comments}"; issue="\${issue##*/}"; printf '{"id":%s,"html_url":"https://github.com/o/r/issues/%s#issuecomment-%s"}' "$((900+n))" "$issue" "$((900+n))" ;;
    *) printf '{"number":%s,"html_url":"https://github.com/o/r/issues/%s"}' "$((40+n))" "$((40+n))" ;;
  esac
  exit 0
fi
key=$(grep -o 'ds-key:[^"\\\\]*' <<< "$*" | head -1)
[ -n "$key" ] || { echo "stub gh: find names no ds-key" >&2; exit 8; }
for f in $(ls -r "$STUB_DIR"/posted-*.json 2>/dev/null); do
  grep -qF "$key" "$f" || continue
  n="\${f##*posted-}"; n="\${n%.json}"
  case "$1" in
    */comments*) issue="\${1%%/comments*}"; issue="\${issue##*/}"; printf '{"number":null,"html_url":"https://github.com/o/r/issues/%s#issuecomment-%s"}' "$issue" "$((900+n))" ;;
    *) printf '{"number":%s,"html_url":"https://github.com/o/r/issues/%s"}' "$((40+n))" "$((40+n))" ;;
  esac
  exit 0
done
exit 0
`;

let stub = "";
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  stub = mkdtempSync(join(base, "gh-"));
  writeFileSync(join(stub, "gh"), STUB); chmodSync(join(stub, "gh"), 0o755);
  writeFileSync(join(stub, "reset"), String(T + 3600));
  writeFileSync(join(stub, "words"), "zebrafoxtrot\n");
  process.env.STUB_DIR = stub;
  process.env.DS_GH = join(stub, "gh");
  process.env.DS_LEAK_WORDS = join(stub, "words");
  process.env.DS_LIMIT_FEEDBACK = "on";
  process.env.DS_LIMIT_FEEDBACK_REPO = "o/r";
  delete process.env.DS_FEEDBACK_ORIGIN;
});
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function rig() {
  const d = mkdtempSync(join(base, "state-"));
  temps.push(d);
  const s = open(d);
  stores.push(s);
  const f = feedback();
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [f] });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at = T) => { await loop.tick(at); await act.drain(); };
  return { s, tick };
}
let n = 0;
function draft(s: Store, set: Row = {}): number {
  const key = `fd:${(++n).toString(16).padStart(8, "0")}`;
  s.upsert("feedback_drafts", { key }, { kind: "issue", title: "Retry backoff lost on restart", body: "The backoff lives in context.\n\nEvidence: 2 notes.",
    area: "loop", label: "bug", state: "review", created_at: T - 600, updated_at: T - 600, ...set });
  return Number((s.get("feedback_drafts", { key }) as Row).id);
}
function note(s: Store, draftId: number | null, state = "drafted"): number {
  const key = `fb:${(++n).toString(16).padStart(16, "0")}`;
  s.upsert("feedback_notes", { key }, { project: "fx", text: "the raw note text", source: "cli", state, draft_id: draftId, at: T - 900, updated_at: T - 900 });
  return Number((s.get("feedback_notes", { key }) as Row).id);
}
const file = (s: Store, kind: string, payload: Record<string, unknown>) => Number(s.requestAny(kind, payload, { by: "board" }).row.id);
const request = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) };
};
const d = (s: Store, id: number) => s.get("feedback_drafts", { id }) as Row;
const noteState = (s: Store, id: number) => (s.get("feedback_notes", { id }) as Row).state;
const calls = () => (existsSync(join(stub, "calls")) ? readFileSync(join(stub, "calls"), "utf8").trim().split("\n").filter(Boolean) : []);
const posts = () => calls().filter((c) => c.includes("-X POST"));
const posted = (i: number) => JSON.parse(readFileSync(join(stub, `posted-${i}.json`), "utf8"));
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[]).map((r) => JSON.parse(String(r.payload)));

describe("feedback-post", () => {
  test("posts the issue with the marker and key, files the draft and its drafted notes", async () => {
    const { s, tick } = rig();
    const id = draft(s), a = note(s, id), b = note(s, id), other = note(s, null, "new");
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req)).toMatchObject({ done: true, ok: true, issue: 41, url: "https://github.com/o/r/issues/41", found: false });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toContain("repos/o/r/issues");
    const p = posted(1);
    expect(p.title).toBe("Retry backoff lost on restart");
    expect(p.body).toContain("<!-- ds-feedback v1 area:loop kind:bug -->");
    expect(p.body).toContain(`<!-- ds-key:${d(s, id).key} -->`);
    expect(p.body).not.toContain("the raw note text");
    expect(d(s, id)).toMatchObject({ state: "filed", repo: "o/r", issue: 41, url: "https://github.com/o/r/issues/41", leak: "ok" });
    expect([noteState(s, a), noteState(s, b), noteState(s, other)]).toEqual(["filed", "filed", "new"]);
    expect(events(s, "feedback_filed")).toEqual([{ draft: id, repo: "o/r", issue: 41, url: "https://github.com/o/r/issues/41", notes: [a, b], found: false }]);
    // The same post again: already filed, no call.
    const again = file(s, "feedback-post", { draft: id });
    await tick(T + 10);
    expect(request(s, again)).toMatchObject({ ok: true, already: true, issue: 41 });
    expect(posts()).toHaveLength(1);
  });

  test("a post replayed after a crash finds the issue by its key and creates no second one", async () => {
    const { s, tick } = rig();
    const id = draft(s), a = note(s, id);
    await tick(); // boot tick, nothing open
    file(s, "feedback-post", { draft: id });
    await tick(T + 1);
    expect(posts()).toHaveLength(1);
    // The crash: the issue was made but the loop died before it wrote filed (the draft still reads posting).
    s.upsert("feedback_drafts", { id }, { state: "posting", issue: null, url: null });
    s.upsert("feedback_notes", { id: a }, { state: "drafted" });
    const replay = file(s, "feedback-post", { draft: id });
    await tick(T + 60);
    expect(request(s, replay)).toMatchObject({ ok: true, issue: 41, found: true });
    expect(posts()).toHaveLength(1);
    expect(calls().filter((c) => c.includes("issues?state=all"))).toHaveLength(2);
    expect(d(s, id)).toMatchObject({ state: "filed", issue: 41 });
    expect(noteState(s, a)).toBe("filed");
    // Another draft's find does not take the first draft's issue: it creates its own.
    const other = draft(s);
    const second = file(s, "feedback-post", { draft: other });
    await tick(T + 120);
    expect(request(s, second)).toMatchObject({ ok: true, issue: 42, found: false });
    expect(posts()).toHaveLength(2);
  });

  test("a replay that now fails the leak check puts the posting draft back in review", async () => {
    const { s, tick } = rig();
    const id = draft(s, { state: "posting", title: "About zebrafoxtrot" });
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: false, error: expect.stringMatching(/^leak check: a word of the host-local list/) });
    expect(calls()).toEqual([]);
    expect(d(s, id)).toMatchObject({ state: "review", leak: "blocked" });
  });

  test("a leak hit marks the draft blocked and refuses with no gh call", async () => {
    const { s, tick } = rig();
    const id = draft(s, { body: "Seen on the zebrafoxtrot host.\n" });
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    const r = request(s, req);
    expect(r).toMatchObject({ done: true, ok: false });
    expect(r.error).toMatch(/^leak check: a word of the host-local list/);
    expect(r.error).not.toContain("zebrafoxtrot");
    expect(r.error).not.toContain(stub);
    expect(calls()).toEqual([]);
    expect(d(s, id)).toMatchObject({ state: "review", leak: "blocked" });
    expect(String(d(s, id).leak_why)).not.toContain("zebrafoxtrot");
  });

  test("a missing word list is a hit too", async () => {
    const { s, tick } = rig();
    process.env.DS_LEAK_WORDS = join(stub, "no-such-list");
    const id = draft(s);
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: false });
    expect(calls()).toEqual([]);
    expect(d(s, id).leak).toBe("blocked");
  });

  test("a draft holding a note of a project that is off now is refused with no gh call", async () => {
    const { s, tick } = rig();
    delete process.env.DS_LIMIT_FEEDBACK;
    s.upsert("config", { project: "", file: "limits.conf", key: "feedback" }, { value: "off", observed_at: T });
    s.upsert("config", { project: "fx", file: "limits.conf", key: "feedback" }, { value: "on", observed_at: T });
    s.upsert("config", { project: "other", file: "limits.conf", key: "feedback" }, { value: "on", observed_at: T });
    const id = draft(s);
    note(s, id);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "feedback" }, { value: "off", observed_at: T + 1 });
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: false, error: expect.stringContaining("project fx has Feedback off") });
    expect(calls()).toEqual([]);
    expect(d(s, id).state).toBe("review");
  });

  test("Feedback off refuses and leaves the draft in review", async () => {
    const { s, tick } = rig();
    process.env.DS_LIMIT_FEEDBACK = "off";
    const id = draft(s);
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: false, error: expect.stringContaining("Feedback is off") });
    expect(calls()).toEqual([]);
    expect(d(s, id).state).toBe("review");
  });

  test("feedbackOn: per project: the env var, else the project's row, else the default row", () => {
    const { s } = rig();
    delete process.env.DS_LIMIT_FEEDBACK;
    delete process.env.DS_LIMIT_FEEDBACK_REPO;
    process.env.DS_FEEDBACK_ORIGIN = "https://github.com/o/n.git";
    const row = (project: string, value: string) => s.upsert("config", { project, file: "limits.conf", key: "feedback" }, { value, observed_at: T });
    expect(feedbackOn(s, "a")).toBe(false);
    expect(feedbackRepo(s)).toBeNull();
    row("", "off");
    row("a", "on");
    expect(feedbackOn(s, "a")).toBe(true);
    expect(feedbackOn(s, "b")).toBe(false);
    expect(feedbackProjects(s)).toEqual(["a"]);
    expect(feedbackRepo(s)).toBe("o/n");
    row("a", "off");
    expect(feedbackProjects(s)).toEqual([]);
    expect(feedbackRepo(s)).toBeNull();
    row("", "on"); // the default row: every project without its own row, and notes with no project
    expect(feedbackOn(s, "b")).toBe(true);
    expect(feedbackOn(s, "a")).toBe(false);
    expect(feedbackProjects(s)).toContain("");
    process.env.DS_LIMIT_FEEDBACK = "off";
    expect(feedbackOn(s, "b")).toBe(false);
    process.env.DS_LIMIT_FEEDBACK = "on";
    expect(feedbackOn(s, "a")).toBe(true);
    expect(feedbackProjects(s)).toContain("a");
  });

  test("feedback_repo: on takes the checkout's origin, an override beats it, a non-GitHub origin gives null", () => {
    const { s } = rig();
    delete process.env.DS_LIMIT_FEEDBACK_REPO;
    const row = (project: string, value: string) => s.upsert("config", { project, file: "limits.conf", key: "feedback_repo" }, { value, observed_at: T });
    process.env.DS_FEEDBACK_ORIGIN = "https://github.com/o/n.git";
    expect(feedbackRepo(s)).toBe("o/n");
    process.env.DS_FEEDBACK_ORIGIN = "git@github.com:o/n2.git";
    expect(feedbackRepo(s)).toBe("o/n2");
    process.env.DS_FEEDBACK_ORIGIN = "https://gitlab.com/o/n.git";
    expect(feedbackRepo(s)).toBeNull();
    process.env.DS_FEEDBACK_ORIGIN = "https://github.com/o/n.git";
    row("", "-");
    row("fx", "own/proj");
    expect(feedbackRepo(s)).toBe("own/proj");
    row("", "own/default");
    expect(feedbackRepo(s)).toBe("own/default");
    process.env.DS_LIMIT_FEEDBACK_REPO = "not a repo";
    expect(feedbackRepo(s)).toBeNull();
  });

  test("a rate-limited post waits for the reset without spending a try", async () => {
    const { s, tick } = rig();
    writeFileSync(join(stub, "limited"), "");
    const id = draft(s);
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req).done).toBe(false);
    expect(d(s, id).state).toBe("posting");
    const ep = s.db.query("SELECT state, next_at, action FROM episodes WHERE subject = ?").get(`req:${req}`) as Row;
    expect(ep.state).toBe("pending");
    expect(Number(ep.next_at)).toBe(T + 3600 + 30);
    expect(JSON.parse(String(ep.action)).wait).toContain("rate limited");
    // Before the reset nothing is sent; after it the post goes out once.
    await tick(T + 1800);
    expect(calls().filter((c) => c.includes("-X POST"))).toHaveLength(1);
    rmSync(join(stub, "limited"));
    await tick(T + 3700);
    expect(request(s, req)).toMatchObject({ ok: true, issue: 41 });
    expect(d(s, id).state).toBe("filed");
  });

  test("an add-to draft comments on its target with the key line and no marker", async () => {
    const { s, tick } = rig();
    const id = draft(s, { kind: "add-to", title: null, target: 7, body: "One more case of the same thing." }), a = note(s, id);
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: true, issue: 7, url: "https://github.com/o/r/issues/7#issuecomment-901" });
    expect(posts()[0]).toContain("repos/o/r/issues/7/comments");
    const p = posted(1);
    expect(p.title).toBeUndefined();
    expect(p.body).toContain(`ds-key:${d(s, id).key}`);
    expect(p.body).not.toContain("ds-feedback v1");
    expect(d(s, id)).toMatchObject({ state: "filed", issue: 7 });
    expect(noteState(s, a)).toBe("filed");
  });

  test("feedback-add-to turns an issue draft into a comment on #N", async () => {
    const { s, tick } = rig();
    const id = draft(s);
    const req = file(s, "feedback-add-to", { draft: id, target: 12 });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: true, issue: 12 });
    expect(posts()[0]).toContain("repos/o/r/issues/12/comments");
    expect(d(s, id)).toMatchObject({ kind: "add-to", target: 12, state: "filed", issue: 12 });
    expect(events(s, "feedback_posting")).toEqual([{ draft: id, repo: "o/r", kind: "add-to", target: 12 }]);
  });

  test("another failure is a retry, and a post given up puts the draft back in review", async () => {
    const { s, tick } = rig();
    writeFileSync(join(stub, "broken"), "");
    const id = draft(s);
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req).done).toBe(false);
    for (let i = 1; i < 12 && !request(s, req).done; i++) await tick(T + i * 3600);
    expect(request(s, req)).toMatchObject({ done: true, ok: false });
    expect(d(s, id).state).toBe("review");
  });

  test("a draft that is not in review is refused", async () => {
    const { s, tick } = rig();
    const id = draft(s, { state: "dismissed" });
    const req = file(s, "feedback-post", { draft: id });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: false, error: expect.stringContaining("dismissed") });
    expect(calls()).toEqual([]);
  });
});

describe("feedback-edit", () => {
  test("stores the new text and checks it again", async () => {
    const { s, tick } = rig();
    const id = draft(s);
    const bad = file(s, "feedback-edit", { draft: id, body: "Now it names zebrafoxtrot." });
    await tick();
    expect(request(s, bad)).toMatchObject({ ok: true, leak: "blocked" });
    expect(d(s, id)).toMatchObject({ body: "Now it names zebrafoxtrot.", leak: "blocked", state: "review" });
    const good = file(s, "feedback-edit", { draft: id, title: "  A better title ", body: "Clean again." });
    await tick(T + 10);
    expect(request(s, good)).toMatchObject({ ok: true, leak: "ok" });
    expect(d(s, id)).toMatchObject({ title: "A better title", body: "Clean again.", leak: "ok", leak_why: null });
    expect(calls()).toEqual([]);
    const filedId = draft(s, { state: "filed", issue: 3 });
    const late = file(s, "feedback-edit", { draft: filedId, body: "x" });
    await tick(T + 20);
    expect(request(s, late)).toMatchObject({ ok: false, error: expect.stringContaining("filed") });
  });
});

describe("feedback-dismiss and feedback-restore", () => {
  test("a dismissed draft takes its drafted notes with it, with the reason", async () => {
    const { s, tick } = rig();
    const id = draft(s), a = note(s, id), filedBefore = note(s, id, "filed");
    const req = file(s, "feedback-dismiss", { draft: id, why: "not worth an issue" });
    await tick();
    expect(request(s, req)).toMatchObject({ ok: true, draft: id, notes: [a] });
    expect(d(s, id)).toMatchObject({ state: "dismissed", reason: "not worth an issue" });
    expect(s.get("feedback_notes", { id: a })).toMatchObject({ state: "dismissed", reason: "not worth an issue" });
    expect(noteState(s, filedBefore)).toBe("filed");
  });

  test("one note alone, and a filed note is refused", async () => {
    const { s, tick } = rig();
    const id = draft(s), a = note(s, id), b = note(s, id), f = note(s, id, "filed");
    const one = file(s, "feedback-dismiss", { note: a });
    const refused = file(s, "feedback-dismiss", { note: f, why: "x" });
    const both = file(s, "feedback-dismiss", { note: b, draft: id });
    await tick();
    expect(request(s, one)).toMatchObject({ ok: true, notes: [a] });
    expect(s.get("feedback_notes", { id: a })).toMatchObject({ state: "dismissed", reason: null });
    expect([noteState(s, b), d(s, id).state]).toEqual(["drafted", "review"]);
    expect(request(s, refused)).toMatchObject({ ok: false, error: expect.stringContaining("filed") });
    expect(noteState(s, f)).toBe("filed");
    expect(request(s, both)).toMatchObject({ ok: false, error: expect.stringContaining("one draft or one note") });
  });

  test("restore puts a dismissed note back to new and leaves its old draft dismissed", async () => {
    const { s, tick } = rig();
    const id = draft(s), a = note(s, id);
    file(s, "feedback-dismiss", { draft: id, why: "dup" });
    await tick();
    const req = file(s, "feedback-restore", { note: a });
    const notDismissed = file(s, "feedback-restore", { note: note(s, null, "new") });
    await tick(T + 10);
    expect(request(s, req)).toMatchObject({ ok: true, note: a });
    expect(s.get("feedback_notes", { id: a })).toMatchObject({ state: "new", reason: null, draft_id: null });
    expect(d(s, id).state).toBe("dismissed");
    expect(request(s, notDismissed)).toMatchObject({ ok: false, error: expect.stringContaining("not dismissed") });
    expect(events(s, "feedback_restored")).toEqual([{ note: a }]);
  });
});

describe("ds feedback dismiss|restore", () => {
  test("file the same requests from the shell", async () => {
    const root = mkdtempSync(join(base, "cli-"));
    mkdirSync(join(root, "state"));
    temps.push(root);
    const st = join(root, "state");
    const s = open(st);
    stores.push(s);
    const id = draft(s), a = note(s, id), gone = note(s, null, "dismissed");
    const ds = (...args: string[]) => Bun.spawnSync([join(ROOT, "bin", "ds"), ...args], { env: { ...process.env, DS_STATE_ROOT: st } });
    const one = ds("feedback", "dismiss", String(a), "--why", "seen before");
    expect(one.exitCode).toBe(0);
    expect(ds("feedback", "dismiss", String(id), "--draft").exitCode).toBe(0);
    expect(ds("feedback", "restore", `#${gone}`).exitCode).toBe(0);
    expect(ds("feedback", "restore", "999").exitCode).toBe(1);
    expect(ds("feedback", "restore", String(a), "--why", "x").exitCode).toBe(2);
    expect(ds("feedback", "dismiss", "abc").exitCode).toBe(2);
    const rows = (s.db.query("SELECT kind, payload, requested_by FROM requests ORDER BY id").all() as Row[]).map((r) => ({ kind: r.kind, by: r.requested_by, ...JSON.parse(String(r.payload)) }));
    expect(rows).toEqual([
      { kind: "feedback-dismiss", by: "ds", note: a, why: "seen before" },
      { kind: "feedback-dismiss", by: "ds", draft: id },
      { kind: "feedback-restore", by: "ds", note: gone },
    ]);
  });

  test("refuse a doomed request at once, with no request row", () => {
    const root = mkdtempSync(join(base, "cli-"));
    mkdirSync(join(root, "state"));
    temps.push(root);
    const st = join(root, "state");
    const s = open(st);
    stores.push(s);
    const filed = note(s, null, "filed"), fresh = note(s, null, "new"), posted = draft(s, { state: "filed" });
    const ds = (...args: string[]) => Bun.spawnSync([join(ROOT, "bin", "ds"), ...args], { env: { ...process.env, DS_STATE_ROOT: st }, stderr: "pipe" });
    const a = ds("feedback", "dismiss", String(filed));
    expect(a.exitCode).toBe(1);
    expect(a.stderr.toString()).toContain(`note ${filed} is filed`);
    const b = ds("feedback", "restore", String(fresh));
    expect(b.exitCode).toBe(1);
    expect(b.stderr.toString()).toContain(`note ${fresh} is new, not dismissed`);
    const c = ds("feedback", "dismiss", String(posted), "--draft");
    expect(c.exitCode).toBe(1);
    expect(c.stderr.toString()).toContain(`draft ${posted} is filed, not in review`);
    expect((s.db.query("SELECT COUNT(*) AS n FROM requests").get() as Row).n).toBe(0);
  });
});

test("finalText drops marker lines the body carried and adds one marker and key", () => {
  const t = finalText({ kind: "issue", key: "fd:1", title: " T ", body: "b\n<!-- ds-feedback v1 area:x kind:y -->\n<!-- ds-key:old -->\n", area: "Not A Word", label: "bug" });
  expect(t.title).toBe("T");
  expect(t.body).toBe("b\n\n<!-- ds-feedback v1 area:other kind:bug -->\n<!-- ds-key:fd:1 -->\n");
});
