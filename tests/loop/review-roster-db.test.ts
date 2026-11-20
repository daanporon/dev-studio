// review-roster-db.test.ts — U228, U257: review-unit's review row comes from the project's `config` rows
// over the shipped conventions/roles.conf (settings.ts readRoster), and the unit tier from loop.db's units.
// No state/<label>/roles.conf is read: the fixtures hold none, or one that disagrees with the rows.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";

const REPO = join(import.meta.dir, "..", "..");
const L = "zzrdb", SQUAD = "topic", HARD = "/wt/hard", STD = "/wt/std";
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });

function tree(): string {
  const t = mkdtempSync(join(tmpdir(), "zzrdb-"));
  temps.push(t);
  mkdirSync(join(t, "state", L, "squads"), { recursive: true });
  cpSync(join(REPO, "conventions"), join(t, "conventions"), { recursive: true });
  const units = [
    { slug: "u1-hard", tier: "hard", builder_wt: `host::${HARD}` },
    { slug: "u2-std", tier: "standard", builder_wt: STD },
  ];
  writeFileSync(join(t, "state", L, "squads", `${SQUAD}.json`), JSON.stringify({ topic: SQUAD, units }));
  return t;
}
/** The loop's rows: the project's roster rows (role -> the rest of the line) and the units. */
function seed(t: string, roster: Record<string, string>, tiers = ["hard", "standard"]): void {
  const s = open(join(t, "state"));
  const at = Math.floor(Date.now() / 1000);
  try {
    for (const [key, value] of Object.entries(roster)) s.upsert("config", { project: L, file: "roles.conf", key }, { value, observed_at: at });
    s.upsert("units", { project: L, squad: SQUAD, slug: "u1-hard" }, { ord: 0, tier: tiers[0], builder_wt: `host::${HARD}`, status: "dispatched", observed_at: at, updated_at: at });
    s.upsert("units", { project: L, squad: SQUAD, slug: "u2-std" }, { ord: 1, tier: tiers[1], builder_wt: STD, status: "dispatched", observed_at: at, updated_at: at });
  } finally { s.close(); }
}
/** What review-unit picks in tree t, per worktree: the tier, the row it reviews on and that row. */
function picks(t: string): Record<string, { tier: string; row: string; fields: string[] }> {
  const code = `
    import { effectiveRosterRows, unitTier } from ${JSON.stringify(join(REPO, "bin/review/review-lib.ts"))};
    import { reviewRowName } from ${JSON.stringify(join(REPO, "bin/review/review-unit.ts"))};
    const rows = effectiveRosterRows(${JSON.stringify(L)});
    const o = {};
    for (const wt of ${JSON.stringify([HARD, STD])}) {
      const tier = unitTier(${JSON.stringify(L)}, wt), row = reviewRowName(rows, tier);
      o[wt] = { tier, row, fields: rows.get(row) ?? [] };
    }
    console.log(JSON.stringify(o));`;
  const env: Record<string, string> = { ...process.env as Record<string, string>, DS_ROOT: t };
  delete env.DS_STATE_ROOT;
  const p = Bun.spawnSync(["bun", "-e", code], { env, cwd: t, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString());
}
const PROJECT_ROWS = { "builder-review": "codex gpt-5 elevate high claude:opus", "builder-review-standard": "claude sonnet elevate medium codex:gpt-5" };

describe("review-unit reads its row from config rows and its tier from loop.db", () => {
  test("no project rows: the shipped roster's review rows, hard and standard", () => {
    const t = tree();
    seed(t, {});
    const got = picks(t);
    expect([got[HARD].tier, got[HARD].row]).toEqual(["hard", "builder-review"]);
    expect([got[STD].tier, got[STD].row]).toEqual(["standard", "builder-review-standard"]);
    expect(got[HARD].fields[1]).toBeTruthy();
  });

  test("the project's rows pick the reviewer model, with no state/<label>/roles.conf", () => {
    const t = tree();
    seed(t, PROJECT_ROWS);
    const got = picks(t);
    expect(got[HARD].fields.slice(1, 3)).toEqual(["codex", "gpt-5"]);
    expect(got[STD].fields.slice(1, 3)).toEqual(["claude", "sonnet"]);
  });

  test("a project roles.conf the rows do not hold is not read", () => {
    const t = tree();
    seed(t, PROJECT_ROWS);
    writeFileSync(join(t, "state", L, "roles.conf"), "builder-review claude file-model elevate high\n");
    expect(picks(t)[HARD].fields.slice(1, 3)).toEqual(["codex", "gpt-5"]);
  });

  test("the tier comes from the units table, over the squad JSON", () => {
    const t = tree();
    seed(t, PROJECT_ROWS, ["standard", "hard"]);   // the squad JSON says the opposite
    const got = picks(t);
    expect([got[HARD].tier, got[STD].tier]).toEqual(["standard", "hard"]);
    expect(got[STD].row).toBe("builder-review");
  });

  test("a unit the database does not hold is read from the squad files", () => {
    const t = tree();
    seed(t, {});
    const s = open(join(t, "state"));
    try { s.db.run("DELETE FROM units"); } finally { s.close(); }
    expect(picks(t)[HARD].tier).toBe("hard");
  });
});
