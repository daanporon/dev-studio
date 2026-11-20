// squad-finish.ts — the one "is this squad finished" rule (squad-done-definition U1). The loop's all-done
// fact and poke (retest.ts), the board's label (board-data.ts) and the Lead's `★ finished` line
// (watch-ts.ts) all call settle(), so they cannot drift apart again. Pure: callers bring the units and
// members from wherever they read them.
//
//   empty        no units at all.
//   active       a testing squad, a Tester member up, or open work: a dispatched unit, an unheld planned
//                unit, a done unit whose PR is still open, or a unit in a status this rule does not know.
//   wrapping-up  a feature squad, no Tester, every unit done or cancelled, no done unit with an open PR:
//                the Lead owes the test check and the debrief.
//   held-only    as wrapping-up, except one or more units are held (planned with hold): the only open
//                work is held, so the squad is NOT finished. Every hold kind (plan, follow-up, reasoned)
//                counts the same here. An unheld planned unit that waits on a held unit (a dep that is
//                held, or a planned unit itself waiting, followed through the squad's own `deps`; a cycle
//                ends as not waiting; `ext_deps` on other squads never count) can never be dispatched, so
//                it does not make the squad active: the squad is parked and `waiting` lists those units
//                (`planned` still lists every unheld planned unit, waiting or not).
//
// `pr_open` is optional: callers that see PRs (retest.ts, the board) fill it; a caller with only the
// squad JSON leaves it out (a done unit's PR is merged by definition there).

export type FinishUnit = { slug?: unknown; status?: unknown; hold?: unknown; held?: unknown; deps?: unknown; pr_open?: boolean };
export type FinishInput = { type?: unknown; units: FinishUnit[]; members: { role?: unknown }[] };
export type FinishState = "active" | "held-only" | "wrapping-up" | "empty";
export type Finish = { state: FinishState; dispatched: string[]; planned: string[]; held: string[]; waiting: string[]; pr_open: string[] };

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

function parseDeps(v: unknown): string[] {
  let a = v;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = []; } }
  return Array.isArray(a) ? a.map(String) : [];
}

export function settle(i: FinishInput): Finish {
  const units = (Array.isArray(i.units) ? i.units : []).filter((u) => u && typeof u === "object");
  const out: Finish = { state: "active", dispatched: [], planned: [], held: [], waiting: [], pr_open: [] };
  let other = false;
  for (const u of units) {
    const slug = String(u.slug ?? "?"), status = String(u.status ?? "planned");
    if (status === "dispatched") out.dispatched.push(slug);
    else if (status === "planned") (truthy(u.hold ?? u.held) ? out.held : out.planned).push(slug);
    else if (status === "done") { if (u.pr_open) out.pr_open.push(slug); }
    else if (status !== "cancelled") other = true;
  }
  if (!units.length) return { ...out, state: "empty" };
  if (String(i.type ?? "feature") !== "feature") return out;
  if ((Array.isArray(i.members) ? i.members : []).some((m) => m?.role === "tester")) return out;
  if (other || out.dispatched.length || out.pr_open.length) return out;
  // Which unheld planned units can only wait on held ones.
  const depsOf = new Map<string, string[]>(), kind = new Map<string, "held" | "planned">();
  for (const u of units) {
    const slug = String(u.slug ?? "?"), status = String(u.status ?? "planned");
    if (status !== "planned") continue;
    kind.set(slug, truthy(u.hold ?? u.held) ? "held" : "planned");
    depsOf.set(slug, parseDeps(u.deps));
  }
  const waits = (slug: string, seen: Set<string>): boolean => {
    if (seen.has(slug)) return false;
    seen.add(slug);
    return (depsOf.get(slug) ?? []).some((d) => kind.get(d) === "held" || (kind.get(d) === "planned" && waits(d, seen)));
  };
  for (const slug of out.planned) if (waits(slug, new Set())) out.waiting.push(slug);
  if (out.planned.length > out.waiting.length) return out;
  return { ...out, state: out.held.length ? "held-only" : "wrapping-up" };
}
