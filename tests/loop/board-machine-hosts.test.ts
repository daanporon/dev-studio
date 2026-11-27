// board-machine-hosts.test.ts — side-loop-host U26: the board's Machine panel has one section per host (main, then
// the accepted side hosts by name), each from that host's own observed_machine, observed_host_procs and
// observed_procs rows; a stale side host shows its age instead of numbers; the tile names the worst host; with no
// side host the data and the page are what they were. The board is built from a small loop.db and mounted.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { open, type Row } from "../../bin/loop/core/store.ts";
import { buildBoard, renderText } from "../../bin/board/board-data.ts";
import { mount } from "./board-mount.ts";

const REPO = join(import.meta.dir, "..", "..");
const NOW = Math.floor(Date.now() / 1000);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardhosts-")); roots.push(root);
  const conv = mkdtempSync(join(tmpdir(), "boardhosts-conv-")); roots.push(conv);
  cpSync(join(REPO, "conventions"), conv, { recursive: true });
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  const s = open(root);
  importConfig(s, root, conv);   // the shipped warn and crit lines
  s.upsert("projects", { label: "p" }, { observed_at: NOW });
  const host = (name: string, status = "accepted") =>
    s.upsert("hosts", { name }, { status, public_key: "k", requested_at: NOW - 900, accepted_at: status === "accepted" ? NOW - 800 : null });
  // One host's three rows, as its observers write them (main's carry its machine name and `local`).
  const sample = (machine: string, load1: number, o: { at?: number; mem_avail_kb?: number; group?: string; busy?: number; loop?: number } = {}) => {
    const at = o.at ?? NOW, side = machine !== "mainbox";
    s.upsert("observed_machine", { host: machine }, { cores: 10, load1, load5: load1, load15: load1, mem_total_kb: 64_000_000, mem_avail_kb: o.mem_avail_kb ?? 48_000_000, swap_total_kb: 0,
      swap_free_kb: 0, psi_cpu_some: 0, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, disks: "[]", groups: "[]", cpu_busy_pct: o.busy ?? 100, observed_at: at });
    s.upsert("observed_host_procs", { host: machine }, { groups: JSON.stringify([{ label: o.group ?? `${machine}-daemon`, procs: 1, rss_kb: 1_000_000, cpu_pct: 5 }]), procs: 1, rss_kb: 1_000_000,
      loop_cpu_pct: o.loop ?? 10, loop_mem_kb: 200_000, loop_source: "tree", observed_at: at });
    const wt = side ? `${machine}::/wt/${machine}` : "local::/wt/main";
    s.upsert("observed_procs", { project: "p", wt }, { host: side ? machine : "local", procs: 3, rss_kb: side ? 3_000_000 : 5_000_000, cpu_pct: side ? 30 : 50, observed_at: at });
  };
  return { s, host, sample, board: () => buildBoard("p", "", root) as any };
}
const labels = (m: any) => m.consumers.map((c: any) => c.label);
const sections = (root: HTMLElement) => [...root.querySelectorAll("#machine .mhost-line b")].map((e) => e.textContent);

test("no side host: no sides or worst, no section headings, a pending host changes nothing", async () => {
  const f = setup();
  f.sample("mainbox", 5);
  const before = f.board().machine;
  expect(before).not.toHaveProperty("sides");
  expect(before).not.toHaveProperty("worst");
  expect(before.host).toBe("mainbox");
  // A join request under main's own machine name hides nothing: only an accepted host owns rows.
  f.host("mainbox", "pending");
  const after = f.board().machine;
  expect(after).toEqual(before);
  const r = await mount(f.board());
  expect(r.errors).toEqual([]);
  expect(r.root.querySelector("#machine")).not.toBeNull();
  expect(r.root.querySelectorAll("#machine .mhost, #machine .mhost-line").length).toBe(0);
  expect(r.root.querySelectorAll(".mhost-name").length).toBe(0);
  expect(r.root.querySelectorAll("#machine .mtop").length).toBe(1);
});

