// orch-rows.test.ts — U276: on a loop root the role-facing message ops are loop.db rows end to end. A Builder's
// `orch.sh ask` (a real subprocess in a git dir that is the Builder member's worktree) writes one needs-reply row
// to its Lead and blocks; the Lead's `ds msg reply` writes the reply row linked to it; the ask prints the answer and
// acks it, so each row is read once. A `watch.sh --worktree` tick then lists a row from loop.db with its ACK-ID and
// the next tick's --ack reads it. A backend that fails every call proves none of this goes through an Orca inbox.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open, type Row } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { sendMessage } from "../../bin/loop/messages/messages.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const RUN = "run_fixture01";
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });

function setup() {
  const base = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || "/tmp", "zzorchrows-"));
  temps.push(base);
  const state = join(base, "state"), wt = join(base, "wt"), log = join(base, "backend.log"), backend = join(base, "backend.sh");
  cpSync(FIXTURE, state, { recursive: true });
  writeFileSync(join(state, ".loop-migrated"), "");
  Bun.spawnSync(["git", "init", "-q", wt]);
  writeFileSync(backend, `#!/usr/bin/env bash\necho "$*" >> '${log}'\necho "fake backend: no Orca here" >&2\nexit 1\n`);
  chmodSync(backend, 0o755);
  writeFileSync(log, "");
  const s = open(state);
  importJson(s);
  const builder = s.db.query("SELECT wt FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder'").get() as Row;
  const mine = `0a1b2c3d-0000-4000-8000-00000000d3a0::${realpathSync(wt)}`;
  s.db.run("UPDATE members SET wt = ? WHERE wt = ?", [mine, String(builder.wt)]);
  s.close();
  const env = { ...process.env, DS_STATE_ROOT: state, BACKEND: backend, DS_ASK_WAIT_S: "30", DS_INSTR_SEEN: join(base, "seen"), PWD: wt };
  delete env.DS_LOOP_CHILD;                                  // a loop child never takes the rows path
  return { state, wt, log, mine, env };
}

const rows = (state: string) => { const s = open(state); try { return s.db.query("SELECT * FROM messages ORDER BY id").all() as Row[]; } finally { s.close(); } };

