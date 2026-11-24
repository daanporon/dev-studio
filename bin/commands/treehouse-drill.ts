// ds treehouse-drill — the helper for the treehouse trial (orca-backend-alternatives U16e, docs/backends/trial-treehouse.md).
//   ds treehouse-drill time [--repo <path>] [--test <cmd>] [--n 3] [--fetch] [--json]
//       worktree start to first test, pooled against fresh: a clone of the repo (default: a one-commit
//       repo) in a temp folder, then `--n` runs of each, every run one worktree made through the loop's own
//       provider (bin/loop/io/worktrees.ts), the test command run in it (`sh -c`, default `true`), and the
//       worktree removed. The treehouse pool is warmed by one untimed lease first (reported as `cold`), so
//       each timed lease reuses a returned slot with its ignored files (node_modules) kept; each git run is a
//       fresh `git worktree add`. Everything lives in the temp folder (pool root, worktree root, loop.db, HOME)
//       and is removed after; the repo and the host's pools are never touched. The treehouse binary is
//       DS_TREEHOUSE_BIN, else treehouse on PATH, else with `--fetch` the pinned release downloaded into
//       that temp folder (sha256 checked); with none it says so and exits 2.
//   ds treehouse-drill leases <project> [--json]
//       read-only: each worktree the treehouse provider made for the project (its `worktrees` rows, live
//       and gone) beside `treehouse status` of its repo: the slot, its lease and holder, and what does not
//       match (a live row whose slot is on another lease or none, a gone row whose slot is still on its
//       lease, a slot leased to this project's holder that no row names). Run after each trial step.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parse } from "../loop/core/cli.ts";
import { stateRoot } from "../lib/shared.ts";
import { open } from "../loop/core/store.ts";
import { createWorktree, git, removeWorktree } from "../loop/io/worktrees.ts";
import { fetchTreehouse, slots, treehouseBin, TREEHOUSE_VERSION } from "../loop/io/providers/treehouse.ts";

export const help = "time [--repo <path>] [--test <cmd>] [--n 3] [--fetch] | leases <project> [--json] — the treehouse trial's start-to-first-test drill and lease check (U16e)";

