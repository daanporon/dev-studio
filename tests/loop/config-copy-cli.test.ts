// config-copy-cli.test.ts — settings-export-import U2: `ds config copy`, `import --dry-run`, `prune`
// and the transfer header of `export`, run as the real `ds` on a temp state root.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { set } from "../../bin/loop/settings/settings.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const SRC = "src", DST = "dst";

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzscopy-")); temps.push(d); return d; }

// A state root with a source holding dev-studio-like rows (one the code no longer knows, one
// project-specific) and an empty target; returns the `ds config` runner and a row reader.
function fixture() {
  const root = join(tmp(), "state");
  for (const p of [SRC, DST]) mkdirSync(join(root, p, "squads"), { recursive: true });
  const s: Store = open(root);
  const raw = (project: string, file: string, key: string, value: string) => s.upsert("config", { project, file, key }, { value, comment: null, observed_at: T });
  set(s, SRC, "limits.conf", "limit_pct", "80", "ds");
  set(s, SRC, "limits.conf", "briefing_time", "07:30", "ds");
  set(s, SRC, "roles.conf", "builder", "claude sonnet ondemand medium", "ds");
  raw(SRC, "limits.conf", "hooks_ts", "1");
  raw(SRC, "limits.conf", "auto_merge", "merge");
  s.close();
  const ds = (...args: string[]) => {
    const r = Bun.spawnSync([DS, "--state", root, "config", ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const rows = (project: string) => {
    const s2 = open(root);
    try { return s2.db.query("SELECT file, key, value FROM config WHERE project = ? ORDER BY file, key").all(project) as { file: string; key: string; value: string }[]; } finally { s2.close(); }
  };
  return { root, ds, rows, raw: (p: string, f: string, k: string, v: string) => { const s3 = open(root); try { s3.upsert("config", { project: p, file: f, key: k }, { value: v, comment: null, observed_at: T }); } finally { s3.close(); } } };
}
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe("ds config copy", () => {
  test("prints the plan and writes nothing; --apply writes the picked rows", () => {
    const f = fixture();
    const dry = f.ds("copy", SRC, DST);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("[x] add    limits.conf limit_pct  - → 80");
    expect(dry.out).toMatch(/\[ \] skip +limits\.conf +hooks_ts .*\(unknown key\)/);
    expect(dry.out).toMatch(/\[ \] skip +limits\.conf +auto_merge .*\(project-specific\)/);
    expect(dry.err).toContain("nothing written");
    expect(f.rows(DST)).toEqual([]);
    const res = f.ds("copy", SRC, DST, "--apply");
    expect(res.code).toBe(0);
    expect(keys(f.rows(DST))).toEqual(["briefing_time", "limit_pct", "builder"]);
  });

  test("--only, --skip, --include and --replace", () => {
    const f = fixture();
    f.ds("copy", SRC, DST, "--apply", "--only", "limits.conf", "--skip", "briefing_time", "--include", "auto_merge");
    expect(keys(f.rows(DST))).toEqual(["auto_merge", "limit_pct"]);
    f.raw(DST, "limits.conf", "limit_ping", "5");
    const plan = JSON.parse(f.ds("copy", SRC, DST, "--replace", "--json").out);
    expect(plan.applied).toBe(false);
    expect(plan.plan.find((r: { key: string }) => r.key === "limit_ping")).toMatchObject({ action: "remove", pick: true });
    expect(f.ds("copy", SRC, DST, "--include", "hooks_ts").code).toBe(2);
    expect(f.ds("copy", SRC, DST, "--only", "nope.conf").code).toBe(2);
    f.ds("copy", SRC, DST, "--replace", "--apply");
    expect(keys(f.rows(DST))).not.toContain("limit_ping");
  });

  test("<from> can be an export file from another host", () => {
    const f = fixture();
    const file = join(tmp(), "src-settings.txt");
    const exp = f.ds("export", "--project", SRC);
    expect(exp.out.split("\n")[0]).toMatch(/^#! ds-settings 1 from=src /);
    writeFileSync(file, exp.out);
    const res = f.ds("copy", file, DST, "--apply");
    expect(res.code).toBe(0);
    expect(keys(f.rows(DST))).toEqual(["briefing_time", "limit_pct", "builder"]);
  });

  test("an unknown source project is refused", () => {
    expect(fixture().ds("copy", "nope", DST).code).toBe(2);
  });
});

describe("ds config import --dry-run", () => {
  test("prints what the restore would change and writes nothing", () => {
    const f = fixture();
    f.ds("set", DST, "limits.conf", "limit_pct", "70");
    const file = join(tmp(), "backup.export");
    writeFileSync(file, "# settings.export\n\n#== limits.conf\nlimit_pct 90\nbriefing_time 06:00\n");
    const r = f.ds("import", "--project", DST, file, "--dry-run");
    expect(r.code).toBe(0);
    const cs = JSON.parse(r.out) as { key: string; old: string | null; new: string | null }[];
    expect(cs.map((c) => [c.key, c.old, c.new])).toEqual([["limit_pct", "70", "90"], ["briefing_time", null, "06:00"]]);
    expect(f.rows(DST).map((x) => x.value)).toEqual(["70"]);
  });
});

describe("ds config prune", () => {
  test("lists rows whose key this dev-studio doesn't know and drops them with --apply", () => {
    const f = fixture();
    const list = f.ds("prune", SRC);
    expect(list.out).toContain("hooks_ts");
    expect(list.out).not.toContain("limit_pct");
    expect(keys(f.rows(SRC))).toContain("hooks_ts");
    expect(f.ds("prune", SRC, "--apply").code).toBe(0);
    expect(keys(f.rows(SRC))).not.toContain("hooks_ts");
    expect(keys(f.rows(SRC))).toContain("limit_pct");
    expect(f.ds("prune", SRC).err).toContain("no stale rows");
    expect(f.ds("history", "--project", SRC, "--key", "hooks_ts").out).toContain("\"new_value\": null");
  });
});
