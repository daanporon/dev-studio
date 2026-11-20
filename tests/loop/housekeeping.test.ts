// housekeeping.test.ts — U10: the sweep's steps 0, 5, 6 and 8 as reconcilers (tokens.ts, alerts.ts,
// compaction.ts), and U67's one "Restart failed" card per member (alerts.ts clears it; U154 removed
// the run-switch giveUp that filed it). The scenarios carry the names of their the removed sweep tests counterparts. Each test
// works on an empty temp state root with one project; rows are written as the observers write them,
// and a Loop with a recording actuator stands for the tick, so "once per episode" is the tick's claim.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRoot } from "./temp-roots.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import type { Action, Actuator, Reconciler } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { mangle } from "../../bin/loop/observers/orca.ts";
import { stateObserver } from "../../bin/loop/observers/state.ts";
import compaction from "../../bin/loop/reconcilers/compaction.ts";
import alerts, { alertGone, cksum, unitSpend } from "../../bin/loop/reconcilers/alerts.ts";
import { cardTitle } from "../../bin/loop/messages/cards.ts";
import { wake } from "../../bin/loop/pause/wake.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import pokeFulfiller from "../../bin/loop/fulfil/poke.ts";
import { realLogScanAllowed, squadSpend, tokensReconciler } from "../../bin/loop/reconcilers/tokens.ts";

const L = "lbl";
const T = 1_800_000_000;
const ws = (n: string) => `id::/home/me/ws/ds-${L}-${n}`;
const LEAD = ws("lead-auth"), THINKER = ws("thinker-auth"), BUILDER = ws("builder-u2-auth"), STUDIO = ws("studio");

const temps: string[] = [], stores: Store[] = [], envs = new Map<string, string | undefined>();
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of envs) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  envs.clear();
});
function tmp(): string { return tempRoot("zzloop-"); }
function setEnv(k: string, v: string) { if (!envs.has(k)) envs.set(k, process.env[k]); process.env[k] = v; }

// A state root with project `lbl`, the conventions' limits as config rows, and DS_TOKEN_DIR.
function root(): { s: Store; tok: string } {
  const d = tmp(), tok = join(d, "tok");
  mkdirSync(join(d, L, "squads"), { recursive: true });
  mkdirSync(tok);
  setEnv("DS_TOKEN_DIR", tok);
  const s = open(d);
  stores.push(s);
  importConfig(s, d);
  return { s, tok };
}
function squad(s: Store, topic: string, doc: Row = {}, status = "running") {
  s.upsert("squads", { project: L, topic }, { status, doc: JSON.stringify({ topic, status, ...doc }), observed_at: T, updated_at: T });
}
function member(s: Store, topic: string, role: string, wt: string, suffix = "") {
  s.upsert("members", { project: L, squad: topic, wt }, { role, suffix, status: "running", observed_at: T, updated_at: T });
}
function unit(s: Store, topic: string, slug: string, status: string, tier: string | null = null, wt: string | null = null) {
  s.upsert("units", { project: L, squad: topic, slug }, { status, tier, builder_wt: wt, observed_at: T, updated_at: T });
}
function worker(s: Store, wt: string, state: string, since = T - 600, unread = 0) {
  s.upsert("observed_workers", { project: L, wt }, { state, since, unread, observed_at: T, gone_at: null });
}
function limitRow(s: Store, key: string, value: string, project = L) {
  s.upsert("config", { project, file: "limits.conf", key }, { value, observed_at: T });
}
// A transcript whose last usage record makes `ctx`; `after` lines follow it.
const usage = (ctx: number, model = "claude-opus-5-5") =>
  JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: ctx - 3, output_tokens: 3 } } });
