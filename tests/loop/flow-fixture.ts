// flow-fixture.ts — the board's Flow fixture (U1): a loop.db built from tests/fixtures/flow/ the way
// tests/board.sh builds its boards (`bin/ds import` over the squad JSON, then tests/board-db.ts for
// the observer rows, events and picks), at a pinned clock and time zone.
//
//   import { flowFixture } from "./flow-fixture.ts";   const f = flowFixture(); f.board(); f.cleanup();
//   bun tests/loop/flow-fixture.ts <state-root> <label-a> [<label-b>]   (prints FX_NOW; tests/board.sh)
//
// Project a: squad `flow` with a unit in each stage and in each Queued and PR open group, five merges
// on five days (typical: building 1200 s, PR open 500 s, merging 100 s), a merge older than a week,
// a done squad `shipped` with one merge and a suspended squad `parked`. Project b: one Building unit
// and five merges with shorter stage times of its own. A squad JSON string "ago:<s>" becomes the
// ISO time that many seconds before FX_NOW; seed `ago` is the same for events. Building splits by the
// seeded reviews (U4): u2-building coding, u19-slow reviewing, u9-closed fixing findings, u8-gone
// review stopped.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard } from "../../bin/board/board-data.ts";

export const FX_NOW = Date.UTC(2027, 0, 15, 12) / 1000;   // a Friday noon
export const FX_TZ = "UTC";
const REPO = join(import.meta.dir, "../..");
const FX = join(REPO, "tests/fixtures/flow");

const iso = (v: unknown): unknown => typeof v === "string" && /^ago:\d+$/.test(v) ? new Date((FX_NOW - Number(v.slice(4))) * 1000).toISOString()
  : Array.isArray(v) ? v.map(iso) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, iso(x)])) : v;

function run(cmd: string[], env: Record<string, string>) {
  const r = spawnSync(cmd[0], cmd.slice(1), { env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")}: exit ${r.status}\n${r.stderr}`);
}

// Builds the fixture's loop.db under <root> for project a (and b when given).
export function buildFlowDb(root: string, a: string, b?: string): void {
  const env = { DS_STATE_ROOT: root, DS_NOW: String(FX_NOW), TZ: FX_TZ };
  const pairs = [["a", a], ...(b ? [["b", b]] : [])] as [string, string][];
  for (const [src, label] of pairs) {
    mkdirSync(join(root, label, "squads"), { recursive: true });
    for (const f of readdirSync(join(FX, src, "squads")))
      writeFileSync(join(root, label, "squads", f), JSON.stringify(iso(JSON.parse(readFileSync(join(FX, src, "squads", f), "utf8")))));
  }
  run([join(REPO, "bin/ds"), "import"], env);
  for (const [src, label] of pairs) run([process.execPath, join(REPO, "tests/board-db.ts"), join(FX, src, "seed.json"), label], env);
}

export function flowFixture(o: { a?: string; b?: string } = {}) {
  process.env.DS_NOW = String(FX_NOW);
  process.env.TZ = FX_TZ;
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "flowfx-"));
  const a = o.a ?? "fa", b = o.b ?? "fb";
  buildFlowDb(root, a, b);
  return {
    root, a, b,
    // The board as board.sh --json builds it: one project, or every project with "".
    board: (project = a) => buildBoard(project, "", root) as any,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

if (import.meta.main) {
  const [root, a, b] = process.argv.slice(2);
  if (!root || !a) { console.error("usage: flow-fixture.ts <state-root> <label-a> [<label-b>]"); process.exit(2); }
  buildFlowDb(root, a, b);
  console.log(FX_NOW);
}