test("a Builder's orch.sh ask reaches its Lead as a row and the Lead's ds msg reply comes back linked; each row is read once; no Orca call", async () => {
  const { state, wt, log, mine, env } = setup();
  const ask = Bun.spawn([join(ROOT, "bin", "role", "orch.sh"), "ask", RUN, "Which base branch?"], { cwd: wt, env, stdout: "pipe", stderr: "pipe" });
  let q: Row | undefined;
  for (let i = 0; i < 100 && !q; i++) { await Bun.sleep(100); q = rows(state)[0]; }
  expect(q).toMatchObject({ project: "fx", squad: "demo", to_role: "lead", from_role: "builder", from_member: mine, needs_reply: 1, body: "Which base branch?", read_at: null });

  const rep = Bun.spawnSync([join(ROOT, "bin", "ds"), "msg", "reply", String(q!.id), "loop-v1", "--as", "demo/lead", "--project", "fx"], { env: { ...env, PWD: ROOT }, cwd: ROOT });
  expect(rep.exitCode).toBe(0);
  expect(await ask.exited).toBe(0);
  expect(await new Response(ask.stdout).text()).toContain("loop-v1");

  const [m, r] = rows(state);
  expect(rows(state)).toHaveLength(2);
  expect(m).toMatchObject({ id: q!.id, replied_at: expect.any(Number), read_at: expect.any(Number) });
  expect(r).toMatchObject({ kind: "reply", reply_to: q!.id, to_role: "builder", from_role: "lead", body: "loop-v1", read_at: expect.any(Number) });
  const s = open(state);
  try {
    const ev = (kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ?").all(kind) as Row[]).map((e) => JSON.parse(String(e.payload)));
    expect(ev("message_replied")).toEqual([{ id: q!.id, reply: r.id }]);         // the Lead read the question by answering it
    expect(ev("message_read").flatMap((e) => e.ids)).toEqual([r.id]);            // the ask read the reply, once
  } finally { s.close(); }
  expect(readFileSync(log, "utf8")).toBe("");
}, 60_000);

test("orch.sh send <run> is a row to the Lead; orch.sh reply <row id> answers one; an unanswered ask exits 5 with its row kept", () => {
  const { state, wt, log, mine, env } = setup();
  const orch = (...a: string[]) => Bun.spawnSync([join(ROOT, "bin", "role", "orch.sh"), ...a], { cwd: wt, env: { ...env, DS_ASK_WAIT_S: "1" } });
  const sent = orch("send", RUN, "worker_done", "U1 done; PR #7");
  expect(sent.exitCode).toBe(0);
  expect(JSON.parse(sent.stdout.toString())).toMatchObject({ created: true, to: "demo/lead" });
  expect(rows(state)[0]).toMatchObject({ to_role: "lead", from_role: "builder", from_member: mine, subject: "worker_done", body: "U1 done; PR #7" });

  const s = open(state);
  const q = sendMessage(s, { to: { project: "fx", squad: "demo", role: "builder", suffix: "u1-spike-loop-as-coordinator" }, from: { project: "fx", squad: "demo", role: "lead", suffix: "", member: null }, subject: "which test?", body: "which test covers it?", needsReply: true }).message.id;
  s.close();
  const rep = orch("reply", String(q), RUN, "orch-rows");
  expect(rep.exitCode).toBe(0);
  expect(JSON.parse(rep.stdout.toString())).toMatchObject({ created: true, reply_to: q });
  expect(rows(state).find((r) => r.reply_to === q)).toMatchObject({ kind: "reply", to_role: "lead", from_role: "builder", body: "orch-rows" });

  const ask = orch("ask", RUN, "Nobody answers this?");
  expect(ask.exitCode).toBe(5);
  expect(ask.stdout.toString()).toContain("no reply to message");
  expect(rows(state).find((r) => r.body === "Nobody answers this?")).toMatchObject({ needs_reply: 1, to_role: "lead" });
  expect(readFileSync(log, "utf8")).toBe("");
}, 60_000);

test("a watch.sh --worktree tick lists the worktree's row from loop.db with an ACK-ID; --ack reads it; no Orca inbox", async () => {
  const { state, wt, log, env } = setup();
  const s = open(state);
  const id = sendMessage(s, { to: { project: "fx", squad: "demo", role: "builder", suffix: "u1-spike-loop-as-coordinator" }, from: { project: "fx", squad: "demo", role: "lead", suffix: "", member: null }, subject: "rebase", body: "main moved; rebase before the PR" }).message.id;
  s.close();
  const watch = (...a: string[]) => Bun.spawnSync([join(ROOT, "bin", "lib", "watch.sh"), "--worktree", ...a], { cwd: wt, env });
  const one = watch("1000");
  const out = one.stdout.toString();
  expect(one.exitCode).toBe(0);
  expect(out).toContain("worktree messages (loop.db)");
  expect(out).toContain("main moved; rebase before the PR");
  expect(out).toContain(`ACK-ID: msg:${id}`);
  expect(rows(state)[0].read_at).toBeNull();
  const two = watch("--ack", `msg:${id}`, "200");
  expect(two.exitCode).toBe(0);
  expect(two.stdout.toString()).toContain("(none — timeout; do a check-in and re-arm)");
  expect(rows(state)[0].read_at).toEqual(expect.any(Number));
  expect(readFileSync(log, "utf8")).not.toMatch(/inbox/);
}, 60_000);

// No role doc or role-facing script reads messages through `orca orchestration check`: only the backend adapter
// (bin/backend/) speaks Orca's inbox verbs, and the loop is its only caller for a Run's mail on a loop root.
test("no role doc or script reads messages through orca orchestration check", () => {
  const places = ["AGENTS.md", "roles", "conventions", "studio", "skills", ".claude/commands", "bin/role", "bin/lib", "bin/hooks", "bin/commands", "bin/loop"];
  const g = Bun.spawnSync(["grep", "-rlE", "orchestration check", ...places], { cwd: ROOT });
  expect(g.stdout.toString().trim()).toBe("");
});