const BOUNDARY = JSON.stringify({ type: "system", subtype: "compact_boundary" });
let seq = 0;
function transcript(s: Store, tok: string, wt: string, lines: string[], observed = true) {
  const dir = join(tok, mangle(wt.split("::")[1])), p = join(dir, "s.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
  const at = T + ++seq; // a new mtime each write, as a live transcript moves
  utimesSync(p, at, at);
  if (observed) s.upsert("observed_transcripts", { path: p }, { project: L, wt, mtime: at, size: lines.join("\n").length + 1, observed_at: T });
}

function recorder(): Actuator & { got: Action[] } {
  const got: Action[] = [];
  return { got, act(a) { got.push(a); } };
}
function loopOf(s: Store, ...reconcilers: Reconciler[]) {
  const rec = recorder();
  const loop = new Loop(s, { observers: [], reconcilers }, rec, { projects: () => [L] });
  return { rec, tick: async (at: number) => (await loop.tick(at)).acted };
}
const pokes = (acted: Action[]) => acted.filter((a) => a.kind === "poke");
const texts = (acted: Action[]) => pokes(acted).map((a) => `${a.member} ${(a.payload as Row).text}`);
const alertsOf = (acted: Action[]) => acted.filter((a) => a.kind === "alert");

describe("step 0: token spend", () => {
  // The real token-usage.sh over a transcript under DS_TOKEN_DIR, in the background.
  const waitscan = async (tf: string) => { for (let i = 0; i < 100 && (!existsSync(tf) || existsSync(`${tf}.lock`)); i++) await Bun.sleep(50); };
  const now = () => Math.floor(Date.now() / 1000);

  test("tokens: the sweep writes the worker's spend, lock released, fresh not rescanned, old rescanned, a running scan not doubled", async () => {
    const { s, tok } = root(), tf = join(s.root, "tokens.tsv");
    const tw = join(tok, mangle(BUILDER.split("::")[1]));
    mkdirSync(tw);
    writeFileSync(join(tw, "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
      message: { id: "k1", model: "claude-opus-5-5", usage: { input_tokens: 1, cache_creation_input_tokens: 4000, cache_read_input_tokens: 2, output_tokens: 3 } } }) + "\n");
    await tokensReconciler().run({ store: s, project: "", tick: 1, now: now(), fired: [], poked: new Set() });
    await waitscan(tf);
    const row = readFileSync(tf, "utf8").split("\n").map((l) => l.split("\t")).find((r) => r[0] === mangle(BUILDER.split("::")[1]));
    expect(row?.[6], "tokens: the sweep writes the worker's spend").toBe("4000");
    expect(existsSync(`${tf}.lock`), "tokens: lock released after the scan").toBe(false);

    writeFileSync(tf, "fresh");
    await tokensReconciler().run({ store: s, project: "", tick: 2, now: now(), fired: [], poked: new Set() });
    await Bun.sleep(500);
    expect(readFileSync(tf, "utf8"), "tokens: a fresh file is not rescanned").toBe("fresh");

    utimesSync(tf, now() - 600, now() - 600);
    await tokensReconciler().run({ store: s, project: "", tick: 3, now: now(), fired: [], poked: new Set() });
    for (let i = 0; i < 100 && readFileSync(tf, "utf8") === "fresh"; i++) await Bun.sleep(50);
    await waitscan(tf);
    expect(readFileSync(tf, "utf8"), "tokens: a 5+ min old file is rescanned").toContain("builder-u2-auth");

    rmSync(tf);
    mkdirSync(`${tf}.lock`);
    await tokensReconciler().run({ store: s, project: "", tick: 4, now: now(), fired: [], poked: new Set() });
    await Bun.sleep(500);
    expect(existsSync(tf), "tokens: a running scan (lock) is not doubled").toBe(false);
  });

  test("DS_PREFIX: the scan, squadSpend and squad-spent.sh count that prefix's workers and no other", async () => {
    const { s, tok } = root(), tf = join(s.root, "tokens.tsv");
    setEnv("DS_PREFIX", "tst-");
    squad(s, "auth");
    const session = (name: string, id: string, input: number) => {
      mkdirSync(join(tok, name));
      writeFileSync(join(tok, name, "s.jsonl"), JSON.stringify({ type: "user", message: 'builder of squad "auth".' }) + "\n" + JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
        message: { id, model: "m", usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } }) + "\n");
    };
    session(`-home-me-ws-${L}-tst-${L}-builder-u2-auth`, "a", 7);
    session(`-home-me-ws-${L}-ds-${L}-builder-u2-auth`, "b", 1000);
    session(`-home-me-ws-tst-other-builder-u2-auth`, "c", 2000);
    await tokensReconciler().run({ store: s, project: "", tick: 1, now: now(), fired: [], poked: new Set() });
    await waitscan(tf);
    const rows = readFileSync(tf, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
    expect(rows.map((r) => [r[0], r[1], r[2], r[5]]).sort(), "the scan reads this prefix's folders, and the project is not taken for the role").toEqual([
      [`-home-me-ws-${L}-tst-${L}-builder-u2-auth`, "auth", "builder", "7"],
      ["-home-me-ws-tst-other-builder-u2-auth", "auth", "builder", "2000"],
    ].sort());
    for (const r of rows) s.upsert("observed_tokens", { worker: r[0], model: r[3] }, { topic: r[1], role: r[2], input: Number(r[5]), observed_at: T });
    s.upsert("observed_tokens", { worker: `-home-me-ws-ds-${L}-builder-u3-auth`, model: "m" }, { topic: "auth", role: "builder", input: 500, observed_at: T });
    expect(squadSpend(s, L, "auth"), "squadSpend: this prefix and label only").toMatchObject({ total: 7, builders: 7 });

    writeFileSync(join(s.root, L, "squads", "auth.json"), JSON.stringify({ topic: "auth", members: [{ since: "2020-01-01T00:00:00Z" }] }));
    const p = Bun.spawnSync(["bash", join(import.meta.dir, "..", "..", "bin", "lib", "squad-spent.sh"), L, "--dir", tok], { env: { ...process.env, DS_STATE_ROOT: s.root } });
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    expect(readFileSync(join(s.root, L, "loop", "squad-spent.tsv"), "utf8").split("\t").slice(2, 7), "squad-spent.sh: this prefix and label only").toEqual(["7", "0", "0", "7", "0"]);

    // A session folder's name has `-` for a label's `.`.
    s.upsert("observed_tokens", { worker: "-home-me-ws-tst-my-repo-builder-u2-dotted", model: "m" }, { topic: "dotted", role: "builder", input: 9, observed_at: T });
    expect(squadSpend(s, "my.repo", "dotted"), "squadSpend: a label with a dot").toMatchObject({ total: 9, builders: 9 });
    const dotted = join(s.root, "my.repo");
    mkdirSync(join(dotted, "squads"), { recursive: true });
    writeFileSync(join(dotted, "squads", "dotted.json"), JSON.stringify({ topic: "dotted", members: [{ since: "2020-01-01T00:00:00Z" }] }));
    session("-home-me-ws-tst-my-repo-builder-u2-dotted", "d", 9);
    writeFileSync(join(tok, "-home-me-ws-tst-my-repo-builder-u2-dotted", "s.jsonl"), readFileSync(join(tok, "-home-me-ws-tst-my-repo-builder-u2-dotted", "s.jsonl"), "utf8").replace('squad \\"auth\\"', 'squad \\"dotted\\"'));
    const q = Bun.spawnSync(["bash", join(import.meta.dir, "..", "..", "bin", "lib", "squad-spent.sh"), "my.repo", "--dir", tok], { env: { ...process.env, DS_STATE_ROOT: s.root } });
    expect(q.exitCode, q.stderr.toString()).toBe(0);
    expect(readFileSync(join(dotted, "loop", "squad-spent.tsv"), "utf8").split("\t").slice(2, 7), "squad-spent.sh: a label with a dot").toEqual(["9", "0", "0", "9", "0"]);
  });

  test("U102: the background review-only scan uses loop member and closed-unit metadata", async () => {
    const { s, tok } = root(), tf = join(s.root, "tokens.tsv");
    squad(s, "auth");
    member(s, "auth", "builder", BUILDER, "u2");
    const closed = ws("builder-u99-ambiguous-unit-name");
    unit(s, "auth", "u99", "done", null, closed);
    for (const wt of [BUILDER, closed]) {
      transcript(s, tok, wt, [JSON.stringify({ type: "user", entrypoint: "sdk-cli", message: { content: "/compound-engineering:ce-code-review base:origin/main" } }),
        JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id: wt, model: "m", usage: { input_tokens: 7 } } })], false);
    }
    await tokensReconciler().run({ store: s, project: "", tick: 1, now: now(), fired: [], poked: new Set() });
    await waitscan(tf);
    const rows = readFileSync(tf, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
    expect(rows.map((r) => [r[0], r[1], r[2]]).sort()).toEqual([BUILDER, closed].map((w) => [mangle(w.split("::")[1]) + ":review", "auth", "review"]).sort());
    await stateObserver({ refreshAccounts: () => {} }).run({ store: s, project: "", tick: 2, now: T, fired: [], poked: new Set() });
    expect(squadSpend(s, L, "auth")).toMatchObject({ total: 14, builders: 0, other: 14 });
  });

  // Spend per squad from observed_tokens.
  function spendRoot() {
    const r = root(), asked: number[] = [];
    squad(r.s, "auth");
    member(r.s, "auth", "lead", LEAD);
    r.s.upsert("members", { project: L, squad: "auth", wt: LEAD }, { since: "2027-01-15T08:00:00.5Z" });
    const tokens = (worker: string, role: string, model: string, input: number, cw: number, cr: number, out: number) =>
      r.s.upsert("observed_tokens", { worker, model }, { topic: "auth", role, input, cache_write: cw, cache_read: cr, output: out, observed_at: T });
    return { ...r, asked, tokens, rec: tokensReconciler({ refreshTokens: () => { asked.push(1); } }) };
  }
  const spent = (s: Store) => readFileSync(join(s.root, L, "loop", "squad-spent.tsv"), "utf8");
  const run = (s: Store, rec: Reconciler, at: number) => rec.run({ store: s, project: "", tick: 1, now: at, fired: [], poked: new Set() });

  test("spend written once per interval: squad-spent.tsv and observed_spend, by role, price-weighted", async () => {
    const { s, tokens, rec, asked } = spendRoot();
    tokens(`-home-me-ws-ds-${L}-lead-auth`, "lead", "m", 10, 100, 1000, 2);       // 10 + 125 + 100 + 10 = 245
    tokens(`-home-me-ws-ds-${L}-builder-u2-auth`, "builder", "m", 0, 1000, 0, 0); // 1250
    tokens(`-home-me-ws-ds-${L}-tester-auth`, "tester", "m", 5, 0, 0, 0);          // other: 5
    tokens(`-home-me-ws-ds-${L}-builder-u2-auth`, "builder", "<synthetic>", 99, 99, 99, 99);
    tokens("-home-me-ws-ds-other-lead-auth", "lead", "m", 99, 99, 99, 99);       // another label's
    await run(s, rec, T);
    const since = Math.floor(Date.parse("2027-01-15T08:00:00.5Z") / 1000);
    expect(spent(s)).toBe(`auth\t${since}\t1500\t245\t0\t1250\t5\t0\n`);
    expect(s.get("observed_spend", { project: L, squad: "auth" })).toMatchObject({ since, total: 1500, lead: 245, builders: 1250, other: 5, frozen: 0 });
    expect(asked.length, "tokens.tsv refresh asked for").toBe(1);

    tokens(`-home-me-ws-ds-${L}-tester-auth`, "tester", "m", 105, 0, 0, 0);
    await run(s, rec, T + 60);
    expect(spent(s), "within the interval: not rewritten").toContain("\t5\t0\n");
    expect(asked.length, "  nor tokens.tsv asked for again").toBe(1);
    await run(s, rec, T + 301);
    expect(spent(s), "after DS_SWEEP_TOKENS_MIN: rewritten").toBe(`auth\t${since}\t1600\t245\t0\t1250\t105\t0\n`);
  });

  test("U102: spend weighs cache writes by TTL and Opus reads at 0.05; a :review row counts under other", async () => {
    const { s, tokens, rec } = spendRoot();
    const row = (worker: string, role: string, model: string, w: [number, number], cr: number) =>
      s.upsert("observed_tokens", { worker, model }, { topic: "auth", role, input: 0, cache_write: w[0] + w[1], cache_read: cr, output: 0, cw_1h: w[0], cw_5m: w[1], observed_at: T });
    row(`-home-me-ws-ds-${L}-builder-u2-auth`, "builder", "claude-opus-5-5", [1000, 400], 2000);   // 2000 + 500 + 100 = 2600
    row(`-home-me-ws-ds-${L}-builder-u2-auth:review`, "review", "claude-opus-5-5", [100, 0], 0);   // 200
    tokens(`-home-me-ws-ds-${L}-lead-auth`, "lead", "claude-sonnet-5-5", 0, 100, 1000, 0);        // no split: 125 + 100
    await run(s, rec, T);
    const since = Math.floor(Date.parse("2027-01-15T08:00:00.5Z") / 1000);
    expect(spent(s)).toBe(`auth\t${since}\t3025\t225\t0\t2600\t200\t0\n`);
  });

  test("a live squad's spend never drops below the last row; a closed squad is frozen once", async () => {
    const { s, tokens, rec } = spendRoot();
    mkdirSync(join(s.root, L, "loop"), { recursive: true });
    writeFileSync(join(s.root, L, "loop", "squad-spent.tsv"), "auth\t1\t9000\t9000\t0\t0\t0\t0\nold\t5\t70\t70\t0\t0\t0\t1\n");
    utimesSync(join(s.root, L, "loop", "squad-spent.tsv"), T - 3600, T - 3600);
    squad(s, "old", {}, "closed");
    squad(s, "gone-now", {}, "closed");
    tokens(`-home-me-ws-ds-${L}-lead-auth`, "lead", "m", 10, 0, 0, 0);
    s.upsert("observed_tokens", { worker: `-home-me-ws-ds-${L}-lead-gone-now`, model: "m" }, { topic: "gone-now", role: "lead", input: 7, observed_at: T });
    s.upsert("observed_tokens", { worker: `-home-me-ws-ds-${L}-lead-old`, model: "m" }, { topic: "old", role: "lead", input: 7, observed_at: T });
    await run(s, rec, T);
    const rows = Object.fromEntries(spent(s).trim().split("\n").map((l) => [l.split("\t")[0], l]));
    expect(rows.auth.split("\t").slice(2, 7), "the 7-day window shrank: keep the lifetime total and assign missing history to other").toEqual(["9000", "10", "0", "0", "8990"]);
    expect(rows.old, "a frozen row is kept as is").toBe("old\t5\t70\t70\t0\t0\t0\t1");
    expect(rows["gone-now"].split("\t").slice(2).join(" "), "a closed squad without a frozen row: computed, then frozen").toBe("7 7 0 0 0 1");
  });

  test("U102: reclassifying Builder spend as review does not keep the old Builder bucket", async () => {
    const { s, tokens, rec } = spendRoot();
    const worker = `-home-me-ws-ds-${L}-builder-u2-auth`;
    tokens(worker, "builder", "m", 100, 0, 0, 0);
    await run(s, rec, T);
    s.db.run("DELETE FROM observed_tokens WHERE worker = ?", [worker]);
    tokens(`${worker}:review`, "review", "m", 100, 0, 0, 0);
    await run(s, rec, T + 301);
    expect(s.get("observed_spend", { project: L, squad: "auth" })).toMatchObject({ total: 100, builders: 0, other: 100 });
    tokens(`${worker}:review`, "review", "m", 20, 0, 0, 0);
    tokens(`-home-me-ws-ds-${L}-lead-auth`, "lead", "m", 10, 0, 0, 0);
    await run(s, rec, T + 602);
    expect(s.get("observed_spend", { project: L, squad: "auth" })).toMatchObject({ total: 100, lead: 10, builders: 0, other: 90 });
    tokens(`-home-me-ws-ds-${L}-lead-auth`, "lead", "m", 200, 0, 0, 0);
    await run(s, rec, T + 903);
    expect(s.get("observed_spend", { project: L, squad: "auth" })).toMatchObject({ total: 220, lead: 200, builders: 0, other: 20 });
  });
});

