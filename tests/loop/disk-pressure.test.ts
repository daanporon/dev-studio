// disk-pressure.test.ts — disk-pressure U3: the disk-pressure reconciler (one Studio alert per project per
// low spell, the 5-point margin, consumer order, the limit off), the disk-usage observer (docker df parse, no
// docker binary, a docker timeout, du over disk_watch_paths) and the alert's clearing through alerts.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import type { Action, Actuator, Reconciler } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import diskPressure from "../../bin/loop/reconcilers/disk-pressure.ts";
import alerts from "../../bin/loop/reconcilers/alerts.ts";
import { diskUsageObserver, type Run } from "../../bin/loop/observers/disk-usage.ts";
import { consumers, parseDockerDf, sizeKb, watchPaths } from "../../bin/loop/squad/disk-pressure.ts";

const T = 1_800_000_000, GB = 1024 * 1024; // kb per GB
const PROJECTS = ["pa", "pb"];
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LIMIT_DISK_CARD_FREE_PCT;
  delete process.env.DS_LIMIT_DISK_WATCH_PATHS;
});
function root(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  for (const p of PROJECTS) mkdirSync(join(d, p, "squads"), { recursive: true });
  const s = open(d);
  stores.push(s);
  importConfig(s, d);
  return s;
}
// `/` at pct free of a 1000 GB disk.
function disk(s: Store, pct: number, path = "/") {
  s.upsert("observed_machine", { host: "h" }, { disks: JSON.stringify([{ path, total_kb: 1000 * GB, free_kb: Math.round(10 * GB * pct) }]), observed_at: T });
}
function docker(s: Store) {
  const row = (key: string, label: string, gb: number, rec: number) => s.upsert("observed_disk_usage", { key }, { label, size_kb: gb * GB, reclaimable_kb: rec * GB, read_at: T, observed_at: T });
  row("docker:build-cache", "Docker build cache", 500, 480);
  row("docker:images", "Docker images", 40, 10);
}
function cleanup(s: Store, project: string, key: string, gb: number, verdict: string, partial = false) {
  s.upsert("observed_cleanup", { project, class: "e", key }, { path: key, size_kb: gb * GB, first_seen: T, verdict, facts: JSON.stringify({ partial }), observed_at: T });
}
function loopOf(s: Store, ...reconcilers: Reconciler[]) {
  const got: Action[] = [];
  const rec: Actuator = { act(a) { got.push(a); } };
  const loop = new Loop(s, { observers: [], reconcilers }, rec, { projects: () => PROJECTS });
  return { tick: async (at: number) => (await loop.tick(at)).acted };
}
const alertsOf = (acted: Action[]) => acted.filter((a) => a.kind === "alert");
const cleared = (acted: Action[]) => acted.filter((a) => a.kind === "alert-clear").map((a) => `${a.project} ${(a.payload as Row).id}`);
function card(s: Store, a: Action) {
  const id = String((a.payload as Row).id);
  s.upsert("observed_alerts", { project: a.project, id },
    { doc: JSON.stringify({ id, asker: "sweep", title: (a.payload as Row).title, question: (a.payload as Row).text, since: new Date(T * 1000).toISOString() }), observed_at: T });
}

