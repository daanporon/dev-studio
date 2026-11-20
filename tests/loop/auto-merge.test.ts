// auto-merge.test.ts — U166: the project's auto_merge setting lets the loop arm GitHub
// auto-merge on a merge-ready unit PR itself. The reconciler cases run real ticks over a hermetic
// state root holding one squad (lc); the fulfiller cases drive bin/loop/fulfil/merge.ts with a
// stubbed `gh` (DS_GH) and a stubbed poke, so no Orca and no network.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { since } from "../../bin/loop/core/events.ts";
import { alertGone } from "../../bin/loop/reconcilers/alerts.ts";
import lifecycle from "../../bin/loop/reconcilers/lifecycle.ts";
import merge, { forgetAutoMerge } from "../../bin/loop/fulfil/merge.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const T = 1_800_000_000;
const LEAD = "wt-lead::/ws/ds-lead-lc", B = "wt-b1::/ws/ds-builder-u1-lc";
const NWO = "o/r";

const temps: string[] = [], stores: Store[] = [];
const savedAutoMerge = process.env.DS_LOOP_AUTO_MERGE;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (savedAutoMerge === undefined) delete process.env.DS_LOOP_AUTO_MERGE;
  else process.env.DS_LOOP_AUTO_MERGE = savedAutoMerge;
  delete process.env.DS_GH;
  forgetAutoMerge();
});

type Unit = Row & { slug: string };
// A root with the fixture's projects and one squad, lc, of a busy Lead and an idle Builder for u1.
function squad(units: Unit[], extra: Row = {}): { s: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), "zzmerge-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, "fx", "squads", "demo.json"));
  rmSync(join(root, "fx", "sweep", "pr-health.json"));
  const doc = {
    type: "feature", status: "running", repo: "path:/x/repo", lead_wt: LEAD,
    members: [{ role: "lead", suffix: "", wt: LEAD }, { role: "builder", suffix: "u1", wt: B }],
    units: units.map((u) => ({ status: "dispatched", builder_wt: B, deps: [], hold: false, ...u })),
    leftovers: [], ...extra,
  };
  writeFileSync(join(root, "fx", "squads", "lc.json"), JSON.stringify(doc, null, 2) + "\n");
  const s = open(root); stores.push(s);
  importJson(s);
  importConfig(s);
  s.upsert("config", { project: "fx", file: "github", key: "repo:path:/x/repo" }, { value: NWO, observed_at: T });
  s.upsert("config", { project: "fx", file: "github", key: `default_branch:${NWO}` }, { value: "main", observed_at: T });
  s.upsert("observed_worktrees", { project: "fx", wt: B }, { path: "/ws/ds-builder-u1-lc", branch: "feat-u1", observed_at: T });
  worker(s, B, "idle");
  worker(s, LEAD, "working"); // the merge-ready tests idle it
  return { s, root };
}
function worker(s: Store, wt: string, state: string) {
  s.upsert("observed_workers", { project: "fx", wt }, { state, since: null, observed_at: T });
}
function pr(s: Store, n: number, set: Row) {
  s.upsert("observed_prs", { project: "fx", ref: `${NWO}#${n}` }, { pr: n, repo: NWO, head: "feat-u1", state: "OPEN", verdict: "ready", reasons: JSON.stringify(""), observed_at: T, ...set });
}
function loop(s: Store) {
  const got: Action[] = [];
  const act: Actuator = { act(a) { got.push(a); } };
  const l = new Loop(s, { observers: [], reconcilers: [lifecycle] }, act, { projects: () => ["fx"] });
  l.boot(T);
  return { got, tick: async (at: number) => (await l.tick(at)).acted };
}
const autoMergeRow = (s: Store) => s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:merge-ready" }) as Row;
const kinds = (a: Action[]) => a.map((x) => `${x.kind} ${x.episode}`);
const leadPokes = (a: Action[]) => a.filter((x) => x.member === LEAD && x.kind === "poke");
const merges = (a: Action[]) => a.filter((x) => x.kind === "merge");

describe("auto_merge off (the default)", () => {
  test("the repo default reads off, so a merge-ready PR pokes the Lead and emits no merge action", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    expect(s.get("config", { project: "", file: "limits.conf", key: "auto_merge" })?.value).toBe("off");
    worker(s, LEAD, "idle");
    pr(s, 7, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, doc: JSON.stringify({ headRefOid: "aaa" }) });
    const got = await loop(s).tick(T);
    expect(merges(got)).toEqual([]);
    expect(kinds(got)).toEqual([`poke merge-ready:${NWO}#7#1#1`]);
  });

  test("an unknown method reads as off", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "squash-it", observed_at: T });
    worker(s, LEAD, "idle");
    pr(s, 7, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, doc: JSON.stringify({ headRefOid: "aaa" }) });
    const got = await loop(s).tick(T);
    expect(merges(got)).toEqual([]);
    expect(leadPokes(got)).toHaveLength(1);
  });
});

