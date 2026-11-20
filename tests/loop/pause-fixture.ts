import pauseResume from "../../bin/loop/reconcilers/pause-resume.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import pauseLifecycle from "../../bin/loop/fulfil/pause.ts";
import member from "../../bin/loop/fulfil/member.ts";
import decider from "../../bin/loop/core/decide.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { acknowledge, journalPath } from "../../bin/loop/pause/pause.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";
import { orcaObserver } from "../../bin/loop/observers/orca.ts";

export function fixture(role = "builder", suffix = "task") {
  const root = tempRoot("pause-lifecycle-");
  const store = open(root); onTestEnd(() => store.close());
  const target = { project: "p", squad: "one", role, suffix };
  const path = join(root, "retained"); mkdirSync(path); writeFileSync(join(path, "unfinished"), "local changes");
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  store.upsert("squads", { project: "p", topic: "one" }, { status: "running", run_id: "run_one", repo: "path:/fake", lead_wt: "wt_lead", observed_at: 1, updated_at: 1 });
  store.upsert("members", target, { wt: "wt_one", status: "running", want: "running", agent: "claude", model: "opus", account: "a", observed_at: 1, updated_at: 1 });
  store.upsert("observed_worktrees", { project: "p", wt: "wt_one" }, { path, observed_at: 1 });
  store.upsert("units", { project: "p", squad: "one", slug: "task" }, { status: "dispatched", builder_wt: "wt_one", tier: "hard", observed_at: 1, updated_at: 1 });
  const orca = new FakeBackend(); orca.agent("wt_one", "term_one", "claude");
  const observer = orcaObserver(orca.observer(
    () => (store.db.query("SELECT DISTINCT wt FROM members WHERE wt IS NOT NULL").all() as { wt: string }[])
      .map((m) => ({ worktreeId: m.wt, path: String(store.get("observed_worktrees", { project: "p", wt: m.wt })?.path ?? path) })),
    () => (store.db.query("SELECT * FROM members").all() as { wt: string; role: string; suffix: string }[])
      .map((m) => ({ squad: "one", role: m.role, suffix: m.suffix, wt: m.wt,
        terminals: orca.agents.filter((a) => a.wt === m.wt).map((a) => a.handle) }))));
  orca.spawn = true;
  // The process walk (U149) as the decider reads it: a member's agent runs while Orca has an agent
  // terminal in its worktree. Each tick's walk also seeds the wishes once (seed.ts).
  const walk = (c: TickCtx) => {
    for (const m of c.store.db.query("SELECT DISTINCT wt FROM members WHERE wt IS NOT NULL").all() as { wt: string }[]) {
      const up = orca.agents.some((a) => a.wt === m.wt) ? "running" : "none";
      c.store.upsert("observed_workers", { project: "p", wt: m.wt }, { walk: up, presence: up, account_at: c.now, observed_at: c.now });
    }
  };
  const act = new LoopActuator({ orca, fulfillers: [pauseLifecycle, member], pick: async () => ({ agent: "claude", model: "opus", account: "a", effort: null }) });
  let at = 10;
  const ctx = (): TickCtx => ({ store, project: "p", tick: at, now: at++, fired: [], poked: new Set() });
  const tick = async () => { const c = ctx(); await observer.run(c); walk(c); pauseResume.run(c); for (const a of await pauseLifecycle.run(c) ?? []) await act.act(a, c); for (const a of await decider.run(c) ?? []) await act.act(a, c); await act.drain(); };
  const checkpoint = () => {
    const row = store.get("pause_members", target)!;
    const file = journalPath(store, target); mkdirSync(join(root, "p", "journals"), { recursive: true });
    writeFileSync(file, `- checkpoint ${row.generation}: test green; unfinished local changes; branch feature; PR remote CI; continue implementation\n`);
    return acknowledge(store, target, String(row.generation), String(row.session), String(row.dispatch ?? "-"), file, at);
  };
  const world = { name: "walk", run: walk };
  return { store, target, path, orca, act, tick, checkpoint, ctx, root, observer, world };
}

