// trial-cli.test.ts — orca-backend-alternatives U16a: `ds trial snapshot|events`, the record helper of a backend
// trial (docs/backends/trial-orca-lite.md). A temp state root, a stub Orca adapter (ORCA_ADAPTER) and one process
// named `claude` started in a member's folder; nothing reads the host's loop, Orca or state.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";

const ROOT = join(import.meta.dir, "..", "..");
const procs: { kill: () => void }[] = [];
afterEach(() => { for (const p of procs.splice(0)) p.kill(); });

async function rig() {
  const base = realpathSync(tempRoot("trial-cli-")), root = join(base, "state");
  mkdirSync(root);
  const lead = join(base, "ws", "lead"), builder = join(base, "ws", "b1");
  for (const d of [lead, builder]) mkdirSync(d, { recursive: true });
  const s = open(root); onTestEnd(() => s.close());
  s.db.run("INSERT INTO squads (project, topic, status, backend, worktree_provider, observed_at, updated_at) VALUES ('fx', 'onlite', 'running', 'orca-lite', 'orca', 1, 1)");
  const member = (role: string, suffix: string, path: string, gen: string, status = "running") =>
    s.db.run("INSERT INTO members (project, squad, role, suffix, agent, wt, status, gen, observed_at, updated_at) VALUES ('fx', 'onlite', ?, ?, 'claude', ?, ?, ?, 1, 1)", [role, suffix, `local::${path}`, status, gen]);
  member("lead", "", lead, "g-lead");
  member("builder", "u1", builder, "g-b1");
  for (const [p, role, id, parent, at] of [[lead, "lead", "R::lead", null, 1], [builder, "builder-u1", "R::b1", lead, 2]] as const)
    s.db.run("INSERT INTO worktrees (host, path, project, name, squad, role, provider, orca_id, parent_path, branch, created_at) VALUES ('local', ?, 'fx', ?, 'onlite', ?, 'orca', ?, ?, ?, ?)", [p, role, role, id, parent, `br-${role}`, at]);
  s.db.run("INSERT INTO orca_calls (retry_id, key, op, project, squad, member, at, state) VALUES ('r1', 'k1', 'terminal.create', 'fx', 'onlite', 'm', 1, 'completed'), ('r2', 'k2', 'terminal.create', 'fx', 'onlite', 'm', 2, 'failed')");
  const ev = (kind: string, at: number, wt: string | null, squad = "onlite", project: string | null = "fx") =>
    s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?)", [at, project, squad, wt, kind, JSON.stringify({ k: kind })]);
  ev("member_started", 100, `local::${builder}`);
  ev("action_done", 101, `local::${builder}`);         // not a trial kind
  ev("member_started", 102, `local::${lead}`, "other");  // another squad
  ev("loop_restart", 103, null, null as unknown as string, null);
  ev("member_closed", 200, `local::${builder}`);
  mkdirSync(join(root, "loop"), { recursive: true });
  writeFileSync(join(root, "loop", "orca-spawns.json"), JSON.stringify({ tick: 7, at: 1800000000, total: 3, top: [{ verb: "terminal list", n: 2 }] }));
  // The stub adapter: Orca's view of each path, with the nesting.
  const adapter = join(base, "orca-adapter.sh");
  writeFileSync(adapter, `#!/bin/sh
[ "$1" = wt-show ] || exit 2
case "$2" in
  path:${lead}) echo '{"id":"R::lead","parentWorktreeId":null,"childWorktreeIds":["R::b1"]}';;
  path:${builder}) echo '{"id":"R::b1","parentWorktreeId":"R::lead","childWorktreeIds":[]}';;
  *) exit 3;;
esac
`, { mode: 0o755 });
  const agent = Bun.spawn(["bash", "-c", "exec -a claude sleep 30"], { cwd: builder });
  procs.push(agent);
  const ds = async (...args: string[]) => {
    const p = Bun.spawn([join(ROOT, "bin", "ds"), "trial", ...args], { env: { ...process.env, DS_STATE_ROOT: root, DS_LOOP_PID: String(process.pid), ORCA_ADAPTER: adapter }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    return { code: await p.exited, out, err };
  };
  // Wait for the exec so the walk sees argv[0] `claude`.
  for (let i = 0; i < 50; i++) { try { if ((await Bun.file(`/proc/${agent.pid}/cmdline`).text()).startsWith("claude")) break; } catch { /* starting */ } await Bun.sleep(20); }
  return { ds, agent, lead, builder };
}

test("snapshot: members with gen and agent pids, worktree rows, Orca's nesting, loop memory, spawns, ledger", async () => {
  const { ds, agent, builder } = await rig();
  const r = await ds("snapshot", "fx", "onlite", "--step", "before restart", "--json");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.squad).toMatchObject({ backend: "orca-lite", worktree_provider: "orca", run_id: null });
  expect(j.loop.pid).toBe(process.pid);
  expect(j.loop.rss_mb).toBeGreaterThan(0);
  expect(j.spawns.total).toBe(3);
  expect(j.ledger).toEqual([{ op: "terminal.create", state: "completed", n: 1 }, { op: "terminal.create", state: "failed", n: 1 }]);
  const b = j.members.find((m: { member: string }) => m.member === "builder-u1");
  expect(b).toMatchObject({ gen: "g-b1", wt: `local::${builder}` });
  expect(b.pids.map((p: { pid: number }) => p.pid)).toEqual([agent.pid]);
  expect(j.members.find((m: { member: string }) => m.member === "lead").pids).toEqual([]);
  expect(j.worktrees.map((w: { orca_id: string }) => w.orca_id)).toEqual(["R::lead", "R::b1"]);
  expect(j.orca.find((o: { role: string }) => o.role === "lead").show.childWorktreeIds).toEqual(["R::b1"]);
  const t = await ds("snapshot", "fx", "onlite", "--step", "after");
  expect(t.out).toContain("### after · ");
  expect(t.out).toContain(`| builder-u1 | running | g-b1 | local::${builder} | ${agent.pid} (`);
  expect(t.out).toContain("- lead `R::lead`: parentWorktreeId `none`, childWorktreeIds [\"R::b1\"]");
  expect(t.out).toContain("terminal.create failed ×1");
  // --no-orca reads nothing from Orca; an unknown squad is refused.
  expect(JSON.parse((await ds("snapshot", "fx", "onlite", "--no-orca", "--json")).out).orca).toBeNull();
  expect((await ds("snapshot", "fx", "nope")).code).toBe(1);
});

test("events: the squad's trial kinds and the watchdog's restarts, by id, from --since", async () => {
  const { ds } = await rig();
  const all = (await ds("events", "fx", "onlite")).out.trim().split("\n");
  expect(all.map((l) => l.split(" ")[2])).toEqual(["member_started", "loop_restart", "member_closed"]);
  expect(all[0]).toMatch(/^#\d+ 1970-01-01T00:01:40Z member_started builder-u1 /);
  const late = JSON.parse((await ds("events", "fx", "onlite", "--since", "150", "--json")).out);
  expect(late.map((e: { kind: string }) => e.kind)).toEqual(["member_closed"]);
  expect((await ds("events", "fx", "onlite", "--since", "soon")).code).toBe(2);
});