describe("auto_merge squash: one merge action per PR head", () => {
  const ready = (s: Store, set: Row = {}) => pr(s, 7, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, doc: JSON.stringify({ headRefOid: "aaa" }), ...set });
  function armed(): { s: Store } {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "squash", observed_at: T });
    worker(s, LEAD, "idle");
    ready(s);
    return { s };
  }

  test("a merge-ready PR gives one merge action and no Lead poke", async () => {
    const { s } = armed(), l = loop(s);
    const got = await l.tick(T);
    expect(merges(got)).toHaveLength(1);
    expect(leadPokes(got)).toEqual([]);
    expect(merges(got)[0]).toMatchObject({
      project: "fx", squad: "lc", member: LEAD, subject: `${NWO}#7`, kind: "merge",
      episode: `merge-ready:${NWO}#7|aaa#auto`,
      payload: { n: 7, repo: NWO, method: "squash", unit: "u1", topic: "lc", base: "main", ref: `${NWO}#7`, head: "aaa" },
    });
    // U249: the episode follows the actuator's claim: unclaimed (count 0) in the tick that emitted it, armed once claimed.
    expect(autoMergeRow(s)).toMatchObject({ episode_key: `${NWO}#7|aaa`, count: 0, state: "merge-unclaimed" });
    expect(merges(await l.tick(T + 1))).toEqual([]);
    expect(autoMergeRow(s)).toMatchObject({ episode_key: `${NWO}#7|aaa`, count: 1, state: "merge-armed" });
  });

  test("a mergeability re-read keeps the episode: no second merge action", async () => {
    const { s } = armed(), l = loop(s);
    expect(merges(await l.tick(T))).toHaveLength(1);
    expect(await l.tick(T + 1)).toEqual([]);
    pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("mergeable-unknown"), since: T + 1 });
    expect(await l.tick(T + 5)).toEqual([]);
    pr(s, 7, { verdict: "ready", reasons: JSON.stringify(""), since: T + 1 });
    expect(merges(await l.tick(T + 10))).toEqual([]);
    expect(autoMergeRow(s)).toMatchObject({ episode_key: `${NWO}#7|aaa`, count: 1 });
  });

  test("a second tick on the same head gives none, and a new head gives one again", async () => {
    const { s } = armed(), l = loop(s);
    expect(merges(await l.tick(T))).toHaveLength(1);
    expect(await l.tick(T + 5)).toEqual([]);
    pr(s, 7, { doc: JSON.stringify({ headRefOid: "bbb" }) });
    const again = await l.tick(T + 10);
    expect(merges(again)).toHaveLength(1);
    expect(String((merges(again)[0].payload as Row).head)).toBe("bbb");
    expect(autoMergeRow(s)).toMatchObject({ episode_key: `${NWO}#7|bbb`, count: 0 });
    expect(await l.tick(T + 11)).toEqual([]);
    expect(autoMergeRow(s)).toMatchObject({ episode_key: `${NWO}#7|bbb`, count: 1 });
  });

  test("a PR that is not merge-ready gives no merge action", async () => {
    for (const set of [{ mergeable: "UNKNOWN" }, { base: "release" }, { verdict: "blocked", reasons: JSON.stringify("conflicting") }]) {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "squash", observed_at: T });
      worker(s, LEAD, "idle");
      pr(s, 7, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, doc: JSON.stringify({ headRefOid: "aaa" }), ...set });
      expect(merges(await loop(s).tick(T))).toEqual([]);
    }
  });

  test("a unit that is not dispatched gives no merge action", async () => {
    const { s } = squad([{ slug: "u1", pr: "7", status: "planned" }]);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "squash", observed_at: T });
    worker(s, LEAD, "idle");
    ready(s);
    expect(merges(await loop(s).tick(T))).toEqual([]);
  });

  test("the env var picks the method", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    process.env.DS_LOOP_AUTO_MERGE = "rebase";
    worker(s, LEAD, "idle");
    ready(s);
    const got = merges(await loop(s).tick(T));
    expect(got).toHaveLength(1);
    expect((got[0].payload as Row).method).toBe("rebase");
  });

  test("the project row beats the repo default", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.upsert("config", { project: "", file: "limits.conf", key: "auto_merge" }, { value: "merge", observed_at: T });
    s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "rebase", observed_at: T });
    worker(s, LEAD, "idle");
    ready(s);
    const got = merges(await loop(s).tick(T));
    expect(got).toHaveLength(1);
    expect((got[0].payload as Row).method).toBe("rebase");
  });

  test("a still-open PR after two gaps raises the stuck alert once, then stays silent", async () => {
    const { s } = armed(), l = loop(s), at = (m: number) => T + m * 60;
    expect(merges(await l.tick(T))).toHaveLength(1);
    expect(await l.tick(T + 1)).toEqual([]);
    expect(await l.tick(at(14))).toEqual([]);
    expect(await l.tick(at(15) + 2)).toEqual([]);
    expect(autoMergeRow(s)).toMatchObject({ count: 2 });
    const stuck = await l.tick(at(31));
    expect(kinds(stuck)).toEqual([`alert merge-ready:${NWO}#7`]);
    expect(String(((stuck[0].payload as Row).title))).toBe("Merge-ready PR left open");
    expect(await l.tick(at(60))).toEqual([]);
    expect(await l.tick(at(90))).toEqual([]);
  });

  test("two stuck units under one Lead alert once each, then stay silent", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }, { slug: "u2", pr: "8" }]);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "squash", observed_at: T });
    worker(s, LEAD, "idle");
    ready(s);
    pr(s, 8, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, head: "feat-u2", doc: JSON.stringify({ headRefOid: "bbb" }) });
    const l = loop(s), at = (m: number) => T + m * 60;
    expect(merges(await l.tick(T))).toHaveLength(2);
    expect(await l.tick(T + 1)).toEqual([]);
    expect(await l.tick(at(15) + 2)).toEqual([]);
    const stuck = await l.tick(at(31));
    expect(kinds(stuck).sort()).toEqual([`alert merge-ready:${NWO}#7`, `alert merge-ready:${NWO}#8`]);
    expect(await l.tick(at(60))).toEqual([]);
    expect(await l.tick(at(90))).toEqual([]);
  });

  test("when arming failed, the stuck alert says so instead of 'armed'", async () => {
    const { s } = armed(), l = loop(s), at = (m: number) => T + m * 60;
    expect(merges(await l.tick(T))).toHaveLength(1);
    expect(await l.tick(T + 1)).toEqual([]);
    s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:merge-ready" }, { state: "merge-failed" });
    expect(await l.tick(at(15) + 2)).toEqual([]);
    const stuck = await l.tick(at(31));
    expect(kinds(stuck)).toEqual([`alert merge-ready:${NWO}#7`]);
    expect(String(((stuck[0].payload as Row).text))).toContain("could not be armed");
  });
});

