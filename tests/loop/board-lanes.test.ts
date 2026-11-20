// board-lanes.test.ts — adaptive-builder-capacity U6: the light lane on the board. Each unit row gets `lane`
// (light | moved | normal), the header splits the working Builders by lane, and the page shows a chip and the
// Builders tile's `normal x/N · light y/M`. With `max_light_builders 0` the board is as it was.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard } from "../../bin/board/board-data.ts";
import { laneNow } from "../../bin/loop/capacity/slot.ts";
import { open } from "../../bin/loop/core/store.ts";

const REPO = join(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function fixture(maxLight: number) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardlanes-")); roots.push(root);
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  const units = [
    { slug: "u1-light", status: "dispatched", deps: [], builder_wt: "wtB1", lane: "light", lane_rule: "docs-only" },
    { slug: "u2-moved", status: "dispatched", deps: [], builder_wt: "wtB2", lane: "light", lane_rule: "docs-only" },
    { slug: "u3-normal", status: "dispatched", deps: [], builder_wt: "wtB3" },
  ];
  const members = [{ role: "lead", wt: "wtLead" }, ...units.map((u) => ({ role: "builder", suffix: u.slug, wt: u.builder_wt }))];
  writeFileSync(join(root, "p", "squads", "t.json"), JSON.stringify({ task_id: "t", run_id: "run_t", repo: "path:/r/p", status: "running", members, units, worktrees: [] }));
  writeFileSync(join(root, "seed.json"), JSON.stringify({ workers: [["wtLead", "working"], ["wtB1", "working"], ["wtB2", "working"], ["wtB3", "working"]] }));
  const env = { ...process.env, DS_STATE_ROOT: root };
  for (const cmd of [[join(REPO, "bin/ds"), "import"], [process.execPath, join(REPO, "tests/board-db.ts"), join(root, "seed.json"), "p"]]) {
    const r = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  }
  const s = open(root);
  const conf = (key: string, value: string) => s.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: 1 });
  conf("max_builders", "6"); conf("max_light_builders", String(maxLight)); conf("light_lane_cpu_h", "3");
  for (const [slug, h] of [["u1-light", 1], ["u2-moved", 4]] as const) s.upsert("unit_cpu", { project: "p", squad: "t", slug }, { cpu_s: h * 3600, wt: "x", first_at: 1, updated_at: 1 });
  s.close();
  return { root, board: () => buildBoard("p", "", root) as any };
}

test("laneNow: light under the threshold, moved past it, normal without the tag", () => {
  expect(laneNow({ lane: "light" }, 1, 3)).toBe("light");
  expect(laneNow({ lane: "light" }, 3, 3)).toBe("light");
  expect(laneNow({ lane: "light" }, 3.5, 3)).toBe("moved");
  expect(laneNow({}, 9, 3)).toBe("normal");
  expect(laneNow(null, 0, 3)).toBe("normal");
});

test("light lane on: unit lanes and the header split", () => {
  const f = fixture(2), b = f.board();
  const u = Object.fromEntries(b.squads[0].units.map((x: any) => [x.slug, x]));
  expect(u["u1-light"].lane).toBe("light");
  expect(u["u1-light"].lane_rule).toBe("docs-only");
  expect(u["u2-moved"].lane).toBe("moved");
  expect(u["u3-normal"].lane).toBeUndefined();
  expect(b.header.builders_working).toBe(3);
  expect(b.header.builders_light).toBe(1);
  expect(b.header.builders_normal).toBe(2);
  expect(b.header.builders_light_of).toBe(2);
});

test("light lane off: no lane keys, the header as before", () => {
  const f = fixture(0), b = f.board();
  expect(b.header.builders_light_of).toBeUndefined();
  expect(b.header.builders_normal).toBeUndefined();
  expect(b.header.builders_working).toBe(3);
});

test("the board never records a lane move event", () => {
  const f = fixture(2); f.board();
  const s = open(f.root);
  expect(s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'unit_lane_moved'").get()).toEqual({ n: 0 });
  s.close();
});

test("the page: chip text and the Builders tile detail", () => {
  const page = readFileSync(join(REPO, "web/board.html"), "utf8");
  expect(page).toContain('"light→normal" : "light"');
  expect(page).toContain('"normal " + H.builders_normal + "/" + H.builders_of + " · light " + H.builders_light + "/" + H.builders_light_of');
  expect(page).toContain('H.builders_light_of > 0 ?');
  // lane off falls through to the old detail
  expect(page).toContain('"of " + H.builders_of + " max"');
});
