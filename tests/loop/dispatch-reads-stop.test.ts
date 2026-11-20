// account-move-slow U1: a member whose stop went out gets its Run's dispatches read every tick,
// not once per DISPATCH_READ_MIN, so the stop sees the old dispatch settle on the next tick.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRuns } from "../../bin/loop/observers/orca.ts";
import { stopCallKey, stopOpen } from "../../bin/loop/squad/member-state.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const T = 1_800_000_000;
const LEAD = "r::/x/lead", BUILDER = "r::/x/b1", EP = "limit:acct-a:1";
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// A running squad with one Lead started two hours ago (past CRASH_WINDOW_MIN) whose Run was read a
// minute ago (inside DISPATCH_READ_MIN): with nothing else going on, no read is due.
function fixture(): { s: Store; lead: Row } {
  const root = mkdtempSync(join(tmpdir(), "dispatch-stop-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: 1 });
  s.upsert("squads", { project: "p", topic: "one" }, { run_id: "run_one", repo: "path:/fake", status: "running", want: "running", observed_at: 1, updated_at: 1 });
  s.upsert("members", { project: "p", squad: "one", role: "lead", suffix: "" },
    { wt: LEAD, status: "running", want: "running", started: new Date((T - 7200) * 1000).toISOString(), observed_at: 1, updated_at: 1 });
  s.upsert("observed_workers", { project: "p", wt: LEAD }, { dispatch_seen_at: T - 60, presence: "running", observed_at: T });
  return { s, lead: s.get("members", { project: "p", squad: "one", role: "lead", suffix: "" })! };
}
// The member action's claim row, as the actuator keeps it, and the stop's worker-stop call.
function stop(s: Store, id: number, state: string, call: string | null = "completed", episode = EP) {
  s.upsert("episodes", { project: "p", subject: `member:${id}`, kind: "action:member" },
    { episode_key: episode, squad: "one", state, started_at: T - 30, ended_at: ["done", "dropped", "failed"].includes(state) ? T : null, source: "loop", observed_at: T });
  if (call) s.db.run("INSERT INTO orca_calls (retry_id, key, op, project, squad, member, payload, at, state) VALUES (?, ?, 'worker-stop', 'p', 'one', ?, '[]', ?, ?)",
    [`r-${Math.random()}`, stopCallKey(id, episode, "worker-stop"), String(s.get("members", { id })?.wt ?? ""), T - 20, call]);
}

describe("dispatchRuns: an open stop reads every tick", () => {
  test("no stop: left out; stop out: in every tick; its episode done: out again", () => {
    const { s, lead } = fixture();
    expect(dispatchRuns(s, "p", T)).toEqual([]);
    stop(s, Number(lead.id), "pending");
    expect(dispatchRuns(s, "p", T)).toEqual([{ run: "run_one", wts: [LEAD] }]);
    expect(dispatchRuns(s, "p", T + 5)).toEqual([{ run: "run_one", wts: [LEAD] }]);
    stop(s, Number(lead.id), "done");
    expect(dispatchRuns(s, "p", T + 10)).toEqual([]);
  });
  test("dropped or failed episodes end the wait; the old DISPATCH_READ_MIN rule still reads when due", () => {
    const { s, lead } = fixture();
    stop(s, Number(lead.id), "dropped");
    expect(dispatchRuns(s, "p", T)).toEqual([]);
    stop(s, Number(lead.id), "failed");
    expect(dispatchRuns(s, "p", T)).toEqual([]);
    expect(dispatchRuns(s, "p", T + 300)).toEqual([{ run: "run_one", wts: [LEAD] }]);
  });
  test("a stop whose call has not gone out, or failed, or is for another episode is not open", () => {
    const { s, lead } = fixture();
    const id = Number(lead.id);
    stop(s, id, "pending", null);
    expect(stopOpen(s, "p", id)).toBe(false);
    stop(s, id, "pending", "failed");
    expect(stopOpen(s, "p", id)).toBe(false);
    expect(dispatchRuns(s, "p", T)).toEqual([]);
    stop(s, id, "pending", "sent", "limit:acct-a:2");   // a new episode with its call out
    expect(stopOpen(s, "p", id)).toBe(true);
    stop(s, id, "pending", null, "limit:acct-a:3");     // the next episode: the old call no longer counts
    expect(stopOpen(s, "p", id)).toBe(false);
  });
  test("a Builder's open stop reads its Run too, generic over roles", () => {
    const { s } = fixture();
    s.upsert("members", { project: "p", squad: "one", role: "builder", suffix: "u1" },
      { wt: BUILDER, status: "running", want: "running", started: new Date((T - 7200) * 1000).toISOString(), observed_at: 1, updated_at: 1 });
    s.upsert("observed_workers", { project: "p", wt: BUILDER }, { dispatch_seen_at: T - 60, presence: "running", observed_at: T });
    const b = s.get("members", { project: "p", squad: "one", role: "builder", suffix: "u1" })!;
    expect(dispatchRuns(s, "p", T)).toEqual([]);
    stop(s, Number(b.id), "running");
    expect(dispatchRuns(s, "p", T).map((r) => ({ ...r, wts: r.wts.toSorted() }))).toEqual([{ run: "run_one", wts: [BUILDER, LEAD] }]);
  });
});