describe("the disk-pressure reconciler", () => {
  test("15% free: one card per project, titled with the free space, Docker build cache first", async () => {
    const s = root();
    disk(s, 15); docker(s);
    cleanup(s, "pa", "/tmp/node-compile-cache/v1.a", 30, "removable", true);
    cleanup(s, "pb", "/tmp/old-wt", 2, "dirty");
    const { tick } = loopOf(s, diskPressure);
    const got = alertsOf(await tick(T));
    expect(got.map((a) => a.project).sort()).toEqual(PROJECTS);
    const p = got[0].payload as Row;
    expect(String(p.id)).toMatch(/^sweep-disk-pressure\.\/-[0-9]+$/);
    expect(p.title).toBe("Disk / low: 150 GB free (15%)");
    const text = String(p.text);
    expect(text).toContain("1. Docker build cache: 500 GB (480 GB reclaimable)");
    expect(text.indexOf("Docker build cache")).toBeLessThan(text.indexOf("Docker images"));
    expect(text).toContain("≥ removable");
    expect(text).toContain("docker builder prune");
    expect(alertsOf(await tick(T + 60)), "no repeat").toEqual([]);
  });

  test("22% keeps the card, 26% clears it; a later dip is a new alert id", async () => {
    const s = root();
    disk(s, 15);
    const { tick } = loopOf(s, diskPressure, alerts);
    const first = alertsOf(await tick(T));
    expect(first.length).toBe(2);
    for (const a of first) card(s, a);
    disk(s, 22);
    expect(cleared(await tick(T + 60)), "inside the margin: kept").toEqual([]);
    expect(alertsOf(await tick(T + 61)), "and not raised again").toEqual([]);
    disk(s, 26);
    expect(cleared(await tick(T + 120)).length, "above limit + 5: cleared").toBe(2);
    disk(s, 10);
    const again = alertsOf(await tick(T + 180));
    expect(again.length).toBe(2);
    expect(String((again[0].payload as Row).id)).not.toBe(String((first[0].payload as Row).id));
  });

  test("a disk above the limit raises nothing, and each low disk has its own card", async () => {
    const s = root();
    s.upsert("observed_machine", { host: "h" }, { disks: JSON.stringify([{ path: "/", total_kb: 1000 * GB, free_kb: 500 * GB }, { path: "/data", total_kb: 1000 * GB, free_kb: 100 * GB }]), observed_at: T });
    const { tick } = loopOf(s, diskPressure);
    const got = alertsOf(await tick(T));
    expect(got.map((a) => (a.payload as Row).title).sort()).toEqual(["Disk /data low: 100 GB free (10%)", "Disk /data low: 100 GB free (10%)"]);
  });

  test("disk_card_free_pct 0 raises no card and clears an open one", async () => {
    const s = root();
    process.env.DS_LIMIT_DISK_CARD_FREE_PCT = "0";
    disk(s, 5);
    const { tick } = loopOf(s, diskPressure, alerts);
    expect(alertsOf(await tick(T))).toEqual([]);
    delete process.env.DS_LIMIT_DISK_CARD_FREE_PCT;
    for (const a of alertsOf(await tick(T + 60))) card(s, a);
    process.env.DS_LIMIT_DISK_CARD_FREE_PCT = "0";
    expect(cleared(await tick(T + 120)).length).toBe(2);
  });

  test("no consumer rows yet: the card still opens and says so", async () => {
    const s = root();
    disk(s, 5);
    const text = String((alertsOf(await loopOf(s, diskPressure).tick(T))[0].payload as Row).text);
    expect(text).toContain("No consumer sizes read yet");
  });
});

describe("consumers", () => {
  test("at most 8, biggest first, process rows left out", () => {
    const s = root();
    for (let i = 1; i <= 10; i++) cleanup(s, "pa", `/x/${i}`, i, "removable");
    s.upsert("observed_cleanup", { project: "pa", class: "b", key: "p" }, { pid: 7, size_kb: 900 * GB, first_seen: T, observed_at: T });
    const c = consumers(s);
    expect(c.length).toBe(8);
    expect(c[0].size_kb).toBe(10 * GB);
  });
  test("docker sizes parse in decimal units", () => {
    expect(sizeKb("500GB")).toBe(Math.round(500e9 / 1024));
    expect(sizeKb("480GB (96%)")).toBe(Math.round(480e9 / 1024));
    expect(sizeKb("0B")).toBe(0);
    expect(sizeKb("junk")).toBeNull();
    const rows = parseDockerDf('{"Type":"Images","Size":"40GB","Reclaimable":"10GB (25%)"}\n{"Type":"Build Cache","Size":"500GB","Reclaimable":"480GB"}\n{"Type":"Other","Size":"1GB"}');
    expect(rows.map((r) => r.key)).toEqual(["docker:images", "docker:build-cache"]);
  });
});

