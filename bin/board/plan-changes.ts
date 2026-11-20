// plan-changes.ts — what changed in a plan since its approved copy (plan-revisions U2, R7, KTD3, KTD4), pure.
// The board's plan question items carry the result as `changes`: the steps added, removed or changed (with the
// live state of the matching squad unit), the other changed parts by section, the parts the revision note does
// not cover, and the line diff grouped by section. `## In plain words` and `## Revisions` are left out of all
// four (the note is the revision, the plain lines have their own card). Never throws: the caller wraps it.

import { UNIT_LINE, parsePlanLine } from "../loop/squad/plan-lines.ts";
import type { Revision } from "../lib/plan-plain.ts";

export type StepChange = { id: string; title: string; kind: "added" | "removed" | "changed"; state: string };
export type DiffLine = { t: "+" | "-"; text: string };
// `unit` ("U1 — <title>") is set when the lines sit under a unit line; those lines group under it inside their section.
export type DiffSection = { heading: string; unit?: string; lines: DiffLine[] };
export type PlanChanges = {
  steps: StepChange[]; sections: string[]; uncovered: { kind: "step" | "section"; name: string }[];
  diff: DiffSection[]; changed_lines: number; truncated: boolean;
};

export const DIFF_CAP = 400;
const SKIP = new Set(["in plain words", "revisions"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => [...new Set(norm(s).split(" ").filter((w) => w.length >= 3))];

type Row = { text: string; section: string; unit: string | null };

// Each line with its `## ` section and, for a unit line and its indented body, the unit id.
function rows(md: string): Row[] {
  const out: Row[] = [];
  let section = "(top)", unit: string | null = null, fence = false;
  for (const [i, text] of md.split("\n").entries()) {
    if (/^\s*```/.test(text)) fence = !fence;
    if (!fence) {
      const h = text.match(/^##\s+(.*?)\s*$/);
      if (h) { section = h[1]; unit = null; }
      else if (UNIT_LINE.test(text)) {
        try { unit = parsePlanLine(i + 1, text).id; } catch { unit = null; }
      } else if (unit && !/^\s+\S/.test(text)) unit = null;
    }
    out.push({ text, section, unit });
  }
  return out;
}

// Plain line LCS on what is left after the common head and tail. Returns the ops in order: " ", "-", "+".
function lineDiff(a: string[], b: string[]): { t: " " | "-" | "+"; ai: number; bi: number }[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  const ops: { t: " " | "-" | "+"; ai: number; bi: number }[] = [];
  for (let i = 0; i < s; i++) ops.push({ t: " ", ai: i, bi: i });
  if (n * m > 25_000_000) { // too large to align: the whole middle counts as replaced
    for (let i = 0; i < n; i++) ops.push({ t: "-", ai: s + i, bi: -1 });
    for (let j = 0; j < m; j++) ops.push({ t: "+", ai: -1, bi: s + j });
  } else {
    const w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = a[s + i] === b[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[s + i] === b[s + j]) { ops.push({ t: " ", ai: s + i, bi: s + j }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { ops.push({ t: "-", ai: s + i, bi: -1 }); i++; }
      else { ops.push({ t: "+", ai: -1, bi: s + j }); j++; }
    }
    for (; i < n; i++) ops.push({ t: "-", ai: s + i, bi: -1 });
    for (; j < m; j++) ops.push({ t: "+", ai: -1, bi: s + j });
  }
  for (let k = 0; ea + k < a.length; k++) ops.push({ t: " ", ai: ea + k, bi: eb + k });
  return ops;
}

type Block = { id: string; title: string; body: string };
function blocks(rs: Row[]): Map<string, Block> {
  const out = new Map<string, Block>();
  for (const r of rs) {
    if (!r.unit) continue;
    const cur = out.get(r.unit);
    if (cur) cur.body += "\n" + r.text.trim();
    else {
      let title = r.unit;
      try { title = parsePlanLine(1, r.text).title || r.unit; } catch { /* keep the id */ }
      out.set(r.unit, { id: r.unit, title, body: r.text.trim() });
    }
  }
  return out;
}

// units: the squad's unit rows (`plan`, `plan_unit`, `status`, `pr`), for the live state of each step.
export function planChanges(plan: string, copy: string, planPath: string, revision: Revision | null, units: any[]): PlanChanges {
  const now = rows(plan), old = rows(copy);
  const nb = blocks(now), ob = blocks(old);
  const base = planPath.slice(planPath.lastIndexOf("/") + 1);
  const stateOf = (id: string) => {
    const u = units.find((x) => String(x?.plan ?? "").split("/").pop() === base && x?.plan_unit === id);
    const s = String(u?.status ?? "");
    return !u ? "not started" : s === "done" ? "merged" : s === "cancelled" ? "cancelled"
      : s === "dispatched" ? (String(u?.pr ?? "") ? "PR open" : "in progress") : "not started";
  };
  const steps: StepChange[] = [];
  for (const [id, b] of nb) {
    const o = ob.get(id);
    if (!o) steps.push({ id, title: b.title, kind: "added", state: stateOf(id) });
    else if (o.body !== b.body) steps.push({ id, title: b.title, kind: "changed", state: stateOf(id) });
  }
  for (const [id, o] of ob) if (!nb.has(id)) steps.push({ id, title: o.title, kind: "removed", state: stateOf(id) });

  const ops = lineDiff(old.map((r) => r.text), now.map((r) => r.text));
  const diff: DiffSection[] = [];
  const parts = new Set<string>();
  let count = 0, truncated = false;
  for (const op of ops) {
    if (op.t === " ") continue;
    const r = op.t === "-" ? old[op.ai] : now[op.bi];
    if (SKIP.has(norm(r.section))) continue;
    if (!r.unit && r.text.trim() === "") continue;
    if (!r.unit) parts.add(r.section);
    count++;
    if (count > DIFF_CAP) { truncated = true; continue; }
    const unit = r.unit ? `${r.unit} — ${(nb.get(r.unit) ?? ob.get(r.unit))?.title ?? r.unit}` : undefined;
    let sec = diff.find((d) => d.heading === r.section && d.unit === unit);
    if (!sec) diff.push(sec = unit ? { heading: r.section, unit, lines: [] } : { heading: r.section, lines: [] });
    sec.lines.push({ t: op.t, text: r.text });
  }
  const sections = [...parts];

  const note = revision ? revision.lines.concat([{ label: "reason", text: revision.reason }]) : [];
  const touched = new Set(words(note.find((l) => l.label === "Steps touched")?.text ?? ""));
  const noteWords = new Set(words(note.map((l) => l.text).join(" ")));
  const uncovered: PlanChanges["uncovered"] = [];
  for (const s of revision ? steps : []) {
    const tw = words(s.title);
    const need = Math.min(2, tw.length);
    if (need > 0 && tw.filter((w) => touched.has(w)).length < need) uncovered.push({ kind: "step", name: s.title });
  }
  for (const h of revision ? sections : []) {
    const hw = words(h);
    if (hw.length && !hw.every((w) => noteWords.has(w))) uncovered.push({ kind: "section", name: h });
  }
  return { steps, sections, uncovered, diff, changed_lines: count, truncated };
}
