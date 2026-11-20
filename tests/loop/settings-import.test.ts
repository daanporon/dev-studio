// settings-import.test.ts — settings-export-import U1: planImport / applyImport in
// bin/loop/settings/settings.ts, the checked copy of one project's settings into another (or from an
// export's text), on a hermetic state root with a copy of conventions/. The plan's actions and whys,
// replace, the picks apply writes (one history row each, stale and refused picks named), the board's
// shell-only keys, the transfer header and the skills.conf section of an export, and `ds config import`
// leaving the skills rows alone for an old backup.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confRows } from "../../bin/loop/db/import-config.ts";
import { FILE_ONLY_LIMITS } from "../../bin/board/board-data.ts";
import {
  applyImport, exportText, exportTransfer, historyOf, importActor, parseExport, planImport, PROJECT_SPECIFIC_LIMITS, set,
  SettingsError, SHELL_ONLY_LIMITS, TRANSFER_HEAD, type PlanRow,
} from "../../bin/loop/settings/settings.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const SRC = "src", DST = "dst";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzsimport-")); temps.push(d); return d; }
function fixture(): { s: Store; o: { conventions: string; now: number } } {
  const root = join(tmp(), "state"), conventions = tmp();
  for (const p of [SRC, DST]) mkdirSync(join(root, p, "squads"), { recursive: true });
  cpSync(join(ROOT, "conventions"), conventions, { recursive: true });
  const s = open(root);
  stores.push(s);
  return { s, o: { conventions, now: T } };
}
// A row as a live host holds it, unchecked: what an older dev-studio wrote (hooks_ts) or the spaces of a
// hand-edited conf file.
const raw = (s: Store, project: string, file: string, key: string, value: string) =>
  s.upsert("config", { project, file, key }, { value, comment: null, observed_at: T });
const row = (s: Store, project: string, file: string, key: string) =>
  (s.db.query("SELECT value FROM config WHERE project = ? AND file = ? AND key = ?").get(project, file, key) as { value: string } | null)?.value ?? null;
const find = (plan: PlanRow[], file: string, key: string) => plan.find((r) => r.file === file && r.key === key)!;
const brief = (r: PlanRow) => [r.action, r.why ?? null, r.pick, r.can_pick];

// dev-studio-like source rows.
function devStudioLike(s: Store): void {
  raw(s, SRC, "limits.conf", "hooks_ts", "1");                 // a key this dev-studio no longer knows
  raw(s, SRC, "limits.conf", "auto_merge", "merge");           // project-specific
  raw(s, SRC, "limits.conf", "limit_pct", "80");               // dst has none: add
  raw(s, SRC, "limits.conf", "context_warn", "90000");         // dst has 120000: change
  raw(s, SRC, "limits.conf", "briefing_time", "07:30");        // dst has the same: same
  raw(s, SRC, "limits.conf", "cleanup_on_close", "rm -rf node_modules/.cache");
  raw(s, SRC, "roles.conf", "builder", "claude  sonnet   ondemand  medium  claude:sonnet,muse:muse-spark-1.3");   // spacing only: same
  raw(s, SRC, "roles.conf", "lead", "claude  sonnet always");  // dst has no row; the default's spacing: same
  raw(s, SRC, "roles.conf", "tester", "claude gpt-9 ondemand"); // unknown model: refused
  raw(s, SRC, "roles.conf", "wizard", "claude opus always");   // a role dst can't run: unknown key
  raw(s, SRC, "ship-mode", "mode", "direct-PR");
  raw(s, SRC, "skills.conf", "builder run", "off");
}
function dstRows(s: Store, o: { conventions: string; now: number }): void {
  set(s, DST, "limits.conf", "context_warn", "120000", "ds", o);
  set(s, DST, "limits.conf", "briefing_time", "07:30", "ds", o);
  set(s, DST, "limits.conf", "max_builders", "3", "ds", o);    // the source lacks it: a remove under replace
  set(s, DST, "roles.conf", "builder", "claude sonnet ondemand medium", "ds", o);
}

