// treehouse-drill.test.ts — orca-backend-alternatives U16e: `ds treehouse-drill` (bin/commands/treehouse-drill.ts).
// `time` runs pooled (treehouse) and fresh (git) worktrees to a first test in a temp folder it removes after;
// `leases` sets a project's treehouse `worktrees` rows beside `treehouse status` and names what does not
// match. Against the pinned treehouse release, or skipped with the reason printed when it can't be fetched
// (DS_TREEHOUSE_FETCH=0, or DS_TREEHOUSE_BIN for a local binary).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";
import { createWorktree, git, removeWorktree } from "../../bin/loop/io/worktrees.ts";
import { fetchTreehouse, treehouse } from "../../bin/loop/io/providers/treehouse.ts";
import { leases, run, timeDrill } from "../../bin/commands/treehouse-drill.ts";

const dir = mkdtempSync(join(tmpdir(), "treehouse-drill-"));
const ENV = ["HOME", "XDG_CONFIG_HOME", "TREEHOUSE_ROOT", "DS_TREEHOUSE_BIN", "TREEHOUSE_NO_UPDATE_CHECK", "DS_WORKTREE_ROOT", "DS_STATE_ROOT"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const restore = () => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
afterAll(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

describe("treehouse-drill without treehouse", () => {
  test("time says treehouse is missing and exits 2; bad arguments print the usage", async () => {
    process.env.DS_TREEHOUSE_BIN = join(dir, "no-such-treehouse");
    try {
      const r = await timeDrill({ n: 1 });
      expect("error" in r && r.error).toMatch(/^treehouse: not installed .*--fetch/);
      expect(process.env.DS_TREEHOUSE_BIN).toBe(join(dir, "no-such-treehouse"));
      expect(await run(["time", "--n", "0"])).toBe(2);
      expect(await run(["nope"])).toBe(2);
      expect(await run(["leases"])).toBe(2);
    } finally { restore(); }
  });

  test("leases of a project with no treehouse rows reads nothing and finds no problem", async () => {
    const r = await leases("nobody", { root: join(dir, "empty-root") });
    expect(r).toMatchObject({ project: "nobody", worktrees: [], strays: [], errors: [], problems: 0 });
  });
});

const got = await fetchTreehouse(join(dir, "bin"));
if ("skip" in got) {
  console.log(`treehouse-drill: the treehouse cases are skipped: ${got.skip}`);
  describe("treehouse-drill", () => { test.skip(`time and leases (skipped: ${got.skip})`, () => {}); });
} else {
  const T = 180_000;
  describe("treehouse-drill", () => {
    test("time: a cold lease, then n pooled and n fresh runs, the test run in each; the temp folder is removed", async () => {
      process.env.DS_TREEHOUSE_BIN = got.bin;
      try {
        const before = readdirSync(tmpdir()).filter((f) => f.startsWith("ds-treehouse-drill-"));
        const r = await timeDrill({ n: 2, test: "test -d .git || test -f .git" });
        if ("error" in r) throw new Error(r.error);
        expect(r.runs.map((x) => `${x.provider}:${x.run}`)).toEqual(["treehouse:cold", "treehouse:1", "treehouse:2", "git:1", "git:2"]);
        expect(r.runs.every((x) => x.test_code === 0 && x.total_ms === x.create_ms + x.test_ms)).toBe(true);
        // The pooled runs reuse the cold run's slot: the pool never grows past one.
        expect(new Set(r.runs.filter((x) => x.provider === "treehouse").map((x) => x.path)).size).toBe(1);
        expect(new Set(r.runs.filter((x) => x.provider === "git").map((x) => x.path)).size).toBe(2);
        expect(r.pooled).toMatchObject({ runs: 2 });
        expect(r.fresh).toMatchObject({ runs: 2 });
        expect(typeof r.pooled.median_total_ms).toBe("number");
        expect(readdirSync(tmpdir()).filter((f) => f.startsWith("ds-treehouse-drill-"))).toEqual(before);
        expect(process.env.DS_TREEHOUSE_BIN).toBe(got.bin);
        expect(process.env.TREEHOUSE_ROOT).toBe(saved.TREEHOUSE_ROOT);
      } finally { restore(); }
    }, T);

    test("leases: matched rows, a gone row whose slot is still leased, and a stray lease of the project's holder", async () => {
      Object.assign(process.env, { DS_TREEHOUSE_BIN: got.bin, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "home", ".config"),
        TREEHOUSE_ROOT: join(dir, "pools"), TREEHOUSE_NO_UPDATE_CHECK: "1", DS_STATE_ROOT: join(dir, "state") });
      mkdirSync(process.env.XDG_CONFIG_HOME!, { recursive: true });
      const s = open(join(dir, "state"));
      try {
        const repo = join(dir, "repo");
        mkdirSync(repo);
        for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) {
          const o = await git(["-C", repo, ...a]);
          if (o.code !== 0) throw new Error(o.err);
        }
        const spec = (name: string) => ({ repo, name, branch: name, base: "main", project: "trialp", squad: "sq", role: "builder" });
        const a = await createWorktree(s, "treehouse", spec("ds-a"), 1000);
        const b = await createWorktree(s, "treehouse", spec("ds-b"), 1001);
        await removeWorktree(s, String(b.row.path), { force: true }, 1002);
        let r = await leases("trialp", { root: join(dir, "state") });
        expect(r.problems).toBe(0);
        expect(r.worktrees.map((t) => [t.name, t.gone_at == null, t.slot?.lease_id ?? null])).toEqual([
          ["ds-a", true, a.row.lease], ["ds-b", false, ""]]);
        expect(await run(["leases", "trialp"])).toBe(0);

        // The row says gone, the slot is still on its lease: a return that never ran.
        s.db.query("UPDATE worktrees SET gone_at = 1003 WHERE path = ?").run(String(a.row.path));
        // A lease of this project's holder that no row names: a create that died before its row.
        const o = await treehouse(repo, ["get", "--lease", "--json", "--lease-holder", "ds:trialp:ds-lost"]);
        expect(o.code).toBe(0);
        r = await leases("trialp", { root: join(dir, "state") });
        expect(r.worktrees.find((t) => t.name === "ds-a")?.problem).toBe("gone row, slot still on its lease");
        expect(r.strays.map((x) => x.lease_holder)).toEqual(["ds:trialp:ds-lost"]);
        expect(r.problems).toBe(2);
        expect(await run(["leases", "trialp"])).toBe(1);
        expect(existsSync(String(a.row.path))).toBe(true);
      } finally { s.close(); restore(); }
    }, T);
  });
}