const USAGE = "usage: ds treehouse-drill time [--repo <path>] [--test <cmd>] [--n 3] [--fetch] [--json]\n       ds treehouse-drill leases <project> [--json]\n";
const G = ["-c", "user.name=drill", "-c", "user.email=drill@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

export type Run = { provider: "treehouse" | "git"; run: number | "cold"; path: string; create_ms: number; test_ms: number; total_ms: number; test_code: number };
const ms = (t0: number) => Math.round(performance.now() - t0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

async function must(args: string[], cwd?: string): Promise<string> {
  const g = await git(cwd ? [...G, "-C", cwd, ...args] : [...G, ...args]);
  if (g.code !== 0) throw new Error(`git ${args.join(" ")}: ${g.err.trim()}`);
  return g.out.trim();
}

/** The drill: `n` pooled and `n` fresh runs in a temp folder, which is removed after. */
export async function timeDrill(o: { repo?: string; test?: string; n?: number; fetch?: boolean; dir?: string }) {
  const n = o.n ?? 3, test = o.test ?? "true";
  const d = o.dir ?? mkdtempSync(join(tmpdir(), "ds-treehouse-drill-"));
  const keys = ["HOME", "DS_TREEHOUSE_BIN", "TREEHOUSE_ROOT", "XDG_CONFIG_HOME", "TREEHOUSE_NO_UPDATE_CHECK", "DS_WORKTREE_ROOT"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    let bin = treehouseBin();
    if (!bin && o.fetch) {
      const got = await fetchTreehouse(join(d, "bin"));
      if ("skip" in got) return { error: `treehouse: ${got.skip}` };
      bin = got.bin;
    }
    if (!bin) return { error: `treehouse: not installed (no DS_TREEHOUSE_BIN, none on PATH); pass --fetch for the pinned ${TREEHOUSE_VERSION} in a temp folder` };
    const repo = join(d, "repo");
    if (o.repo) await must(["clone", "-q", o.repo, repo]);
    else {
      mkdirSync(repo);
      await must(["init", "-q", "-b", "main"], repo);
      await must(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    }
    const base = await must(["rev-parse", "--abbrev-ref", "HEAD"], repo);
    mkdirSync(join(d, "config"), { recursive: true }); mkdirSync(join(d, "home"), { recursive: true });
    Object.assign(process.env, { HOME: join(d, "home"), DS_TREEHOUSE_BIN: bin, TREEHOUSE_ROOT: join(d, "pools"), XDG_CONFIG_HOME: join(d, "config"),
      TREEHOUSE_NO_UPDATE_CHECK: "1", DS_WORKTREE_ROOT: join(d, "wts") });
    const s = open(join(d, "state"));
    const runs: Run[] = [];
    try {
      const one = async (provider: Run["provider"], run: Run["run"]) => {
        const name = `drill-${provider}-${run}`, t0 = performance.now();
        const { row } = await createWorktree(s, provider, { repo, name, branch: name, base, project: "drill", squad: "drill", role: "builder" });
        const create = ms(t0), path = String(row.path), t1 = performance.now();
        const p = Bun.spawn(["sh", "-c", test], { cwd: path, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        const code = await p.exited, testMs = ms(t1);
        runs.push({ provider, run, path, create_ms: create, test_ms: testMs, total_ms: create + testMs, test_code: code });
        await removeWorktree(s, path, { force: true });
      };
      await one("treehouse", "cold");
      for (let i = 1; i <= n; i++) await one("treehouse", i);
      for (let i = 1; i <= n; i++) await one("git", i);
    } finally { s.close(); }
    const timed = (p: Run["provider"]) => runs.filter((r) => r.provider === p && r.run !== "cold");
    const sum = (p: Run["provider"]) => ({ runs: timed(p).length, median_total_ms: median(timed(p).map((r) => r.total_ms)),
      median_create_ms: median(timed(p).map((r) => r.create_ms)), median_test_ms: median(timed(p).map((r) => r.test_ms)) });
    return { at: new Date().toISOString(), repo: o.repo ?? null, test, n, treehouse: bin, runs, pooled: sum("treehouse"), fresh: sum("git") };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (!o.dir) rmSync(d, { recursive: true, force: true });
  }
}

type Tree = { squad: string | null; role: string | null; name: string; path: string; repo: string; branch: string | null; lease: string | null; created_at: number | null; gone_at: number | null };
export type Lease = Tree & { slot: { status: string; lease_id: string; lease_holder: string } | null; problem: string | null };

/** Each treehouse worktree of the project beside its repo's `treehouse status`; reads only. */
export async function leases(project: string, o: { root?: string } = {}) {
  const db = join(o.root ?? stateRoot(), "loop.db");
  let trees: Tree[] = [];
  if (existsSync(db)) {
    const d = new Database(db, { readonly: true });
    try {
      trees = d.query(`SELECT squad, role, name, path, repo, branch, lease, created_at, gone_at FROM worktrees
        WHERE project = ? AND provider = 'treehouse' AND repo IS NOT NULL ORDER BY repo, created_at, path`).all(project) as Tree[];
    } finally { d.close(); }
  }
  const out: Lease[] = [], strays: { repo: string; path: string; lease_id: string; lease_holder: string }[] = [], errors: string[] = [];
  for (const repo of [...new Set(trees.map((t) => t.repo))]) {
    let pool: Awaited<ReturnType<typeof slots>>;
    try { pool = await slots(repo); } catch (e) { errors.push((e as Error).message); pool = []; }
    const mine = trees.filter((t) => t.repo === repo);
    // A path can hold several rows over time (a returned slot leased again): the newest says what should be.
    const newest = new Map(mine.map((t) => [t.path, t]));
    for (const t of mine) {
      const sl = pool.find((x) => x.path === t.path) ?? null;
      const current = newest.get(t.path) === t, held = !!sl?.lease_id && sl.lease_id === t.lease;
      const problem = !current ? null
        : t.gone_at == null && !held ? (sl ? `live row, slot on ${sl.lease_id ? `lease ${sl.lease_id}` : "no lease"}` : "live row, no slot in the pool")
        : t.gone_at != null && held ? "gone row, slot still on its lease" : null;
      out.push({ ...t, slot: sl ? { status: sl.status, lease_id: sl.lease_id, lease_holder: sl.lease_holder } : null, problem });
    }
    for (const sl of pool) {
      if (!sl.lease_id || !sl.lease_holder.startsWith(`ds:${project}:`)) continue;
      // A row on that lease, live or gone, already says what is wrong with it (a gone row on a held lease above).
      if (!mine.some((t) => t.path === sl.path && t.lease === sl.lease_id))
        strays.push({ repo, path: sl.path, lease_id: sl.lease_id, lease_holder: sl.lease_holder });
    }
  }
  const problems = out.filter((x) => x.problem).length + strays.length + errors.length;
  return { at: new Date().toISOString(), project, worktrees: out, strays, errors, problems };
}

function timeText(r: Awaited<ReturnType<typeof timeDrill>>): string {
  if ("error" in r) return `${r.error}\n`;
  const row = (x: Run) => `  ${x.provider.padEnd(9)} ${String(x.run).padEnd(4)} create ${x.create_ms} ms  test ${x.test_ms} ms (exit ${x.test_code})  total ${x.total_ms} ms`;
  const sum = (k: string, s: typeof r.pooled) => `${k}: ${s.runs} runs, median ${s.median_total_ms} ms (create ${s.median_create_ms} ms, test ${s.median_test_ms} ms)`;
  return [`repo: ${r.repo ?? "(a one-commit temp repo)"}  test: ${r.test}  treehouse: ${r.treehouse}`, ...r.runs.map(row),
    sum("pooled (treehouse)", r.pooled), sum("fresh (git)", r.fresh)].join("\n") + "\n";
}

function leasesText(r: Awaited<ReturnType<typeof leases>>): string {
  const lines = r.worktrees.map((t) => `  ${t.gone_at == null ? "live" : "gone"} ${t.squad ?? "-"}/${t.role ?? "-"} ${t.path} lease ${t.lease ?? "-"}`
    + ` → slot ${t.slot ? `${t.slot.status}, ${t.slot.lease_id ? `lease ${t.slot.lease_id} (${t.slot.lease_holder})` : "no lease"}` : "none"}${t.problem ? `  !! ${t.problem}` : ""}`);
  for (const x of r.strays) lines.push(`  !! ${x.path} leased to ${x.lease_holder} (${x.lease_id}), no row names it`);
  for (const e of r.errors) lines.push(`  !! ${e}`);
  return [`${r.project}: ${r.worktrees.length} treehouse worktree row(s), ${r.problems} problem(s)`, ...lines].join("\n") + "\n";
}

export async function run(args: string[]): Promise<number> {
  const { pos, opt, flag } = parse(args, ["repo", "test", "n"], ["json", "fetch"]);
  const [cmd, project] = pos;
  if (cmd === "time" && pos.length === 1) {
    const n = opt.n === undefined ? 3 : Number(opt.n);
    if (!Number.isInteger(n) || n < 1 || n > 50) { process.stderr.write("ds treehouse-drill: --n is a whole number from 1 to 50\n"); return 2; }
    if (opt.repo && !existsSync(opt.repo)) { process.stderr.write(`ds treehouse-drill: no such repo: ${opt.repo}\n`); return 2; }
    const r = await timeDrill({ repo: opt.repo, test: opt.test, n, fetch: flag.has("fetch") });
    process.stdout.write(flag.has("json") ? `${JSON.stringify(r, null, 2)}\n` : timeText(r));
    return "error" in r ? 2 : 0;
  }
  if (cmd === "leases" && project && pos.length === 2) {
    const r = await leases(project);
    process.stdout.write(flag.has("json") ? `${JSON.stringify(r, null, 2)}\n` : leasesText(r));
    return r.problems ? 1 : 0;
  }
  process.stderr.write(USAGE);
  return 2;
}
