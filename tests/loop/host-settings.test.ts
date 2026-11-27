// host-settings.test.ts — side-loop-host U25 (issue #127, KTD16): the machine keys are set per host. A `[host]` key of
// conventions/limits.conf reads the env var on the reading host, then that host's override (host_config), then the
// default, never a project's row; `ds host set|rm|show` writes and shows them with a config_history row each; a new
// side host gets seats and its brake on; migration 0064 turns main's brake on when any project had it on; a side host
// gets its own rows as `local` in the settings copy; every limit() copy routes a host key the same way.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, open, type Store } from "../../bin/loop/core/store.ts";
import { hostKeys, hostLine, isHostKey, SELF } from "../../bin/lib/host-settings.ts";
import { hostShow, rmHostKey, setHostKey } from "../../bin/loop/settings/host-settings.ts";
import { accept, newKeyPair, remove, requestJoin } from "../../bin/link/host-keys.ts";
import { DOWN, applyDown, downManifest } from "../../bin/link/replica.ts";
import { limit as loopLimit, limitLine } from "../../bin/loop/settings/limits.ts";
import { limit as pickLimit } from "../../bin/loop/capacity/pick.ts";
import { get, set, SettingsError } from "../../bin/loop/settings/settings.ts";
import { limitsJson } from "../../bin/board/board-data.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";