describe("planImport", () => {
  test("each source row planned against the target: skip with why, add, change, same; nothing written", () => {
    const { s, o } = fixture();
    devStudioLike(s);
    dstRows(s, o);
    const before = historyOf(s, DST).length;
    const plan = planImport(s, DST, { project: SRC }, o);
    expect(brief(find(plan, "limits.conf", "hooks_ts"))).toEqual(["skip", "unknown key", false, false]);
    expect(brief(find(plan, "limits.conf", "auto_merge"))).toEqual(["skip", "project-specific", false, true]);
    expect(find(plan, "limits.conf", "auto_merge").value).toBe("merge");
    expect(brief(find(plan, "limits.conf", "limit_pct"))).toEqual(["add", null, true, true]);
    expect(find(plan, "limits.conf", "context_warn")).toMatchObject({ action: "change", current: "120000", value: "90000", pick: true });
    expect(brief(find(plan, "limits.conf", "briefing_time"))).toEqual(["same", null, false, false]);
    expect(brief(find(plan, "limits.conf", "cleanup_on_close"))).toEqual(["skip", "project-specific", false, true]);
    expect(find(plan, "roles.conf", "builder")).toMatchObject({ action: "same", value: "claude sonnet ondemand medium claude:sonnet,muse:muse-spark-1.3" });
    expect(find(plan, "roles.conf", "lead")).toMatchObject({ action: "same", current: null });
    const tester = find(plan, "roles.conf", "tester");
    expect([tester.action, tester.can_pick]).toEqual(["skip", false]);
    expect(tester.why).toMatch(/^refused: unknown model 'claude:gpt-9'/);
    expect(brief(find(plan, "roles.conf", "wizard"))).toEqual(["skip", "unknown key", false, false]);
    expect(brief(find(plan, "ship-mode", "mode"))).toEqual(["skip", "project-specific", false, true]);
    expect(brief(find(plan, "skills.conf", "builder run"))).toEqual(["add", null, true, true]);
    expect(plan.some((r) => r.action === "remove")).toBe(false);   // no replace: the target's own rows stay
    expect(historyOf(s, DST).length).toBe(before);
  });

  test("replace: a target row the source lacks is a remove (picked); a project-specific one is a tickable skip", () => {
    const { s, o } = fixture();
    devStudioLike(s);
    dstRows(s, o);
    set(s, DST, "limits.conf", "expected_checks", "tests", "ds", o);
    const plan = planImport(s, DST, { project: SRC }, { ...o, replace: true });
    expect(find(plan, "limits.conf", "max_builders")).toMatchObject({ action: "remove", value: null, current: "3", pick: true, can_pick: true });
    expect(find(plan, "limits.conf", "expected_checks")).toMatchObject({ action: "skip", why: "project-specific", value: null, pick: false, can_pick: true });
  });

  test("the board's plan marks the shell-only keys `shell only`, not tickable", () => {
    const { s, o } = fixture();
    devStudioLike(s);
    expect(brief(find(planImport(s, DST, { project: SRC }, { ...o, board: true }), "limits.conf", "cleanup_on_close"))).toEqual(["skip", "shell only", false, false]);
  });

  test("a skills rule a shipped `required` rule pins is refused; a level equal to the shipped one is same", () => {
    const { s, o } = fixture();
    raw(s, SRC, "skills.conf", "builder no-mistakes", "off");
    raw(s, SRC, "skills.conf", "builder lavish", "name-only");
    raw(s, SRC, "skills.conf", "builder run", "loud");
    raw(s, SRC, "skills.conf", "wizard run", "off");
    const plan = planImport(s, DST, { project: SRC }, o);
    expect(find(plan, "skills.conf", "builder no-mistakes").why).toBe("refused: no-mistakes is required for builder; it can't be lowered");
    expect(find(plan, "skills.conf", "builder lavish").action).toBe("same");
    expect(find(plan, "skills.conf", "builder run").why).toBe("refused: run: unknown level loud");
    expect(find(plan, "skills.conf", "wizard run").why).toBe("unknown key");
  });

  test("a roster row may name a model the import's own models.conf brings; an unknown account plan warns", () => {
    const { s, o } = fixture();
    raw(s, SRC, "models.conf", "claude|opus-next", "Claude · Next | low,high");
    raw(s, SRC, "roles.conf", "thinker", "claude opus-next always");
    raw(s, SRC, "roles.conf", "tester", "claude opus ondemand - claude:sonnet:low:Ultra max");
    s.upsert("observed_accounts", { agent: "claude", account: "a1" }, { plan: "max", observed_at: T });
    const plan = planImport(s, DST, { project: SRC }, o);
    expect(find(plan, "roles.conf", "thinker")).toMatchObject({ action: "add", value: "claude opus-next always" });
    expect(find(plan, "roles.conf", "thinker").warn).toBeUndefined();
    expect(find(plan, "roles.conf", "tester")).toMatchObject({ action: "add", warn: "no account on this host reports plan claude:Ultra" });
  });

  test("u4: a skip row carries the incoming value; a source roster row without fallbacks clears them; spacing alone is same; an unknown section is refused", () => {
    const { s, o } = fixture();
    raw(s, SRC, "limits.conf", "hooks_ts", "1");
    raw(s, SRC, "limits.conf", "auto_merge", "merge");
    raw(s, SRC, "roles.conf", "builder-standard", "claude sonnet ondemand medium");
    raw(s, DST, "roles.conf", "builder-standard", "claude sonnet ondemand medium claude:opus");
    raw(s, SRC, "roles.conf", "builder-hard-babysit", "claude sonnet ondemand - claude:opus");
    raw(s, DST, "roles.conf", "builder-hard-babysit", "claude   sonnet  ondemand  -  claude:opus");
    raw(s, SRC, "roles.conf", "tester", "claude gpt-9 always");
    const plan = planImport(s, DST, { project: SRC }, o);
    expect(find(plan, "limits.conf", "hooks_ts")).toMatchObject({ action: "skip", raw: "1" });
    expect(find(plan, "limits.conf", "auto_merge").value).toBe("merge");
    expect(find(plan, "roles.conf", "tester").raw).toBe("claude gpt-9 always");
    expect(find(plan, "roles.conf", "builder-standard")).toMatchObject({ action: "change", value: "claude sonnet ondemand medium" });
    expect(find(plan, "roles.conf", "builder-hard-babysit").action).toBe("same");
    applyImport(s, DST, { project: SRC }, [{ file: "roles.conf", key: "builder-standard" }], "t", o);
    expect(row(s, DST, "roles.conf", "builder-standard")).toBe("claude sonnet ondemand medium");
    const text = `${TRANSFER_HEAD} 1 from=x\n#== nosuch.conf\nfoo 1\n`;
    expect(() => planImport(s, DST, { text }, o)).toThrow(/unknown section 'nosuch.conf'/);
  });

  test("an unknown source project, the target itself, a text that is not an export, a newer format: refused", () => {
    const { s, o } = fixture();
    expect(() => planImport(s, DST, { project: "nope" }, o)).toThrow(/no project 'nope' on this host/);
    expect(() => planImport(s, DST, { project: DST }, o)).toThrow(/can't import from itself/);
    expect(() => planImport(s, DST, { text: "hello\nworld\n" }, o)).toThrow(/^not a settings export: no '#! ds-settings' header/);
    expect(() => parseExport(`${TRANSFER_HEAD} 2 from=x\n`)).toThrow(/format 2, newer than this dev-studio reads \(1\)/);
    expect(() => parseExport(`${TRANSFER_HEAD} x\n`)).toThrow(SettingsError);
  });
});

describe("applyImport", () => {
  test("writes only the picked rows, one history row each by the actor, and the backup once; a stale pick is not written", () => {
    const { s, o } = fixture();
    devStudioLike(s);
    dstRows(s, o);
    const src = { project: SRC };
    const plan = planImport(s, DST, src, { ...o, replace: true });
    const before = historyOf(s, DST).length;
    const picks = plan.filter((r) => r.pick).map((r) => ({ file: r.file, key: r.key, expect: r.current }));
    expect(picks.map((p) => p.key).sort()).toEqual(["builder run", "context_warn", "limit_pct", "max_builders"]);
    set(s, DST, "limits.conf", "context_warn", "110000", "ds", o);   // changed after the preview
    const n = historyOf(s, DST).length;
    const res = applyImport(s, DST, src, picks, importActor(src), { ...o, replace: true, now: T + 5 });
    expect(res.stale).toEqual([{ file: "limits.conf", key: "context_warn", expect: "120000", current: "110000" }]);
    expect(res.skipped).toEqual([]);
    expect(res.written.map((c) => [c.file, c.key, c.old, c.new])).toEqual([
      ["limits.conf", "limit_pct", null, "80"], ["limits.conf", "max_builders", "3", null], ["skills.conf", "builder run", null, "off"]]);
    expect(row(s, DST, "limits.conf", "context_warn")).toBe("110000");
    expect(row(s, DST, "limits.conf", "max_builders")).toBeNull();
    expect(row(s, DST, "limits.conf", "auto_merge")).toBeNull();
    expect(row(s, DST, "limits.conf", "hooks_ts")).toBeNull();
    const hist = historyOf(s, DST).slice(n);
    expect(hist.map((h) => [h.key, h.actor, h.at])).toEqual([["limit_pct", "import:src", T + 5], ["max_builders", "import:src", T + 5], ["builder run", "import:src", T + 5]]);
    expect(n).toBe(before + 1);
    expect(readFileSync(join(s.root, DST, "settings.export"), "utf8")).toBe(exportText(s, DST));
    expect(exportText(s, DST)).toContain("#== skills.conf\nbuilder run off\n");
  });

  test("a project-specific row is written when picked; a refused, unknown or shell-only (board) pick is skipped with its why", () => {
    const { s, o } = fixture();
    devStudioLike(s);
    const picks = ["auto_merge", "hooks_ts", "cleanup_on_close"].map((key) => ({ file: "limits.conf", key }))
      .concat([{ file: "roles.conf", key: "tester" }, { file: "limits.conf", key: "no_such" }]);
    const res = applyImport(s, DST, { project: SRC }, picks, "board", { ...o, board: true });
    expect(res.written.map((c) => [c.key, c.new])).toEqual([["auto_merge", "merge"]]);
    expect(res.skipped.map((x) => [x.key, x.why.replace(/ \(.*$/, "")])).toEqual([
      ["hooks_ts", "unknown key"], ["cleanup_on_close", "shell only"], ["no_such", "not in the import"], ["tester", "refused: unknown model 'claude:gpt-9'"]]);
    expect(row(s, DST, "limits.conf", "cleanup_on_close")).toBeNull();
    // From the shell the same pick writes it, as the restore would (set refuses its spaces).
    const shell = applyImport(s, DST, { project: SRC }, [{ file: "limits.conf", key: "cleanup_on_close" }], "import:src", o);
    expect(shell.written.map((c) => c.new)).toEqual(["rm -rf node_modules/.cache"]);
  });

  test("a roster row whose model comes with the import is refused when the model row is not picked", () => {
    const { s, o } = fixture();
    raw(s, SRC, "models.conf", "claude|opus-next", "Claude · Next | low,high");
    raw(s, SRC, "roles.conf", "thinker", "claude opus-next always");
    const without = applyImport(s, DST, { project: SRC }, [{ file: "roles.conf", key: "thinker" }], "board", o);
    expect(without.written).toEqual([]);
    expect(without.skipped[0].why).toMatch(/^refused: unknown model 'claude:opus-next'/);
    const both = applyImport(s, DST, { project: SRC }, [{ file: "roles.conf", key: "thinker" }, { file: "models.conf", key: "claude|opus-next" }], "board", o);
    expect(both.written.map((c) => c.file)).toEqual(["models.conf", "roles.conf"]);
  });
});

describe("the export file", () => {
  test("an export with the header and the skills section reads back to the same rows; the backup has no header", () => {
    const { s, o } = fixture();
    raw(s, SRC, "skills.conf", "builder run", "off");   // before the sets, so the backup they write has it
    set(s, SRC, "limits.conf", "limit_pct", "80", "ds", o);
    set(s, SRC, "roles.conf", "builder", "claude sonnet ondemand medium", "ds", o);
    set(s, SRC, "models.conf", "codex|gpt-x", "Codex · X | low,high", "ds", o);
    const text = exportTransfer(s, SRC, { now: T });
    expect(text.split("\n")[0]).toMatch(/^#! ds-settings 1 from=src rev=\S+ at=2027-01-15T08:00:00\.000Z$/);
    expect(parseExport(text)).toMatchObject({ header: true, from: SRC, at: "2027-01-15T08:00:00.000Z" });
    const backup = readFileSync(join(s.root, SRC, "settings.export"), "utf8");
    expect(backup.startsWith("#")).toBe(true);
    expect(backup).not.toContain(TRANSFER_HEAD);
    expect(backup).toBe(exportText(s, SRC));
    const plan = planImport(s, DST, { text, name: "src.txt" }, o);
    const res = applyImport(s, DST, { text, name: "src.txt" }, plan.filter((r) => r.pick).map((r) => ({ file: r.file, key: r.key })), importActor({ text, name: "src.txt" }), o);
    expect(res.written.length).toBe(4);
    const rows = (p: string) => s.db.query("SELECT file, key, value FROM config WHERE project = ? ORDER BY file, key").all(p);
    expect(rows(DST)).toEqual(rows(SRC));
    expect(historyOf(s, DST).every((h) => h.actor === "import:src.txt")).toBe(true);
  });

  test("an old headerless export (no skills section) still imports, and replace leaves the skills rows alone", () => {
    const { s, o } = fixture();
    raw(s, DST, "skills.conf", "builder run", "off");
    const old = "# settings.export — old's settings overrides, a backup that nothing reads.\n\n#== limits.conf\nlimit_pct 70\n";
    const plan = planImport(s, DST, { text: old }, { ...o, replace: true });
    expect(plan.map((r) => [r.file, r.key, r.action])).toEqual([["limits.conf", "limit_pct", "add"]]);
    // With the header, a missing skills section means no skills rows: replace removes them.
    const now = `${TRANSFER_HEAD} 1 from=x\n${old}`;
    expect(planImport(s, DST, { text: now }, { ...o, replace: true }).map((r) => [r.key, r.action])).toEqual([["limit_pct", "add"], ["builder run", "remove"]]);
  });

  test("`ds config import` of an old backup with no skills section leaves the skills rows; one with the section restores them", () => {
    const { s, o } = fixture();
    set(s, DST, "limits.conf", "limit_pct", "80", "ds", o);
    raw(s, DST, "skills.conf", "builder run", "off");
    const root = s.root, dir = tmp();
    const ds = (...args: string[]) => Bun.spawnSync([DS, "--state", root, "config", ...args], { stdout: "pipe", stderr: "pipe" });
    const oldBackup = join(dir, "old.export");
    writeFileSync(oldBackup, "# settings.export — dst's settings overrides, a backup that nothing reads.\n\n#== limits.conf\nlimit_pct 70\n");
    s.close();
    expect(ds("import", "--project", DST, oldBackup).exitCode).toBe(0);
    const s2 = open(root);
    stores.push(s2);
    expect(row(s2, DST, "limits.conf", "limit_pct")).toBe("70");
    expect(row(s2, DST, "skills.conf", "builder run")).toBe("off");
    const newBackup = join(dir, "new.export");
    writeFileSync(newBackup, "# settings.export\n\n#== skills.conf\nbuilder lavish off\n");
    s2.close();
    expect(ds("import", "--project", DST, newBackup).exitCode).toBe(0);
    const s3 = open(root);
    stores.push(s3);
    expect(s3.db.query("SELECT key, value FROM config WHERE project = ? AND file = 'skills.conf'").all(DST)).toEqual([{ key: "builder lavish", value: "off" }]);
  });

  test("the project-specific limits keys are shipped keys, and the shell-only ones are the board's file-only list", () => {
    const shipped = new Set(confRows("", "limits.conf", join(ROOT, "conventions", "limits.conf")).map((r) => String(r.key.key)));
    for (const k of PROJECT_SPECIFIC_LIMITS) expect([k, shipped.has(k)]).toEqual([k, true]);
    expect([...SHELL_ONLY_LIMITS].sort()).toEqual([...FILE_ONLY_LIMITS].sort());
    for (const k of SHELL_ONLY_LIMITS) expect((PROJECT_SPECIFIC_LIMITS as readonly string[]).includes(k)).toBe(true);
  });
});
