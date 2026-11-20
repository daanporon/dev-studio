// board-github.test.ts — U287: the board shows the loop's GitHub API budget (JSON, PRs tile states, text GITHUB
// line), one self-clearing Needs-you card while it is used up with a merge-ready PR open, a lasting
// merge_card in Needs-you, and one card per PR.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard, renderText } from "../../bin/board/board-data.ts";
import { githubView, budgetCard, githubLine, dropLeadMergeCopies } from "../../bin/board/github-view.ts";
import { open } from "../../bin/loop/core/store.ts";

const REPO = join(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const NOW = Math.floor(Date.now() / 1000);
// The board's clock is DS_NOW else Date.now(): pin it to NOW (and the card grace) so no other file's leak moves it.
const saved = { DS_NOW: process.env.DS_NOW, DS_LIMIT_NEEDS_GRACE_MIN: process.env.DS_LIMIT_NEEDS_GRACE_MIN };
beforeAll(() => { process.env.DS_NOW = String(NOW); delete process.env.DS_LIMIT_NEEDS_GRACE_MIN; });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

type Sched = Record<string, unknown>;
function fixture(sched: Sched | null, opts: { ready?: boolean; alerts?: any[]; question?: any } = {}) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardgh-")); roots.push(root);
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  const members = [{ role: "lead", wt: "wtLead" }];
  const waiting_on_you = opts.question ? [opts.question] : [];
  writeFileSync(join(root, "p", "squads", "t.json"), JSON.stringify({ task_id: "t", run_id: "run_t", repo: "path:/r/p", status: "running", members, units: [], worktrees: [], waiting_on_you }));
  writeFileSync(join(root, "seed.json"), JSON.stringify({ workers: [["wtLead", "working"]] }));
  const env = { ...process.env, DS_STATE_ROOT: root };
  for (const cmd of [[join(REPO, "bin/ds"), "import"], [process.execPath, join(REPO, "tests/board-db.ts"), join(root, "seed.json"), "p"]]) {
    const r = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  }
  const s = open(root);
  if (sched) s.upsert("observed_github", { repo: "" }, { next_at: NOW, interval_s: 164, cost: 114, observed_at: NOW, ...sched });
  if (opts.ready !== false) s.upsert("observed_prs", { project: "p", ref: "o/r#7" }, { pr: 7, repo: "o/r", state: "OPEN", verdict: "ready", observed_at: NOW });
  for (const a of opts.alerts ?? []) s.upsert("observed_alerts", { project: "p", id: a.id }, { doc: JSON.stringify(a), observed_at: NOW });
  s.close();
  return () => buildBoard("p", "", root) as any;
}

const out = { remaining: 0, rate_limit: 5000, reset_at: NOW + 900, error: "GraphQL: API rate limit already exceeded" };
const ids = (b: any) => b.needs_you.map((n: any) => String(n.id));

test("github view: ok, low and out; a passed reset ends it", () => {
  expect(githubView(null, NOW)).toBeNull();
  expect(githubView({ remaining: 2906, rate_limit: 5000, interval_s: 164 }, NOW)?.level).toBe("ok");
  expect(githubView({ remaining: 600, rate_limit: 5000 }, NOW)?.level).toBe("low");
  expect(githubView({ ...out }, NOW)?.level).toBe("out");
  expect(githubView({ ...out, reset_at: NOW - 1 }, NOW)?.level).not.toBe("out");
  expect(githubView({ remaining: 400, rate_limit: 5000, error: "HTTP 429" }, NOW)?.level).toBe("out");
});

test("the text line only shows under 20 % or used up", () => {
  expect(githubLine(githubView({ remaining: 2906, rate_limit: 5000 }, NOW), 0)).toBeNull();
  expect(githubLine(githubView({ remaining: 600, rate_limit: 5000, reset_at: NOW + 60 }, NOW), 0)).toMatch(/^GITHUB API 12% left/);
  expect(githubLine(githubView(out, NOW), 2)).toMatch(/^GITHUB API limit used up.*2 PRs waiting to merge/);
});

