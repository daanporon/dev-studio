// derive.ts — the one shared rule (U94) for a squad doc's derived lists:
// worktrees[]/assignments[] come from members, so every existing reader keeps working.
// squad-state.ts (every write) and export-json.ts squadDoc (the loop's export) both use this;
// nowhere else derives these lists.
//
// worktrees[] is the members' wts plus a recorded worktree no member owns (add-worktree
// stays valid across exports). Callers that rebuild from the roster alone (add-member,
// remove-member, rekey-member) pass no keep, so a dropped member's worktree goes with it.
type J = any;
type Doc = Record<string, J>;
const arr = (v: J): J[] => (Array.isArray(v) ? v : []);
const alt = (v: J, d: J) => (v !== undefined && v !== null && v !== false ? v : d);   // `v // d`
function rank(v: J): number {
  if (v === undefined || v === null) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  return typeof v === "number" ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 5 : 6;
}
// jq's total order: null < false < true < numbers < strings < arrays < objects.
function cmp(a: J, b: J): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return a - b;
  if (ra === 4) return a < b ? -1 : a > b ? 1 : 0;
  return cmp(JSON.stringify(a), JSON.stringify(b));
}
const eq = (a: J, b: J) => cmp(a, b) === 0;
function unique(xs: J[]): J[] {
  return [...xs].sort(cmp).filter((x, i, s) => i === 0 || !eq(s[i - 1], x));
}

export function derive(doc: Doc, worktrees = true, keep: J[] = []): void {
  const members = arr(doc.members);
  if (worktrees) {
    const wts = members.map((m: J) => m?.wt ?? null);
    const owned = new Set(wts.map((w) => JSON.stringify(w)));
    doc.worktrees = unique([...wts, ...keep.filter((w) => !owned.has(JSON.stringify(w ?? null)))]);
  }
  doc.assignments = members.filter((m: J) => m?.role === "builder" && alt(m.for, "") !== "")
    .map((m: J) => ({ builder: m.suffix ?? null, unit: alt(arr(m.owns)[0], ""), thinker: m.for }));
}
