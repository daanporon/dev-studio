// observers-config.test.ts — U4: the config and documents observers on a copy of
// tests/fixtures/loop/state with a copy of conventions/, and `ds config` / `ds documents`.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import type { Observer, TickCtx } from "../../bin/loop/core/plugins.ts";
import { limitsJson, rolesJson } from "../../bin/board/board-data.ts";
import { configObserver } from "../../bin/loop/observers/config.ts";
import { documentsObserver } from "../../bin/loop/observers/documents.ts";
import { set } from "../../bin/loop/settings/settings.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(d); return d; }
function fixture(): { s: Store; conv: string } {
  const d = tmp(), conv = tmp();
  cpSync(FIXTURE, d, { recursive: true });
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  const s = open(d);
  stores.push(s);
  return { s, conv };
}
const tick = (s: Store, o: Observer, at: number, project = "") =>
  o.run({ store: s, project, tick: at, now: at, fired: [], poked: new Set() } as TickCtx);
const conf = (s: Store, project: string, file: string, key: string) => s.get("config", { project, file, key });
function ds(root: string, ...args: string[]) {
  const p = Bun.spawnSync([DS, "--state", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("config observer", () => {
  test("Codex catalog reaches the board through config rows and refreshes", () => {
    const { s, conv } = fixture(), cli = join(tmp(), "codex");
    const before = process.env.CODEX_BIN;
    process.env.CODEX_BIN = cli;
    try {
      const catalog = (model: string) => writeFileSync(cli,
        `#!/usr/bin/env bash\necho '{"models":[{"slug":"${model}","display_name":"Future Codex","visibility":"list","supported_reasoning_levels":[{"effort":"high"}]}]}'\n`, { mode: 0o755 });
      catalog("future-codex");
      const o = configObserver(conv);
      tick(s, o, T);
      expect(conf(s, "", "codex-models", "codex|future-codex")?.value).toBe("Codex · Future Codex | high");
      expect(rolesJson("fx", s.root)?.catalog.find((c) => c.model === "future-codex")).toMatchObject({ agent: "codex", efforts: ["high"], custom: false });
      writeFileSync(join(conv, "models.conf"), "codex | global-only | Global | low\n");
      set(s, "fx", "models.conf", "codex|project-only", "Project | max", "test");
      tick(s, o, T + 1);
      const models = rolesJson("fx", s.root)!.catalog;
      expect(models.find((c) => c.model === "project-only")).toMatchObject({ efforts: ["max"], custom: false });
      expect(models.some((c) => c.model === "global-only")).toBe(false);
      expect(models.some((c) => c.model === "future-codex")).toBe(true);
      catalog("next-codex");
      tick(s, o, T + 5);
      expect(conf(s, "", "codex-models", "codex|future-codex")).not.toBeNull();
      tick(s, o, T + 300);
      expect(conf(s, "", "codex-models", "codex|future-codex")).toBeNull();
      expect(conf(s, "", "codex-models", "codex|next-codex")?.value).toBe("Codex · Future Codex | high");
      rmSync(cli);
      tick(s, o, T + 600);
      expect(conf(s, "", "codex-models", "codex|next-codex")).toBeNull();
    } finally {
      if (before === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = before;
    }
  });

  test("the first tick cuts a project's files over to rows (U256); a file written after it is not read", () => {
    const { s, conv } = fixture(), o = configObserver(conv);
    const lim = join(s.root, "fx", "limits.conf");
    writeFileSync(lim, "context_warn 50000   # fx only\nlimit_pct 80\n");
    tick(s, o, T);
    expect(conf(s, "", "limits.conf", "context_warn")?.value).toBe("100000");
    expect([conf(s, "fx", "limits.conf", "context_warn")?.value, conf(s, "fx", "limits.conf", "context_warn")?.comment]).toEqual(["50000", "fx only"]);
    expect(conf(s, "fx", "roles.conf", "builder")?.value).toBe("claude  sonnet  ondemand  medium");
    expect(conf(s, "fx", "ship-mode", "mode")?.value).toBe("pr");
    expect(existsSync(lim)).toBe(false);
    expect(readdirSync(join(s.root, "fx")).filter((f) => f.includes(".imported-")).sort())
      .toEqual(["limits.conf.imported-2027-01-15", "roles.conf.imported-2027-01-15", "ship-mode.imported-2027-01-15"]);
    expect(existsSync(join(s.root, "fx", "settings.export"))).toBe(true);
    expect(existsSync(join(s.root, ".settings-migrated"))).toBe(true);

    // After the cut-over a project file is not read, and its rows are not dropped when it goes.
    writeFileSync(lim, "context_warn 60000\n");
    tick(s, o, T + 10);
    expect(conf(s, "fx", "limits.conf", "context_warn")?.value).toBe("50000");
    expect(conf(s, "fx", "limits.conf", "limit_pct")?.value).toBe("80");
    rmSync(lim);
    tick(s, o, T + 15);
    expect(s.db.query("SELECT key FROM config WHERE project = 'fx' AND file = 'limits.conf' ORDER BY key").all()).toEqual([{ key: "context_warn" }, { key: "limit_pct" }]);
  });

  test("legacy early-switch keys in a project file load without appearing on the board", () => {
    const { s, conv } = fixture();
    writeFileSync(join(s.root, "fx", "limits.conf"), "early_pct 80\nearly_switch_pct 90\nlimit_pct 100\n");
    tick(s, configObserver(conv), T);
    expect(conf(s, "fx", "limits.conf", "limit_pct")?.value).toBe("100");
    const keys = limitsJson("fx", s.root)!.limits.map((r) => r.key);
    expect(keys).not.toContain("early_pct");
    expect(keys).not.toContain("early_switch_pct");
  });

  test("ds config --project prints the conventions and that project's rows", () => {
    const { s, conv } = fixture();
    tick(s, configObserver(conv), T);
    const r = ds(s.root, "config", "--project", "fx", "--file", "roles.conf");
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as Row[];
    expect(new Set(rows.map((x) => x.project))).toEqual(new Set(["", "fx"]));
    expect(rows.every((x) => x.file === "roles.conf")).toBe(true);
    expect(rows).toContainEqual(expect.objectContaining({ project: "fx", key: "builder", value: "claude  sonnet  ondemand  medium" }));
  });
});

describe("documents observer", () => {
  test("plans, journals, the cross-squad log and the archive, body as on disk; a vanished file drops", () => {
    const { s } = fixture(), o = documentsObserver();
    tick(s, o, T, "fx");
    const docs = s.db.query("SELECT path, body, observed_at FROM documents WHERE project = 'fx' ORDER BY path").all() as Row[];
    expect(docs.map((d) => d.path)).toEqual(["fx/archive/peer-20261001-120000.json", "fx/cross-squad.md", "fx/journals/demo.md", "fx/squads/demo-plan.md"]);
    expect(docs[3].body).toBe(readFileSync(join(s.root, "fx", "squads", "demo-plan.md"), "utf8"));
    expect(docs.every((d) => d.observed_at === T)).toBe(true);

    rmSync(join(s.root, "fx", "cross-squad.md"));
    const plan = join(s.root, "fx", "squads", "demo-plan.md");
    writeFileSync(plan, "# changed\n");
    utimesSync(plan, T, T);
    tick(s, o, T + 5, "fx");
    expect(s.db.query("SELECT path, body, observed_at FROM documents WHERE project = 'fx' AND path NOT LIKE 'fx/archive/%' ORDER BY path").all()).toEqual([
      { path: "fx/journals/demo.md", body: readFileSync(join(s.root, "fx", "journals", "demo.md"), "utf8"), observed_at: T + 5 },
      { path: "fx/squads/demo-plan.md", body: "# changed\n", observed_at: T + 5 }]);
  });

  test("a file that vanishes and comes back unchanged gets its row back", () => {
    const { s } = fixture(), o = documentsObserver(), f = join(s.root, "fx", "cross-squad.md");
    utimesSync(f, T, T);
    const body = readFileSync(f, "utf8");
    tick(s, o, T, "fx");
    rmSync(f);
    tick(s, o, T + 5, "fx");
    expect(s.get("documents", { project: "fx", path: "fx/cross-squad.md" })).toBeNull();
    writeFileSync(f, body);
    utimesSync(f, T, T);
    tick(s, o, T + 10, "fx");
    expect(s.get("documents", { project: "fx", path: "fx/cross-squad.md" })?.body).toBe(body);
  });

  test("ds documents --project lists path and mtime, the body with --body", () => {
    const { s } = fixture();
    tick(s, documentsObserver(), T, "fx");
    const r = ds(s.root, "documents", "--project", "fx");
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as Row[];
    expect(rows.map((x) => x.path)).toEqual(["fx/archive/peer-20261001-120000.json", "fx/cross-squad.md", "fx/journals/demo.md", "fx/squads/demo-plan.md"]);
    expect(rows.every((x) => typeof x.mtime === "number" && !("body" in x))).toBe(true);
    expect((JSON.parse(ds(s.root, "documents", "--project", "fx", "--body").out) as Row[])[1].body).toBe(readFileSync(join(s.root, "fx", "cross-squad.md"), "utf8"));
  });
});
