// board-unlock.test.ts — picker-prefers-unblocking-units U2: the board shows ⬆N on a queued unit others wait on,
// says why in the unit window, and lists `unblock_first` in Settings. Data comes from loop.db alone (buildBoard).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard, limitGroup, limitsJson, renderText } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";
import { mount } from "./board-mount.ts";

const REPO = join(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type U = Record<string, unknown>;
// Squad `a` and `b` of project p. `live`: dispatched units with a working Builder; `queued`: planned, ready units.
function fixture(o: { a: { live?: U[]; queued?: U[]; extra?: U }; b: { live?: U[]; queued?: U[] }; limits: Record<string, string> }) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardunlock-")); roots.push(root);
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
const unitOf = (b: any, t: string, slug: string) => squadOf(b, t).units.find((u: any) => u.slug === slug);
const settle = () => new Promise((r) => setTimeout(r, 30));

// Squad b: an older leaf and a newer root with 3 open dependents; squad a (the focus squad) has a leaf.
const chain = (limits: Record<string, string> = {}) => fixture({
  a: { queued: [{ slug: "a1" }] },
  b: { queued: [{ slug: "leaf" }, { slug: "root" }, { slug: "d1", deps: ["root"] }, { slug: "d2", deps: ["d1"] }, { slug: "d3", deps: ["root"] }] },
  limits: { max_builders: "3", focus_squad: "a", ...limits },
});

test("data: the root carries unlocks 3 and unlock on; the leaf and the focus leaf carry neither", () => {
  const b = chain().board();
  expect(unitOf(b, "b", "root").unlocks).toBe(3);
  expect(unitOf(b, "b", "root").unlock).toBe("on");
  expect(unitOf(b, "b", "leaf").unlocks).toBeUndefined();
  expect(unitOf(b, "a", "a1").unlocks).toBeUndefined();
  expect(unitOf(b, "b", "d1").unlocks).toBe(1);          // d2 waits on d1: a blocked unit still shows its count, off the line
  expect(unitOf(b, "b", "d1").unlock).toBeUndefined();
  const card = b.flow.cards.find((c: any) => c.key === "p/b/root");
  expect(card.unlocks).toBe(3);
  expect(card.unlock).toBe("on");
  expect(b.flow.cards.find((c: any) => c.key === "p/b/leaf").unlocks).toBeUndefined();
});

test("unblock_first off: the count stays, the key is not on", () => {
  const b = chain({ unblock_first: "off" }).board();
  expect(unitOf(b, "b", "root").unlocks).toBe(3);
  expect(unitOf(b, "b", "root").unlock).toBeUndefined();
});

test("the text board prints unlocks:3 on the root only", () => {
  const text = renderText(chain().board());
  expect(text).toMatch(/root.*unlocks:3/);
  expect(text).not.toMatch(/leaf.*unlocks:/);
});

test("Settings groups unblock_first under Agents & nudges, with on/off as its values", async () => {
  const root = chain().root;
  expect(limitGroup("unblock_first")).toBe("Agents & nudges");
  const row = limitsJson("p", root).limits.find((l: any) => l.key === "unblock_first");
  expect(row.allowed).toEqual(["on", "off"]);
  expect(readFileSync(join(REPO, "bin/commands/limits-ts.ts"), "utf8")).toContain('key === "unblock_first") return ["on", "off"]');
});

test("the mounted page: ⬆3 on the root's Flow card and row, none on the leaf, and the Runs on line", async () => {
  const f = chain();
  const run = await mount(f.board()), doc = run.window.document, W = run.window;
  expect(run.errors).toEqual([]);
  const card = (key: string) => doc.querySelector(`.fcard[data-key="${key}"]`) as any;
  expect(card("p/b/root").querySelector(".umark.unlock:not(.held)").textContent).toBe("⬆3");
  expect(card("p/b/leaf").querySelector(".umark.unlock")).toBeNull();
  card("p/b/root").dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  expect((doc.querySelector(".ud-runs") as any).textContent).toContain("⬆ unlocks 3: goes first inside the limit");
  doc.querySelector(".ud-close")!.dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  card("p/b/leaf").dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  expect((doc.querySelector(".ud-runs") as any).textContent).not.toContain("⬆");
});

test("the mounted page with the key off: the mark is dim", async () => {
  const run = await mount(chain({ unblock_first: "off" }).board()), doc = run.window.document;
  expect(doc.querySelector('.fcard[data-key="p/b/root"] .umark.unlock.held')!.textContent).toBe("⬆3");
});