// U249: a merge the actuator turned down is emitted again, and the card says what really happened.
describe("U249: the episode follows the claim", () => {
  const readyPr = (s: Store, n: number, head: string, set: Row = {}) =>
    pr(s, n, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, head: `feat-u${n}`, doc: JSON.stringify({ headRefOid: head, autoMergeRequest: null }), ...set });
  const cfg = (s: Store) => { s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "squash", observed_at: T }); worker(s, LEAD, "idle"); };
  // An actuator that turns a merge down (ready false, nothing claimed) while `open` is false.
  function gated() {
    const st = { open: false }, got: Action[] = [];
    const act: Actuator = { act(a) { got.push(a); }, ready: (a: Action) => a.kind !== "merge" || st.open };
    return { st, got, act };
  }
  const gloop = (s: Store, act: Actuator) => { const l = new Loop(s, { observers: [], reconcilers: [lifecycle] }, act, { projects: () => ["fx"] }); l.boot(T);
    return { all: async (at: number) => await l.tick(at), tick: async (at: number) => (await l.tick(at)).acted }; };
  const claimRow = (s: Store, n: number) => s.get("episodes", { project: "fx", subject: `${NWO}#${n}`, kind: "action:merge" });

  test("an action turned down before the claim is emitted again every tick, at count 0, then claimed", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]); cfg(s); readyPr(s, 7, "aaa");
    const g = gated(), l = gloop(s, g.act);
    for (const at of [T, T + 5, T + 10]) {
      const r = await l.all(at);
      expect(r.acted).toEqual([]);   // nothing claimed
      expect(merges(r.actions)).toHaveLength(1);   // and emitted again
      expect(autoMergeRow(s)).toMatchObject({ count: 0, state: "merge-unclaimed" });
    }
    g.st.open = true;
    expect(merges(await l.tick(T + 15))).toHaveLength(1);
    expect(claimRow(s, 7)).toMatchObject({ state: "acted", episode_key: `merge-ready:${NWO}#7|aaa#auto` });
    expect(autoMergeRow(s)).toMatchObject({ count: 0 });
    await l.tick(T + 16);
    expect(autoMergeRow(s)).toMatchObject({ count: 1, state: "merge-armed" });
  });

  test("two merge-ready PRs of one Lead each get their own claim", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }, { slug: "u2", pr: "8" }]); cfg(s); readyPr(s, 7, "aaa"); readyPr(s, 8, "bbb");
    const l = loop(s);
    expect(merges(await l.tick(T)).map((a) => a.subject).sort()).toEqual([`${NWO}#7`, `${NWO}#8`]);
    expect(claimRow(s, 7)).toBeTruthy(); expect(claimRow(s, 8)).toBeTruthy();
  });

  test("a never-started merge gets a card that says so, once", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]); cfg(s); readyPr(s, 7, "aaa");
    const g = gated(), l = gloop(s, g.act), at = (m: number) => T + m * 60;
    await l.tick(T);
    expect(await l.tick(at(14))).toEqual([]);
    const card = await l.tick(at(31));
    expect(kinds(card)).toEqual([`alert merge-ready:${NWO}#7`]);
    expect(String((card[0].payload as Row).text)).toContain("never started");
    expect(await l.tick(at(60))).toEqual([]);
  });

  test("armed but not merged: the card says armed only when GitHub shows autoMergeRequest", async () => {
    const { s } = armedPr();
    const l = loop(s), at = (m: number) => T + m * 60;
    await l.tick(T); await l.tick(T + 1); await l.tick(at(15) + 2);
    const card = await l.tick(at(31));
    expect(String((card[0].payload as Row).text)).toContain("armed on GitHub");
    // and without it on GitHub the card does not claim it
    const { s: s2 } = armedPr({ autoMergeRequest: null });
    const l2 = loop(s2);
    await l2.tick(T); await l2.tick(T + 1); await l2.tick(at(15) + 2);
    const card2 = await l2.tick(at(31));
    expect(String((card2[0].payload as Row).text)).toContain("GitHub shows no auto-merge");
    expect(String((card2[0].payload as Row).text)).not.toContain("armed on GitHub");
  });
  function armedPr(extra: Row = { autoMergeRequest: { enabledAt: "x" } }) {
    const { s } = squad([{ slug: "u1", pr: "7" }]); cfg(s);
    pr(s, 7, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, doc: JSON.stringify({ headRefOid: "aaa", ...extra }) });
    return { s };
  }

  test("GitHub still shows no auto-merge after a done claim: a new round; an armed one or a third round stops", async () => {
    const { s } = armedPr({ autoMergeRequest: null });
    const l = loop(s);
    await l.tick(T);
    s.db.run("UPDATE episodes SET state = 'done', observed_at = ? WHERE kind = 'action:merge'", [T + 2]);
    pr(s, 7, { observed_at: T + 1 });
    expect(await l.tick(T + 100)).toEqual([]);   // the reading is older than the settle: not acted on
    pr(s, 7, { observed_at: T + 300 });
    const again = merges(await l.tick(T + 300));
    expect(again.map((a) => a.episode)).toEqual([`merge-ready:${NWO}#7|aaa#auto#r2`]);
    s.db.run("UPDATE episodes SET state = 'done', observed_at = ? WHERE kind = 'action:merge'", [T + 301]);
    pr(s, 7, { observed_at: T + 600 });
    expect(merges(await l.tick(T + 600)).map((a) => a.episode)).toEqual([`merge-ready:${NWO}#7|aaa#auto#r3`]);
    s.db.run("UPDATE episodes SET state = 'done', observed_at = ? WHERE kind = 'action:merge'", [T + 601]);
    pr(s, 7, { observed_at: T + 900 });
    expect(merges(await l.tick(T + 900))).toEqual([]);   // three rounds is the limit
  });

  test("U286: a merge GitHub refused for its rate limit is armed again once the budget is back; another failure is not", async () => {
    for (const [why, healed] of [["GraphQL: API rate limit already exceeded for user ID 71901.", true], ["GraphQL: Auto-merge is not allowed for this repository", false]] as const) {
      const { s } = armedPr({ autoMergeRequest: null });
      const l = loop(s);
      await l.tick(T);
      // What the fulfiller left before U286: the claim done with gh's reason, three tries, merge-failed.
      s.db.run("UPDATE episodes SET state = 'done', result = ?, observed_at = ? WHERE kind = 'action:merge'", [`not armed for aaa: ${why}`, T + 2]);
      s.upsert("episodes", { project: "fx", subject: `${NWO}#7`, kind: "merge-tries" }, { squad: "lc", episode_key: `merge-ready:${NWO}#7|aaa#auto`, count: 3, state: "retrying", source: "loop", observed_at: T + 2 });
      s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:merge-ready" }, { count: 1, state: "merge-failed", next_at: T + 99_999, observed_at: T + 2 });
      s.upsert("observed_github", { repo: "" }, { cost: 8, remaining: 0, reset_at: T + 1200, observed_at: T + 2 });
      pr(s, 7, { observed_at: T + 300 });
      expect(merges(await l.tick(T + 300))).toEqual([]);   // no budget yet
      expect(autoMergeRow(s)).toMatchObject({ state: "merge-failed" });
      pr(s, 7, { observed_at: T + 1300 });
      const sent = merges(await l.tick(T + 1300)).map((a) => a.episode);
      expect(sent).toEqual(healed ? [`merge-ready:${NWO}#7|aaa#auto#r2`] : []);
      expect(autoMergeRow(s)).toMatchObject(healed ? { state: "merge-armed", count: 1, result: null } : { state: "merge-failed" });
      if (healed) expect(merges(await l.tick(T + 1301))).toEqual([]);   // claimed: round 2 runs, nothing more
    }
  });

  test("an armed PR is not sent again", async () => {
    const { s } = armedPr({ autoMergeRequest: { enabledAt: "x" } });
    const l = loop(s);
    await l.tick(T);
    s.db.run("UPDATE episodes SET state = 'done', observed_at = ? WHERE kind = 'action:merge'", [T + 2]);
    pr(s, 7, { observed_at: T + 900 });
    expect(merges(await l.tick(T + 900))).toEqual([]);
  });
});

