// ds squad-spent-ts — each squad's spend since it started, for the board (U222):
// what bin/lib/squad-spent.sh runs. Writes state/<label>/loop/squad-spent.tsv; prints nothing.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stateRoot, readJson, globJson } from "../lib/shared";
import { tokenUsage } from "./token-usage-ts";

export const help = `<label> [--dir <claude-projects-dir>] — each squad's spend since it started, into state/<label>/loop/squad-spent.tsv (squad-spent.sh)`;

function sinceOf(file: string): string {
  const d = readJson(file);
  let min: number | undefined;
  if (d && typeof d === "object" && Array.isArray(d.members)) {
    for (const m of d.members) {
      const s = m && typeof m === "object" ? m.since : undefined;
      if (s === null || s === undefined || s === false) continue;
      if (typeof s !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s)) continue;
      const e = Date.parse(s) / 1000;
      if (Number.isNaN(e)) continue;
      if (min === undefined || e < min) min = e;
    }
  }
  if (min !== undefined) return String(Math.trunc(min));
  try { return String(Math.floor(statSync(file).mtimeMs / 1000)); } catch { return "0"; }
}


export async function run(argv: string[]): Promise<number> {
  const label = argv[0] ?? "";
  if (!label) { console.error("usage: squad-spent.sh <label> [--dir <claude-projects-dir>]"); return 2; }
  let dir = process.env.DS_TOKEN_DIR || join(process.env.HOME ?? "", ".claude", "projects");
  for (let i = 1; i < argv.length;) {
    if (argv[i] === "--dir") { dir = argv[i + 1] ?? ""; i += 2; }
    else { console.error(`squad-spent: unknown argument ${argv[i]}`); return 2; }
  }
  const root = stateRoot();
  const out = join(root, label, "loop", "squad-spent.tsv");
  mkdirSync(join(root, label, "loop"), { recursive: true });
  if (!existsSync(out)) writeFileSync(out, "");

  // <topic>\t<since>\t<frozen>: archived first, then live; a later row for a topic wins.
  const list: string[] = [];
  for (const f of globJson(join(root, label, "archive"))) {
    const d = readJson(f);
    const t = d && typeof d === "object" && d.topic !== null && d.topic !== undefined && d.topic !== false ? String(d.topic) : "";
    list.push(`${t}\t${sinceOf(f)}\t1`);
  }
  for (const f of globJson(join(root, label, "squads"))) list.push(`${basename(f, ".json")}\t${sinceOf(f)}\t0`);
  const byTopic = new Map<string, string>();
  for (const l of list) { const t = l.split("\t")[0]; if (t !== "") byTopic.set(t, l); }
  const scan = byTopic.size
    ? Bun.spawnSync(["sort"], { stdin: new TextEncoder().encode([...byTopic.values()].join("\n") + "\n") }).stdout.toString().split("\n").filter((l) => l !== "")
    : [];

  const existing = readFileSync(out, "utf8").split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
  const frozenRow = (t: string) => existing.find((r) => r[0] === t && r[7] === "1");
  const rowText = (t: string) => existing.filter((r) => r[0] === t).map((r) => r.join("\t"));

  let need: number | null = null;
  for (const l of scan) {
    const [topic, since, frozen] = l.split("\t");
    if (frozen === "1" && frozenRow(topic)) continue;
    if (need === null || Number(since) < need) need = Number(since);
  }
  if (need === null) return 0;

  const table = tokenUsage({ days: 7, since: String(need), dir, byWorker: true, top: 0 }).split("\n").filter((l) => l !== "");
  const named = ((process.env.DS_PREFIX ?? "ds-") + label).replace(/[^A-Za-z0-9]/g, "-");
  const lbl = `-${named}-`;
  const rows = table.slice(1).map((l) => l.split("\t"));
  const spentRow = (topic: string): string => {
    let tot = 0;
    const s: Record<string, number> = { lead: 0, thinker: 0, builder: 0, other: 0 };
    for (const f of rows) {
      if (f[1] !== topic || !f[0].includes(lbl) || f[3] === "<synthetic>") continue;
      const n = (i: number) => Number(f[i - 1]) || 0;
      const cw = n(11) + n(12) > 0 ? n(11) * 2 + n(12) * 1.25 + (n(7) - n(11) - n(12) > 0 ? (n(7) - n(11) - n(12)) * 1.25 : 0) : n(7) * 1.25;
      const v = cw + n(8) * (/opus/.test(f[3]) ? 0.05 : 0.1) + n(9) * 5 + n(6);
      const r = f[2] === "lead" || f[2] === "thinker" || f[2] === "builder" ? f[2] : "other";
      s[r] += v; tot += v;
    }
    const d = (x: number) => String(Math.trunc(x));
    return [d(tot), d(s.lead), d(s.thinker), d(s.builder), d(s.other)].join("\t");
  };
  let body = "";
  for (const l of scan) {
    const [topic, since, frozen] = l.split("\t");
    if (frozenRow(topic)) { for (const r of rowText(topic)) body += r + "\n"; continue; }
    body += `${topic}\t${since}\t${spentRow(topic)}\t${frozen}\n`;
  }
  writeFileSync(out + ".tmp", body);
  renameSync(out + ".tmp", out);
  return 0;
}
