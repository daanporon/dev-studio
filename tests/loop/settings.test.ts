// settings.test.ts — U255: bin/loop/settings/settings.ts, the one writer of a project's settings rows, on a
// hermetic state root with a copy of conventions/: get/set/rm/reset for limits.conf, roles.conf,
// models.conf and ship-mode, its refusals, one config_history row per change, the env var winning,
// export -> confRows -> the same rows, `ds config` (import too, U256), and the config observer keeping a
// missing project's rows (KTD5; U256: its settings rows too, they are the only copy).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confRows } from "../../bin/loop/db/import-config.ts";
import { configObserver } from "../../bin/loop/observers/config.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { backendChangeNote, exportFiles, exportSections, exportText, get, historyOf, readGet, readProjectRosterLines, readRoster, readRows, reset, rm, set, SettingsError, type SettingsFile } from "../../bin/loop/settings/settings.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { resolveBackUp } from "../../bin/loop/settings/roster.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const P = "demo";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
// Under $XDG_RUNTIME_DIR when there is one: Bun under a crowded /tmp starts slowly (builder notes).
function tmp(): string { const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzsettings-")); temps.push(d); return d; }
function fixture(): { s: Store; conventions: string; o: { conventions: string; now: number } } {
  const root = join(tmp(), "state"), conventions = tmp();
  mkdirSync(join(root, P, "squads"), { recursive: true });
  cpSync(join(ROOT, "conventions"), conventions, { recursive: true });
  const s = open(root);
  stores.push(s);
  return { s, conventions, o: { conventions, now: T } };
}
const row = (s: Store, file: string, key: string, project = P) =>
  (s.db.query("SELECT value FROM config WHERE project = ? AND file = ? AND key = ?").get(project, file, key) as { value: string } | null)?.value ?? null;
const refused = (fn: () => unknown, msg: RegExp) => { expect(fn).toThrow(SettingsError); expect(fn).toThrow(msg); };
function withEnv<T>(name: string, value: string, fn: () => T): T {
  const before = process.env[name];
  process.env[name] = value;
  try { return fn(); } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
}

describe("settings module", () => {
  test("limits.conf: get from the default, set, rm, reset; each change one history row", () => {
    const { s, o } = fixture();
    expect(get(s, P, "limits.conf", "auto_merge", o)).toMatchObject({ value: "off", source: "default" });
    expect(set(s, P, "limits.conf", "auto_merge", "squash", "ds", o)).toEqual([{ project: P, file: "limits.conf", key: "auto_merge", old: null, new: "squash" }]);
    expect(get(s, P, "limits.conf", "auto_merge", o)).toMatchObject({ value: "squash", source: "project" });
    expect(set(s, P, "limits.conf", "auto_merge", "squash", "ds", o)).toEqual([]);   // no change, no history row
    set(s, P, "limits.conf", "auto_merge", "merge", "board", o);
    set(s, P, "limits.conf", "limit_pct", "80", "ds", o);
    expect(rm(s, P, "limits.conf", "auto_merge", "ds", o)).toHaveLength(1);
    expect(rm(s, P, "limits.conf", "auto_merge", "ds", o)).toEqual([]);
    expect(get(s, P, "limits.conf", "auto_merge", o).source).toBe("default");
    expect(reset(s, P, "limits.conf", null, "ds", o)).toEqual([{ project: P, file: "limits.conf", key: "limit_pct", old: "80", new: null }]);
    expect(row(s, "limits.conf", "limit_pct")).toBeNull();
    expect(historyOf(s, P, "limits.conf").map((h) => [h.key, h.old_value, h.new_value, h.actor, h.at])).toEqual([
      ["auto_merge", null, "squash", "ds", T], ["auto_merge", "squash", "merge", "board", T], ["limit_pct", null, "80", "ds", T],
      ["auto_merge", "merge", null, "ds", T], ["limit_pct", "80", null, "ds", T]]);
  });

  test("an env var wins over the project row; the row is still written", () => {
    const { s, o } = fixture();
    set(s, P, "limits.conf", "auto_merge", "squash", "ds", o);
    expect(withEnv("DS_LOOP_AUTO_MERGE", "rebase", () => get(s, P, "limits.conf", "auto_merge", o))).toMatchObject({ value: "rebase", source: "env", env: "DS_LOOP_AUTO_MERGE" });
    expect(withEnv("DS_LIMIT_MAX_BUILDERS", "7", () => get(s, P, "limits.conf", "max_builders", o))).toMatchObject({ value: "7", source: "env", env: "DS_LIMIT_MAX_BUILDERS" });
    expect(get(s, P, "limits.conf", "auto_merge", o).source).toBe("project");
  });

  test("roles.conf: a set writes that role's row only; a role the project lacks runs the default (U267); rm and reset drop the row", () => {
    const { s, o } = fixture();
    const shipped = confRows("", "roles.conf", join(o.conventions, "roles.conf"));
    const dflt = (k: string): string => String(shipped.find((r) => r.key.key === k)!.set.value);
    const rows = (): { n: number } => s.db.query("SELECT count(*) AS n FROM config WHERE project = ? AND file = 'roles.conf'").get(P) as { n: number };
    expect(get(s, P, "roles.conf", "builder", o)).toMatchObject({ source: "default", value: "claude  opus   ondemand -  claude:sonnet,muse:muse-spark-1.3" });
    // Omitted fallbacks are the current row's, as roles.sh set carries them.
    expect(set(s, P, "roles.conf", "builder", "claude sonnet", "ds", o)).toEqual([{ project: P, file: "roles.conf", key: "builder",
      old: null, new: "claude sonnet ondemand - claude:sonnet,muse:muse-spark-1.3" }]);
    expect(rows()).toEqual({ n: 1 });   // no copy of the default roster
    expect(row(s, "roles.conf", "lead")).toBeNull();
    expect(get(s, P, "roles.conf", "lead", o)).toMatchObject({ source: "default", value: dflt("lead") });
    expect(get(s, P, "roles.conf", "studio", o)).toMatchObject({ source: "default", value: dflt("studio") });
    set(s, P, "roles.conf", "builder", "claude sonnet ondemand high - plus", "ds", o);
    expect(get(s, P, "roles.conf", "builder", o)).toMatchObject({ source: "project", value: "claude sonnet ondemand high - plus" });
    // reset drops the project's row: the role follows the default again.
    expect(reset(s, P, "roles.conf", "builder", "ds", o)).toEqual([{ project: P, file: "roles.conf", key: "builder", old: "claude sonnet ondemand high - plus", new: null }]);
    expect(row(s, "roles.conf", "builder")).toBeNull();
    expect(get(s, P, "roles.conf", "builder", o)).toMatchObject({ source: "default", value: dflt("builder") });
    expect(reset(s, P, "roles.conf", "builder", "ds", o)).toEqual([]);   // nothing to drop
    expect(() => reset(s, P, "roles.conf", "nope", "ds", o)).toThrow("'nope' is not in the default roster");
    set(s, P, "roles.conf", "tester", "claude sonnet", "ds", o);
    expect(rm(s, P, "roles.conf", "tester", "ds", o)[0]).toMatchObject({ key: "tester", new: null });
    expect(get(s, P, "roles.conf", "tester", o)).toMatchObject({ source: "default", value: dflt("tester") });
    // A row copied before U267 (the whole-roster seed) stays a project row until reset (R5).
    s.upsert("config", { project: P, file: "roles.conf", key: "lead" }, { value: dflt("lead"), observed_at: 1 });
    expect(get(s, P, "roles.conf", "lead", o)).toMatchObject({ source: "project", value: dflt("lead") });
    expect(reset(s, P, "roles.conf", "lead", "ds", o)[0]).toMatchObject({ key: "lead", new: null });
    expect(get(s, P, "roles.conf", "lead", o)).toMatchObject({ source: "default" });
    set(s, P, "roles.conf", "lead", "claude opus", "ds", o);
    expect(reset(s, P, "roles.conf", null, "ds", o)).toHaveLength(1);
    expect(rows()).toEqual({ n: 0 });
    expect(historyOf(s, P, "roles.conf")).toHaveLength(8);
  });

  test("roles.conf: setting a role to its default on a project with no roster is no change", () => {
    const { s, o } = fixture();
    expect(set(s, P, "roles.conf", "lead", String(get(s, P, "roles.conf", "lead", o).value), "ds", o)).toEqual([]);
    expect(s.db.query("SELECT count(*) AS n FROM config WHERE project = ?").get(P)).toEqual({ n: 0 });
    expect(historyOf(s, P)).toEqual([]);
  });

  test("roles.conf column 8 (configurable-role-elevation U1, U3): kept on an omitted set, cleared by -, checked, refused on elevate, accepted on studio", () => {
    const { s, o } = fixture();
    set(s, P, "roles.conf", "lead", "claude sonnet always - - - up", "ds", o);
    expect(row(s, "roles.conf", "lead")).toBe("claude sonnet always - - - up");
    // An omitted column 8 keeps the row's own; `-` clears it (inherit) and drops the trailing dashes.
    set(s, P, "roles.conf", "lead", "claude opus always high", "ds", o);
    expect(row(s, "roles.conf", "lead")).toBe("claude opus always high - - up");
    set(s, P, "roles.conf", "lead", "claude opus always high - - -", "ds", o);
    expect(row(s, "roles.conf", "lead")).toBe("claude opus always high");
    set(s, P, "roles.conf", "thinker", "claude opus always - - - stay", "ds", o);
    expect(row(s, "roles.conf", "thinker")).toBe("claude opus always - - - stay");
    refused(() => set(s, P, "roles.conf", "lead", "claude opus always - - - yes", "ds", o), /return \(column 8\) must be up, stay or - \(got 'yes' on row 'lead'\)/);
    refused(() => set(s, P, "roles.conf", "builder-review", "claude opus elevate - - - up", "ds", o), /can't go on 'builder-review': it is an elevate row/);
    // U3: `up` on studio moves the Studio back up through studio-move.
    set(s, P, "roles.conf", "studio", "claude sonnet ondemand - - - up", "ds", o);
    expect(row(s, "roles.conf", "studio")).toBe("claude sonnet ondemand - - - up");
    // `stay` on an elevate row is allowed (it changes nothing).
    set(s, P, "roles.conf", "builder-review", "claude opus elevate - - - stay", "ds", o);
    refused(() => set(s, P, "roles.conf", "lead", "claude opus always - - - up extra", "ds", o), /at most 8 columns/);
  });

  test("resolveBackUp (configurable-role-elevation U1, U3): own row, default row, base role, else stay; elevate always stays; studio from its own rows", () => {
    const d = new Map([["thinker", "claude opus always - - - up"], ["builder", "claude opus ondemand"], ["builder-standard", "claude sonnet ondemand"],
      ["builder-review", "claude opus elevate"], ["builder-review-standard", "claude sonnet elevate medium"], ["studio", "claude sonnet ondemand"], ["lead", "claude sonnet always"]]);
    const none = new Map<string, string>();
    expect(resolveBackUp("thinker", none, d)).toEqual({ back_up: true, value: "up", from: "default" });
    expect(resolveBackUp("lead", none, d)).toEqual({ back_up: false, value: "stay", from: null });
    expect(resolveBackUp("thinker-standard-babysit", none, d)).toEqual({ back_up: true, value: "up", from: "thinker" });
    // A project thinker row written before column 8 still moves up.
    expect(resolveBackUp("thinker", new Map([["thinker", "claude opus always high"]]), d).back_up).toBe(true);
    expect(resolveBackUp("thinker", new Map([["thinker", "claude opus always - - - stay"]]), d)).toEqual({ back_up: false, value: "stay", from: "row" });
    const up = new Map([["builder", "claude opus ondemand - - - up"]]);
    expect(resolveBackUp("builder-standard", up, d)).toEqual({ back_up: true, value: "up", from: "builder" });
    expect(resolveBackUp("builder-hard-babysit", up, d).back_up).toBe(true);
    expect(resolveBackUp("builder-standard", new Map([...up, ["builder-standard", "claude sonnet ondemand - - - stay"]]), d).back_up).toBe(false);
    for (const r of ["builder-review", "builder-review-standard", "studio"]) expect(resolveBackUp(r, up, d).back_up).toBe(false);
    expect(resolveBackUp("builder-review", new Map([["builder-review", "claude opus elevate - - - up"]]), d).back_up).toBe(false);
    // U3: studio resolves from its project row, then the default studio row, else stay.
    expect(resolveBackUp("studio", new Map([["studio", "claude sonnet ondemand - - - up"]]), d)).toEqual({ back_up: true, value: "up", from: "row" });
    expect(resolveBackUp("studio", none, new Map([...d, ["studio", "claude sonnet ondemand - - - up"]]))).toEqual({ back_up: true, value: "up", from: "default" });
    expect(resolveBackUp("studio", none, d)).toEqual({ back_up: false, value: "stay", from: null });
  });

  test("models.conf: set, get, rm, reset; the value shape confRows makes", () => {
    const { s, o } = fixture();
    expect(get(s, P, "models.conf", "claude|opus", o)).toMatchObject({ source: "default", value: "Claude · Opus | low,medium,high,xhigh,max" });
    set(s, P, "models.conf", "codex|gpt-x", "Codex · X|low,high", "ds", o);
    expect(get(s, P, "models.conf", "codex|gpt-x", o)).toMatchObject({ source: "project", value: "Codex · X | low,high" });
    // A model the project's catalog now holds may be named in its roster.
    set(s, P, "roles.conf", "researcher", "codex gpt-x", "ds", o);
    expect(row(s, "roles.conf", "researcher")).toBe("codex gpt-x ondemand");
    set(s, P, "models.conf", "muse|muse-x", "Muse · X | -", "ds", o);
    expect(rm(s, P, "models.conf", "codex|gpt-x", "ds", o)).toHaveLength(1);
    expect(reset(s, P, "models.conf", null, "ds", o)).toHaveLength(1);
    expect(get(s, P, "models.conf", "muse|muse-x", o)).toMatchObject({ value: null, source: null });
    expect(historyOf(s, P, "models.conf")).toHaveLength(4);
  });

  test("ship-mode: the default from projects.conf or ce-pipeline, set, default clears, rm, reset", () => {
    const { s, o } = fixture();
    expect(get(s, P, "ship-mode", "mode", o)).toMatchObject({ value: "ce-pipeline", source: "default" });
    writeFileSync(join(o.conventions, "projects.conf"), `${P} local-only   # demo\n`);
    expect(get(s, P, "ship-mode", "mode", o)).toMatchObject({ value: "local-only", source: "default" });
    set(s, P, "ship-mode", "mode", "direct-PR", "ds", o);
    expect(get(s, P, "ship-mode", "mode", o)).toMatchObject({ value: "direct-PR", source: "project" });
    expect(set(s, P, "ship-mode", "mode", "default", "ds", o)).toEqual([{ project: P, file: "ship-mode", key: "mode", old: "direct-PR", new: null }]);
    set(s, P, "ship-mode", "mode", "no-mistakes", "ds", o);
    expect(rm(s, P, "ship-mode", "mode", "ds", o)).toHaveLength(1);
    set(s, P, "ship-mode", "mode", "ce-pipeline", "ds", o);
    expect(reset(s, P, "ship-mode", "mode", "ds", o)).toHaveLength(1);
    expect(get(s, P, "ship-mode", "mode", o).source).toBe("default");
    expect(historyOf(s, P, "ship-mode")).toHaveLength(6);
  });

  test("refusals change nothing: unknown limits key, bad value, unknown role, unknown model, unknown ship mode", () => {
    const { s, o } = fixture();
    refused(() => set(s, P, "limits.conf", "no_such_key", "1", "ds", o), /unknown key 'no_such_key'/);
    refused(() => set(s, P, "limits.conf", "auto_merge", "always", "ds", o), /auto_merge must be off, squash, merge or rebase/);
    refused(() => set(s, P, "roles.conf", "wizard", "claude opus", "ds", o), /unknown role 'wizard'/);
    refused(() => set(s, P, "roles.conf", "builder", "claude gpt-9", "ds", o), /unknown model 'claude:gpt-9'/);
    refused(() => set(s, P, "roles.conf", "builder", "claude opus sometimes", "ds", o), /spawn must be always\|ondemand\|elevate/);
    refused(() => set(s, P, "roles.conf", "builder", "claude opus ondemand - bad,,list", "ds", o), /fallbacks must be/);
    refused(() => set(s, P, "models.conf", "codex", "X | low", "ds", o), /<agent>\|<model>/);
    refused(() => set(s, P, "ship-mode", "mode", "yolo", "ds", o), /invalid mode 'yolo'/);
    refused(() => set(s, P, "notes.conf", "x", "1", "ds", o), /unknown settings file/);
    refused(() => set(s, "../evil", "limits.conf", "auto_merge", "off", "ds", o), /bad project label/);
    expect(s.db.query("SELECT count(*) AS n FROM config WHERE project != ''").get()).toEqual({ n: 0 });
    expect(historyOf(s, P)).toEqual([]);
  });

  test("export -> confRows reads back the same rows, comments too; the backup file is rewritten on each change", () => {
    const { s, o } = fixture();
    set(s, P, "limits.conf", "auto_merge", "squash", "ds", o);
    set(s, P, "limits.conf", "review_risk_paths", "bin/loop/*,web/*.html", "ds", o);
    set(s, P, "roles.conf", "builder", "claude sonnet ondemand medium", "ds", o);
    set(s, P, "models.conf", "codex|gpt-x", "Codex · X | low,high", "ds", o);
    set(s, P, "ship-mode", "mode", "local-only", "ds", o);
    const backup = join(s.root, P, "settings.export");
    expect(readFileSync(backup, "utf8")).toBe(exportText(s, P));
    expect(exportText(s, P)).toStartWith(`# settings.export — ${P}'s settings overrides, a backup that nothing reads.\n`);
    const files = exportFiles(s, P), sections = exportSections(exportText(s, P));
    expect(Object.keys(files).sort()).toEqual(["limits.conf", "models.conf", "roles.conf", "ship-mode"]);
    expect(sections).toEqual(files);
    const dir = tmp();
    for (const [f, text] of Object.entries(files) as [SettingsFile, string][]) {
      writeFileSync(join(dir, f), text);
      const back = confRows(P, f, join(dir, f)).map((r) => [r.key.key, r.set.value, r.set.comment]);
      const rows = s.db.query("SELECT key, value, comment FROM config WHERE project = ? AND file = ? ORDER BY rowid").all(P, f).map((r) => Object.values(r as object));
      expect(back).toEqual(rows);
    }
    expect(files["roles.conf"]).toBe("builder claude sonnet ondemand medium claude:sonnet,muse:muse-spark-1.3\n");   // the one row set (U267), no copied default
    rm(s, P, "ship-mode", "mode", "ds", o);
    expect(readFileSync(backup, "utf8")).not.toContain("#== ship-mode");
  });
});

describe("read API (U257): the readers outside the loop, no Store", () => {
  test("readGet, readRows, readRoster, readProjectRosterLines read the rows at the state root", () => {
    const { s, o } = fixture();
    set(s, P, "limits.conf", "auto_merge", "squash", "ds", o);
    set(s, P, "roles.conf", "builder", "claude sonnet ondemand medium", "ds", o);
    set(s, "other", "roles.conf", "lead", "claude opus always high", "ds", o);
    const r = { root: s.root, conventions: o.conventions };
    expect([readGet(P, "limits.conf", "auto_merge", r).value, readGet(P, "limits.conf", "auto_merge", r).source]).toEqual(["squash", "project"]);
    expect(readGet(P, "limits.conf", "expected_checks", r).source).not.toBe("project");
    expect(readRows(P, "roles.conf", r).map((x) => x.key)).toEqual(["builder"]);
    const roster = readRoster(P, r);
    expect(roster.get("builder")).toStartWith("claude sonnet ondemand medium");
    expect(roster.has("lead")).toBe(true);   // the shipped row fills a role the project lacks
    expect(readRoster("other", r).get("builder")).not.toStartWith("claude sonnet ondemand");
    expect(readProjectRosterLines(r).map((l) => l.split(" ")[0]).sort()).toEqual(["builder", "lead"]);
  });

  test("no loop.db at the root: the defaults, no rows, and no database made", () => {
    const { o } = fixture();
    const root = join(tmp(), "state"), r = { root, conventions: o.conventions };
    expect(readGet(P, "limits.conf", "auto_merge", r).source).not.toBe("project");
    expect(readRows(P, "roles.conf", r)).toEqual([]);
    expect(readRoster(P, r).has("lead")).toBe(true);
    expect(readProjectRosterLines(r)).toEqual([]);
    expect(existsSync(join(root, "loop.db"))).toBe(false);
  });
});

describe("ds config", () => {
  const ds = (root: string, ...args: string[]) => {
    const p = Bun.spawnSync([DS, "--state", root, "config", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_LOOP_AUTO_MERGE: "" } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  test("get prints value and source; set/rm write a row and history; a refusal exits 2; export prints conf syntax", () => {
    const root = fixture().s.root;
    expect(JSON.parse(ds(root, "get", P, "limits.conf", "auto_merge").out)).toMatchObject({ value: "off", source: "default" });
    const r = ds(root, "set", P, "limits.conf", "auto_merge", "squash");
    expect([r.code, JSON.parse(r.out)[0].new]).toEqual([0, "squash"]);
    expect(JSON.parse(ds(root, "get", P, "limits.conf", "auto_merge").out)).toMatchObject({ value: "squash", source: "project" });
    const bad = ds(root, "set", P, "limits.conf", "nope", "1");
    expect([bad.code, bad.err]).toEqual([2, "ds config: unknown key 'nope' (see: limits.sh show)\n"]);
    expect(ds(root, "set", P, "roles.conf", "builder", "claude", "sonnet", "ondemand").code).toBe(0);
    expect(ds(root, "export", "--project", P).out).toContain("#== roles.conf\n");
    expect(ds(root, "rm", P, "limits.conf", "auto_merge").code).toBe(0);
    expect((JSON.parse(ds(root, "history", "--project", P, "--file", "limits.conf").out) as unknown[]).length).toBe(2);
    expect(ds(root, "get", P, "limits.conf").code).toBe(2);
    expect(existsSync(join(root, P, "settings.export"))).toBe(true);
  });

  test("import puts a settings.export or a renamed file back; a name that isn't a settings file needs --file", () => {
    const root = fixture().s.root, dir = tmp();
    ds(root, "set", P, "limits.conf", "limit_pct", "80");
    ds(root, "set", P, "ship-mode", "mode", "direct-PR");
    const backup = join(dir, "backup.export");
    writeFileSync(backup, readFileSync(join(root, P, "settings.export")));
    ds(root, "set", P, "limits.conf", "limit_pct", "70");
    ds(root, "set", P, "limits.conf", "auto_merge", "squash");
    ds(root, "rm", P, "ship-mode", "mode");
    expect(ds(root, "import", "--project", P, backup).code).toBe(0);
    // `export` is a transfer file: the backup's text under the header line.
    expect(ds(root, "export", "--project", P).out.split("\n").slice(1).join("\n")).toBe(readFileSync(backup, "utf8"));
    writeFileSync(join(dir, "limits.conf.imported-2026-11-17"), "context_warn 90000\n");
    expect(ds(root, "import", "--project", P, join(dir, "limits.conf.imported-2026-11-17")).code).toBe(0);
    expect(JSON.parse(ds(root, "get", P, "limits.conf", "context_warn").out)).toMatchObject({ value: "90000", source: "project" });
    expect(JSON.parse(ds(root, "get", P, "limits.conf", "limit_pct").out)).toMatchObject({ source: "default" });
    writeFileSync(join(dir, "x.txt"), "mode local-only\n");
    expect(ds(root, "import", "--project", P, join(dir, "x.txt")).code).toBe(2);
    expect(ds(root, "import", "--project", P, "--file", "ship-mode", join(dir, "x.txt")).code).toBe(0);
  });
});

describe("config observer (KTD5)", () => {
  test("a project whose folder is gone keeps its skills.conf rows and its settings rows", () => {
    const { s, conventions } = fixture();
    writeFileSync(join(s.root, P, "limits.conf"), "limit_pct 80\n");
    const o = configObserver(conventions);
    const tick = (at: number) => o.run({ store: s, project: "", tick: at, now: at, fired: [], poked: new Set() } as TickCtx);
    tick(T);
    expect(row(s, "limits.conf", "limit_pct")).toBe("80");
    s.upsert("config", { project: P, file: "skills.conf", key: "builder lavish" }, { value: "off", observed_at: T });
    rmSync(join(s.root, P), { recursive: true });
    tick(T + 5);
    expect(row(s, "skills.conf", "builder lavish")).toBe("off");
    expect(row(s, "limits.conf", "limit_pct")).toBe("80");
  });
});

describe("U32: a backend change is checked when it is set", () => {
  const has = (...bins: string[]) => (b: string) => (bins.includes(b) ? `/usr/bin/${b}` : null);
  const squad = (s: Store, topic: string, backend: string, status = "running") =>
    s.upsert("squads", { project: P, topic }, { repo: "path:/x", status, want: "running", observed_at: 1, updated_at: 1, backend });

  // The shipped roster names muse, which a contract backend cannot launch: the other tests run on a claude-only one.
  const claudeOnly = (o: { conventions: string; now: number }) => { writeFileSync(join(o.conventions, "roles.conf"), "lead claude sonnet always\nbuilder claude sonnet always\n"); return o; };

  test("a missing binary, a tool the backend cannot use and a roster row it cannot launch are each refused with the fix", () => {
    const { s, o } = fixture();
    const oo = { ...o, which: has("orca") };
    refused(() => set(s, P, "limits.conf", "default_backend", "tmux", "ds", oo), /needs 'tmux', which is not on PATH.*install it, or pick another backend/);
    const tm = { ...o, which: has("tmux") };
    // the shipped roster names muse for a role: a contract backend can start claude only
    refused(() => set(s, P, "limits.conf", "default_backend", "tmux", "ds", tm), /can start only claude.*roles\.conf/);
    expect(row(s, "limits.conf", "default_backend")).toBeNull();
    // the same change fits once the roster is claude only
    claudeOnly(o);
    expect(set(s, P, "limits.conf", "default_backend", "tmux", "ds", tm)).toHaveLength(1);
  });

  test("U54: default_backend is refused while the Studio runs on another backend, naming ds up --backend; its own fits", () => {
    const { s, o } = fixture();
    claudeOnly(o);
    const tm = { ...o, which: has("tmux", "orca") };
    s.upsert("projects", { label: P }, { studio_wt: "local::/x/studio", doc: JSON.stringify({ studio_backend: "tmux" }), observed_at: 1 });
    refused(() => set(s, P, "limits.conf", "default_backend", "orca", "board", tm), new RegExp(`Studio runs on tmux.*ds up ${P} --backend orca`));
    expect(row(s, "limits.conf", "default_backend")).toBeNull();
    expect(set(s, P, "limits.conf", "default_backend", "tmux", "ds", tm)).toHaveLength(1);
    // A project with no Studio yet (a first ds up writes its backend before it exists): no such check.
    s.upsert("projects", { label: P }, { studio_wt: null, observed_at: 2 });
    expect(set(s, P, "limits.conf", "default_backend", "orca", "ds", tm)).toHaveLength(1);
  });

  test("worktree_provider: an explicit git or treehouse with orca is refused; so is a backend change under it", () => {
    const { s, o } = fixture();
    claudeOnly(o);
    refused(() => set(s, P, "limits.conf", "worktree_provider", "git", "ds", o), /cannot use worktree_provider git.*set worktree_provider auto, or pick another backend/);
    refused(() => set(s, P, "limits.conf", "worktree_provider", "treehouse", "ds", o), /cannot use worktree_provider treehouse/);
    expect(set(s, P, "limits.conf", "worktree_provider", "auto", "ds", o)).toHaveLength(1);
    // orca-lite also uses Orca's worktrees: a row of git is refused there too
    s.upsert("config", { project: P, file: "limits.conf", key: "worktree_provider" }, { value: "git", observed_at: 1 });
    refused(() => set(s, P, "limits.conf", "default_backend", "orca-lite", "ds", { ...o, which: has("orca") }), /orca-lite cannot use worktree_provider git/);
  });

  test("a valid change is written, and the note says where new squads start and how many stay", () => {
    const { s, o } = fixture();
    claudeOnly(o);
    squad(s, "a", "orca"); squad(s, "b", "orca"); squad(s, "c", "orca", "closed"); squad(s, "d", "tmux");
    const oo = { ...o, which: has("orca") };
    const cs = set(s, P, "limits.conf", "default_backend", "orca-lite", "ds", oo);
    expect(cs).toHaveLength(1);
    expect(backendChangeNote(s, P, cs, oo)).toBe("new squads start on orca-lite; 2 running squads stay on orca");
    squad(s, "b", "orca", "closed");
    const back = set(s, P, "limits.conf", "default_backend", "orca", "ds", oo);
    expect(backendChangeNote(s, P, back, oo)).toBe("new squads start on orca; 0 running squads stay on orca-lite");
    expect(backendChangeNote(s, P, [], oo)).toBe("");
  });

  test("a DS_LIMIT_DEFAULT_BACKEND env var is warned about", () => {
    const { s, o } = fixture();
    claudeOnly(o);
    const oo = { ...o, which: has("orca") };
    const cs = set(s, P, "limits.conf", "default_backend", "orca-lite", "ds", oo);
    const note = withEnv("DS_LIMIT_DEFAULT_BACKEND", "tmux", () => backendChangeNote(s, P, cs, oo));
    expect(note).toMatch(/^warning: DS_LIMIT_DEFAULT_BACKEND=tmux is set and overrides every project's default_backend/);
  });
});
