// host-drain.test.ts — side-loop-host U16 (issue #127): `ds host drain <name>` stops new starts on that host while
// the members it runs finish and may restart there; `ds host undrain <name>` takes it back.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { hostBrake } from "../../bin/loop/capacity/pick.ts";
import { placeSide } from "../../bin/loop/capacity/place.ts";
import { codeRev } from "../../bin/link/client.ts";
import { hostLine, listHosts } from "../../bin/link/host-keys.ts";
import { LINK_VERSION } from "../../bin/link/protocol.ts";
import { UP_MIGRATION } from "../../bin/link/replica.ts";
import { agentGone, builderOnSide, cleanup, HOST, member, rig, type Rig } from "./side-rig.ts";

afterEach(cleanup);

const ds = (r: Rig, ...args: string[]) => {
  const p = Bun.spawnSync([join(import.meta.dir, "..", "..", "bin/ds"), "host", ...args],
    { env: { ...process.env, DS_STATE_ROOT: r.s.root, DS_WHO: "op" }, stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const drainFlag = (r: Rig) => Number(r.s.get("hosts", { name: HOST })!.drain ?? 0);
const events = (r: Rig) => r.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'host_drain_set'").get() as { n: number };

test("drain and undrain set the flag, say how many members run on, and refuse a host that is not accepted", async () => {
  const r = await rig();
  await builderOnSide(r);
  expect(ds(r, "drain", HOST)).toMatchObject({ rc: 0, out: `host ${HOST} is draining: no new starts there, 1 members run on\n` });
  expect(drainFlag(r)).toBe(1);
  expect(hostLine(listHosts(r.s).find((h) => h.name === HOST)!)).toContain("draining");
  expect(ds(r, "drain", HOST).rc).toBe(0);
  expect(events(r).n).toBe(1);
  expect(ds(r, "undrain", HOST)).toMatchObject({ rc: 0, out: `host ${HOST} takes new starts again\n` });
  expect(drainFlag(r)).toBe(0);
  const none = ds(r, "drain", "nope");
  expect(none.rc).toBe(1);
  expect(none.err).toContain("no accepted host 'nope'");
}, 60_000);   // real git, a board server and a mounted page: slow on a loaded host

test("a draining host takes no new start; the member it runs restarts there", async () => {
  const r = await rig();
  const { m } = await builderOnSide(r);
  const who = (row: unknown) => ({ squad: r.sq, suffix: "u1", member: row }) as any;
  const fresh = { project: "fx", squad: r.sq, role: "builder", suffix: "u2", wt: null, host: HOST };
  // The side said hello with main's code, so placement takes it (place.ts "behind").
  r.s.upsert("hosts", { name: HOST }, { link_version: LINK_VERSION, up_migration: UP_MIGRATION, code_rev: codeRev(), last_seen_at: r.now() });
  r.s.upsert("observed_machine", { host: HOST }, { cores: 8, load1: 1, load5: 1, load15: 1, mem_total_kb: 32_000_000, mem_avail_kb: 24_000_000, swap_total_kb: 0,
    swap_free_kb: 0, psi_cpu_some: 0, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, disks: "[]", groups: "[]", cpu_busy_pct: 10, observed_at: r.now() });
  expect(placeSide(r.s, "builder", r.now())).toEqual({ host: HOST, skipped: [] });
  ds(r, "drain", HOST);
  expect(placeSide(r.s, "builder", r.now())).toEqual({ host: null, skipped: [`${HOST} draining`] });
  // A start already pinned there with no worktree waits; the member with its worktree there is not held.
  expect(hostBrake(r.s, "fx", who(fresh), r.now(), "builder")).toBe(`${HOST} is draining`);
  expect(hostBrake(r.s, "fx", who(member(r.s, Number(m.id))), r.now(), "builder")).toBeNull();
  // Its restart lands there again.
  const before = r.side.calls.filter((c) => c.op === "terminal.create").length;
  r.s.upsert("members", { id: m.id }, { restart_at: r.now() + 1, restart_mode: "now", restart_by: "operator" });
  const created = () => r.side.calls.filter((c) => c.op === "terminal.create").length;
  for (let i = 0; i < 20 && created() === before; i++) {
    await r.tick();
    // No side observer in this rig: once the stop was sent, say the agent is gone.
    if (r.side.calls.some((c) => c.op === "terminal.close")) agentGone(r, String(m.wt));
  }
  expect(created()).toBeGreaterThan(before);
  expect(member(r.s, Number(m.id))).toMatchObject({ host: HOST, want: "running" });
}, 60_000);   // real git, a board server and a mounted page: slow on a loaded host
