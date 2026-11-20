// fulfil-account-reset.test.ts — account-free-resets U4: the `account-reset` fulfiller behind the board's
// Use button. The backend is the fake (no provider is ever reached); the accounts refresh is counted.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { accountReset } from "../../bin/loop/fulfil/account-reset.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

type Answer = { code: number; out: string; err?: string };
function rig(answers: Answer[]) {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzar-"));
  temps.push(d);
  const s = open(d);
  stores.push(s);
  const orca = new FakeOrca();
  let n = 0;
  orca.answer = (c) => c.op === "account-reset-use" ? { err: "", ...answers[Math.min(n++, answers.length - 1)] } : undefined;
  const refreshed: string[] = [];
  const f = accountReset({ refresh: (root) => refreshed.push(root) });
  const act = new LoopActuator({ orca, fulfillers: [f] });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at = T) => { await loop.tick(at); await act.drain(); };
  return { s, orca, refreshed, tick };
}
const press = (s: Store, key = "k-123") =>
  Number(s.requestAny("account-reset", { agent: "claude", account: "acc1", grant: "g1", key }, { project: "fx", by: "board" }).row.id);
const request = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) };
};
const used = (s: Store) => (s.db.query("SELECT project, payload FROM events WHERE kind = 'account_reset_used' ORDER BY id").all() as Row[])
  .map((r) => ({ project: r.project, ...JSON.parse(String(r.payload)) }));

describe("account-reset fulfiller", () => {
  test("an answer finishes the request with the outcome, logs the event and refreshes the accounts once", async () => {
    const r = rig([{ code: 0, out: "used\tnone · resets left 1\n" }]);
    const id = press(r.s);
    await r.tick();
    const calls = r.orca.of("account-reset-use");
    expect(calls.map((c) => c.args)).toEqual([["claude", "acc1", "g1", "k-123"]]);
    expect(request(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "used", detail: "none · resets left 1" });
    expect(used(r.s)).toEqual([{ project: "fx", agent: "claude", account: "acc1", grant: "g1", outcome: "used", detail: "none · resets left 1", by: "board" }]);
    expect(r.refreshed).toEqual([r.s.root]);
    await r.tick(T + 60);   // done: never claimed again
    expect(r.orca.of("account-reset-use").length).toBe(1);
  });

  test.each(["nothing_to_reset", "no_grant", "already_used"])("%s finishes ok with that outcome", async (o) => {
    const r = rig([{ code: 0, out: `${o}\twhy\n` }]);
    const id = press(r.s);
    await r.tick();
    expect(request(r.s, id)).toMatchObject({ done: true, ok: true, outcome: o });
    expect(r.refreshed.length).toBe(1);
  });

  test("a failed outcome finishes the request as failed, with the reason, and is not retried", async () => {
    const r = rig([{ code: 0, out: "failed\tHTTP 403: forbidden\n" }]);
    const id = press(r.s);
    await r.tick();
    expect(request(r.s, id)).toMatchObject({ done: true, ok: false, outcome: "failed", error: "HTTP 403: forbidden" });
    expect(used(r.s).map((e) => e.outcome)).toEqual(["failed"]);
    await r.tick(T + 3600);
    expect(r.orca.of("account-reset-use").length).toBe(1);
  });

  test("no answer keeps the request open and the retry passes the same key", async () => {
    const r = rig([{ code: 1, out: "", err: "account-reset-use: no answer from claude; the claim is in doubt, retry with the same key" }, { code: 0, out: "already_used\tgrant already redeemed\n" }]);
    const id = press(r.s);
    await r.tick();
    expect(request(r.s, id).done).toBe(false);
    expect(used(r.s)).toEqual([]);
    expect(r.refreshed).toEqual([]);
    for (let i = 1; i <= 4 && !request(r.s, id).done; i++) await r.tick(T + i * 1000);
    const keys = r.orca.of("account-reset-use").map((c) => c.args[3]);
    expect(keys.length).toBe(2);
    expect(new Set(keys)).toEqual(new Set(["k-123"]));
    expect(request(r.s, id)).toMatchObject({ done: true, ok: true, outcome: "already_used" });
  });

  test("given up after the retries, the request fails and a failed event is logged", async () => {
    const r = rig([{ code: 1, out: "", err: "no answer from claude" }]);
    const id = press(r.s);
    for (let i = 0; i < 12 && !request(r.s, id).done; i++) await r.tick(T + i * 1000);
    const res = request(r.s, id);
    expect(res).toMatchObject({ done: true, ok: false });
    expect(String(res.error)).toContain("no answer from claude");
    expect(used(r.s).map((e) => [e.outcome, e.grant])).toEqual([["failed", "g1"]]);
    expect(r.refreshed).toEqual([]);
    expect(new Set(r.orca.of("account-reset-use").map((c) => c.args[3]))).toEqual(new Set(["k-123"]));
  });

  test("only the fulfiller calls account-reset-use", () => {
    // orch-ts.ts names the verb only to refuse it (an agent never uses a grant).
    const allowed = new Set(["bin/backend/orca.ts", "bin/loop/fulfil/account-reset.ts", "bin/commands/orch-ts.ts"]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== "node_modules") walk(p); continue; }
        if (/\.(ts|sh|html|js)$/.test(f) || !f.includes(".")) {
          const rel = relative(ROOT, p);
          if (!allowed.has(rel) && readFileSync(p, "utf8").includes("account-reset-use")) hits.push(rel);
        }
      }
    };
    walk(join(ROOT, "bin"));
    walk(join(ROOT, "web"));
    expect(hits).toEqual([]);
  });
});