describe("the disk-usage observer", () => {
  const ctx = (s: Store, now: number) => ({ store: s, project: "", now, tick: 1 }) as never;
  const df = '{"Type":"Build Cache","Size":"500GB","Reclaimable":"480GB (96%)"}\n{"Type":"Images","Size":"40GB","Reclaimable":"10GB (25%)"}\n';
  const ok: Run = async (cmd) => (cmd[0] === "docker" ? { rc: 0, out: df } : { rc: 0, out: `2048\t${cmd[cmd.length - 1]}\n` });

  test("writes docker rows and a du row per valid watched path", async () => {
    const s = root();
    process.env.DS_LIMIT_DISK_WATCH_PATHS = "/srv/cache /srv/../etc /srv/*glob relative";
    await diskUsageObserver({ run: ok, hasDocker: () => true }).run(ctx(s, T));
    expect(s.get("observed_disk_usage", { key: "docker:build-cache" })?.size_kb).toBe(Math.round(500e9 / 1024));
    expect(s.get("observed_disk_usage", { key: "du:/srv/cache" })?.size_kb).toBe(2048);
    expect(s.db.query("SELECT key FROM observed_disk_usage WHERE key LIKE 'du:%'").all().length).toBe(1);
    expect(s.get("observed_disk_usage", { key: "meta:docker" })?.error).toBeNull();
  });
  test("disk_watch_paths is this host's (ds host set): sized and named on the card; a project row or import is not read", async () => {
    const s = root();
    const ds = (...a: string[]) => Bun.spawnSync([join(import.meta.dir, "..", "..", "bin", "ds"), "--state", s.root, ...a], { stdout: "pipe", stderr: "pipe" });
    const f = join(s.root, "pa.export");
    writeFileSync(f, "#== limits.conf\ndisk_watch_paths /srv/skipped\n");
    expect(ds("config", "import", "--project", "pa", f).exitCode).toBe(0);   // skipped as now per host
    s.upsert("config", { project: "pb", file: "limits.conf", key: "disk_watch_paths" }, { value: "/srv/old", observed_at: T });   // unread
    expect(ds("host", "set", "local", "disk_watch_paths", "/srv/a,/srv/../etc,/srv/b", "/srv/b", "/srv/c").exitCode).toBe(0);
    expect(watchPaths(s)).toEqual(["/srv/a", "/srv/b", "/srv/c"]); // bad path dropped, b once
    const calls: string[] = [];
    await diskUsageObserver({ run: async (c, t) => { calls.push(c[c.length - 1]); return ok(c, t); }, hasDocker: () => false }).run(ctx(s, T));
    expect(calls).toEqual(["/srv/a", "/srv/b", "/srv/c"]);
    disk(s, 15);
    expect(consumers(s).map((c) => c.label)).toEqual(expect.arrayContaining(["/srv/c"]));
    process.env.DS_LIMIT_DISK_WATCH_PATHS = "/srv/env"; // the env value wins alone
    expect(watchPaths(s)).toEqual(["/srv/env"]);
  });
  test("no docker binary: no docker rows, the meta row says so, du still runs", async () => {
    const s = root();
    process.env.DS_LIMIT_DISK_WATCH_PATHS = "/srv/cache";
    const calls: string[] = [];
    await diskUsageObserver({ run: async (c, t) => { calls.push(c[0]); return ok(c, t); }, hasDocker: () => false }).run(ctx(s, T));
    expect(calls).toEqual(["du"]);
    expect(s.db.query("SELECT key FROM observed_disk_usage WHERE key LIKE 'docker:%'").all()).toEqual([]);
    expect(s.get("observed_disk_usage", { key: "meta:docker" })?.error).toBe("no docker binary");
  });
  test("a docker timeout keeps the old rows and records the error", async () => {
    const s = root();
    const obs = diskUsageObserver({ run: ok, hasDocker: () => true });
    await obs.run(ctx(s, T));
    const slow = diskUsageObserver({ run: async (c, t) => (c[0] === "docker" ? null : ok(c, t)), hasDocker: () => true });
    await slow.run(ctx(s, T + 7200));
    expect(s.get("observed_disk_usage", { key: "docker:build-cache" })?.size_kb).toBe(Math.round(500e9 / 1024));
    expect(s.get("observed_disk_usage", { key: "meta:docker" })?.error).toBe("docker system df timed out");
  });
  test("reads once an hour, every 30 min while a spell is open, and never waits for a slow read", async () => {
    const s = root();
    let n = 0;
    const obs = diskUsageObserver({ run: async (c, t) => { if (c[0] === "docker") n++; return ok(c, t); }, hasDocker: () => true });
    await obs.run(ctx(s, T)); await obs.run(ctx(s, T + 1800));
    expect(n).toBe(1);
    s.upsert("episodes", { project: "pa", subject: "disk-pressure./", kind: "disk-pressure" }, { state: "low", started_at: T, episode_key: "1", source: "loop", observed_at: T });
    await obs.run(ctx(s, T + 1800));
    expect(n).toBe(2);
    const hang = diskUsageObserver({ run: () => new Promise(() => {}), hasDocker: () => true, budgetMs: 20 });
    const t0 = Date.now();
    await hang.run(ctx(root(), T));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
