// board-queue-order.test.ts — picker-prefers-unblocking-units U3: the whole queued lane reads in the loop's order
// (flow.queued_order and the queued cards of flow.cards), next up and not ready alike. Data from loop.db alone.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";

const REPO = join(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type U = Record<string, unknown>;
// Squad `a` and `b` of project p. `live`: dispatched units with a working Builder; `queued`: planned, ready units.
function fixture(o: { a: { live?: U[]; queued?: U[]; extra?: U }; b: { live?: U[]; queued?: U[] }; limits: Record<string, string> }) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardqorder-")); roots.push(root);
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  const workers: [string, string][] = [];
  for (const [topic, sq] of [["a", o.a], ["b", o.b]] as const) {
    const live = (sq.live ?? []).map((u, i) => ({ status: "dispatched", deps: [], builder_wt: `wt-${topic}${i}`, ...u }));
    const queued = (sq.queued ?? []).map((u) => ({ status: "planned", deps: [], ...u }));
    const units = [...live, ...queued];
    const members = [{ role: "lead", wt: `lead-${topic}` }, ...live.map((u: any) => ({ role: "builder", suffix: u.slug, wt: u.builder_wt }))];
    workers.push([`lead-${topic}`, "working"], ...live.map((u: any): [string, string] => [u.builder_wt, "working"]));
    writeFileSync(join(root, "p", "squads", `${topic}.json`), JSON.stringify({ task_id: topic, run_id: `run_${topic}`, repo: "path:/r/p", status: "running", members, units, worktrees: [] }));
  }
  writeFileSync(join(root, "seed.json"), JSON.stringify({ workers }));
  const env = { ...process.env, DS_STATE_ROOT: root };
  for (const cmd of [[join(REPO, "bin/ds"), "import"], [process.execPath, join(REPO, "tests/board-db.ts"), join(root, "seed.json"), "p"]]) {
    const r = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  }
  const s = open(root);
  for (const [key, value] of Object.entries(o.limits)) s.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: 1 });
  s.close();
  return { root, board: () => buildBoard("p", "", root) as any };
}
const squadOf = (b: any, t: string) => b.squads.find((s: any) => s.topic === t);

const slugs = (ks: string[]) => ks.map((k) => k.split("/")[2]);
// Seats are full (both gates live). Focus squad `a` has two leaves waiting on its gate; squad `b` has an older leaf, a
// newer root with 3 open dependents and the dependents, all waiting on its gate.
const lane = (limits: Record<string, string> = {}) => fixture({
  a: { live: [{ slug: "gate-a" }], queued: [{ slug: "a1", deps: ["gate-a"] }, { slug: "a2", deps: ["gate-a"] }] },
  b: { live: [{ slug: "gate-b" }], queued: [{ slug: "leaf", deps: ["gate-b"] }, { slug: "root", deps: ["gate-b"] }, { slug: "d1", deps: ["root"] }, { slug: "d2", deps: ["root"] }, { slug: "d3", deps: ["root"] }] },
  limits: { max_builders: "2", focus_squad: "a", ...limits },
});
const queuedCards = (b: any) => b.flow.cards.filter((c: any) => c.stage === "queued").map((c: any) => c.key);

test("not ready: the focus squad first, then the unit with more dependents before the older leaf", () => {
  const b = lane().board();
  expect(slugs(b.flow.queued_order)).toEqual(["a1", "a2", "root", "leaf", "d1", "d2", "d3"]);
  expect(queuedCards(b)).toEqual(b.flow.queued_order);
  expect(b.flow.cards.filter((c: any) => c.stage !== "queued").map((c: any) => c.slug).sort()).toEqual(["gate-a", "gate-b"]);
});

test("unblock_first off: focus first, then oldest", () => {
  const b = lane({ unblock_first: "off" }).board();
  expect(slugs(b.flow.queued_order)).toEqual(["a1", "a2", "leaf", "root", "d1", "d2", "d3"]);
  expect(queuedCards(b)).toEqual(b.flow.queued_order);
});

test("a started unit waiting for a seat sorts above the planned units of its group", () => {
  const f = fixture({
    a: { live: [{ slug: "gate-a" }], queued: [{ slug: "a1" }] },
    b: { live: [{ slug: "gate-b" }], queued: [{ slug: "p1" }, { slug: "p2" }, { slug: "back", status: "dispatched" }] },
    limits: { max_builders: "2", unblock_first: "off" },
  });
  const b = f.board();
  const order = slugs(b.flow.queued_order);
  expect(order.indexOf("back")).toBeLessThan(order.indexOf("p1"));
  expect(queuedCards(b)).toEqual(b.flow.queued_order);
});
