// machine-level.ts — the host's levels (ok|warn|crit) from the latest observed_machine row and the
// machine_*_warn/crit limits (conventions/limits.conf). One function for the board's machine panel
// (bin/board/board-data.ts) and the Builder host brake (bin/loop/capacity/pick.ts, builder_host_brake), so the
// colour an operator sees and the brake can never disagree. Pure: the caller passes the row, how it
// reads a line (`Line`: a whole number or null = no line) and the time.

export type Line = (key: string) => number | null;
export type MachineRow = Record<string, unknown>;
export const LVL: Record<string, number> = { ok: 0, warn: 1, crit: 2 };
export const worst = (...l: string[]) => l.reduce((a, b) => (LVL[b] > LVL[a] ? b : a), "ok");

// The machine observer's cadence (DS_LOOP_MACHINE_S, default 30 s); a sample older than three of
// them is stale: the board says so and the brake ignores it.
export const machineCadence = () => (Number(process.env.DS_LOOP_MACHINE_S) > 0 ? Number(process.env.DS_LOOP_MACHINE_S) : 30);
export const machineStale = (observedAt: number, now: number) => now - observedAt > 3 * machineCadence();

// A metric's level: warn/crit keys are machine_<m>_warn_pct (psi: machine_psi_warn, sfx ""), read at
// their raw value. No value, or no line, is ok.
export const levelOf = (line: Line) => (v: number | null, m: string, sfx = "_pct"): string => {
  if (v == null) return "ok";
  const c = line(`machine_${m}_crit${sfx}`), w = line(`machine_${m}_warn${sfx}`);
  return c != null && v >= c ? "crit" : w != null && v >= w ? "warn" : "ok";
};

const num = (x: unknown) => (x == null ? null : Number(x));
const psiOf = (...v: unknown[]) => { const m = v.map(num).filter((x): x is number => x != null); return m.length ? Math.max(...m) : null; };

// Load, memory, swap and pressure of one sample, each with its level. Disks are the board's own (it
// colours them with levelOf); the brake leaves them out.
export function machineLevels(r: MachineRow, line: Line) {
  const level = levelOf(line);
  const cores = num(r.cores), load1 = num(r.load1);
  const loadPct = cores && load1 != null ? load1 / cores * 100 : null;
  const memTotal = num(r.mem_total_kb), memAvail = num(r.mem_avail_kb);
  const memPct = memTotal && memAvail != null ? (memTotal - memAvail) / memTotal * 100 : null;
  const swapTotal = num(r.swap_total_kb), swapFree = num(r.swap_free_kb);
  const swapPct = swapTotal && swapFree != null ? (swapTotal - swapFree) / swapTotal * 100 : null; // no swap = ok, never a division
  // PSI avg10 per resource (the worse of some/full).
  const psi = ([["cpu", psiOf(r.psi_cpu_some)], ["mem", psiOf(r.psi_mem_some, r.psi_mem_full)], ["io", psiOf(r.psi_io_some, r.psi_io_full)]] as [string, number | null][])
    .map(([kind, avg10]) => ({ kind, avg10, level: level(avg10, "psi", "") }));
  // Full swap alone is not an emergency: Linux leaves idle pages there long after a squeeze. Crit needs the host stalling on memory too
  // (PSI mem at or above machine_psi_warn); without PSI data the plain fill level stands.
  const memPsi = psi[1].avg10;
  let swapLevel = level(swapPct, "swap");
  if (swapLevel === "crit" && memPsi != null && memPsi < (line("machine_psi_warn") ?? 10)) swapLevel = "warn";
  return { cores, load1, loadPct, memTotal, memAvail, memPct, swapTotal, swapPct, psi, lv: { load: level(loadPct, "load"), mem: level(memPct, "mem"), swap: swapLevel } };
}

// The first crit line a fresh sample crosses — load, memory, swap, then cpu/mem/io pressure — as
// `<metric> <value> ≥ crit <line>`; null when none is crossed, or the sample is missing or stale.
export function hostCrit(r: MachineRow | null, line: Line, now: number): string | null {
  if (!r || r.observed_at == null || machineStale(Number(r.observed_at), now)) return null;
  const m = machineLevels(r, line), rd = (v: number) => Math.round(v * 10) / 10;
  const crossed: [string, number | null, string, string][] = [
    ["load", m.loadPct, m.lv.load, "machine_load_crit_pct"], ["mem", m.memPct, m.lv.mem, "machine_mem_crit_pct"], ["swap", m.swapPct, m.lv.swap, "machine_swap_crit_pct"],
    ...m.psi.map((p) => [`psi ${p.kind}`, p.avg10, p.level, "machine_psi_crit"] as [string, number | null, string, string]),
  ];
  const hit = crossed.find(([, v, level]) => v != null && level === "crit");
  if (!hit) return null;
  const pct = hit[3].endsWith("_pct") ? "%" : "";
  return `${hit[0]} ${rd(hit[1]!)}${pct} ≥ crit ${line(hit[3])}${pct}`;
}