describe("step 5: runaway unit", () => {
  // runaway <running unit's cache_write>: three done standard units at 2M, a hard one at 90M.
  function runaway(cw: number, withDone = true) {
    const { s } = root();
    squad(s, "auth");
    const units: [string, string, string][] = [["d1", "done", "standard"], ["d2", "done", "standard"], ["d3", "done", "standard"], ["h1", "done", "hard"], ["u2", "dispatched", "standard"]];
    for (const [slug, st, tier] of units) {
      if (st === "done" && !withDone) continue;
      unit(s, "auth", slug, st, tier, `id::/w/${slug}`);
      // U232: a figure counts as full when its Builder started inside the token window.
      s.upsert("members", { project: L, squad: "auth", wt: `id::/w/${slug}` }, { role: "builder", suffix: slug, status: "running", since: new Date((T - 3600) * 1000).toISOString(), observed_at: T, updated_at: T });
      s.upsert("observed_tokens", { worker: `-w-${slug}`, model: "m" }, { topic: "auth", role: "builder", cache_write: slug === "u2" ? cw : slug === "h1" ? 90_000_000 : 2_000_000, observed_at: T });
    }
    return s;
  }

  test("runaway unit (7M vs median 2M): one alert; rerun: no second alert", async () => {
    const s = runaway(7_000_000), { tick } = loopOf(s, alerts);
    const a = alertsOf(await tick(T));
    expect(a.length, "runaway unit (7M vs median 2M): one alert").toBe(1);
    const p = a[0].payload as Row;
    expect(p.text, "  names the unit, tokens and the median").toContain("u2 in auth has spent 7.0M");
    expect(p.text, "  and the median").toContain("median 2.0M of 3 done standard units");
    expect(a[0]).toMatchObject({ squad: "auth", subject: "unit-tokens.auth.u2", episode: "unit-tokens" });
    expect(p, "unit-tokens alert: its own option").toMatchObject({ target: "squad", option: "looked at it", title: "Unit spending a lot", unit: "u2", id: `sweep-unit-tokens.auth.u2-${cksum("unit-tokens")}` });
    expect(alertsOf(await tick(T + 60)).length, "  rerun: no second alert").toBe(0);
  });

  test("U102: a unit whose cost is mostly review alerts: the Builder row and its :review row add up", async () => {
    const s = runaway(1_000_000);
    s.upsert("observed_tokens", { worker: "-w-u2:review", model: "m" }, { topic: "auth", role: "review", cache_write: 6_000_000, observed_at: T });
    const { tick } = loopOf(s, alerts);
    const a = alertsOf(await tick(T));
    expect(a.length, "1M own + 6M review > 3x the 2M median").toBe(1);
    expect((a[0].payload as Row).text).toContain("u2 in auth has spent 7.0M");
  });

  test("5M (under 3x median): no alert", async () => {
    const { tick } = loopOf(runaway(5_000_000), alerts);
    expect(alertsOf(await tick(T)).length).toBe(0);
  });

  test("fewer than 3 done units: the absolute cap", async () => {
    const { tick } = loopOf(runaway(25_000_000, false), alerts);
    expect((alertsOf(await tick(T))[0]?.payload as Row)?.text).toContain("over the 20M cap");
  });

  test("an episode the sweep already alerted (its .alerted marker) is not alerted again", async () => {
    const s = runaway(7_000_000);
    s.upsert("episodes", { project: L, subject: "unit-tokens.auth.u2", kind: "alerted" }, { state: JSON.stringify(["unit-tokens"]), episode_key: "unit-tokens", source: "sweep", observed_at: T });
    const { tick } = loopOf(s, alerts);
    expect(alertsOf(await tick(T)).length).toBe(0);
  });

  test("cksum is POSIX cksum (the sweep's alert ids)", () => {
    const sh = Bun.spawnSync(["sh", "-c", "printf '%s' 'ctx|id::/w/studio' | cksum"]).stdout.toString().split(" ")[0];
    expect(String(cksum("ctx|id::/w/studio"))).toBe(sh);
  });
});