const REPO = join(import.meta.dir, "..", "..");
const DS = join(REPO, "bin", "ds");
const T0 = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
const ENVS = ["DS_LIMIT_BUILDER_HOST_BRAKE", "DS_LIMIT_MACHINE_LOAD_CRIT_PCT", "DS_LIMIT_SEATS", "DS_LIMIT_RESTART_RSS_GB"];
afterEach(() => {
  for (const k of ENVS) delete process.env[k];
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string { const d = mkdtempSync(join(tmpdir(), "zzhs-")); temps.push(d); return d; }
function store(root = temp()): Store { mkdirSync(join(root, "realp", "squads"), { recursive: true }); const s = open(root); stores.push(s); return s; }
const projectRow = (s: Store, project: string, key: string, value: string) =>
  s.upsert("config", { project, file: "limits.conf", key }, { value, observed_at: T0 });
const history = (s: Store, host: string) =>
  s.db.query("SELECT key, old_value, new_value, actor FROM config_history WHERE host = ? ORDER BY id").all(host) as Record<string, unknown>[];
function sideHost(s: Store, name: string, seats?: number): void {
  expect(requestJoin(s, { name, public_key: newKeyPair().publicKey }, T0).ok).toBe(true);
  expect(accept(s, name, { seats, by: "op" }, T0).ok).toBe(true);
}

function ds(root: string, ...args: string[]): { code: number; out: string; err: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DS_ROOT|DS_MEMBER|DS_WT|DS_GEN|DS_NOW|DS_WHO|DS_BACKEND|DS_LIMIT_.*)$/.test(k)) env[k] = v;
  const r = Bun.spawnSync([DS, ...args], { env: { ...env, DS_STATE_ROOT: root, DS_LIMIT_LINK_LISTEN: "off" }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("the host keys", () => {
  test("the KTD16 machine keys carry [host]; the two project-bound ones do not", () => {
    for (const k of ["seats", "builder_host_brake", "restart_rss_gb", "machine_load_crit_pct", "machine_psi_crit", "host_tidy",
      "cleanup_tmp_globs", "cleanup_tmp_age_h", "disk_card_free_pct", "disk_watch_paths", "tick_alarm_ms", "tick_alarm_windows"]) expect([k, isHostKey(k)]).toEqual([k, true]);
    for (const k of ["cleanup_on_close", "worktree_provider", "max_builders", "auto_merge"]) expect([k, isHostKey(k)]).toEqual([k, false]);
    expect(hostKeys().length).toBe(23);
  });

  test("lookup: env on the reading host, then the host override, then the default; a project row is never read", () => {
    const s = store();
    projectRow(s, "realp", "builder_host_brake", "on");
    expect(hostLine(s.db, SELF, "builder_host_brake")).toMatchObject({ value: "off", source: "default" });
    expect(pickLimit(s, "realp", "builder_host_brake")).toBe("off");
    setHostKey(s, SELF, "builder_host_brake", "on", "t");
    expect(hostLine(s.db, SELF, "builder_host_brake")).toMatchObject({ value: "on", source: "host" });
    process.env.DS_LIMIT_BUILDER_HOST_BRAKE = "off";
    expect(hostLine(s.db, SELF, "builder_host_brake")).toMatchObject({ value: "off", source: "env" });
    // Main cannot see a side host's env: the env var counts only for `local`.
    sideHost(s, "box-2");
    expect(hostLine(s.db, "box-2", "builder_host_brake")).toMatchObject({ value: "on", source: "host" });
  });

  test("every limit() copy reads main's own override for a host key", () => {
    const s = store();
    projectRow(s, "realp", "restart_rss_gb", "3");
    projectRow(s, "realp", "machine_load_crit_pct", "999");
    setHostKey(s, SELF, "restart_rss_gb", "12", "t");
    setHostKey(s, SELF, "machine_load_crit_pct", "120", "t");
    expect(loopLimit(s, "realp", "restart_rss_gb")).toBe("12");
    expect(limitLine(s, "realp", "machine_load_crit_pct")).toBe("120");
    expect(pickLimit(s, "realp", "machine_load_crit_pct")).toBe("120");
    // Settings' own read says where it came from, and a project write is refused with the way to set it.
    expect(get(s, "realp", "limits.conf", "restart_rss_gb")).toMatchObject({ value: "12", source: "host" });
    expect(() => set(s, "realp", "limits.conf", "restart_rss_gb", "4", "t")).toThrow(SettingsError);
    expect(() => set(s, "realp", "limits.conf", "restart_rss_gb", "4", "t")).toThrow(/ds host set <host> restart_rss_gb/);
  });
});

test("the board's Settings: a host key shows main's value and source, and a leftover project row as now per host", () => {
  const s = store();
  importConfig(s, s.root, join(REPO, "conventions"));   // the repo defaults the Settings rows list
  projectRow(s, "realp", "builder_host_brake", "on");
  setHostKey(s, SELF, "machine_load_crit_pct", "130", "op");
  const row = (k: string) => limitsJson("realp", s.root)!.limits.find((l) => l.key === k)!;
  expect(row("builder_host_brake")).toMatchObject({ value: "off", source: "default", host: true, nowPerHost: "on" });
  expect(row("machine_load_crit_pct")).toMatchObject({ value: "130", source: "host", host: true, nowPerHost: null, changed: { by: "op", undo: false } });
  expect(row("max_builders")).toMatchObject({ host: false });
});

describe("ds host set|rm|show", () => {
  test("set writes the override with one history row; rm drops it; a non-host key or unknown host is refused", () => {
    const s = store();
    expect(setHostKey(s, SELF, "machine_load_crit_pct", "130", "op")).toEqual([{ host: SELF, key: "machine_load_crit_pct", old: null, new: "130" }]);
    expect(setHostKey(s, SELF, "machine_load_crit_pct", "130", "op")).toEqual([]);
    expect(rmHostKey(s, SELF, "machine_load_crit_pct", "op")).toHaveLength(1);
    expect(history(s, SELF).filter((h) => h.key === "machine_load_crit_pct")).toEqual([
      { key: "machine_load_crit_pct", old_value: null, new_value: "130", actor: "op" },
      { key: "machine_load_crit_pct", old_value: "130", new_value: null, actor: "op" }]);
    expect(() => setHostKey(s, SELF, "max_builders", "3", "op")).toThrow(/not a host key/);
    expect(() => setHostKey(s, "nobox", "seats", "3", "op")).toThrow(/no host 'nobox'/);
    expect(() => setHostKey(s, SELF, "builder_host_brake", "maybe", "op")).toThrow(/on or off/);
  });

  test("the CLI: set, show with sources, refusals exit 1", () => {
    const root = temp();
    store(root).close();
    expect(ds(root, "host", "set", "local", "builder_host_brake", "on")).toMatchObject({ code: 0, out: "local builder_host_brake: (default) -> on\n" });
    const show = ds(root, "host", "show", "local");
    expect(show.code).toBe(0);
    expect(show.out).toMatch(/^builder_host_brake\s+on\s+host$/m);
    expect(show.out).toMatch(/^machine_load_crit_pct\s+\S+\s+default$/m);
    const json = JSON.parse(ds(root, "host", "show", "local", "--json").out) as { key: string; source: string }[];
    expect(json.find((r) => r.key === "builder_host_brake")?.source).toBe("host");
    const bad = ds(root, "host", "set", "local", "max_builders", "3");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("max_builders is not a host key");
    // ds limits show prints the host key's value and source too.
    const lim = ds(root, "limits", "show", "realp");
    expect(lim.out).toMatch(/^builder_host_brake\s+on\s+host\s/m);
    const refused = ds(root, "limits", "set", "realp", "builder_host_brake", "off");
    expect(refused.code).not.toBe(0);
  });
});

describe("side hosts", () => {
  test("accept gives seats and the brake on; set seats moves hosts.seats; remove drops the rows", () => {
    const s = store();
    sideHost(s, "box-2", 3);
    expect(Object.fromEntries(hostShow(s, "box-2").filter((r) => r.source === "host").map((r) => [r.key, r.value]))).toEqual({ seats: "3", builder_host_brake: "on" });
    sideHost(s, "box-3");
    expect(hostLine(s.db, "box-3", "seats").value).toBe("2");
    setHostKey(s, "box-2", "seats", "5", "op");
    expect(s.get("hosts", { name: "box-2" })?.seats).toBe(5);
    expect(remove(s, "box-2", { by: "op" }).ok).toBe(true);
    expect(s.db.query("SELECT COUNT(*) AS n FROM host_config WHERE host = 'box-2'").get()).toEqual({ n: 0 });
  });

  test("the settings copy carries the host's own rows as `local`, not another host's or main's", () => {
    const main = store();
    setHostKey(main, SELF, "machine_load_crit_pct", "120", "op");
    sideHost(main, "box-2");
    sideHost(main, "box-3");
    setHostKey(main, "box-2", "restart_rss_gb", "6", "op");
    expect(DOWN).toContain("host_config");
    const m = downManifest(main, "box-2");
    const side = store();
    applyDown(side, m);
    const rows = side.db.query("SELECT host, key, value FROM host_config ORDER BY key").all();
    expect(rows).toEqual([
      { host: "local", key: "builder_host_brake", value: "on" },
      { host: "local", key: "restart_rss_gb", value: "6" },
      { host: "local", key: "seats", value: "2" }]);
    expect(loopLimit(side, "realp", "restart_rss_gb")).toBe("6");
    expect(pickLimit(side, "realp", "builder_host_brake")).toBe("on");
  });
});

describe("migration 0064", () => {
  function before0064(): { db: Database; full: string } {
    const full = join(REPO, "bin", "loop", "migrations"), dir = temp();
    for (const f of readdirSync(full)) if (f.endsWith(".sql") && f < "0064") cpSync(join(full, f), join(dir, f));
    const db = new Database(join(temp(), "loop.db"));
    migrate(db, dir);
    return { db, full };
  }

  test("main's brake is on when any project had it on; the project rows stay; accepted hosts get seats and brake", () => {
    const { db, full } = before0064();
    db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('realp', 'limits.conf', 'builder_host_brake', 'on', ?), ('other', 'limits.conf', 'builder_host_brake', 'off', ?)", [T0, T0]);
    db.run("INSERT INTO hosts (name, status, public_key, seats, requested_at) VALUES ('box-2', 'accepted', 'k', 4, ?)", [T0]);
    migrate(db, full);
    expect(db.query("SELECT host, key, value FROM host_config ORDER BY host, key").all()).toEqual([
      { host: "box-2", key: "builder_host_brake", value: "on" },
      { host: "box-2", key: "seats", value: "4" },
      { host: "local", key: "builder_host_brake", value: "on" }]);
    expect((db.query("SELECT COUNT(*) AS n FROM config WHERE key = 'builder_host_brake'").get() as { n: number }).n).toBe(2);
    expect((db.query("SELECT COUNT(*) AS n FROM config_history WHERE actor = 'migration' AND host IS NOT NULL").get() as { n: number }).n).toBe(3);
    db.close();
  });

  test("main's host tidy is apply when any project had it; each cleanup glob key is the union of the projects' lists", () => {
    const { db, full } = before0064();
    const row = (p: string, k: string, v: string) => db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES (?, 'limits.conf', ?, ?, ?)", [p, k, v, T0]);
    row("pa", "host_tidy", "apply"); row("pb", "host_tidy", "report");
    row("pa", "cleanup_tmp_globs", "/tmp/aa-*,/tmp/ab-*"); row("pb", "cleanup_tmp_globs", "/tmp/bb-*"); row("pc", "cleanup_tmp_globs", "-");
    row("pb", "cleanup_trim_globs", "/tmp/cache/v1.*");
    row("pa", "cleanup_tmp_age_h", "24"); row("pb", "cleanup_tmp_age_h", "96"); row("pc", "cleanup_tmp_age_h", "x");
    migrate(db, full);
    expect(db.query("SELECT key, value FROM host_config WHERE host = 'local' ORDER BY key").all()).toEqual([
      { key: "cleanup_tmp_age_h", value: "96" },   // the longest, so retention never shortens
      { key: "cleanup_tmp_globs", value: "/tmp/aa-*,/tmp/ab-* /tmp/bb-*" },
      { key: "cleanup_trim_globs", value: "/tmp/cache/v1.*" },
      { key: "host_tidy", value: "apply" }]);
    db.close();
  });

  test("no project with the brake on: main keeps the default off", () => {
    const { db, full } = before0064();
    db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('realp', 'limits.conf', 'builder_host_brake', 'off', ?), ('realp', 'limits.conf', 'cleanup_tmp_age_h', '12', ?)", [T0, T0]);   // shorter age: not carried
    migrate(db, full);
    expect(db.query("SELECT * FROM host_config").all()).toEqual([]);
    db.close();
  });
});
