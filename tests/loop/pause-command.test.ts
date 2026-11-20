import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./pause-fixture.ts";
import { projection } from "../../bin/loop/pause/pause.ts";

const repo = join(import.meta.dir, "../..");
async function command(root: string, args: string[], handle = "term_one") {
  const p = Bun.spawn(args, { env: { ...process.env, DS_STATE_ROOT: root, ORCA_TERMINAL_HANDLE: handle, BACKEND: "/nonexistent-backend" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
test("public pause/resume commands work with the loop down and enqueue no imperative backend requests", async () => {
  const f = fixture();
  const p = await command(f.root, [join(repo, "bin/ds"), "pause", "member", "p", "one", "builder", "task"]);
  expect(p.code).toBe(0); expect(JSON.parse(p.out).state).toBe("pausing");
  await f.tick(); f.checkpoint(); await f.tick();
  const r = await command(f.root, [join(repo, "bin/ds"), "resume", "member", "p", "one", "builder", "task"]);
  expect(r.code).toBe(0); expect(JSON.parse(r.out).state).toBe("resuming");
  expect(f.store.db.query("SELECT COUNT(*) n FROM requests").get()).toEqual({ n: 0 });
  expect(f.orca.started).toHaveLength(0); await f.tick(); await f.tick(); expect(f.orca.started).toHaveLength(1);
});

test("checkpoint helper writes useful journal content before acknowledgment, then pause closes the terminal", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick();
  const gen = String(projection(f.store, f.target).generation);
  const p = await command(f.root, [join(repo, "bin/role/pause-checkpoint.sh"), "p", "one", "builder", "task", gen,
    "Tests passed; unfinished local changes; chose cooperative closure; branch feature; PR #7 remote CI; continue from retained files", "--commands-finished"]);
  expect(p.code).toBe(0);
  const row = f.store.get("pause_members", f.target)!;
  expect(row.acknowledged_at).not.toBeNull();
  expect(readFileSync(String(row.checkpoint), "utf8")).toContain(`checkpoint ${gen}: Tests passed; unfinished local changes`);
  expect(f.orca.of("pause-close")).toHaveLength(0); await f.tick();
  expect(projection(f.store, f.target).state).toBe("paused");
});

test("failed journal write or foreign terminal refuses acknowledgment", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick();
  const gen = String(projection(f.store, f.target).generation), journalDir = join(f.root, "p", "journals");
  mkdirSync(join(f.root, "p"), { recursive: true }); writeFileSync(journalDir, "cannot be a directory");
  const args = [join(repo, "bin/role/pause-checkpoint.sh"), "p", "one", "builder", "task", gen, "unfinished work", "--commands-finished"];
  expect((await command(f.root, args)).code).not.toBe(0);
  expect(f.store.get("pause_members", f.target)?.acknowledged_at).toBeNull();
  rmSync(journalDir); expect((await command(f.root, args, "foreign")).code).not.toBe(0);
  await f.tick(); expect(f.orca.of("pause-close")).toHaveLength(0);
});

test("dependency wait command validates tracked references and shows remaining prerequisites", async () => {
  const f = fixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "dispatched", observed_at: 1, updated_at: 1 });
  const refs = JSON.stringify([{ kind: "unit", project: "p", squad: "one", slug: "before" }]);
  const p = await command(f.root, [join(repo, "bin/ds"), "pause", "member", "p", "one", "builder", "task", "--prerequisites", refs]);
  expect(p.code).toBe(0); expect(JSON.parse(p.out).sources[0].remaining).toEqual(["prerequisite unresolved: p/one/before"]);
  expect((await command(f.root, [join(repo, "bin/ds"), "resume", "member", "p", "one", "builder", "wrong"])).code).not.toBe(0);
});