// U249 with the real actuator: the #464/#465 case and busy background slots.
describe("U249: the real actuator", () => {
  function rig(nprs: number, bgSlots: number, slowPoke = false) {
    const units = Array.from({ length: nprs }, (_, i) => ({ slug: `u${i + 1}`, pr: String(7 + i) }));
    const { s } = squad(units);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: "squash", observed_at: T });
    worker(s, LEAD, "idle");
    units.forEach((u, i) => pr(s, 7 + i, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, head: `feat-${u.slug}`, doc: JSON.stringify({ headRefOid: `h${i}`, autoMergeRequest: null }) }));
    const merged: string[] = [], hold = { release: () => {} }, gate = new Promise<void>((ok) => { hold.release = ok; });
    const mf: Fulfiller = { name: "merge", kinds: ["merge"], run: () => [], exec: async (a) => { merged.push(a.subject); await Bun.sleep(30); return { done: true }; } };
    const pf: Fulfiller = { name: "poke", kinds: ["poke"], run: () => [], exec: async () => { await gate; return { done: true }; } };
    const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [mf, pf], bgSlots });
    const pokes: Action[] = slowPoke ? [{ project: "fx", squad: "lc", member: "wt-x", subject: "req:slow", kind: "poke", episode: "e1", payload: { wt: "wt-x" } }] : [];
    const l = new Loop(s, { observers: [], reconcilers: [{ name: "slow", run: () => pokes }, lifecycle] }, act, { projects: () => ["fx"] });
    l.boot(T);
    return { s, act, l, merged, hold };
  }
  const claims = (s: Store) => (s.db.query("SELECT subject, state FROM episodes WHERE kind = 'action:merge' ORDER BY subject").all() as Row[]).map((r) => `${r.subject}:${r.state}`);

  test("two merge-ready PRs of one Lead in one tick both merge, and no card is raised", async () => {
    const { s, act, l, merged } = rig(2, 6);
    const r = await l.tick(T);
    expect(merges(r.actions)).toHaveLength(2);
    await act.drain();
    expect(merged.sort()).toEqual([`${NWO}#7`, `${NWO}#8`]);
    expect(claims(s)).toEqual([`${NWO}#7:done`, `${NWO}#8:done`]);
    await l.tick(T + 1);
    expect(s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:merge-ready" })).toMatchObject({ count: 1, state: "merge-armed" });
  });

  test("with one slot held by a slow poke, the merge waits at count 0 and merges once the slot frees; bg_deferred counts it", async () => {
    const { s, act, l, merged, hold } = rig(1, 1, true);
    await l.tick(T);   // the poke takes the only slot; the merge is turned down before its claim
    await l.tick(T + 1); await l.tick(T + 2);
    expect(merged).toEqual([]);
    expect(autoMergeRow(s)).toMatchObject({ count: 0, state: "merge-unclaimed" });
    expect(claims(s)).toEqual([]);
    const d = JSON.parse(readFileSync(join(s.root, "loop", "bg-deferred.json"), "utf8"));
    expect(d.total.merge).toBeGreaterThanOrEqual(3);
    hold.release(); await act.drain();
    await l.tick(T + 3); await act.drain(); await l.tick(T + 4); await act.drain();
    expect(merged).toEqual([`${NWO}#7`]);
    expect(autoMergeRow(s)).toMatchObject({ count: 1, state: "merge-armed" });
  });
});

