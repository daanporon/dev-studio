// wait-on.test.ts — U220: a dispatched unit whose deps (written by `squad-state.sh wait-on` or a plan's
// `— blocks:` line) are not done gets a dependency pause on its Builder from the dependency-waits
// reconciler: the Builder's slot frees once its agent is gone, nothing pokes it, and it restarts from
// its journal (told what it waited on) once the dep is done.
import { expect, test } from "bun:test";
import { fixture } from "./pause-fixture.ts";
import dependencyWaits from "../../bin/loop/reconcilers/dependency-waits.ts";
import { projection, intents } from "../../bin/loop/pause/pause.ts";
import { slot } from "../../bin/loop/capacity/slot.ts";
import { wake } from "../../bin/loop/pause/wake.ts";
import { resumePrompt } from "../../bin/loop/reconcilers/pause-resume.ts";

function waiting(deps: string[] = ["fix"], status = "dispatched") {
  const f = fixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "fix" }, { status: "dispatched", observed_at: 1, updated_at: 1 });
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { status, deps: JSON.stringify(deps), doc: JSON.stringify({ slug: "task", wait_on: { fix: "fix first" } }) });
  return f;
}
const open = (f: ReturnType<typeof fixture>) => f.store.db.query("SELECT * FROM pause_intents WHERE source = 'dependency' AND cleared_at IS NULL").all() as Record<string, unknown>[];

test("a dispatched unit with an unmet dep gets a dependency pause by wait-on, frees its slot, and resumes when the dep is done", async () => {
  const f = waiting();
  dependencyWaits.run(f.ctx());
  expect(open(f)).toMatchObject([{ scope: "member", squad: "one", role: "builder", suffix: "task", requested_by: "wait-on" }]);
  expect(JSON.parse(String(open(f)[0].prerequisites))).toEqual([{ kind: "unit", project: "p", squad: "one", slug: "fix" }]);
  await f.tick(); f.checkpoint(); await f.tick();
  expect(projection(f.store, f.target).state).toBe("paused");
  // The reconciler is steady: no second pause, no new events however many ticks pass.
  for (let n = 0; n < 5; n++) { dependencyWaits.run(f.ctx()); await f.tick(); }
  expect(open(f)).toHaveLength(1);
  // The agent is gone, so the slot is free for another Builder.
  expect(f.orca.agents).toHaveLength(0);
  expect(slot(f.store, "p", { squad: "one", suffix: "other" }, 100).ok).toBe(true);
  f.store.upsert("units", { project: "p", squad: "one", slug: "fix" }, { status: "done" });
  dependencyWaits.run(f.ctx());
  for (let n = 0; n < 4; n++) await f.tick();
  expect(open(f)).toHaveLength(0);
  expect(f.orca.started).toHaveLength(1);
  expect(projection(f.store, f.target).state).toBe("active");
  const m = f.store.db.query("SELECT * FROM members WHERE suffix = 'task'").get() as Record<string, unknown>;
  expect(resumePrompt(f.store, m, f.store.get("pause_members", f.target)!)).toContain("waited on fix, which has merged");
});

test("a Builder that already has a manual pause is left alone", () => {
  const f = waiting();
  f.store.pause({ scope: "member", ...f.target });
  dependencyWaits.run(f.ctx());
  expect(open(f)).toHaveLength(0);
  expect(intents(f.store, f.target)).toHaveLength(1);
});

test("a planned unit's dep places no pause", () => {
  const f = waiting(["fix"], "planned");
  dependencyWaits.run(f.ctx());
  expect(open(f)).toHaveLength(0);
});

test("wait-off (the dep leaves deps) clears the pause wait-on placed; a dep list that grows is followed", () => {
  const f = waiting();
  f.store.upsert("units", { project: "p", squad: "one", slug: "fix2" }, { status: "dispatched", observed_at: 1, updated_at: 1 });
  dependencyWaits.run(f.ctx());
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { deps: JSON.stringify(["fix", "fix2"]) });
  dependencyWaits.run(f.ctx());
  expect(JSON.parse(String(open(f)[0].prerequisites)).map((p: { slug: string }) => p.slug)).toEqual(["fix", "fix2"]);
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { deps: JSON.stringify([]) });
  dependencyWaits.run(f.ctx());
  expect(open(f)).toHaveLength(0);
});

test("a dependency-paused Builder gets no PR poke", async () => {
  const f = waiting();
  dependencyWaits.run(f.ctx());
  const w = wake(f.ctx(), "wt_one", "checks failed", "pr-news", "head1#red", { allowWorking: true });
  expect(w.status).toBe("skipped:paused");
  expect(w.actions).toEqual([]);
});
