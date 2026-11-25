// contract-observe.test.ts — orca-backend-alternatives U12: the loop decides for a squad off Orca from
// the contract observer (bin/loop/observers/contract.ts) and the finish rows (bin/loop/squad/finish-read.ts),
// never from Orca, on the rig of contract-rig.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { walkReality } from "../../bin/loop/core/decide.ts";
import { view } from "../../bin/loop/squad/member-state.ts";
import { readState } from "../../bin/loop/observers/contract.ts";
import { wake, type Wake } from "../../bin/loop/pause/wake.ts";
import type { Row } from "../../bin/loop/core/store.ts";
import type { Reconciler } from "../../bin/loop/core/plugins.ts";
import { cleanRigs, add, creates, finish, lead, live, LONG, member, members, pathOf, rig, sends, SQ, startLead, startMember, started, T, term, unit, worker, type Rig } from "./contract-rig.ts";

afterEach(cleanRigs);

describe("readState: what the loop reads for a terminal on a backend with no native state", () => {
  const base = { native: null, out: null, transcript: null, tail: "❯ ", walk: "running", now: 100, quiet: 10 };
  test("no agent process reads idle whatever the backend says; else a native answer wins", () => {
    expect(readState({ ...base, walk: "none", out: 99, native: "working" })).toBe("idle");
    expect(readState({ ...base, native: "waiting" })).toBe("waiting");
    expect(readState({ ...base, walk: "unknown", native: "working" })).toBe("working");
  });
  test("output or the transcript within chat_quiet_s, or esc to interrupt, reads working", () => {
    expect(readState({ ...base, out: 95 })).toBe("working");
    expect(readState({ ...base, transcript: 95 })).toBe("working");
    expect(readState({ ...base, tail: "✻ Thinking… (esc to interrupt)\n❯ " })).toBe("working");
  });
  test("quiet with an empty prompt and a live agent reads idle; a draft or no prompt is unknown", () => {
    expect(readState({ ...base, out: 80 })).toBe("idle");
    expect(readState({ ...base, tail: "❯ half a line" })).toBe("unknown");
    expect(readState({ ...base, tail: "$ " })).toBe("unknown");
    expect(readState({ ...base, walk: "unknown" })).toBe("unknown");
  });
});