describe("step 6: idle compaction", () => {
  // A squad with a done unit (not planning), its Lead, Thinker and Builder.
  function team(opts: { units?: boolean; defaultIdle?: boolean } = {}) {
    const r = root();
    if (!opts.defaultIdle) limitRow(r.s, "compact_idle_min", "2");   // the tests below idle 10 min; the default (55) has its own test
    squad(r.s, "auth");
    member(r.s, "auth", "lead", LEAD);
    member(r.s, "auth", "thinker", THINKER);
    member(r.s, "auth", "builder", BUILDER, "u2");
    if (opts.units !== false) unit(r.s, "auth", "u1", "done");
    return r;
  }

  test("idle Thinker at 151k: /compact typed; within the cooldown: not typed again; after the cooldown: typed again", async () => {
    const { s, tok } = team();
    limitRow(s, "compact_mode_thinker", "compact"); // clearing has its own test
    worker(s, THINKER, "idle");
    transcript(s, tok, THINKER, [usage(251_000)]);
    const { tick } = loopOf(s, compaction);
    const a = await tick(T);
    expect(texts(a), "idle Thinker at 151k: /compact typed").toEqual([`${THINKER} /compact`]);
    expect(pokes(a)[0].payload).toMatchObject({ mode: "compact", ctx: 251_000, thr: 120_000, requireIdle: true, reason: "compact" });
    expect(s.get("episodes", { project: L, subject: THINKER, kind: "wake:compact" })?.started_at, "the compacted.tsv equivalent").toBe(T);
    expect(texts(await tick(T + 60)), "  within the cooldown: not typed again").toEqual([]);
    expect(texts(await tick(T + 31 * 60)), "  after the cooldown: typed again").toEqual([`${THINKER} /compact`]);
  });

  test("the sweep's compacted.tsv (observed and imported) counts toward the cooldown", async () => {
    const { s, tok } = team();
    worker(s, THINKER, "idle");
    transcript(s, tok, THINKER, [usage(251_000)]);
    s.upsert("observed_compacted", { project: L, wt: THINKER }, { at: T - 60, observed_at: T });
    const { tick } = loopOf(s, compaction);
    expect(texts(await tick(T))).toEqual([]);
  });

  test("compact_boundary after the last usage: not compacted; a usage record after the boundary: compacted again", async () => {
    const { s, tok } = team();
    worker(s, THINKER, "idle");
    transcript(s, tok, THINKER, [usage(251_000), BOUNDARY]);
    const { tick } = loopOf(s, compaction);
    expect(texts(await tick(T)), "compact_boundary after the last usage: not compacted").toEqual([]);
    transcript(s, tok, THINKER, [usage(251_000), BOUNDARY, usage(251_000)]);
    expect(texts(await tick(T + 60)), "  a usage record after the boundary: compacted again").toEqual([`${THINKER} /compact`]);
  });

  test("idle Thinker with open plan-x question: not compacted; after the question is resolved: compacted", async () => {
    const { s, tok } = team();
    squad(s, "auth", { waiting_on_you: [{ id: "plan-x", asker: "thinker" }] });
    worker(s, THINKER, "idle");
    transcript(s, tok, THINKER, [usage(251_000)]);
    const { tick } = loopOf(s, compaction);
    expect(texts(await tick(T))).toEqual([]);
    squad(s, "auth", { waiting_on_you: [] });
    expect(texts(await tick(T + 60))).toEqual([`${THINKER} /compact`]);
  });

  test("idle Thinker, squad planning (no unit dispatched/done): not compacted; once a unit is done: compacted", async () => {
    const { s, tok } = team({ units: false });
    unit(s, "auth", "u1", "planned");
    worker(s, THINKER, "idle");
    transcript(s, tok, THINKER, [usage(251_000)]);
    const { tick } = loopOf(s, compaction);
    expect(texts(await tick(T))).toEqual([]);
    unit(s, "auth", "u1", "done");
    expect(texts(await tick(T + 60))).toEqual([`${THINKER} /compact`]);
  });

  test("non-thinker in a planning squad: still compacted; non-thinker with an open question: still compacted", async () => {
    const { s, tok } = team({ units: false });
    worker(s, BUILDER, "idle");
    transcript(s, tok, BUILDER, [usage(160_000)]);
    const { tick } = loopOf(s, compaction);
    expect(texts(await tick(T)), "non-thinker in a planning squad: still compacted").toEqual([`${BUILDER} /compact`]);
    const r2 = team();
    squad(r2.s, "auth", { waiting_on_you: [{ id: "q", asker: "builder-u2" }] });
    worker(r2.s, BUILDER, "idle");
    transcript(r2.s, r2.tok, BUILDER, [usage(160_000)]);
    expect(texts(await loopOf(r2.s, compaction).tick(T)), "non-thinker with an open question: still compacted").toEqual([`${BUILDER} /compact`]);
  });

  // per-role thresholds: defaults lead 100k / thinker 120k / builder 150k; role key wins, else the global context_compact
  async function at(role: "lead" | "thinker" | "builder", ctx: number, setup: (s: Store) => void = () => {}) {
    const { s, tok } = team(), wt = { lead: LEAD, thinker: THINKER, builder: BUILDER }[role];
    setup(s);
    worker(s, wt, "idle");
    transcript(s, tok, wt, [usage(ctx)]);
    return texts(await loopOf(s, compaction).tick(T)).length;
  }
  test("per-role thresholds, project and env overrides, a non-numeric role key", async () => {
    expect(await at("lead", 110_000), "Lead at 110k (>= context_compact_lead 100k): compacted").toBe(1);
    expect(await at("thinker", 110_000), "Thinker at 110k (< 120k): left alone").toBe(0);
    expect(await at("thinker", 130_000), "Thinker at 130k (>= 120k): compacted").toBe(1);
    expect(await at("builder", 140_000), "Builder at 140k (< 150k): left alone").toBe(0);
    expect(await at("lead", 110_000, (s) => limitRow(s, "context_compact_lead", "200000")), "project override raises the Lead threshold: 110k left alone").toBe(0);
    setEnv("DS_LIMIT_CONTEXT_COMPACT_LEAD", "200000");
    expect(await at("lead", 110_000), "env override per key: 110k < 200k left alone").toBe(0);
    delete process.env.DS_LIMIT_CONTEXT_COMPACT_LEAD;
    expect(await at("lead", 110_000, (s) => { limitRow(s, "context_compact_lead", "lots"); limitRow(s, "context_compact", "105000"); }),
      "non-numeric role key falls back to global 105k: compacted").toBe(1);
  });

  test("below the threshold, idle too briefly, working or waiting: nothing; done: typed; mode off: never", async () => {
    expect(await at("thinker", 100_000), "idle Thinker below the threshold: nothing").toBe(0);
    {
      const { s, tok } = team();
      worker(s, BUILDER, "idle", T - 30);
      transcript(s, tok, BUILDER, [usage(300_000)]);
      expect(texts(await loopOf(s, compaction).tick(T)), "idle only 30 s (< compact_idle_min): nothing").toEqual([]);
    }
    for (const [st, n, name] of [["working", 0, "working Builder at 300k: left alone"], ["waiting", 0, "waiting Builder at 300k: left alone"], ["done", 1, "done Builder at 300k: /compact typed"]] as const) {
      const { s, tok } = team();
      worker(s, BUILDER, st);
      transcript(s, tok, BUILDER, [usage(300_000)]);
      expect(texts(await loopOf(s, compaction).tick(T)).length, name).toBe(n);
    }
    expect(await at("thinker", 300_000, (s) => limitRow(s, "compact_mode_thinker", "off")), "compact_mode_thinker off: never typed").toBe(0);
  });

  test("compact_idle_min follows the 1-hour cache: default 55 minutes, a project override still wins (U104)", async () => {
    const run = async (idleS: number, override?: string) => {
      const { s, tok } = team({ defaultIdle: true });
      if (override) limitRow(s, "compact_idle_min", override);
      worker(s, BUILDER, "idle", T - idleS);
      transcript(s, tok, BUILDER, [usage(300_000)]);
      return texts(await loopOf(s, compaction).tick(T)).length;
    };
    expect(await run(30 * 60), "idle 30 min, default: not compacted").toBe(0);
    expect(await run(55 * 60), "idle 55 min, default: compacted").toBe(1);
    expect(await run(3 * 60, "2"), "override 2: compacted at 3 min").toBe(1);
    expect(await run(60, "2"), "override 2: not at 1 min").toBe(0);
  });

  // clear: only a Lead with nothing in flight, else compact. U156: a clear writes a loop
  // clear_at wish and types nothing; the decider types the clear command and a fresh
  // transcript or rollout confirms it.
  async function clear(role: "lead" | "thinker", setup: (s: Store, tok: string) => void = () => {}, unread = 0, quiet = false) {
    setEnv("DS_NOW", String(T));   // wishOnce stamps now(); the tick below runs at T
    const { s, tok } = team(), wt = role === "lead" ? LEAD : THINKER;
    limitRow(s, `compact_mode_${role}`, "clear");
    worker(s, wt, "idle", T - 600, unread);
    transcript(s, tok, wt, [usage(300_000)]);
    if (quiet) { const p = join(tok, mangle(wt.split("::")[1]), "s.jsonl"); utimesSync(p, T - 600, T - 600); } // quiet for the whole idle window
    setup(s, tok);
    const acted = await loopOf(s, compaction).tick(T);
    const row = s.get("members", { project: L, squad: "auth", role, suffix: "" })!;
    return { typed: texts(acted)[0]?.split(" ")[1] as string | undefined, clearAt: row.clear_at as number | null, clearBy: row.clear_by as string | null };
  }
  test("clear: a Lead with nothing in flight writes a loop clear wish and types nothing; otherwise /compact", async () => {
    expect(await clear("lead"), "clear: Lead with nothing in flight -> clear wish, no poke").toMatchObject({ typed: undefined, clearAt: T, clearBy: "loop" });
    expect((await clear("lead", (s) => unit(s, "auth", "u2", "dispatched"))).typed, "clear: dispatched unit in flight -> /compact").toBe("/compact");
    expect((await clear("lead", (s) => squad(s, "auth", { waiting_on_you: [{ id: "q", asker: "lead" }] }))).typed, "clear: open question -> /compact").toBe("/compact");
    expect((await clear("lead", () => {}, 1)).typed, "clear: unread inbox -> /compact").toBe("/compact");
    expect(await clear("thinker", () => {}, 0, true), "clear: a Thinker with nothing open -> clear wish").toMatchObject({ typed: undefined, clearAt: T, clearBy: "loop" });
  });

  // U144: a Thinker is cleared only with nothing open; each blocker types /compact instead.
  // U156: none of these type; the clear cases write the wish instead.
  test("clear: a Thinker is cleared only with nothing open, else /compact; a repeat tick writes nothing new", async () => {
    const dir = (s: Store) => join(s.root, L, "squads");
    const wtDir = (tok: string) => join(tok, mangle(THINKER.split("::")[1]));
    const old = (p: string) => utimesSync(p, T - 600, T - 600);
    expect(await clear("thinker", (s) => squad(s, "auth", { waiting_on_you: [{ id: "q", asker: "thinker" }] }), 0, true), "open thinker question: skipped, not even compacted").toMatchObject({ typed: undefined, clearAt: null });
    expect((await clear("thinker", (s) => writeFileSync(join(dir(s), "auth-x-plan.md"), "p"), 0, true)).typed, "unapproved plan file").toBe("/compact");
    expect(await clear("thinker", (s) => { writeFileSync(join(dir(s), "auth-x-plan.md"), "p"); squad(s, "auth", { approved_plans: [`/h/state/${L}/squads/auth-x-plan.md`] }); }, 0, true), "approved plan file").toMatchObject({ typed: undefined, clearBy: "loop" });
    expect((await clear("thinker", (_s, tok) => { mkdirSync(join(wtDir(tok), "s", "subagents"), { recursive: true }); writeFileSync(join(wtDir(tok), "s", "subagents", "a.jsonl"), "x"); utimesSync(join(wtDir(tok), "s", "subagents", "a.jsonl"), T - 30, T - 30); }, 0, true)).typed, "subagent file written in the window").toBe("/compact");
    expect(await clear("thinker", (_s, tok) => { mkdirSync(join(wtDir(tok), "s", "subagents"), { recursive: true }); const f = join(wtDir(tok), "s", "subagents", "a.jsonl"); writeFileSync(f, "x"); old(f); }, 0, true), "old subagent file").toMatchObject({ typed: undefined, clearBy: "loop" });
    expect((await clear("thinker", () => {}, 1, true)).typed, "unread mail").toBe("/compact");
    expect((await clear("thinker", () => {}, 0, false)).typed, "session written inside the window").toBe("/compact");
    // once written, a repeat tick writes nothing new (the wish is pending, not re-asked)
    setEnv("DS_NOW", String(T));
    const { s, tok } = team();
    worker(s, THINKER, "idle", T - 600, 0);
    transcript(s, tok, THINKER, [usage(300_000)]);
    utimesSync(join(wtDir(tok), "s.jsonl"), T - 600, T - 600);
    const { tick } = loopOf(s, compaction);
    expect(texts(await tick(T))).toEqual([]);
    const first = s.get("members", { project: L, squad: "auth", role: "thinker", suffix: "" })!;
    expect(Number(first.clear_at)).toBe(T);
    const wishes = (s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'wish'").get() as { n: number }).n;
    expect(texts(await tick(T + 60)), "repeat tick").toEqual([]);
    expect(s.get("members", { project: L, squad: "auth", role: "thinker", suffix: "" })!.clear_at).toBe(first.clear_at);
    expect((s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'wish'").get() as { n: number }).n, "no second wish event").toBe(wishes);
  });

  test("clear: a Muse member is never cleared; a confirmed or pending clear writes nothing", async () => {
    setEnv("DS_NOW", String(T));
    const { s, tok } = team();
    s.upsert("members", { project: L, squad: "auth", role: "thinker", suffix: "" }, { agent: "muse" });
    limitRow(s, "compact_mode_thinker", "clear");
    worker(s, THINKER, "idle", T - 600, 0);
    transcript(s, tok, THINKER, [usage(300_000)]);
    utimesSync(join(tok, mangle(THINKER.split("::")[1]), "s.jsonl"), T - 600, T - 600);
    expect(texts(await loopOf(s, compaction).tick(T)), "muse: nothing typed").toEqual([]);
    expect(s.get("members", { project: L, squad: "auth", role: "thinker", suffix: "" })!.clear_at, "muse: no clear wish").toBeNull();
    // a confirmed clear inside the cooldown writes nothing; a pending one is not re-asked
    const r2 = team();
    limitRow(r2.s, "compact_mode_thinker", "clear");
    worker(r2.s, THINKER, "idle", T - 600, 0);
    transcript(r2.s, r2.tok, THINKER, [usage(300_000)]);
    utimesSync(join(r2.tok, mangle(THINKER.split("::")[1]), "s.jsonl"), T - 600, T - 600);
    const id = Number(r2.s.get("members", { project: L, squad: "auth", role: "thinker", suffix: "" })!.id);
    r2.s.upsert("members", { id }, { clear_at: null, cleared_at: T - 60 });
    expect(texts(await loopOf(r2.s, compaction).tick(T))).toEqual([]);
    expect(r2.s.get("members", { id })!.clear_at).toBeNull();
    r2.s.upsert("members", { id }, { clear_at: T - 10, cleared_at: null });
    expect(texts(await loopOf(r2.s, compaction).tick(T + 60))).toEqual([]);
    expect(r2.s.get("members", { id })!.clear_at).toBe(T - 10);
  });

  test("a limited member is not typed into (wake's rules hold)", async () => {
    const { s, tok } = team();
    worker(s, BUILDER, "idle");
    s.upsert("observed_workers", { project: L, wt: BUILDER }, { limited: "0\tsession limit" });
    transcript(s, tok, BUILDER, [usage(300_000)]);
    expect(texts(await loopOf(s, compaction).tick(T))).toEqual([]);
  });

  // Studio: never typed into; one alert per episode
  test("Studio at 200k: not typed into, one Studio alert once per episode; context dropped: the alert clears itself", async () => {
    const { s, tok } = root();
    s.upsert("projects", { label: L }, { studio_wt: STUDIO, observed_at: T });
    worker(s, STUDIO, "idle");
    transcript(s, tok, STUDIO, [usage(200_000)], false); // the Studio has no observed_transcripts row
    const { tick } = loopOf(s, compaction);
    const a = await tick(T);
    expect(pokes(a), "Studio at 200k: not typed into").toEqual([]);
    expect(alertsOf(a).length, "  one Studio alert, once per episode").toBe(1);
    const p = alertsOf(a)[0].payload as Row;
    expect(p.text, "  names the Studio's context").toContain("Studio context is 200000 (>= 150000)");
    expect([alertsOf(a)[0].squad, p.target], "  not filed on any squad").toEqual([null, "project"]);
    expect(p.option, "  its own option: compacted").toBe("done — I compacted the Studio");
    expect(alertsOf(await tick(T + 60)).length, "  once per episode").toBe(0);

    transcript(s, tok, STUDIO, [usage(200_000), BOUNDARY], false);
    const c = await tick(T + 120);
    expect(c.map((x) => [x.kind, (x.payload as Row).prefix]), "Studio compacted: its context alert clears").toEqual([["alert-clear", "sweep-studio.ctx-"]]);
    expect((await tick(T + 180)).length, "  cleared once").toBe(0);

    transcript(s, tok, STUDIO, [usage(200_000), BOUNDARY, usage(190_000)], false);
    expect(alertsOf(await tick(T + 240)).length, "  a new rise: a new episode, alerted again").toBe(1);
  });

  test("Studio threshold is context_compact_studio: quiet at 140k, alert at 150k; a lower key moves it", async () => {
    const { s, tok } = root();
    s.upsert("projects", { label: L }, { studio_wt: STUDIO, observed_at: T });
    worker(s, STUDIO, "idle");
    transcript(s, tok, STUDIO, [usage(140_000)], false);
    const { tick } = loopOf(s, compaction);
    expect(alertsOf(await tick(T)).length, "140k: quiet").toBe(0);
    transcript(s, tok, STUDIO, [usage(150_000)], false);
    expect(alertsOf(await tick(T + 60)).length, "150k: alert").toBe(1);
  });

  test("context_compact_studio wins over context_compact for the Studio alert", async () => {
    const { s, tok } = root();
    s.upsert("projects", { label: L }, { studio_wt: STUDIO, observed_at: T });
    worker(s, STUDIO, "idle");
    limitRow(s, "context_compact_studio", "100000");
    transcript(s, tok, STUDIO, [usage(110_000)], false);
    expect(alertsOf(await loopOf(s, compaction).tick(T)).length, "110k >= studio 100k, below context_compact 150k").toBe(1);
  });

  test("a Studio alert the sweep already filed (studio.ctx.alerted) is not filed again, and still clears", async () => {
    const { s, tok } = root();
    s.upsert("projects", { label: L }, { studio_wt: STUDIO, observed_at: T });
    s.upsert("episodes", { project: L, subject: "studio.ctx", kind: "alerted" }, { started_at: T - 600, state: JSON.stringify([`ctx|${STUDIO}`]), episode_key: `ctx|${STUDIO}`, source: "sweep", observed_at: T });
    worker(s, STUDIO, "done");
    transcript(s, tok, STUDIO, [usage(200_000)], false);
    const { tick } = loopOf(s, compaction);
    expect((await tick(T)).length).toBe(0);
    transcript(s, tok, STUDIO, [usage(1000)], false);
    expect((await tick(T + 60)).map((x) => x.kind)).toEqual(["alert-clear"]);
  });

  // U263: the Studio compacted through its own terminal handle (R8, R9, AE2).
  describe("the Studio's idle /compact", () => {
    const N = T + 3600; // the Studio quiet for an hour: its last output at T
    // The project's Studio adopted on term_s1, a ds-loop pane running codex and a shell beside it (AE1).
    function studio(screen = "│ ❯ │\n", opts: { handle?: string | null; ctx?: number; lastOutput?: number } = {}) {
      const { s, tok } = root();
      s.upsert("projects", { label: L }, { studio_wt: STUDIO, observed_at: T });
      s.upsert("members", { project: L, squad: "_studio", wt: STUDIO }, { role: "studio", suffix: "", agent: "claude", status: "running",
        handle: opts.handle === undefined ? "term_s1" : opts.handle, observed_at: T, updated_at: T });
      const term = (handle: string, title: string, identity: string | null, tail: string) =>
        s.upsert("observed_terminals", { project: L, handle }, { wt: STUDIO, title, tail, tail_at: T + 1, gone_at: null, observed_at: T,
          doc: JSON.stringify({ identity, last_output_at: opts.lastOutput ?? T, unread: 0 }) });
      term("term_s1", "claude", "claude", screen);
      term("term_s2", "ds-loop briefing", "codex", "│ › │\n");
      term("term_s3", "bash", null, "$ \n");
      worker(s, STUDIO, "working"); // Orca's worktree state follows the codex pane: not the Studio's
      transcript(s, tok, STUDIO, [usage(opts.ctx ?? 160_000)], false);
      return { s, tok };
    }
    const setScreen = (s: Store, screen: string) => s.db.run("UPDATE observed_terminals SET tail = ? WHERE handle = 'term_s1'", [screen]);

    test("AE2: idle an hour at 160k with an empty prompt: /compact once, to the Studio's handle, no card", async () => {
      const { s } = studio();
      const { tick } = loopOf(s, compaction);
      const a = await tick(N);
      expect(pokes(a).map((x) => [x.member, (x.payload as Row).text, (x.payload as Row).handle]), "one /compact to term_s1").toEqual([[STUDIO, "/compact", "term_s1"]]);
      expect(alertsOf(a), "  no card").toEqual([]);
      expect(pokes(await tick(N + 60)), "  once per cooldown").toEqual([]);
      expect(pokes(await tick(N + 29 * 60)), "  still inside compact_cooldown_min").toEqual([]);
      expect(pokes(await tick(N + 31 * 60)).length, "  context still high after the cooldown: again").toBe(1);
    });

    test("AE2: a draft on the input line: nothing typed; the card after the guard held its window, naming why", async () => {
      const { s } = studio("│ ❯ draft text │\n");
      const { tick } = loopOf(s, compaction);
      const a = await tick(N);
      expect([pokes(a), alertsOf(a)], "draft: no poke, no card yet").toEqual([[], []]);
      expect(alertsOf(await tick(N + 599)), "  the hold has not run out").toEqual([]);
      const b = await tick(N + 600);
      expect(pokes(b), "  still never typed").toEqual([]);
      expect(alertsOf(b).length, "  the card").toBe(1);
      expect(String((alertsOf(b)[0].payload as Row).text)).toContain("Studio context is 160000 (>= 150000) — the loop could not compact it: text at the prompt");
      setScreen(s, "│ ❯ │\n");
      expect(texts(await tick(N + 660)), "  the line emptied: compacted").toEqual([`${STUDIO} /compact`]);
    });

    test("busy (output on its terminal), unread mail, a pending request: no /compact", async () => {
      const busy = studio("│ ❯ │\n", { lastOutput: N - 60 });
      const b = loopOf(busy.s, compaction);
      expect([pokes(await b.tick(N)), await b.tick(N + 700)], "busy past the hold window: neither a poke nor a card").toEqual([[], []]);

      const mail = studio();
      mail.s.db.run("UPDATE observed_terminals SET doc = json_patch(doc, '{\"unread\":1}') WHERE handle = 'term_s1'");
      expect(pokes(await loopOf(mail.s, compaction).tick(N)), "unread mail").toEqual([]);

      const req = studio();
      req.s.db.run("INSERT INTO requests (project, key, kind, payload, created_at) VALUES (?, ?, 'file', '{}', ?)", [L, `file:${L}/_studio/q.md`, T]);
      expect(pokes(await loopOf(req.s, compaction).tick(N)), "a request waits for the Studio").toEqual([]);
    });

    test("below context_compact_studio: nothing; the cooldown counts an earlier compaction", async () => {
      expect(pokes(await loopOf(studio("│ ❯ │\n", { ctx: 140_000 }).s, compaction).tick(N)), "140k").toEqual([]);
      const { s } = studio();
      s.upsert("observed_compacted", { project: L, wt: STUDIO, at: N - 600 }, { observed_at: N - 600 });
      expect(pokes(await loopOf(s, compaction).tick(N)), "compacted 10 min ago").toEqual([]);
    });

    test("compact_mode_studio off: the card only, as before", async () => {
      const { s } = studio();
      limitRow(s, "compact_mode_studio", "off");
      worker(s, STUDIO, "idle");
      const a = await loopOf(s, compaction).tick(N);
      expect(pokes(a)).toEqual([]);
      expect(alertsOf(a).length).toBe(1);
      expect(String((alertsOf(a)[0].payload as Row).text)).toContain("compact_mode_studio is off");
    });

    test("a Studio with no adopted terminal is never typed into: the card only", async () => {
      const { s } = studio("│ ❯ │\n", { handle: null });
      worker(s, STUDIO, "idle");
      const a = await loopOf(s, compaction).tick(N);
      expect(pokes(a)).toEqual([]);
      expect(String((alertsOf(a)[0]?.payload as Row)?.text)).toContain("holds no Studio terminal");
    });

    // The actuator: the poke goes out as poke-terminal to term_s1 only, never by worktree.
    function rig(s: Store, ...after: Reconciler[]) {
      const orca = new FakeOrca();
      const act = new LoopActuator({ orca, fulfillers: [pokeFulfiller] });
      const loop = new Loop(s, { observers: [], reconcilers: [compaction, ...after] }, act, { projects: () => [L] });
      loop.boot(N - 60);
      return { orca, tick: async (at: number) => { await loop.tick(at); await act.drain(); } };
    }

    test("sent through poke-terminal to the Studio's handle; no worktree poke, no other terminal", async () => {
      const { s } = studio();
      const { orca, tick } = rig(s);
      await tick(N);
      expect(orca.of("poke-terminal").map((c) => c.args), "only term_s1").toEqual([["term_s1", "/compact"]]);
      expect(orca.of("poke"), "never the worktree's agent terminal").toEqual([]);
    });

    test("the guard re-read before typing: a draft since the decision sends nothing, and the next ready tick compacts", async () => {
      const { s } = studio();
      const typing: Reconciler = { name: "typing", run() { setScreen(s, "│ ❯ wait │\n"); return []; } };
      const r = rig(s, typing);
      await r.tick(N);
      expect(r.orca.of("poke-terminal"), "not sent").toEqual([]);
      expect(s.get("episodes", { project: L, subject: STUDIO, kind: "wake:compact" })?.state, "  the wake episode is unsent").toBe("unsent");
      setScreen(s, "│ ❯ │\n");
      const again = rig(s);
      await again.tick(N + 60);
      expect(again.orca.of("poke-terminal").map((c) => c.args), "  no cooldown from the unsent one").toEqual([["term_s1", "/compact"]]);
    });
  });
});

describe("step 8: picker entries", () => {
  const iso = (t: number) => new Date(t * 1000).toISOString();
  // A picker entry on squad auth asked by the Lead; the state observer mirrors it into observed_pickers.
  function picker(q: Row = {}, opts: { state?: string | null; terminal?: boolean; result?: string | null; transcript?: boolean } = {}) {
    const { s } = root();
    const tp = join(s.root, "t.jsonl");
    if (opts.transcript !== false) {
      const lines = [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1" }] } })];
      if (opts.result) lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: opts.result }] } }));
      writeFileSync(tp, lines.join("\n") + "\n");
    }
    squad(s, "auth", { waiting_on_you: [{ id: "p1", source: "picker", asker: "lead", card_wt: LEAD, since: iso(T - 600), tool_use_id: "tu1", transcript_path: tp, ...q }] });
    member(s, "auth", "lead", LEAD);
    if (opts.state !== null) worker(s, LEAD, opts.state ?? "waiting");
    s.upsert("observed_terminals", { project: L, handle: "term-1" }, { wt: opts.terminal === false ? ws("other") : LEAD, observed_at: T, gone_at: null });
    return s;
  }
  async function reap(s: Store, at = T) {
    const o = stateObserver({ tokenDir: join(s.root, "tok"), lavishDir: join(s.root, "lavish"), lavishLog: join(s.root, "lavish.log"), refreshAccounts: () => {} });
    await o.run({ store: s, project: "", tick: 1, now: at, fired: [], poked: new Set() });
    await alerts.run({ store: s, project: L, tick: 1, now: at, fired: [], poked: new Set() });
    return (s.db.query("SELECT payload FROM requests WHERE kind = 'picker'").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as Row);
  }

  test("still waiting, no tool_result: kept", async () => { expect(await reap(picker())).toEqual([]); });
  test("its picker closed (tool_result in the transcript): reaped", async () => {
    expect(await reap(picker({}, { result: "tu1" }))).toEqual([{ op: "resolve", id: "p1", squad: "auth", reason: "its picker closed (tool_result in the transcript)" }]);
  });
  test("tool_result for another id: kept", async () => { expect(await reap(picker({}, { result: "tu9" }))).toEqual([]); });
  test("agent gone from worker-states: reaped", async () => {
    expect((await reap(picker({}, { state: null })))[0]?.reason).toBe("its agent's worktree is gone");
  });
  test("no live agent terminal: reaped", async () => {
    expect((await reap(picker({}, { state: "idle", terminal: false })))[0]?.reason).toBe("its agent has no live terminal");
  });
  test("idle + old entry: reaped", async () => {
    expect((await reap(picker({}, { state: "idle" })))[0]?.reason).toBe("its agent is idle and the entry is over 2 min old");
  });
  test("working + old entry: reaped", async () => {
    expect((await reap(picker({}, { state: "working" })))[0]?.reason).toBe("its agent is working and the entry is over 2 min old");
  });
  test("idle + old entry with fractional since: reaped", async () => {
    expect((await reap(picker({ since: iso(T - 600).replace(".000Z", ".123456Z") }, { state: "idle" })))[0]?.reason).toBe("its agent is idle and the entry is over 2 min old");
  });
  test("working + fresh entry: kept", async () => {
    expect(await reap(picker({ since: iso(T - 30) }, { state: "working" }))).toEqual([]);
  });
  test("waiting + old + no result: kept", async () => { expect(await reap(picker({}, { state: "waiting" }))).toEqual([]); });
  test("non-picker entry, idle + old: kept", async () => {
    expect(await reap(picker({ source: "sweep" }, { state: "idle" }))).toEqual([]);
  });
  test("no card_wt, asker gone: reaped", async () => {
    expect((await reap(picker({ card_wt: undefined }, { state: null })))[0]?.reason).toBe("its agent's worktree is gone");
  });
  test("missing transcript + waiting: kept", async () => {
    expect(await reap(picker({}, { transcript: false }))).toEqual([]);
  });
  test("a stale entry is asked to resolve once, however many ticks see it", async () => {
    const s = picker({}, { state: "idle" });
    await reap(s);
    expect((await reap(s, T + 60)).length).toBe(1);
  });
});

