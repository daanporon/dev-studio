// lanes.ts — lane records of finished units and the report over them (light-lane plan U5).
// recordLane runs in the unit-done path; laneRules/laneReport serve `ds lanes` and bin/role/lane-rules.sh.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Row, Store } from "../core/store.ts";

export type LaneRule = { id: string; lane: "light" | "normal"; when: string; evidence: string };

// `- <id>: light|normal — <when it applies> — <evidence>`
export function parseRules(text: string): LaneRule[] {
  const out: LaneRule[] = [];
  for (const l of text.split("\n")) {
    const m = l.match(/^- ([A-Za-z0-9][A-Za-z0-9._-]*): (light|normal) — (.*?)(?: — (.*))?$/);
    if (m) out.push({ id: m[1], lane: m[2] as "light" | "normal", when: m[3], evidence: m[4] ?? "" });
  }
  return out;
}
export function rulesFile(root: string, label: string): string { return join(root, label, "lanes.md"); }
export function laneRules(root: string, label: string): LaneRule[] {
  const f = rulesFile(root, label);
  return existsSync(f) ? parseRules(readFileSync(f, "utf8")) : [];
}

// The distinct top-level folders of a PR doc's `files` ("." for a file in the repo root), sorted.
export function topFolders(prDoc: unknown): string[] {
  let d: any = prDoc;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { return []; } }
  const nodes: any[] = Array.isArray(d?.files?.nodes) ? d.files.nodes : [];
  const set = new Set<string>();
  for (const n of nodes) if (typeof n?.path === "string" && n.path) set.add(n.path.includes("/") ? n.path.slice(0, n.path.indexOf("/")) : ".");
  return [...set].sort();
}

// The unit's lane record, written once its PR merged. Idempotent: a re-run refreshes the same row.
export function recordLane(store: Store, unit: Row, prDoc: unknown, prNumber: number | null, at: number): void {
  const project = String(unit.project), squad = String(unit.squad), slug = String(unit.slug);
  let doc: Row = {};
  try { doc = typeof unit.doc === "string" ? JSON.parse(unit.doc) : (unit.doc as Row) ?? {}; } catch { /* no doc */ }
  const cpu = store.db.query("SELECT cpu_s, peak_cpu_pct FROM unit_cpu WHERE project = ? AND squad = ? AND slug = ?").get(project, squad, slug) as { cpu_s: number; peak_cpu_pct: number | null } | null;
  const moved = !!store.db.query("SELECT 1 FROM events WHERE kind = 'unit_lane_moved' AND project = ? AND squad = ? AND unit = ?").get(project, squad, slug);
  store.upsert("unit_lanes", { project, squad, slug }, {
    lane: doc.lane === "light" ? "light" : "normal", lane_rule: (doc.lane_rule as string) || null,
    cpu_s: Number(cpu?.cpu_s ?? 0), peak_cpu_pct: cpu?.peak_cpu_pct ?? null, moved: moved ? 1 : 0,
    folders: JSON.stringify(topFolders(prDoc)), pr: prNumber, done_at: at,
  });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

export type LaneReport = {
  rules: { id: string; lane: string; when: string; evidence: string; units: number; moved: number; median_cpu_h: number }[];
  folders: { folder: string; units: number; median_cpu_h: number }[];
};

// Per rule (the file's, then any rule only the records name): its units, how many moved (misses), median
// CPU-hours. Per top-level folder: median CPU-hours over the unmarked units (no rule, not tagged light).
export function laneReport(store: Store, root: string, project: string): LaneReport {
  const rows = store.db.query("SELECT * FROM unit_lanes WHERE project = ? ORDER BY done_at, slug").all(project) as Row[];
  const h = (r: Row) => Number(r.cpu_s ?? 0) / 3600;
  const known = laneRules(root, project);
  const ids = [...known.map((r) => r.id), ...new Set(rows.map((r) => r.lane_rule as string).filter((x) => x && !known.some((k) => k.id === x)))];
  const rules = ids.map((id) => {
    const k = known.find((r) => r.id === id), mine = rows.filter((r) => r.lane_rule === id);
    return { id, lane: k?.lane ?? "(not in lanes.md)", when: k?.when ?? "", evidence: k?.evidence ?? "", units: mine.length,
      moved: mine.filter((r) => r.moved).length, median_cpu_h: r2(median(mine.map(h))) };
  });
  const byFolder = new Map<string, number[]>();
  for (const r of rows) {
    if (r.lane_rule || r.lane === "light") continue;
    let fs: string[] = [];
    try { fs = JSON.parse(String(r.folders ?? "[]")); } catch { /* none */ }
    for (const f of fs) byFolder.set(f, [...(byFolder.get(f) ?? []), h(r)]);
  }
  const folders = [...byFolder].map(([folder, xs]) => ({ folder, units: xs.length, median_cpu_h: r2(median(xs)) }))
    .sort((a, b) => a.median_cpu_h - b.median_cpu_h || a.folder.localeCompare(b.folder));
  return { rules, folders };
}

export function formatReport(label: string, rep: LaneReport): string {
  const L: string[] = [`lane rules for ${label} (state/${label}/lanes.md):`];
  if (!rep.rules.length) L.push("  (no rules yet — add one with bin/role/lane-rules.sh " + label + " add <id> light \"<when>\" \"<evidence>\")");
  for (const r of rep.rules) L.push(`  ${r.id}: ${r.units} unit${r.units === 1 ? "" : "s"}, ${r.moved} moved, median ${r.median_cpu_h} CPU-h${r.units === 0 ? " (no finished unit yet)" : ""} [${r.lane}]`);
  L.push("unmarked units, median CPU-h per top-level folder:");
  if (!rep.folders.length) L.push("  (no finished unmarked unit with a recorded PR yet)");
  for (const f of rep.folders) L.push(`  ${f.folder}: median ${f.median_cpu_h} CPU-h over ${f.units} unit${f.units === 1 ? "" : "s"}`);
  return L.join("\n") + "\n";
}