test("side hosts: main first then by name, each from its own rows, newer side rows never become main's", async () => {
  const f = setup();
  f.sample("mainbox", 5, { at: NOW - 20, busy: 200, loop: 100 });
  f.host("zed"); f.host("alpha"); f.host("gone", "removed");
  f.sample("zed", 2, { busy: 300, loop: 40 });
  f.sample("alpha", 3);
  const m = f.board().machine;
  expect(m.host).toBe("mainbox");
  expect(m.load.load1).toBe(5);
  expect(m.sides.map((x: any) => x.host)).toEqual(["alpha", "zed"]);
  expect(labels(m)).toEqual(["left over · main"]);
  expect(m.breakdown.host.groups.map((g: any) => g.label)).toEqual(["mainbox-daemon"]);
  expect(m.total.rss_kb).toBe(5_000_000);
  expect(m.total.busy_cores).toBe(2);
  expect(m.loop.cpu_cores).toBe(1);
  const zed = m.sides[1];
  expect(zed.load.load1).toBe(2);
  expect(labels(zed)).toEqual(["left over · zed"]);
  expect(zed.breakdown.host.groups.map((g: any) => g.label)).toEqual(["zed-daemon"]);
  expect(zed.total.rss_kb).toBe(3_000_000);
  expect(zed.total.busy_cores).toBe(3);
  expect(zed.loop.cpu_cores).toBe(0.4);
  // All levels ok: main keeps the tile.
  expect(m.worst).toMatchObject({ host: "main", level: "ok" });
  expect(renderText(f.board())).toContain("MACHINE  load 5");

  const r = await mount(f.board());
  expect(r.errors).toEqual([]);
  expect(sections(r.root)).toEqual(["main", "alpha", "zed"]);
  expect(r.root.querySelectorAll("#machine .mtop").length).toBe(3);
  expect(r.root.querySelectorAll("#machine .ucard").length).toBe(3);
  const alpha = r.root.querySelector("#machine .mhost")!;
  expect(alpha.querySelector(".mhost-line")!.textContent).toContain("load 0.3× cores");
  expect(alpha.querySelector(".mhost-line")!.textContent).toContain("mem 25%");
  expect(alpha.querySelector(".mtop")!.textContent).toContain("left over · alpha");
  expect(alpha.querySelector(".mtop")!.textContent).not.toContain("zed");
});

test("the tile and summary name the worst host; a stale side host shows its age and never counts", async () => {
  const f = setup();
  f.sample("mainbox", 5);
  f.host("alpha"); f.host("beta"); f.host("newbie");
  f.sample("alpha", 16);                          // 160% of 10 cores: past the 150% crit line
  f.sample("beta", 90, { at: NOW - 600 });        // far worse, but ten minutes old
  const m = f.board().machine;
  expect(m.worst).toMatchObject({ host: "alpha", level: "crit" });
  const beta = m.sides.find((x: any) => x.host === "beta");
  expect(beta).toMatchObject({ stale: true, observed_at: NOW - 600 });
  expect(beta.age_s).toBeGreaterThanOrEqual(600);
  for (const k of ["load", "mem", "consumers", "breakdown", "card"]) expect(beta).not.toHaveProperty(k);
  expect(m.sides.find((x: any) => x.host === "newbie")).toMatchObject({ stale: true, observed_at: null, age_s: null });

  const r = await mount(f.board());
  expect(r.errors).toEqual([]);
  const name = r.root.querySelector(".mhost-name")!;
  expect(name.textContent).toBe("alpha");
  const t = name.closest(".tile")!.textContent!;
  expect(t).toContain("Machine");
  expect(t).toContain("1.6×");
  expect(r.root.querySelector("#machine > summary")!.textContent).toContain("alpha · load 1.6× cores");
  const hosts = [...r.root.querySelectorAll("#machine .mhost")];
  expect(hosts.map((h) => h.querySelector("b")!.textContent)).toEqual(["alpha", "beta", "newbie"]);
  expect(hosts[1].textContent).toBe("beta no fresh sample: last one 10m ago");
  expect(hosts[2].textContent).toBe("newbie no sample yet");
  expect(hosts[1].querySelector(".mtop, .ucard")).toBeNull();
});

test("each section is levelled by its own host's lines, never main's (U25's per-host machine keys)", () => {
  const f = setup();
  const line = (host: string, value: string) => f.s.upsert("host_config", { host, key: "machine_load_crit_pct" }, { value, set_at: NOW });
  f.sample("mainbox", 12);                        // 120% of 10 cores: warn on the shipped lines (100 / 150)
  f.host("alpha"); f.sample("alpha", 12);
  expect(f.board().machine.sides[0].load.level).toBe("warn");
  line("alpha", "110");
  let m = f.board().machine;
  expect([m.load.level, m.sides[0].load.level]).toEqual(["warn", "crit"]);
  expect(m.worst).toMatchObject({ host: "alpha", level: "crit" });
  f.s.db.query("DELETE FROM host_config WHERE host = 'alpha'").run();
  line("local", "110");
  m = f.board().machine;
  expect([m.load.level, m.sides[0].load.level]).toEqual(["crit", "warn"]);
  expect(m.worst).toMatchObject({ host: "main", level: "crit" });
});