test("budgetCard needs a used-up budget and a waiting PR of that project", () => {
  const g = githubView(out, NOW);
  expect(budgetCard("p", g, [])).toBeNull();
  expect(budgetCard("p", g, [{ project: "q", num: "1" }])).toBeNull();
  expect(budgetCard("p", githubView({ remaining: 2000, rate_limit: 5000 }, NOW), [{ project: "p", num: "1" }])).toBeNull();
  expect(budgetCard("p", g, [{ project: "p", num: "7" }, { project: "p", num: "8" }])?.text).toMatch(/2 merge-ready PRs wait \(#7, #8\); the loop merges them after the reset/);
});

test("board JSON carries the budget; normal state raises no card", () => {
  const b = fixture({ remaining: 2906, rate_limit: 5000, reset_at: NOW + 900, error: null })();
  expect(b.github).toMatchObject({ remaining: 2906, limit: 5000, interval_s: 164, level: "ok", pct: 58 });
  expect(ids(b).some((i: string) => i.startsWith("github-budget"))).toBe(false);
  expect(renderText(b)).not.toContain("GITHUB");
});

test("used up with a merge-ready PR: one Needs-you card, text GITHUB line; gone when the budget is back", () => {
  const b = fixture(out)();
  expect(b.github.level).toBe("out");
  expect(b.github.waiting).toEqual([{ project: "p", num: "7" }]);
  expect(ids(b).filter((i: string) => i === "github-budget:p")).toHaveLength(1);
  expect(b.needs_you.find((n: any) => n.id === "github-budget:p").text).toMatch(/1 merge-ready PR wait \(#7\)/);
  expect(renderText(b)).toContain("GITHUB API limit used up");
  const back = fixture({ ...out, remaining: 4000, error: null })();
  expect(ids(back).some((i: string) => i.startsWith("github-budget"))).toBe(false);
  const none = fixture(out, { ready: false })();
  expect(ids(none).some((i: string) => i.startsWith("github-budget"))).toBe(false);
});

test("a merge_card that is not the rate limit reaches Needs-you after the grace; one card per PR", () => {
  const old = new Date((NOW - 3600) * 1000).toISOString();
  const card = { id: "merge-1", kind: "merge_card", title: "t · lead: Merge-ready PR left open", question: "PR #7 merge it by hand", ref: "o/r#7", since: old };
  const lead = { id: "q1", title: "Merge-ready PR left open", question: "PR #7 merge it by hand", asker: "lead", pr: "7" };
  const b = fixture(null, { alerts: [card], question: lead })();
  expect(ids(b)).toContain("merge-1");
  expect(b.needs_you.filter((n: any) => /Merge-ready PR left open/.test(String(n.title)))).toHaveLength(1);
  const fresh = fixture(null, { alerts: [{ ...card, since: new Date(NOW * 1000).toISOString() }] })();
  expect(ids(fresh)).not.toContain("merge-1");
  const rl = fixture(null, { alerts: [{ ...card, question: "GraphQL: API rate limit already exceeded" }] })();
  expect(ids(rl)).not.toContain("merge-1");
});

test("dropLeadMergeCopies leaves other questions", () => {
  const qs = [{ title: "Merge-ready PR left open" }, { title: "Which colour?" }];
  expect(dropLeadMergeCopies(qs, () => true)).toEqual([{ title: "Which colour?" }]);
});

// The PRs tile (web/board.html githubTile, cut out of the page): tooltip always, amber under 20 %, red when used up.
const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const ta = page.indexOf("function githubTile"), tb = page.indexOf("function Tile(", ta);
const githubTile: (g: any) => { level: string; detail: string; tip: string } = new Function(`${page.slice(ta, tb)} return githubTile;`)();

test("PRs tile: normal keeps the detail and adds a tooltip; low is amber; out is red with the waiting count", () => {
  expect(githubTile(null)).toEqual({ level: "", detail: "", tip: "" });
  const ok = githubTile({ level: "ok", remaining: 2906, limit: 5000, interval_s: 164, reset_at: NOW + 900 });
  expect(ok.level).toBe(""); expect(ok.detail).toBe("");
  expect(ok.tip).toMatch(/GitHub API 2906\/5000 left · reads every 164 s · resets \d\d:\d\d/);
  const low = githubTile({ level: "low", pct: 12, remaining: 600, limit: 5000, reset_at: NOW + 900 });
  expect(low.level).toBe("warn"); expect(low.detail).toMatch(/^GitHub API 12% · resets \d\d:\d\d$/);
  const out = githubTile({ level: "out", remaining: 0, limit: 5000, reset_at: NOW + 900, waiting: [{ num: "7" }, { num: "8" }] });
  expect(out.level).toBe("crit"); expect(out.detail).toMatch(/^GitHub limit out → \d\d:\d\d · 2 waiting to merge$/);
});
