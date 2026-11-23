// finish-record.test.ts — orca-backend-alternatives U3: every worker's end leaves one `finishes` row
// (migration 0052) with its outcome and generation (DS_GEN), and a replay writes none. The store API,
// `ds finish` (a Tester's or Researcher's verdict) and finish-unit.sh's PR, --no-pr and --failed ends,
// the last against a stub gh and a stub backend on a temp state root.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { finishKey, listFinishes, parseMember, recordFinish } from "../../bin/loop/squad/finish.ts";

const ROOT = join(import.meta.dir, "..", "..");
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; }
function store(root: string): Store { const s = open(root); stores.push(s); return s; }
const rows = (root: string, where = "1"): Row[] => { const s = store(root); return s.db.query(`SELECT * FROM finishes WHERE ${where} ORDER BY id`).all() as Row[]; };

// A clean env for a child: no caller identity, no loop front, the temp state root.
function env(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DS_MEMBER|DS_GEN|DS_LOOP_CHILD|DS_NOW|ORCA_TERMINAL_HANDLE|CLAUDE_PROJECT_DIR)$/.test(k)) e[k] = v;
  return { ...e, DS_STATE_ROOT: root, ...extra };
}
function sh(argv: string[], o: { cwd?: string; env: Record<string, string> }): { rc: number; out: string; err: string } {
  const p = Bun.spawnSync(argv, { cwd: o.cwd, env: o.env, stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("recordFinish", () => {
  const member = { project: "zzfin", squad: "sq", role: "tester", suffix: "" };

  test("a verdict writes one row with its generation and one event; the same finish again writes none", () => {
    const s = store(temp("zzfin-"));
    const a = recordFinish(s, { member, unit: "u1-x", outcome: "verdict", body: "pass: 2 bugs, none blocking", gen: "g1", wt: "/w/t" }, 1000);
    expect(a.created).toBe(true);
    expect(a.row).toMatchObject({ project: "zzfin", squad: "sq", member: "zzfin/sq/tester", unit: "u1-x", gen: "g1", outcome: "verdict", wt: "/w/t", at: 1000 });
    const b = recordFinish(s, { member, unit: "u1-x", outcome: "verdict", body: "pass: 2 bugs, none blocking", gen: "g1", wt: "/w/t" }, 2000);
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    expect(listFinishes(s)).toHaveLength(1);
    const ev = s.db.query("SELECT * FROM events WHERE kind = 'finish_recorded'").all() as Row[];
    expect(ev).toHaveLength(1);
    expect(JSON.parse(String(ev[0].payload))).toMatchObject({ member: "zzfin/sq/tester", unit: "u1-x", outcome: "verdict", gen: "g1" });
  });

  test("another generation, outcome or text is another finish; no unit and no gen are NULL", () => {
    const s = store(temp("zzfin-"));
    recordFinish(s, { member, unit: null, outcome: "verdict", body: "fail", gen: "g1" });
    recordFinish(s, { member, unit: null, outcome: "verdict", body: "fail", gen: "g2" });
    const r = recordFinish(s, { member, unit: null, outcome: "verdict", body: "fail" });
    expect(r.row.unit).toBeNull();
    expect(r.row.gen).toBeNull();
    expect(listFinishes(s, { member: "zzfin/sq/tester" })).toHaveLength(3);
    expect(finishKey({ member, unit: null, outcome: "verdict", body: "fail" })).toBe(String(r.row.key));
  });

  test("an unknown outcome or an empty body is refused before any write", () => {
    const s = store(temp("zzfin-"));
    expect(() => recordFinish(s, { member, unit: null, outcome: "maybe" as never, body: "x" })).toThrow(/outcome/);
    expect(() => recordFinish(s, { member, unit: null, outcome: "ok", body: "  " })).toThrow(/empty/);
    expect(listFinishes(s)).toHaveLength(0);
  });

  test("parseMember reads the DS_MEMBER shape", () => {
    expect(parseMember("p/sq/builder-u3-x")).toEqual({ project: "p", squad: "sq", role: "builder", suffix: "u3-x" });
    expect(parseMember("p/sq/lead")).toEqual({ project: "p", squad: "sq", role: "lead", suffix: "" });
    expect(parseMember("p/sq/nobody")).toBeNull();
    expect(parseMember("p/builder")).toBeNull();
  });
});

describe("ds finish", () => {
  const DS = join(ROOT, "bin", "ds");

  test("a verdict with --as writes one row with DS_GEN; the replay writes none; list shows it", () => {
    const root = temp("zzfin-cli-");
    const args = [DS, "finish", "u2-y", "--outcome", "verdict", "--body", "fail: login breaks", "--as", "sq/tester", "--project", "zzfin"];
    const a = sh(args, { env: env(root, { DS_GEN: "gen-t" }) });
    expect(a.err).toBe("");
    expect(a.rc).toBe(0);
    expect(a.out).toContain("finish recorded");
    const b = sh(args, { env: env(root, { DS_GEN: "gen-t" }) });
    expect(b.rc).toBe(0);
    expect(b.out).toContain("finish already recorded");
    const got = rows(root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ member: "zzfin/sq/tester", unit: "u2-y", gen: "gen-t", outcome: "verdict", body: "fail: login breaks" });
    const l = sh([DS, "finish", "list", "--project", "zzfin", "--json"], { env: env(root) });
    expect(JSON.parse(l.out).map((r: Row) => r.member)).toEqual(["zzfin/sq/tester"]);
  });

  test("DS_MEMBER names the finisher and '-' records no unit", () => {
    const root = temp("zzfin-cli-");
    const a = sh([DS, "finish", "-", "--outcome", "verdict", "--body", "report: docs/r.md"], { env: env(root, { DS_MEMBER: "zzfin/sq/researcher" }) });
    expect(a.rc).toBe(0);
    expect(rows(root)[0]).toMatchObject({ member: "zzfin/sq/researcher", unit: null, gen: null });
  });

  test("a bad outcome, a missing body or no member is usage and writes nothing", () => {
    const root = temp("zzfin-cli-");
    const out = temp("zzfin-out-");   // no git worktree: no member to find
    expect(sh([DS, "finish", "-", "--outcome", "maybe", "--body", "x", "--as", "sq/tester", "--project", "zzfin"], { env: env(root) }).rc).toBe(2);
    expect(sh([DS, "finish", "-", "--outcome", "verdict", "--as", "sq/tester", "--project", "zzfin"], { env: env(root) }).rc).toBe(2);
    expect(sh([DS, "finish", "-", "--outcome", "verdict", "--body", "x"], { cwd: out, env: env(root) }).rc).toBe(2);
    expect(rows(root)).toHaveLength(0);
  });
});

describe("finish-unit.sh writes the row on every path", () => {
  const LABEL = "zzfinunit", TOPIC = "regplan", UNIT = "U1-widget";

  // A temp state root with the squad's state file, a Builder worktree with one commit and a review
  // receipt for it, a repo carrying the GitHub remote, a stub gh (PR list + health) and a stub backend.
  function rig() {
    const t = temp("zzfin-unit-"), root = join(t, "state"), wt = join(t, "wt"), repo = join(t, "repo");
    const state = join(root, LABEL, "squads", `${TOPIC}.json`);
    mkdirSync(join(root, LABEL, "squads"), { recursive: true });
    writeFileSync(state, JSON.stringify({ repo: `path:${repo}`, units: [{ slug: UNIT, status: "dispatched" }] }));
    const git = (cwd: string, ...a: string[]) => { const r = sh(["git", ...a], { cwd, env: env(root) }); if (r.rc !== 0) throw new Error(r.err); return r.out.trim(); };
    mkdirSync(repo); git(repo, "init", "-q", "-b", "main"); git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    mkdirSync(wt); git(wt, "init", "-q", "-b", "u1-widget"); git(wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    writeFileSync(join(wt, ".git", "ds-review"), `${git(wt, "rev-parse", "HEAD")}\t${Math.floor(Date.now() / 1000)}\t-\t0\tclaude:opus\tproof=1\n`);
    const ghStub = join(t, "gh"), backend = join(t, "backend"), calls = join(t, "backend-calls");
    writeFileSync(ghStub, `#!/usr/bin/env bash
if [ "$1" = pr ] && [ "$2" = list ]; then printf '%s' '[{"number":7,"state":"OPEN"}]'; fi
if [ "$1" = api ] && [ "$2" = graphql ]; then cat ${JSON.stringify(join(ROOT, "tests", "fixtures", "pr-health", "ready.json"))}; fi
`);
    writeFileSync(backend, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
[ "$1" = worker-done ] && { echo "worker-done: completed task task_stub"; exit 0; }
exit 2
`);
    chmodSync(ghStub, 0o755); chmodSync(backend, 0o755); writeFileSync(calls, "");
    const fu = (gen: string | null, ...a: string[]) =>
      sh([join(ROOT, "bin", "role", "finish-unit.sh"), state, UNIT, ...a], { cwd: wt, env: env(root, { BACKEND: backend, DS_GH: ghStub, ...(gen ? { DS_GEN: gen } : {}) }) });
    return { root, fu, calls: () => readFileSync(calls, "utf8") };
  }

  test("a merge-ready PR writes one ok row with the Builder, unit and generation; a replay writes none", () => {
    const r = rig();
    const a = r.fu("gen-b1");
    expect(a.err).not.toContain("could not record");
    expect(a.rc).toBe(0);
    let got = rows(r.root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ project: LABEL, squad: TOPIC, member: `${LABEL}/${TOPIC}/builder-${UNIT}`, unit: UNIT, gen: "gen-b1", outcome: "ok" });
    expect(String(got[0].body)).toContain("PR #7 merge-ready");
    expect(r.fu("gen-b1").rc).toBe(0);
    got = rows(r.root);
    expect(got).toHaveLength(1);
  }, 60_000);

  test("--no-pr writes one no-pr row; a replay writes none", () => {
    const r = rig();
    expect(r.fu("gen-b2", "--no-pr").rc).toBe(0);
    expect(r.fu("gen-b2", "--no-pr").rc).toBe(0);
    const got = rows(r.root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ outcome: "no-pr", gen: "gen-b2", unit: UNIT });
  }, 60_000);

  test("--failed writes one failed row and sends worker_done --outcome failed; a replay writes none", () => {
    const r = rig();
    const a = r.fu("gen-b3", "--failed", "the API it needs does not exist");
    expect(a.rc).toBe(0);
    expect(r.calls()).toContain("worker-done --outcome failed failed U1-widget");
    expect(r.fu("gen-b3", "--failed", "the API it needs does not exist").rc).toBe(0);
    const got = rows(r.root);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ outcome: "failed", gen: "gen-b3", unit: UNIT });
    expect(String(got[0].body)).toContain("the API it needs does not exist");
  }, 60_000);

  test("--check writes no row", () => {
    const r = rig();
    expect(r.fu("gen-b4", "--check").rc).toBe(0);
    expect(rows(r.root)).toHaveLength(0);
  }, 60_000);
});