describe("the loop decides for a squad off Orca (U12)", () => {
  test("a crashed member with no finish row is restarted", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startMember(r, "builder", "u1"), bp = pathOf(b);
    unit(r, b, "u1", "dispatched");
    r.fake.exit(term(r, b).t.id);                 // the terminal and its agent are gone
    await r.tick();
    expect(worker(r.s, b)).toMatchObject({ presence: "none" });
    expect(worker(r.s, b)?.gone_at).not.toBeNull();
    for (let i = 0; i < 6 && live(r.fake, bp).length === 0; i++) await r.tick();
    expect(creates(r.fake, bp)).toHaveLength(2);
    expect(live(r.fake, bp)).toHaveLength(1);
  }, LONG);

  test("killing the agent while its shell stays reads crashed: the decider restarts it in a new terminal", async () => {
    const r = await rig();
    const l = await startLead(r), lp = pathOf(l), first = term(r, l).t.id;
    r.killed.add(first);                          // claude died; the tmux window and its shell are still there
    await r.tick();
    expect(worker(r.s, l)).toMatchObject({ walk: "none", presence: "none", state: "idle" });
    expect(JSON.parse(String(r.s.get("observed_worktrees", { project: "fx", wt: String(l.wt) })?.doc))).toMatchObject({ agents: 0 });
    for (let i = 0; i < 6 && creates(r.fake, lp).length < 2; i++) await r.tick();
    expect(creates(r.fake, lp)).toHaveLength(2);
    const t = live(r.fake, lp);
    expect(t).toHaveLength(1);                    // the old shell's terminal was closed first
    expect(t[0].t.id).not.toBe(first);
  }, LONG);

  test("a Builder that crashes after its finish row while its unit is open is restarted", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startMember(r, "builder", "u2"), bp = pathOf(b);
    unit(r, b, "u2", "dispatched");
    finish(r, b, "ok");
    r.fake.exit(term(r, b).t.id);
    for (let i = 0; i < 8 && creates(r.fake, bp).length < 2; i++) await r.tick();
    expect(creates(r.fake, bp)).toHaveLength(2);
  }, LONG);

  test("a finished Builder is retired once its unit is done", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startMember(r, "builder", "u3"), bp = pathOf(b), firstTerm = term(r, b).t.id;
    unit(r, b, "u3", "done", 31);
    r.s.upsert("observed_prs", { project: "fx", ref: `${SQ}/u3` }, { pr: 31, state: "MERGED", observed_at: r.now() });
    // Its output still moves (a tmux pane reads working): the finish row says its work ended.
    term(r, b).last = r.now() + 5;
    await r.tick(2);
    expect(member(r.s, Number(b.id)).want).not.toBe("gone");
    finish(r, b, "ok");
    for (let i = 0; i < 8 && live(r.fake, bp).length > 0; i++) { term(r, b) && (term(r, b).last = r.now() + 5); await r.tick(); }
    expect(member(r.s, Number(b.id)).want).toBe("gone");
    expect(live(r.fake, bp)).toHaveLength(0);
    expect(creates(r.fake, bp)).toHaveLength(1);
    // The observer still reads it after the wish: its closed terminal is seen gone, so the close stops once.
    await r.tick(3);
    expect(worker(r.s, b)?.gone_at).not.toBeNull();
    expect(walkReality(r.s, member(r.s, Number(b.id)), r.now())).toBe("none");
    expect(r.fake.calls.filter((c) => c.op === "terminal.close" && (c.req as { id: string }).id === firstTerm)).toHaveLength(1);
  }, LONG);

  test("a Tester that finished and exited is not started again and is retired", async () => {
    const r = await rig();
    await startLead(r);
    const t = await startMember(r, "tester", "t1"), tp = pathOf(t);
    finish(r, t, "verdict");
    expect(view(r.s, member(r.s, Number(t.id)))).toBe("stopped");
    r.killed.add(term(r, t).t.id);                // its agent exits; the shell stays
    await r.tick(8);
    expect(creates(r.fake, tp)).toHaveLength(1);
    expect(member(r.s, Number(t.id)).want).toBe("gone");
    const ev = r.s.db.query("SELECT * FROM events WHERE kind = 'tester_pass_done' AND project = 'fx' AND squad = ?").all(SQ) as Row[];
    expect(ev).toHaveLength(1);
    expect(ev[0].member).toBe(String(t.wt));
  }, LONG);

  test("the Lead hears once of each failed and no-PR finish", async () => {
    const r = await rig();
    await startLead(r);
    const a = await startMember(r, "builder", "u4"), b = await startMember(r, "builder", "u5");
    unit(r, a, "u4", "dispatched");
    unit(r, b, "u5", "dispatched");
    finish(r, a, "failed", r.now() - 200, "tests red\nsee the log");
    finish(r, b, "no-pr", r.now() - 200, "nothing to change");
    await r.tick(4);
    const reqs = (slug: string) => r.acted.filter((x) => x.kind === "request.file" && String(x.episode).startsWith(`failed|${slug}|gen:`));
    expect(reqs("u4")).toHaveLength(1);
    expect(reqs("u5")).toHaveLength(1);
    const [fa, fb] = [String((reqs("u4")[0].payload as Row).text), String((reqs("u5")[0].payload as Row).text)];
    expect((reqs("u4")[0].payload as Row).target).toBe(SQ);
    expect(fa).toStartWith("failed report:");
    expect(fa).toContain("ds finish");
    expect(fa).toContain("tests red / see the log");
    expect(fb).toStartWith("report with no PR:");
  }, LONG);

  test("wake() pokes an idle member on a backend with no native state", async () => {
    let ask = "", got: Wake | null = null;
    const waker: Reconciler = { name: "waker", run: (ctx) => {
      if (!ask) return [];
      got = wake(ctx, ask, "check your inbox, from the test", "test", "w1");
      ask = "";
      return got.actions;
    } };
    const r = await rig({ state: "none" }, { extra: [waker] });
    const l = await startLead(r);
    // Claude draws its prompt: the output moved, so it reads working until chat_quiet_s (10 s) passes.
    const t = term(r, l);
    t.lines.push("╭────╮", "│ ❯  │", "╰────╯");
    t.last = r.now();
    await r.tick();
    expect(worker(r.s, l)?.state).toBe("working");
    await r.tick(2);
    expect(worker(r.s, l)?.state).toBe("idle");
    expect(r.fake.calls.some((c) => c.op === "agent.state")).toBe(false);
    ask = String(l.wt);
    await r.tick(2);
    expect(got!.status).toBe("sent");
    expect(sends(r.fake, term(r, l).t.id)).toContain("check your inbox, from the test");
  }, LONG);

  test("a mixed project over ten ticks: the Orca observer marks no member off Orca gone, and nothing restarts it", async () => {
    const r = await rig();
    const l = await startLead(r), b = await startMember(r, "builder", "u6");
    unit(r, b, "u6", "dispatched");
    const ps = r.orcaReads();
    await r.tick(10);
    expect(r.orcaReads()).toBeGreaterThan(ps);       // the Orca observer did run
    for (const m of [l, b]) {
      expect(creates(r.fake, pathOf(m))).toHaveLength(1);
      expect(worker(r.s, m)?.gone_at ?? null).toBeNull();
      expect(r.s.get("observed_worktrees", { project: "fx", wt: String(m.wt) })?.gone_at ?? null).toBeNull();
      const terms = r.s.db.query("SELECT gone_at FROM observed_terminals WHERE project = 'fx' AND wt = ?").all(String(m.wt)) as Row[];
      expect(terms.length).toBe(1);
      expect(terms[0].gone_at).toBeNull();
    }
    expect(r.walks()).toBeGreaterThanOrEqual(10);
  }, LONG);
});

describe("the tree a native backend shows (U21f)", () => {
  test("parents native: observed_worktrees.parent is the parent the backend shows; groups: the loop's own record", async () => {
    for (const parents of ["native", "groups"] as const) {
      const r = await rig({ parents });
      const l = await startLead(r), b = await startMember(r, "builder", "u1");
      await r.tick();
      const tree = (m: Row) => r.s.get("observed_worktrees", { project: "fx", wt: String(m.wt) })?.parent ?? null;
      r.s.db.run("UPDATE worktrees SET parent_path = '/loop/says' WHERE host = 'local' AND path = ?", [pathOf(b)]);
      r.fake.trees.set(pathOf(b), "/backend/shows");
      await r.tick(2);
      expect(tree(b)).toBe(parents === "native" ? "local::/backend/shows" : "local::/loop/says");
      if (parents === "native") {
        r.fake.trees.delete(pathOf(b));   // moved to the top level in the backend
        await r.tick(2);
        expect(tree(b)).toBeNull();
      }
      void l;
    }
  }, LONG);
});