// The `pr merge` lines gh was run with (the repo-setting read is an `api` line).
const ghMerges = (root: string) => readFileSync(join(root, "gh.log"), "utf8").trim().split("\n").filter((l) => l.startsWith("pr merge")).join("\n");

describe("merge fulfiller", () => {
  // A stub gh on PATH via DS_GH: logs its argv, then answers as told.
  function fakeGh(root: string, code: number, out: string, err: string): string {
    const log = join(root, "gh.log");
    const f = join(root, `gh-${code}.sh`);
    writeFileSync(f, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n${out ? `printf '%s\\n' ${JSON.stringify(out)}` : ":"}\n${err ? `printf '%s\\n' ${JSON.stringify(err)} >&2` : ":"}\nexit ${code}\n`);
    chmodSync(f, 0o755);
    return f;
  }
  type ExecResult = { done?: boolean; failed?: string; result?: unknown };
  function rig(s: Store) {
    const pokes: { wt: string; text: string }[] = [];
    const act = {
      seat: () => ({}),
      driver: () => ({ poke: async (m: { wt: string }, text: string) => { pokes.push({ wt: m.wt, text }); return "started"; } }),
    };
    const run = (a: Action, at: number) => (merge.exec as unknown as (a: Action, x: unknown) => Promise<ExecResult>)(a, { store: s, now: at, act });
    return { pokes, exec: run };
  }
  function action(s: Store): Action {
    return { project: "fx", squad: "lc", member: LEAD, subject: LEAD, kind: "merge", episode: `merge-ready:${NWO}#7|aaa#auto`,
      payload: { n: 7, repo: NWO, method: "squash", unit: "u1", topic: "lc", base: "main", ref: `${NWO}#7`, head: "aaa", ep: `${NWO}#7|aaa` } };
  }
  const alertRows = (s: Store) => {
    const f = join(s.root, "fx", "alerts.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]) : [];
  };

  test("success runs gh pr merge --auto and pokes the Lead once", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    process.env.DS_GH = fakeGh(root, 0, "Enabled auto-merge", "");
    const { pokes, exec } = rig(s);
    const r = await exec(action(s), T);
    expect(r).toMatchObject({ done: true, result: "started" });
    expect(ghMerges(root)).toBe("pr merge 7 --repo o/r --auto --squash --match-head-commit aaa");
    expect(since(s, 0, { kinds: ["auto_merge_armed"] })).toHaveLength(1);
    expect(pokes).toHaveLength(1);
    expect(pokes[0].wt).toBe(LEAD);
    expect(pokes[0].text).toContain("PR #7 for unit u1 is merge-ready; the loop armed auto-merge (squash)");
    expect(alertRows(s).filter((a) => a.title === "Auto-merge not armed")).toEqual([]);
  });

  test("without a head there is nothing to pin: no --match-head-commit", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    process.env.DS_GH = fakeGh(root, 0, "Enabled auto-merge", "");
    pr(s, 7, { state: "OPEN" });
    const { exec } = rig(s);
    const noHead = { ...action(s) };
    noHead.payload = { n: 7, repo: NWO, method: "squash", unit: "u1", topic: "lc", base: "main", ref: `${NWO}#7`, ep: `${NWO}#7` };
    const a = noHead;
    const r = await exec(a, T);
    expect(r).toMatchObject({ done: true, result: "started" });
    expect(ghMerges(root)).toBe("pr merge 7 --repo o/r --auto --squash");
  });

  test("a refusal waits and tries again; the third failure raises one card and merge-failed", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    process.env.DS_GH = fakeGh(root, 1, "", "GraphQL: Auto-merge is not allowed for this repository (enableAutoMerge)");
    s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:merge-ready" },
      { squad: "lc", episode_key: `${NWO}#7|aaa`, count: 1, state: "merge-armed", source: "loop", started_at: T, observed_at: T });
    const { pokes, exec } = rig(s);
    const a = action(s);
    expect(await exec(a, T)).toMatchObject({ wait: expect.stringContaining("try 1 of 3"), at: T + 180 });
    expect(await exec(a, T + 180)).toMatchObject({ wait: expect.stringContaining("try 2 of 3"), at: T + 360 });
    expect(alertRows(s).filter((x) => x.title === "Auto-merge not armed")).toEqual([]);
    const r = await exec(a, T + 360);
    expect(r.done).toBe(true);
    expect(String(r.result)).toContain("not armed for aaa");
    // U286: the failure keeps gh's reason, so a rate-limited one can be told apart.
    expect(s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:merge-ready" })).toMatchObject({ state: "merge-failed", result: expect.stringContaining("enableAutoMerge") });
    const bad = alertRows(s).filter((x) => x.title === "Auto-merge not armed");
    expect(bad).toHaveLength(1);
    expect(String(bad[0].question)).toContain("could not arm auto-merge (squash)");
    expect(String(bad[0].question)).toContain("enableAutoMerge");
    expect(bad[0]).toMatchObject({ kind: "merge_card", ref: `${NWO}#7`, head: "aaa" });
    expect(pokes).toEqual([]);
  });

  test("U286: a rate-limited merge waits for GitHub's reset; it is no try, marks nothing failed and raises no card", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    process.env.DS_GH = fakeGh(root, 1, "", "GraphQL: API rate limit already exceeded for user ID 71901.");
    s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:merge-ready" },
      { squad: "lc", episode_key: `${NWO}#7|aaa`, count: 1, state: "merge-armed", source: "loop", started_at: T, observed_at: T });
    s.upsert("observed_github", { repo: "" }, { remaining: 0, reset_at: T + 1200, observed_at: T });
    const { pokes, exec } = rig(s);
    const a = action(s);
    for (const at of [T, T + 180, T + 360, T + 540]) expect(await exec(a, at)).toMatchObject({ wait: expect.stringContaining("rate limit"), at: T + 1230 });
    expect(s.get("episodes", { project: "fx", subject: a.subject, kind: "merge-tries" })).toBeNull();
    expect(alertRows(s).filter((x) => x.title === "Auto-merge not armed")).toEqual([]);
    expect(autoMergeRow(s)).toMatchObject({ state: "merge-armed" });
    expect(pokes).toEqual([]);
    // Past the observer's reset the free `gh api rate_limit` says when (here it fails: the retry gap).
    expect(await exec(a, T + 1300)).toMatchObject({ at: T + 1300 + 180 });
    expect(readFileSync(join(root, "gh.log"), "utf8")).toContain("api rate_limit --jq .resources.graphql");
  });

  // U290: a fake gh that refuses for the rate limit while a poisoned file sits in its cache dir.
  function cacheGh(root: string, cache: string): string {
    const f = join(root, "gh-cache.sh");
    writeFileSync(f, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(root, "gh.log")}"\n[ "$1 $2" = "pr merge" ] || exit 0\n` +
      `if [ -e "${cache}/gh/poison" ]; then echo "GraphQL: API rate limit already exceeded for user ID 71901." >&2; exit 1; fi\necho merged\n`);
    chmodSync(f, 0o755);
    return f;
  }
  function cacheRig(budget: Row | null) {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    const cache = join(root, "cache"); mkdirSync(join(cache, "gh"), { recursive: true });
    const poison = join(cache, "gh", "poison"), keep = join(cache, "gh", "keep");
    writeFileSync(keep, `HTTP/2.0 200 OK\n\n{"data":{"repository":{"id":"x"}}}`);
    process.env.DS_GH = cacheGh(root, cache); process.env.XDG_CACHE_HOME = cache;
    if (budget) s.upsert("observed_github", { repo: "" }, { ...budget, observed_at: T });
    return { s, root, poison, keep, ...rig(s) };
  }
  const savedXdg = process.env.XDG_CACHE_HOME;
  afterEach(() => { if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = savedXdg; });
  const POISON = `HTTP/2.0 200 OK\n\n{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit","message":"API rate limit already exceeded"}]}`;
  const mergeRuns = (root: string) => readFileSync(join(root, "gh.log"), "utf8").split("\n").filter((l) => l.startsWith("pr merge")).length;

  test("U290: a rate-limited merge with budget left clears gh's poisoned cache entries and merges in one exec", async () => {
    const { s, root, poison, keep, exec } = cacheRig({ remaining: 4000, reset_at: T + 1200, rate_limit: 5000 });
    writeFileSync(poison, POISON);
    const r = await exec(action(s), T + 10);
    expect(r).toMatchObject({ done: true });
    expect(existsSync(poison)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(mergeRuns(root)).toBe(2);
    expect(s.db.query("SELECT payload FROM events WHERE kind = 'gh_cache_cleared'").all()).toHaveLength(1);
    expect(alertRows(s).filter((x) => x.kind === "gh_cache_cleared" && String(x.question).includes("cleared 1 entry"))).toHaveLength(1);
  });

  test("U290: a rate-limited merge with the budget used up waits as today and touches no cache file", async () => {
    const { s, root, poison, exec } = cacheRig({ remaining: 0, reset_at: T + 1200, rate_limit: 5000 });
    writeFileSync(poison, POISON);
    expect(await exec(action(s), T + 10)).toMatchObject({ wait: expect.stringContaining("rate limit"), at: T + 1230 });
    expect(existsSync(poison)).toBe(true);
    expect(mergeRuns(root)).toBe(1);
    expect(s.db.query("SELECT 1 FROM events WHERE kind = 'gh_cache_cleared'").all()).toEqual([]);
  });

  test("U290: a rate-limited merge with budget left and nothing poisoned waits as today", async () => {
    const { s, root, poison, keep, exec } = cacheRig({ remaining: 4000, reset_at: T + 1200, rate_limit: 5000 });
    writeFileSync(poison, "not a cached error");   // makes the fake refuse, but is no GraphQL rate-limit body
    expect(await exec(action(s), T + 10)).toMatchObject({ wait: expect.stringContaining("rate limit"), at: T + 10 + 180 });
    expect(existsSync(poison)).toBe(true);
    expect(existsSync(keep)).toBe(true);
    expect(mergeRuns(root)).toBe(1);
    expect(s.db.query("SELECT 1 FROM events WHERE kind = 'gh_cache_cleared'").all()).toEqual([]);
  });

  test("U286: with no reset on the row a rate-limited merge asks gh api rate_limit when to come back", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    const f = join(root, "gh-rl.sh");
    writeFileSync(f, `#!/usr/bin/env bash\n[ "$1 $2" = "api rate_limit" ] && { echo '{"limit":5000,"used":5000,"remaining":0,"reset":${T + 900}}'; exit 0; }\necho "gh: API rate limit exceeded for user ID 1. (HTTP 403)" >&2; exit 1\n`);
    chmodSync(f, 0o755);
    process.env.DS_GH = f;
    const { exec } = rig(s);
    expect(await exec(action(s), T)).toMatchObject({ wait: expect.stringContaining("rate limit"), at: T + 930 });
  });

  test("U286: a secondary limit (budget left) waits the retry gap, not the hourly reset", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    process.env.DS_GH = fakeGh(root, 1, "", "gh: You have exceeded a secondary rate limit. (HTTP 403)");
    s.upsert("observed_github", { repo: "" }, { cost: 6, remaining: 4000, reset_at: T + 3000, observed_at: T });
    const { exec } = rig(s);
    expect(await exec(action(s), T)).toMatchObject({ wait: expect.stringContaining("rate limit"), at: T + 180 });
    expect(s.get("episodes", { project: "fx", subject: action(s).subject, kind: "merge-tries" })).toBeNull();
  });

  test("a refusal then success on the second try: no card, merged, one Lead poke", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    const f = join(root, "gh-flaky.sh");
    writeFileSync(f, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(root, "gh.log")}"\n[ "$1" = api ] && { echo false; exit 0; }\nif [ -e "${join(root, "seen")}" ]; then exit 0; fi\ntouch "${join(root, "seen")}"; echo "HTTP 502" >&2; exit 1\n`);
    chmodSync(f, 0o755);
    process.env.DS_GH = f;
    const { pokes, exec } = rig(s);
    const a = action(s);
    expect(await exec(a, T)).toMatchObject({ wait: expect.stringContaining("502") });
    expect(await exec(a, T + 180)).toMatchObject({ done: true, result: "started" });
    expect(pokes).toHaveLength(1);
    expect(alertRows(s).filter((x) => x.kind !== "limit")).toEqual([]);
    expect(since(s, 0, { kinds: ["auto_merge_armed"] })).toHaveLength(1);
  });

  test("allow_auto_merge false merges directly, without --auto, and says so", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    const f = join(root, "gh-direct.sh");
    writeFileSync(f, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(root, "gh.log")}"\n[ "$1" = api ] && echo false\nexit 0\n`);
    chmodSync(f, 0o755);
    process.env.DS_GH = f;
    const { pokes, exec } = rig(s);
    expect(await exec(action(s), T)).toMatchObject({ done: true });
    expect(ghMerges(root)).toBe("pr merge 7 --repo o/r --squash --match-head-commit aaa");
    expect(JSON.parse(String(since(s, 0, { kinds: ["auto_merge_armed"] })[0].payload))).toMatchObject({ direct: true });
    expect(pokes[0].text).toContain("the loop merged it (squash)");
  });

  test("a failed direct merge's card says to merge by hand", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    mkdirSync(join(root, "fx"), { recursive: true });
    const f = join(root, "gh-directfail.sh");
    writeFileSync(f, `#!/usr/bin/env bash\n[ "$1" = api ] && { echo false; exit 0; }\necho "not mergeable" >&2; exit 1\n`);
    chmodSync(f, 0o755);
    process.env.DS_GH = f;
    const { exec } = rig(s);
    const a = action(s);
    await exec(a, T); await exec(a, T + 180); await exec(a, T + 360);
    const bad = alertRows(s).filter((x) => x.title === "Auto-merge not armed");
    expect(String(bad[0].question)).toContain("direct merge failed 3 times (not mergeable). Merge it by hand");
  });

  test("a moved head ends the episode as stale", () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { state: "OPEN", doc: JSON.stringify({ headRefOid: "aaa" }) });
    expect(merge.stale?.(action(s), { store: s } as never)).toBe(false);
    pr(s, 7, { state: "OPEN", doc: JSON.stringify({ headRefOid: "bbb" }) });
    expect(merge.stale?.(action(s), { store: s } as never)).toBe(true);
  });

  test("stale when the PR left the open state; a bad payload fails", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { state: "OPEN" });
    const a = action(s);
    expect(merge.stale?.(a, { store: s } as never)).toBe(false);
    pr(s, 7, { state: "MERGED" });
    expect(merge.stale?.(a, { store: s } as never)).toBe(true);
    const { exec } = rig(s);
    expect(await exec({ ...a, payload: { n: 7 } }, T)).toMatchObject({ failed: expect.anything() });
  });
});