describe("review follow-ups", () => {
  test("a closed squad's units count toward no median and raise no runaway alert", async () => {
    const { s } = root();
    squad(s, "auth");
    squad(s, "old", {}, "closed");
    for (const slug of ["d1", "d2", "d3"]) {
      unit(s, "old", slug, "done", "standard", `id::/w/${slug}`);
      s.upsert("observed_tokens", { worker: `-w-${slug}`, model: "m" }, { topic: "old", role: "builder", cache_write: 1_000_000, observed_at: T });
    }
    unit(s, "old", "z9", "dispatched", "standard", "id::/w/z9");
    unit(s, "auth", "u2", "dispatched", "standard", "id::/w/u2");
    for (const w of ["z9", "u2"]) s.upsert("observed_tokens", { worker: `-w-${w}`, model: "m" }, { topic: "x", role: "builder", cache_write: 7_000_000, observed_at: T });
    expect(alertsOf(await loopOf(s, alerts).tick(T)).length, "7M is under the 20M cap once the closed squad's 1M units are left out").toBe(0);
  });

  test("a Studio rise after a clear keeps the sweep's alert id; one the sweep filed after the clear is not filed again", async () => {
    const { s, tok } = root();
    s.upsert("projects", { label: L }, { studio_wt: STUDIO, observed_at: T });
    worker(s, STUDIO, "idle");
    transcript(s, tok, STUDIO, [usage(200_000)], false);
    const { tick } = loopOf(s, compaction);
    const first = alertsOf(await tick(T))[0];
    transcript(s, tok, STUDIO, [usage(1000)], false);
    await tick(T + 60);
    transcript(s, tok, STUDIO, [usage(200_000)], false);
    const again = alertsOf(await tick(T + 120))[0];
    expect((again?.payload as Row)?.id).toBe((first.payload as Row).id);
    expect((first.payload as Row).id).toBe(`sweep-studio.ctx-${cksum(`ctx|${STUDIO}`)}`);

    transcript(s, tok, STUDIO, [usage(1000)], false);
    await tick(T + 180);
    s.upsert("episodes", { project: L, subject: "studio.ctx", kind: "alerted" }, { started_at: T + 200, state: JSON.stringify([`ctx|${STUDIO}`]), episode_key: `ctx|${STUDIO}`, source: "sweep", observed_at: T + 200 });
    transcript(s, tok, STUDIO, [usage(200_000)], false);
    expect(alertsOf(await tick(T + 240)).length).toBe(0);
  });
});

