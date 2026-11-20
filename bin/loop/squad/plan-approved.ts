// plan-approved.ts — whether a unit's plan is approved: the canonical plan path and the approved_plans
// match. A leaf module (node imports only), so the pause layer can read it without importing the ready
// reconciler (reconcilers/ready.ts re-exports both).
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Plan paths are stored and compared canonical: a relative one is anchored at the
// dev-studio root (the state root's parent, where state/ lives), `~/x.md` expands against
// $HOME, then realpath -m resolves symlinks as far as the path exists. So
// `state/dev-studio/squads/x-plan.md`, its absolute form and `~/.dev-studio/state/.../x-plan.md`
// all compare equal. (Kept in sync with bin/loop/squad/squad-state.ts canonPath by hand.)
const canonCache = new Map<string, string>();
// The dev-studio root: the directory holding state/ (the state root's parent).
export function devRoot(root: string): string {
  let d = dirname(resolve(root));
  try { d = realpathSync(d); } catch { /* not there yet */ }
  return d;
}
export function canonPath(root: string, p: string): string {
  if (p.startsWith("~/")) p = `${process.env.HOME ?? ""}/${p.slice(2)}`;
  else if (!p.startsWith("/")) p = join(devRoot(root), p);
  const key = `${root}\0${p}`;
  let c = canonCache.get(key);
  if (c === undefined) {
    // realpath -m: symlinks resolved as far as the path exists, the rest kept as written.
    let head = resolve(p);
    const tail: string[] = [];
    for (;;) {
      try { c = join(realpathSync(head), ...tail); break; } catch { /* not there yet */ }
      if (head === "/") { c = resolve(p); break; }
      tail.unshift(basename(head));
      head = dirname(head);
    }
    canonCache.set(key, c);
  }
  return c;
}

// Whether a plan counts as approved: an empty plan is ad-hoc/operator-directed work and always
// passes; otherwise it must canon-match an entry of the squad's approved_plans.
export function approvedPlans(root: string, approved: unknown, plan: string | null): boolean {
  if (!plan) return true;
  const plans = Array.isArray(approved) ? approved : [];
  return plans.some((a) => canonPath(root, String(a)) === canonPath(root, plan));
}
