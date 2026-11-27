// disk-pressure.ts — the facts behind the disk-pressure Studio card (disk-pressure U3), shared by the
// reconciler (bin/loop/reconcilers/disk-pressure.ts) and the board's DISK line: the disks the machine
// observer lists, what each is down to, and the consumers (Docker, cleanup rows, disk_watch_paths) a card names.
import { homedir } from "node:os";
import { posix } from "node:path";
import type { Store } from "../core/store.ts";
import { limitEnv, limitInt } from "../settings/limits.ts";
import { hostLine, SELF } from "../../lib/host-settings.ts";

export const KIND = "disk-pressure";
export const MARGIN_PCT = 5;           // a spell closes only above the limit plus these points
export const MAX_CONSUMERS = 8;
export const keyOf = (path: string) => `disk-pressure.${path}`;
export const limitOf = (store: Store, project: string) => limitInt(store, project, "disk_card_free_pct", 20);

export type Disk = { path: string; total_kb: number; free_kb: number; free_pct: number };
export type Consumer = { label: string; size_kb: number; note: string };

// The newest machine row's disks, each with its free share (a disk with no size is skipped).
export function disksOf(store: Store): Disk[] {
  const r = store.db.query("SELECT disks FROM observed_machine ORDER BY observed_at DESC LIMIT 1").get() as { disks: string | null } | null;
  if (!r?.disks) return [];
  try {
    return (JSON.parse(r.disks) as { path: string; total_kb: number; free_kb: number }[])
      .filter((d) => d && typeof d.path === "string" && d.total_kb > 0 && Number.isFinite(d.free_kb))
      .map((d) => ({ ...d, free_pct: (d.free_kb / d.total_kb) * 100 }));
  } catch { return []; }
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
// docker's "500GB", "1.2kB", "0B", "480GB (96%)" → kilobytes (docker prints decimal units); null when unreadable.
export function sizeKb(s: unknown): number | null {
  const m = String(s ?? "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)/i);
  const u = m ? UNITS[m[2].toLowerCase()] : undefined;
  return m && u ? Math.round((Number(m[1]) * u) / 1024) : null;
}

// `docker system df --format json` (one object per line, or an array): Type, Size, Reclaimable.
export function parseDockerDf(out: string): { key: string; label: string; size_kb: number; reclaimable_kb: number | null }[] {
  const rows: any[] = [];
  const t = out.trim();
  try { const j = JSON.parse(t); if (Array.isArray(j)) rows.push(...j); else if (j && typeof j === "object") rows.push(j); }
  catch { for (const l of t.split("\n")) { try { rows.push(JSON.parse(l)); } catch { /* not a row */ } } }
  const names: Record<string, string> = { "build cache": "build-cache", images: "images", "local volumes": "volumes", containers: "containers" };
  const out2: { key: string; label: string; size_kb: number; reclaimable_kb: number | null }[] = [];
  for (const r of rows) {
    const type = String(r?.Type ?? "").trim(), id = names[type.toLowerCase()], size = sizeKb(r?.Size);
    if (!id || size == null) continue;
    const label = id === "volumes" ? "Docker volumes" : `Docker ${type.toLowerCase()}`;
    out2.push({ key: `docker:${id}`, label, size_kb: size, reclaimable_kb: sizeKb(r?.Reclaimable) });
  }
  return out2;
}

// disk_watch_paths: absolute, no `..`, no wildcard; a leading ~/ is the home. A host key (U25): the env value, else this
// host's override, else the default; each path checked on its own, so a bad one costs only itself. No project row is read.
export function watchPaths(store: Store): string[] {
  // A host key (U25, KTD16): this host's line (env, its override, the default), never a project's row.
  const line = hostLine(store.db, SELF, "disk_watch_paths", limitEnv("disk_watch_paths")).value;
  const lines = line ? [line] : [];
  const out: string[] = [];
  for (const line of lines) for (const raw of line.split(/[,\s]+/).filter(Boolean)) {
    if (raw === "-") continue;
    const p = raw.startsWith("~/") ? posix.join(homedir(), raw.slice(2)) : raw;
    if (!p.startsWith("/") || p.split("/").includes("..") || /[*?\[]/.test(p)) continue;
    const n = posix.normalize(p);
    if (n !== "/" && !out.includes(n)) out.push(n);
  }
  return out;
}

export const human = (kb: number) => {
  const gb = kb / 1024 / 1024;
  return gb >= 1 ? `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB` : `${Math.max(0, Math.round(kb / 1024))} MB`;
};

// At most MAX_CONSUMERS, biggest first: Docker rows, the live cleanup rows of every project, the watched paths.
export function consumers(store: Store): Consumer[] {
  const all: Consumer[] = [];
  for (const r of store.db.query("SELECT label, size_kb, reclaimable_kb FROM observed_disk_usage WHERE key LIKE 'docker:%' AND size_kb > 0").all() as { label: string; size_kb: number; reclaimable_kb: number | null }[])
    all.push({ label: r.label, size_kb: r.size_kb, note: r.reclaimable_kb != null ? `${human(r.reclaimable_kb)} reclaimable` : "" });
  for (const r of store.db.query("SELECT project, class, key, path, size_kb, verdict, facts FROM observed_cleanup WHERE gone_at IS NULL AND pid IS NULL AND size_kb > 0").all() as
    { project: string; class: string; key: string; path: string | null; size_kb: number; verdict: string | null; facts: string | null }[]) {
    let partial = false;
    try { partial = !!JSON.parse(r.facts ?? "{}").partial; } catch { /* no facts */ }
    const where = r.class === "f" ? `trim ${r.key}` : r.class === "e" ? r.key : r.path ?? r.key; // a glob's row: its glob, not its parent
    all.push({ label: `Host tidy ${where}${r.project ? ` (${r.project})` : ""}`, size_kb: r.size_kb, note: `${partial ? "≥ " : ""}${r.verdict ?? "not judged"}` });
  }
  for (const r of store.db.query("SELECT label, size_kb FROM observed_disk_usage WHERE key LIKE 'du:%' AND size_kb > 0").all() as { label: string; size_kb: number }[])
    all.push({ label: r.label, size_kb: r.size_kb, note: "" });
  return all.sort((a, b) => b.size_kb - a.size_kb).slice(0, MAX_CONSUMERS);
}
export const consumerLine = (c: Consumer) => `${c.label}: ${human(c.size_kb)}${c.note ? ` (${c.note})` : ""}`;
export const pctText = (d: Disk) => `${Math.round(d.free_pct)}%`;
export const titleOf = (d: Disk) => `Disk ${d.path} low: ${human(d.free_kb)} free (${pctText(d)})`;