describe("U67: a failed restart has one card that clears", () => {
  const KEY = "auth.builder-u2", ACCT = "acct-a";
  const EP1 = `limit|${BUILDER}|claude/${ACCT}|usage limit, resets 14:00`;
  // A squad `auth` whose Builder u2 runs on claude/acct-a, both accounts listed.
  function setup(): Store {
    const { s } = root();
    squad(s, "auth");
    member(s, "auth", "builder", BUILDER, "u2");
    s.db.run("UPDATE members SET agent = 'claude', account = ? WHERE wt = ?", [ACCT, BUILDER]);
    for (const account of [ACCT, "acct-b"]) s.upsert("observed_accounts", { agent: "claude", account }, { updated: String(T), observed_at: T });
    s.upsert("observed_worktrees", { project: L, wt: BUILDER }, { doc: JSON.stringify({ agents: 1 }), observed_at: T, gone_at: null });
    return s;
  }
  // A "Restart failed" card as the state observer imports it from alerts.json.
  function card(s: Store, id: string, doc: Row) {
    s.upsert("observed_alerts", { project: L, id }, { doc: JSON.stringify({ id, asker: "sweep", title: "Restart failed", since: new Date((T - 600) * 1000).toISOString(), ...doc }), observed_at: T });
  }
  const text = `builder-u2 of auth (usage limit on ${ACCT}: usage limit, resets 14:00) — the loop could not restart it: restart-role exit 2: no; run: x`;
  const cleared = (acted: Action[]) => acted.filter((a) => a.kind === "alert-clear").map((a) => (a.payload as Row).id);
  const limited = (s: Store, episodeKey: string, state = "limited") =>
    s.upsert("episodes", { project: L, subject: BUILDER, kind: "limited" }, { started_at: T - 900, state, episode_key: episodeKey, source: "loop", observed_at: T });

  test("a member now running on a listed account: one alert-clear; still down: none", async () => {
    const s = setup();
    worker(s, BUILDER, "working");
    limited(s, `claude/${ACCT}|usage limit, resets 14:00`, "closed");
    card(s, "loop-up-1", { question: text, kind: "restart_failed", member: BUILDER, episode: EP1, count: 1 });
    const { tick } = loopOf(s, alerts);
    expect(cleared(await tick(T))).toEqual(["loop-up-1"]);
    expect(cleared(await tick(T + 60)), "cleared once").toEqual([]);

    const d = setup();
    worker(d, BUILDER, "idle");
    d.upsert("observed_workers", { project: L, wt: BUILDER }, { limited: `${T + 3600}\tusage limit` });
    limited(d, `claude/${ACCT}|usage limit, resets 14:00`);
    card(d, "loop-down-1", { question: text, kind: "restart_failed", member: BUILDER, episode: EP1, count: 1 });
    expect(cleared(await loopOf(d, alerts).tick(T)), "still limited in the episode it was raised for").toEqual([]);
  });

  test("the episode it was raised for closed, or the member is gone: cleared", async () => {
    const s = setup();
    worker(s, BUILDER, "idle");
    s.upsert("observed_workers", { project: L, wt: BUILDER }, { limited: `${T + 3600}\tweekly limit` });
    limited(s, `claude/${ACCT}|weekly limit, resets Mon`);
    card(s, "loop-ep-1", { question: text, kind: "restart_failed", member: BUILDER, episode: EP1, count: 1 });
    expect(cleared(await loopOf(s, alerts).tick(T)), "a newer episode: the card's has closed").toEqual(["loop-ep-1"]);

    const g = setup();
    g.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [BUILDER]);
    card(g, "loop-gone-1", { question: text, kind: "restart_failed", member: BUILDER, episode: EP1, count: 1 });
    expect(cleared(await loopOf(g, alerts).tick(T))).toEqual(["loop-gone-1"]);
  });

  // U154: the run-switch kind (and fulfil/request.ts giveUp that folded its "Restart failed" cards)
  // is gone. A failed switch retries through the refusals classifier's backoff (refusals.ts), whose
  // own suite covers its cards.

  test("an old text-only card for a member now running clears; one for a member still down stays", async () => {
    const s = setup();
    worker(s, BUILDER, "working");
    card(s, "loop-auth.builder-u2-old1", { question: text });
    expect(cleared(await loopOf(s, alerts).tick(T))).toEqual(["loop-auth.builder-u2-old1"]);

    const d = setup();
    worker(d, BUILDER, "idle");
    d.upsert("observed_workers", { project: L, wt: BUILDER }, { limited: `${T + 3600}\tusage limit` });
    card(d, "loop-auth.builder-u2-old2", { question: text });
    expect(cleared(await loopOf(d, alerts).tick(T))).toEqual([]);

    // Running, not limited, but on an account the list no longer has: kept.
    const u = setup();
    worker(u, BUILDER, "working");
    u.db.run("UPDATE members SET account = 'acct-gone' WHERE wt = ?", [BUILDER]);
    card(u, "loop-auth.builder-u2-old3", { question: text });
    expect(cleared(await loopOf(u, alerts).tick(T)), "unlisted account").toEqual([]);
  });
});

