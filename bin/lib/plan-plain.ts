// plan-plain.ts — the plan's plain section, pure (no side effects at load).
//
// A plan carries `## In plain words` near the top: five list lines, each `- **<Label>:** <text>` (conventions/plan-shape.md).
// `ask-operator` (the refusal) and the board (the display) both read it here, so they never disagree.
//   plainSection(markdown)  -> {lines, missing} | null   (null: no such heading)
//   planFallback(markdown)  -> [{label, text}] | null    (the **PROBLEM:** / **DONE:** lines, for a plan without the section)
//   planPlain(markdown)     -> {plain, plain_from}       (what the board shows: the section when complete, else the fallback, else null)

export const PLAIN_HEADING = "In plain words";
export const PLAIN_LABELS = ["What you get", "Steps", "Risky or can't be undone", "Cost and time", "You are approving"] as const;
export type PlainLine = { label: string; text: string };

// Label comparison ignores case, a trailing colon and the curly apostrophe.
// One shared label-line pattern: `- **Label:** text`, `* **Label:** text` or `**Label:** text` (the dash is optional).
const LABEL_LINE = /^(?:[-*]\s+)?\*\*(.+?)\*\*\s*:?\s*(.*)$/;
export const LABEL_FORM = (label: string) => `- **${label}:** …`;
const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[:\s]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
const CANON = new Map<string, string>(PLAIN_LABELS.map((l) => [norm(l), l]));

// The lines under the heading, up to the next heading of level 1 or 2.
export function plainSection(markdown: string): { lines: PlainLine[]; missing: string[] } | null {
  const src = markdown.split("\n");
  const at = src.findIndex((l) => /^##\s+/.test(l) && norm(l.replace(/^##\s+/, "")) === norm(PLAIN_HEADING));
  if (at < 0) return null;
  const found = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (let i = at + 1; i < src.length && !/^#{1,2}\s/.test(src[i]); i++) {
    if (cur && /^\s+\S/.test(src[i])) { cur.push(src[i].trim()); continue; }
    const m = src[i].match(LABEL_LINE);
    if (m) {
      const label = CANON.get(norm(m[1]));
      // `**Label:** text` has the colon inside the bold; `**Label**: text` outside; both read the same.
      cur = label && !found.has(label) ? [m[2]] : null;
      if (label && cur) found.set(label, cur);
    }
  }
  const lines: PlainLine[] = [];
  const missing: string[] = [];
  for (const l of PLAIN_LABELS) {
    const text = (found.get(l) ?? []).join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push({ label: l, text }); else missing.push(l);
  }
  return { lines, missing };
}

// `**PROBLEM:** …` and `**DONE:** …`: the paragraph after each marker (to the next blank line).
export function planFallback(markdown: string): PlainLine[] | null {
  const src = markdown.split("\n");
  const out: PlainLine[] = [];
  for (const [mark, label] of [["PROBLEM", "Problem"], ["DONE", "Done"]] as const) {
    const at = src.findIndex((l) => new RegExp(`^\\s*(?:[-*]\\s+)?\\*\\*${mark}:?\\*\\*:?`).test(l));
    if (at < 0) continue;
    const parts = [src[at].replace(new RegExp(`^\\s*(?:[-*]\\s+)?\\*\\*${mark}:?\\*\\*:?`), "")];
    for (let i = at + 1; i < src.length && src[i].trim() !== "" && !/^#{1,6}\s/.test(src[i]); i++) parts.push(src[i]);
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push({ label, text });
  }
  return out.length ? out : null;
}

export function planPlain(markdown: string): { plain: PlainLine[] | null; plain_from: "section" | "fallback" | null } {
  const sec = plainSection(markdown);
  if (sec && !sec.missing.length) return { plain: sec.lines, plain_from: "section" };
  const fb = planFallback(markdown);
  return fb ? { plain: fb, plain_from: "fallback" } : { plain: null, plain_from: null };
}

// ---- The revisions section (plan-plan-revisions U1) ----
//   planRevisions(markdown)  -> [{rev, date, reason, lines, missing}] newest first (empty: no `## Revisions` section or no entries)
//   approvedCopyPath(plan)   -> the saved copy's path: `<plan without .md>.approved.md` beside the plan
// An entry is `### Rev <N> — <YYYY-MM-DD> — <short reason>` followed by four list lines, in the order of REVISION_LABELS.
export const REVISIONS_HEADING = "Revisions";
export const REVISION_LABELS = ["What changed", "Why", "Steps touched", "Stays as approved"] as const;
export type Revision = { rev: number; date: string; reason: string; lines: PlainLine[]; missing: string[] };

const REV_CANON = new Map<string, string>(REVISION_LABELS.map((l) => [norm(l), l]));

export function planRevisions(markdown: string): Revision[] {
  const src = markdown.split("\n");
  const at = src.findIndex((l) => /^##\s+/.test(l) && norm(l.replace(/^##\s+/, "")) === norm(REVISIONS_HEADING));
  if (at < 0) return [];
  const out: Revision[] = [];
  let cur: { rev: Revision; found: Map<string, string[]> } | null = null;
  let open: string[] | null = null;
  const close = () => {
    if (!cur) return;
    for (const l of REVISION_LABELS) {
      const text = (cur.found.get(l) ?? []).join(" ").replace(/\s+/g, " ").trim();
      if (text) cur.rev.lines.push({ label: l, text }); else cur.rev.missing.push(l);
    }
    out.push(cur.rev);
    cur = null;
  };
  for (let i = at + 1; i < src.length && !/^#{1,2}\s/.test(src[i]); i++) {
    const h = src[i].match(/^###\s+Rev\s+(\d+)\b\s*(?:[—–-]+\s*(\d{4}-\d{2}-\d{2}))?\s*(?:[—–-]+\s*(.*))?$/i);
    if (h) {
      close();
      cur = { rev: { rev: Number(h[1]), date: h[2] ?? "", reason: (h[3] ?? "").trim(), lines: [], missing: [] }, found: new Map() };
      open = null;
      continue;
    }
    if (!cur) continue;
    if (open && /^\s+\S/.test(src[i])) { open.push(src[i].trim()); continue; }
    const m = src[i].match(LABEL_LINE);
    if (m) {
      const label = REV_CANON.get(norm(m[1]));
      open = label && !cur.found.has(label) ? [m[2]] : null;
      if (label && open) cur.found.set(label, open);
    }
  }
  close();
  return out.sort((a, b) => b.rev - a.rev);
}

export function approvedCopyPath(planPath: string): string {
  return planPath.replace(/\.md$/, "") + ".approved.md";
}
