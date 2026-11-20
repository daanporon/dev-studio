// settings-migrate.test.ts — U256, the settings cut-over (bin/loop/settings/settings-migrate.ts) on a hermetic state
// root with two projects' override files: each file's rows equal its export section and its renamed copy;
// a crash after each step (DS_SETTINGS_CRASH, in a child process) then a rerun gives the same rows and no
// second history row; a file that reappears after the mark is not read and raises one alert
// (reconcilers/settings-files.ts) that clears when it goes; the readers outside the loop (ds_limit,
// ds_ship_mode) follow the rows; `ds limits|roles|ship-mode` write rows and create no file.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confText, PROJECT_FILES } from "../../bin/loop/db/import-config.ts";
import { configObserver } from "../../bin/loop/observers/config.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import settingsFiles from "../../bin/loop/reconcilers/settings-files.ts";
import { exportSections } from "../../bin/loop/settings/settings.ts";
import { migrateSettings } from "../../bin/loop/settings/settings-migrate.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000, DATE = "2027-01-15";
const FILES: Record<string, Record<string, string>> = {
  alpha: {
    "limits.conf": "# alpha's overrides\ncontext_warn 50000   # alpha only\nlimit_pct 80\nreview_delta_full_lines 120\n",
    "roles.conf": "builder    claude  sonnet ondemand  medium\nthinker    claude  opus   always    high claude:sonnet\n",
    "ship-mode": "direct-PR\n",
  },
  beta: {
    "limits.conf": "auto_merge squash\n",
    "models.conf": "codex | beta-model | Beta | low,high\n",
  },
};

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzsettings-")); temps.push(d); return d; }
function fixture(): string {
  const root = join(tmp(), "state");
  for (const [p, files] of Object.entries(FILES)) {
    mkdirSync(join(root, p, "squads"), { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(root, p, f), text);
  }
  mkdirSync(join(root, "gamma", "squads"), { recursive: true });   // a project with no overrides
  return root;
}
function store(root: string): Store { const s = open(root); stores.push(s); return s; }
const rows = (s: Store) => s.db.query("SELECT project, file, key, value, comment FROM config WHERE project != '' ORDER BY project, file, key").all();
const history = (s: Store) => s.db.query("SELECT project, file, key, old_value, new_value, actor FROM config_history ORDER BY project, file, key").all();
const parsed = (p: string, f: string, text: string) => confText(p, f, text, 0).map((r) => [r.key.key, r.set.value]);
function child(root: string, crash: string) {
  const code = `import { open } from ${JSON.stringify(join(ROOT, "bin/loop/core/store.ts"))};
import { migrateSettings } from ${JSON.stringify(join(ROOT, "bin/loop/settings/settings-migrate.ts"))};
const s = open(${JSON.stringify(root)}); migrateSettings(s, s.root, undefined, { now: ${T} }); s.close();`;
  return Bun.spawnSync(["bun", "-e", code], { env: { ...process.env, DS_SETTINGS_CRASH: crash }, stdout: "pipe", stderr: "pipe" });
}

describe("settings cut-over", () => {
  test("every override file becomes rows, its export section, and a renamed copy with the same rows; the mark is last", () => {
    const root = fixture(), s = store(root);
    const out = migrateSettings(s, root, undefined, { now: T })!;
    expect(out.map((m) => `${m.project}/${m.file}`).sort()).toEqual(["alpha/limits.conf", "alpha/roles.conf", "alpha/ship-mode", "beta/limits.conf", "beta/models.conf"]);
    expect(existsSync(join(root, ".settings-migrated"))).toBe(true);
    for (const [p, files] of Object.entries(FILES)) {
      const sections = exportSections(readFileSync(join(root, p, "settings.export"), "utf8"));
      for (const f of PROJECT_FILES) {
        expect(existsSync(join(root, p, f))).toBe(false);
        if (!(f in files)) { expect(sections[f as keyof typeof sections]).toBeUndefined(); continue; }
        const renamed = readFileSync(join(root, p, `${f}.imported-${DATE}`), "utf8");
        expect(renamed).toBe(files[f]);
        // The export diff against the renamed file: the same rows, key by key.
        expect(parsed(p, f, sections[f as keyof typeof sections] ?? "")).toEqual(parsed(p, f, renamed));
      }
    }
    expect(s.get("config", { project: "alpha", file: "limits.conf", key: "context_warn" })).toMatchObject({ value: "50000", comment: "alpha only" });
    expect(s.get("config", { project: "beta", file: "models.conf", key: "codex|beta-model" })?.value).toBe("Beta | low,high");
    expect((history(s) as { actor: string }[]).every((h) => h.actor === "migration")).toBe(true);
    expect(history(s).length).toBe((rows(s) as unknown[]).length);
    expect(readdirSync(join(root, "gamma"))).toEqual(["squads"]);
    // Done once: a second run does nothing.
    expect(migrateSettings(s, root, undefined, { now: T + 60 })).toBeNull();
  });

  test("a name already taken gets a numbered suffix", () => {
    const root = fixture();
    writeFileSync(join(root, "beta", `limits.conf.imported-${DATE}`), "old\n");
    migrateSettings(store(root), root, undefined, { now: T });
    expect(readFileSync(join(root, "beta", `limits.conf.imported-${DATE}`), "utf8")).toBe("old\n");
    expect(readFileSync(join(root, "beta", `limits.conf.imported-${DATE}.2`), "utf8")).toBe(FILES.beta["limits.conf"]);
  });

  test("a folder that is not a loop project yet (no squads/, no dispatcher.json) still has its override cut over", () => {
    const root = fixture();
    mkdirSync(join(root, "delta"));
    writeFileSync(join(root, "delta", "limits.conf"), "limit_pct 55\n");
    const s = store(root);
    migrateSettings(s, root, undefined, { now: T });
    expect(s.db.query("SELECT value FROM config WHERE project = 'delta' AND file = 'limits.conf' AND key = 'limit_pct'").get()).toEqual({ value: "55" });
    expect(existsSync(join(root, "delta", "limits.conf"))).toBe(false);
    expect(existsSync(join(root, "delta", `limits.conf.imported-${DATE}`))).toBe(true);
  });

  for (const step of ["import", "export", "rename", "mark-tmp"]) {
    test(`a crash after ${step}, then a rerun: the same rows and history as one clean run`, () => {
      const clean = fixture(), cs = store(clean);
      migrateSettings(cs, clean, undefined, { now: T });

      const root = fixture();
      const r = child(root, step);
      expect([r.exitCode, r.stderr.toString()]).toEqual([9, `settings-migrate: crash injected after ${step}\n`]);
      expect(existsSync(join(root, ".settings-migrated"))).toBe(false);
      const s = store(root);
      migrateSettings(s, root, undefined, { now: T + 30 });
      expect(rows(s)).toEqual(rows(cs));
      expect(history(s)).toEqual(history(cs));
      expect(existsSync(join(root, ".settings-migrated"))).toBe(true);
      expect(existsSync(join(root, ".settings-migrated.tmp"))).toBe(false);
      for (const [p, files] of Object.entries(FILES)) for (const f of Object.keys(files)) {
        expect(existsSync(join(root, p, f))).toBe(false);
        expect(readFileSync(join(root, p, `${f}.imported-${DATE}`), "utf8")).toBe(files[f]);
      }
    });
  }
});

describe("after the cut-over", () => {
  const conventions = join(ROOT, "conventions");
  const reconcile = (s: Store, project: string) => settingsFiles.run({ store: s, project, tick: T, now: T, fired: [], poked: new Set() } as TickCtx) as { kind: string; subject: string; episode: string; payload: Record<string, unknown> }[];

  test("the observer cuts over on its first tick; a reappearing file is not read and raises one alert, cleared when it goes", () => {
    const root = fixture(), s = store(root), o = configObserver(conventions);
    expect(reconcile(s, "alpha")).toEqual([]);   // before the mark: nothing to say
    o.run({ store: s, project: "", tick: T, now: T, fired: [], poked: new Set() } as TickCtx);
    expect(existsSync(join(root, ".settings-migrated"))).toBe(true);
    expect(reconcile(s, "alpha")).toEqual([]);

    const lim = join(root, "alpha", "limits.conf");
    writeFileSync(lim, "context_warn 1\n");
    o.run({ store: s, project: "", tick: T + 5, now: T + 5, fired: [], poked: new Set() } as TickCtx);
    expect(s.get("config", { project: "alpha", file: "limits.conf", key: "context_warn" })?.value).toBe("50000");
    const [a, ...more] = reconcile(s, "alpha");
    expect(more).toEqual([]);
    expect(a).toMatchObject({ kind: "alert", subject: "settings-file:limits.conf", payload: { title: "alpha: limits.conf is not read", card: "settings_file" } });
    expect(String(a.payload.text)).toContain(`ds config import --project alpha ${lim}`);
    expect(reconcile(s, "beta")).toEqual([]);

    // Sent once (the actuator's episode claim), then the file goes: one clear.
    s.upsert("episodes", { project: "alpha", subject: a.subject, kind: "action:alert" }, { episode_key: a.episode, state: "done", source: "loop", started_at: T, observed_at: T });
    rmSync(lim);
    const [c, ...none] = reconcile(s, "alpha");
    expect(none).toEqual([]);
    expect(c).toMatchObject({ kind: "alert-clear", subject: a.subject, episode: `cleared@${a.episode}` });
    expect(existsSync(lim)).toBe(false);
  });

  test("ds limits, roles and ship-mode change rows and create no file; ds_limit and ds_ship_mode read them", () => {
    const root = fixture(), cmd = (script: string, ...args: string[]) =>
      Bun.spawnSync([join(ROOT, "bin", "commands", script), ...args], { env: { ...process.env, DS_STATE_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    const twin = (fn: string, ...args: string[]) =>
      Bun.spawnSync(["bash", "-c", `source ${join(ROOT, "tests/lib/twins.sh")}; ${fn} "$@"`, "_", ...args], { env: { ...process.env, DS_STATE_ROOT: root }, stdout: "pipe" }).stdout.toString();
    // Before the cut-over the readers still see the files.
    expect(twin("ds_limit", "alpha", "context_warn")).toBe("50000\n");
    expect(twin("ds_ship_mode", "alpha")).toBe("direct-PR");

    // The first write cuts the root over, then writes its row.
    expect(cmd("limits.sh", "set", "alpha", "limit_pct", "70").exitCode).toBe(0);
    expect(existsSync(join(root, ".settings-migrated"))).toBe(true);
    expect(cmd("roles.sh", "set", "beta", "builder", "claude", "sonnet").exitCode).toBe(0);
    expect(cmd("ship-mode.sh", "beta", "local-only").exitCode).toBe(0);
    const bad = cmd("limits.sh", "set", "beta", "nope", "1");
    expect([bad.exitCode, bad.stderr.toString()]).toEqual([2, "limits.sh: unknown key 'nope' (see: limits.sh show)\n"]);
    for (const p of ["alpha", "beta"]) for (const f of PROJECT_FILES) expect(existsSync(join(root, p, f))).toBe(false);

    expect(twin("ds_limit", "alpha", "limit_pct")).toBe("70\n");
    expect(twin("ds_limit", "alpha", "context_warn")).toBe("50000\n");
    expect(twin("ds_limit_src", "beta", "auto_merge")).toBe("squash\toverride\n");
    expect(twin("ds_ship_mode", "beta")).toBe("local-only");
    expect(cmd("roles.sh", "list", "beta").stdout.toString()).toMatch(/\nbuilder +claude +sonnet +ondemand/);
    const s = store(root);
    expect(s.get("config", { project: "beta", file: "roles.conf", key: "builder" })?.value).toBe("claude sonnet ondemand - claude:sonnet,muse:muse-spark-1.3");
    expect(readFileSync(join(root, "beta", "settings.export"), "utf8")).toContain("#== ship-mode\nlocal-only\n");

    expect(cmd("limits.sh", "rm", "alpha", "limit_pct").exitCode).toBe(0);
    expect(cmd("ship-mode.sh", "beta", "default").exitCode).toBe(0);
    expect(cmd("roles.sh", "reset", "beta", "builder").exitCode).toBe(0);
    expect(twin("ds_limit_src", "alpha", "limit_pct")).toMatch(/\tdefault\n$/);
    expect(twin("ds_ship_mode", "beta")).toBe("ce-pipeline");
    expect(s.get("config", { project: "beta", file: "roles.conf", key: "builder" })).toBeNull();
  });
});