describe("merge cards clear themselves (U240)", () => {
  const card = (extra: Row = {}): Row => ({ asker: "sweep", id: "loop-x-1", title: "lc · u1: Auto-merge not armed", kind: "merge_card", ref: `${NWO}#7`, head: "aaa",
    question: "PR #7 (lc/u1) is merge-ready but ...", since: new Date(T * 1000).toISOString(), ...extra });
  const gone = (s: Store, a: Row) => alertGone(s, "fx", a, T + 60);
  test("merged, closed, or a newer head drops the card with its reason; an open PR on the same head keeps it", () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { state: "OPEN", doc: JSON.stringify({ headRefOid: "aaa" }) });
    expect(gone(s, card())).toBe(false);
    pr(s, 7, { state: "OPEN", doc: JSON.stringify({ headRefOid: "bbb" }) });
    expect(gone(s, card())).toBe("the PR has a newer head");
    pr(s, 7, { state: "MERGED" });
    expect(gone(s, card())).toBe("the PR merged");
    pr(s, 7, { state: "CLOSED" });
    expect(gone(s, card())).toBe("the PR closed");
  });
  test("today's #430 card (no fields, kind or head) drops once the PR row is MERGED", () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 430, { state: "OPEN", doc: JSON.stringify({ headRefOid: "eae2830" }) });
    const old = card({ kind: undefined, ref: undefined, head: undefined, title: "Auto-merge not armed", question: "PR #430 (sweep-run-loop/u1) is merge-ready but the loop could not arm auto-merge (squash): ..." });
    expect(gone(s, old)).toBe(false);
    pr(s, 430, { state: "MERGED", doc: JSON.stringify({ headRefOid: "eae2830" }) });
    expect(gone(s, old)).toBe("the PR merged");
  });
  test("the left-open card goes the same way", () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { state: "MERGED" });
    expect(gone(s, card({ title: "Merge-ready PR left open" }))).toBe("the PR merged");
  });
});