// U232: a Needs-you card names its squad and unit, and clears itself when no longer true.
describe("U232: cards say whose they are and clear themselves", () => {
  const fresh = new Date((T - 3600) * 1000).toISOString();
  function team() {
    const { s } = root();
    squad(s, "sweep-run-loop");
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/lead" }, { role: "lead", suffix: "", status: "running", since: fresh, observed_at: T, updated_at: T });
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/b222" }, { role: "builder", suffix: "u222", status: "running", since: fresh, observed_at: T, updated_at: T });
    return s;
  }
  const card = (s: Store, a: Row) => ({ ...a }) as Row & { id?: string };

  test("titles: a Lead's poke card, a unit's runaway card, a project card", () => {
    const s = team();
    expect(cardTitle(s, L, { squad: "sweep-run-loop", member: "id::/w/lead" }, "Poke unanswered")).toBe("sweep-run-loop · lead: Poke unanswered");
    expect(cardTitle(s, L, { squad: "sweep-run-loop", member: "id::/w/b222", unit: "u222-port-read-helpers" }, "Unit spending a lot")).toBe("sweep-run-loop · U222: Unit spending a lot");
    expect(cardTitle(s, L, { squad: "sweep-run-loop", member: "id::/w/b222" }, "Agent broken")).toBe("sweep-run-loop · builder-u222: Agent broken");
    expect(cardTitle(s, L, { squad: "sweep-run-loop" }, "Rebind failed")).toBe("sweep-run-loop · Rebind failed");
    expect(cardTitle(s, L, { squad: null }, "Studio limit")).toBe("Studio limit");
    expect(cardTitle(s, L, { squad: "sweep-run-loop", member: "id::/w/lead" }, "sweep-run-loop · lead: Poke unanswered")).toBe("sweep-run-loop · lead: Poke unanswered");
  });

  test("a poke-capped action carries card + text naming the member, never a worktree id", () => {
    const s = team();
    s.upsert("observed_workers", { project: L, wt: "id::/w/lead" }, { state: "idle", since: T - 600, unread: 0, observed_at: T, gone_at: null });
    const ctx = { store: s, project: L, now: T, poked: new Set<string>() } as never;
    s.upsert("episodes", { project: L, subject: "id::/w/lead", kind: "wake:all-done" }, { squad: "sweep-run-loop", episode_key: "e1", count: 5, state: "poking", next_at: null, source: "loop", observed_at: T });
    const r = wake(ctx, "id::/w/lead", "wrap up", "all-done", "e1");
    expect(r.status).toBe("skipped:capped");
    const p = r.actions[0].payload as Row;
    expect(p).toMatchObject({ title: "Wrap-up stalled: Lead did not answer", card: "poke_unanswered", reason: "all-done",
      fields: { pokeEpisode: "e1", act: { action: "close", topic: "sweep-run-loop", label: "Close squad" } } });
    expect(String(p.text)).toContain("Every unit of sweep-run-loop is done or cancelled");
    expect(String(p.text)).toContain("asked its Lead 5 times");
    expect(String(p.text)).toContain("press Close squad");
    expect(String(p.text)).not.toContain("::");
    // another reason keeps the poke wording, with the Lead as the one to look
    s.upsert("episodes", { project: L, subject: "id::/w/lead", kind: "wake:held" }, { squad: "sweep-run-loop", episode_key: "h1", count: 5, state: "poking", next_at: null, source: "loop", observed_at: T });
    const q = wake(ctx, "id::/w/lead", "held", "held", "h1").actions[0].payload as Row;
    expect(q).toMatchObject({ title: "Poke unanswered", reason: "held" });
    expect(q.fields).not.toHaveProperty("act");
    expect(String(q.text)).toContain("its Lead can look at it; this note goes when the agent answers");
    expect(String(q.text)).not.toContain("ignore it");
  });

  test("settle: an all-done poke card clears when a unit is dispatched again; a non-all-done one when the worker turns working", () => {
    const s = team();
    s.upsert("squads", { project: L, topic: "sweep-run-loop" }, { type: "feature" });
    unit(s, "sweep-run-loop", "u1", "done");
    const allDoneCard = { kind: "poke_unanswered", member: "id::/w/lead", squad: "sweep-run-loop", reason: "all-done", pokeEpisode: "e1" } as Row;
    const capped = (key: string, state = "capped") => s.upsert("episodes", { project: L, subject: "id::/w/lead", kind: "wake:all-done" }, { squad: "sweep-run-loop", episode_key: key, count: 5, state, source: "loop", observed_at: T });
    capped("e1");
    expect(alertGone(s, L, allDoneCard, T)).toBe(false);
    capped("e2");
    expect(alertGone(s, L, allDoneCard, T)).toBe("the Lead answered");
    capped("e1", "poking");
    expect(alertGone(s, L, allDoneCard, T)).toBe("the Lead answered");
    capped("e1");
    unit(s, "sweep-run-loop", "u2", "dispatched");
    expect(alertGone(s, L, allDoneCard, T)).toBe("the squad is no longer all done");
    s.upsert("episodes", { project: L, subject: "id::/w/b222", kind: "wake:held" }, { squad: "sweep-run-loop", episode_key: "h1", count: 5, state: "capped", source: "loop", observed_at: T });
    const heldCard = { kind: "poke_unanswered", member: "id::/w/b222", squad: "sweep-run-loop", reason: "held", pokeEpisode: "h1" } as Row;
    s.upsert("observed_workers", { project: L, wt: "id::/w/b222" }, { state: "idle", since: T, unread: 0, observed_at: T, gone_at: null });
    expect(alertGone(s, L, heldCard, T)).toBe(false);
    s.upsert("observed_workers", { project: L, wt: "id::/w/b222" }, { state: "working", since: T, unread: 0, observed_at: T, gone_at: null });
    expect(alertGone(s, L, heldCard, T)).toBe("the worker is working again");
    s.upsert("observed_workers", { project: L, wt: "id::/w/b222" }, { state: "idle", since: T, unread: 0, observed_at: T, gone_at: null });
    s.upsert("episodes", { project: L, subject: "id::/w/b222", kind: "wake:held" }, { episode_key: "h2", count: 1, state: "poking", source: "loop" });
    expect(alertGone(s, L, heldCard, T)).toBe("its poke episode was reset");
    // the member is gone
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/b222" }, { status: "gone" });
    expect(alertGone(s, L, { ...heldCard, pokeEpisode: "h2" }, T)).toBe("its member no longer exists");
  });

  test("settle: a runaway card clears once its unit is not dispatched; an old card by its text", () => {
    const s = team();
    unit(s, "sweep-run-loop", "u222", "dispatched");
    const c = { kind: "runaway_unit", squad: "sweep-run-loop", unit: "u222" } as Row;
    expect(alertGone(s, L, c, T)).toBe(false);
    unit(s, "sweep-run-loop", "u222", "done");
    expect(alertGone(s, L, c, T)).toBe("the unit is no longer running");
    unit(s, "sweep-run-loop", "u222", "dispatched");
    const old = { question: "unit u222 of sweep-run-loop has spent 3.0M cache_write tokens" } as Row;
    expect(alertGone(s, L, old, T)).toBe(false);
    unit(s, "sweep-run-loop", "u222", "planned");
    expect(alertGone(s, L, old, T)).toBe("the unit is no longer running");
  });

  test("basis: a done unit counts its Builder rows plus :review; a partial one (started before the token window) is left out", () => {
    const s = team();
    unit(s, "sweep-run-loop", "d1", "done", "standard", "id::/w/d1");
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/d1" }, { role: "builder", suffix: "d1", status: "gone", since: fresh, observed_at: T, updated_at: T });
    s.upsert("observed_tokens", { worker: "-w-d1", model: "a" }, { cache_write: 1_000_000, observed_at: T });
    s.upsert("observed_tokens", { worker: "-w-d1", model: "b" }, { cache_write: 500_000, observed_at: T });
    s.upsert("observed_tokens", { worker: "-w-d1:review", model: "a" }, { cache_write: 700_000, observed_at: T });
    expect(unitSpend(s, L, { squad: "sweep-run-loop", slug: "d1", status: "done", builder_wt: "id::/w/d1" }, T, false)).toBe(2_200_000);
    unit(s, "sweep-run-loop", "d2", "done", "standard", "id::/w/d2");
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/d2" }, { role: "builder", suffix: "d2", status: "gone", since: new Date((T - 30 * 86400) * 1000).toISOString(), observed_at: T, updated_at: T });
    s.upsert("observed_tokens", { worker: "-w-d2", model: "a" }, { cache_write: 50_000, observed_at: T });
    expect(unitSpend(s, L, { squad: "sweep-run-loop", slug: "d2", status: "done", builder_wt: "id::/w/d2" }, T, false)).toBeNull();
  });

  test("basis: a dispatched unit's figure is kept after its worktree rows go", () => {
    const s = team();
    const u = { squad: "sweep-run-loop", slug: "d1", status: "dispatched", builder_wt: "id::/w/d1" };
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/d1" }, { role: "builder", suffix: "d1", status: "running", since: fresh, observed_at: T, updated_at: T });
    s.upsert("observed_tokens", { worker: "-w-d1", model: "a" }, { cache_write: 3_000_000, observed_at: T });
    expect(unitSpend(s, L, u, T, true)).toBe(3_000_000);
    s.db.run("DELETE FROM observed_tokens"); s.db.run("DELETE FROM members WHERE wt = 'id::/w/d1'");
    expect(unitSpend(s, L, { ...u, status: "done" }, T, false)).toBe(3_000_000);
  });

  test("a live unit at 1.1M under a basis of real done-unit spend raises no card", async () => {
    const s = team();
    for (const [slug, n] of [["d1", 1_000_000], ["d2", 1_200_000], ["d3", 900_000]] as const) {
      unit(s, "sweep-run-loop", slug, "done", "standard", `id::/w/${slug}`);
      s.upsert("members", { project: L, squad: "sweep-run-loop", wt: `id::/w/${slug}` }, { role: "builder", suffix: slug, status: "gone", since: fresh, observed_at: T, updated_at: T });
      s.upsert("observed_tokens", { worker: `-w-${slug}`, model: "a" }, { cache_write: n, observed_at: T });
    }
    unit(s, "sweep-run-loop", "live", "dispatched", "standard", "id::/w/live");
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/live" }, { role: "builder", suffix: "live", status: "running", since: fresh, observed_at: T, updated_at: T });
    s.upsert("observed_tokens", { worker: "-w-live", model: "a" }, { cache_write: 1_100_000, observed_at: T });
    const { tick } = loopOf(s, alerts);
    expect(alertsOf(await tick(T)).length).toBe(0);
  });

  test("an answered runaway card returns once at 2x the spend and not before", async () => {
    const s = team();
    for (const slug of ["d1", "d2", "d3"]) {
      unit(s, "sweep-run-loop", slug, "done", "standard", `id::/w/${slug}`);
      s.upsert("members", { project: L, squad: "sweep-run-loop", wt: `id::/w/${slug}` }, { role: "builder", suffix: slug, status: "gone", since: fresh, observed_at: T, updated_at: T });
      s.upsert("observed_tokens", { worker: `-w-${slug}`, model: "a" }, { cache_write: 2_000_000, observed_at: T });
    }
    unit(s, "sweep-run-loop", "live", "dispatched", "standard", "id::/w/live");
    s.upsert("members", { project: L, squad: "sweep-run-loop", wt: "id::/w/live" }, { role: "builder", suffix: "live", status: "running", since: fresh, observed_at: T, updated_at: T });
    const spend = (n: number) => s.upsert("observed_tokens", { worker: "-w-live", model: "a" }, { cache_write: n, observed_at: T });
    const { tick } = loopOf(s, alerts);
    spend(7_000_000);
    const first = alertsOf(await tick(T));
    expect(first.length).toBe(1);
    expect((first[0].payload as Row)).toMatchObject({ title: "Unit spending a lot", unit: "live", card: "runaway_unit" });
    // answered ("looked at it"): the card is gone from the board
    spend(10_000_000);
    expect(alertsOf(await tick(T + 60)).length, "under 2x of where it stood").toBe(0);
    spend(14_000_000);
    const again = alertsOf(await tick(T + 120));
    expect(again.length, "2x: back once").toBe(1);
    expect(again[0].episode).toBe("unit-tokens@2x");
    spend(40_000_000);
    expect(alertsOf(await tick(T + 180)).length, "and only once").toBe(0);
  });
});
describe("U1: the default token scan never reads the real session logs from a test", () => {
  const unset = () => { envs.set("DS_TOKEN_DIR", process.env.DS_TOKEN_DIR); delete process.env.DS_TOKEN_DIR; };
  const run = (s: Store) => tokensReconciler().run({ store: s, project: "", tick: 1, now: Math.floor(Date.now() / 1000), fired: [], poked: new Set() });
  test("DS_TOKEN_DIR unset and a temp root: no scan starts and no lock is left", async () => {
    const { s } = root();
    unset();
    await run(s);
    await Bun.sleep(300);
    expect(existsSync(join(s.root, "tokens.tsv.lock"))).toBe(false);
    expect(existsSync(join(s.root, "tokens.tsv"))).toBe(false);
  });
  test("DS_TOKEN_DIR set to a fixture and a temp root: the scan runs over it", async () => {
    const { s, tok } = root(), tf = join(s.root, "tokens.tsv");
    const tw = join(tok, mangle(BUILDER.split("::")[1]));
    mkdirSync(tw);
    writeFileSync(join(tw, "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
      message: { id: "g1", model: "claude-opus-5-5", usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 } } }) + "\n");
    await run(s);
    for (let i = 0; i < 100 && (!existsSync(tf) || existsSync(`${tf}.lock`)); i++) await Bun.sleep(50);
    expect(readFileSync(tf, "utf8")).toContain("builder-u2-auth");
  });
  test("the decision: the host's own root is allowed by real or symlinked path, another root is refused", () => {
    unset();
    const d = tmp(), host = join(d, "host-state"), link = join(d, "link");
    mkdirSync(host);
    symlinkSync(host, link);
    expect(realLogScanAllowed(host, host)).toBe(true);
    expect(realLogScanAllowed(link, host)).toBe(true);
    expect(realLogScanAllowed(host, link)).toBe(true);
    const other = join(d, "other");
    mkdirSync(other);
    expect(realLogScanAllowed(other, host)).toBe(false);
    expect(realLogScanAllowed(join(d, "missing"), host)).toBe(false);
  });
  test("the preload leaves DS_TOKEN_DIR a temp path after earlier tests' cleanup", () => {
    expect(process.env.DS_TOKEN_DIR).toBeTruthy();
    expect(process.env.DS_TOKEN_DIR).not.toContain(".claude/projects");
  });
});
