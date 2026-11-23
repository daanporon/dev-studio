import { existsSync } from "node:fs";
import type { Action, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { prUrl } from "../settings/projects.ts";

export const CANCEL_KINDS = new Set(["cancel.stop", "cancel.remove", "cancel.pr"]);
export const prNumber = (pr: unknown): number => Number(String(pr ?? "").match(/(\d+)\/?$/)?.[1] ?? 0);
export function sharedBuilder(store: Store, u: Row): boolean {
  return !!u.builder_wt && !!store.db.query("SELECT 1 FROM units WHERE builder_wt = ? AND NOT (project = ? AND squad = ? AND slug = ?) AND status != 'cancelled'")
    .get(u.builder_wt, u.project, u.squad, u.slug);
}
export function cancellationRepository(store: Store, u: Row): string {
  const url = prUrl(String(u.pr ?? ""));
  if (url) return url.nwo;
  const s = store.get("squads", { project: u.project, topic: u.squad });
  return String(store.get("config", { project: u.project, file: "github", key: `repo:${s?.repo}` })?.value ?? "");
}
export function sharedPr(store: Store, u: Row): boolean {
  const n = prNumber(u.pr), repo = cancellationRepository(store, u);
  return n > 0 && (prNumber(String(u.superseded_by ?? "").startsWith("PR#") ? u.superseded_by : null) === n
    || (store.db.query("SELECT * FROM units WHERE NOT (project = ? AND squad = ? AND slug = ?) AND status != 'cancelled' AND pr IS NOT NULL").all(u.project, u.squad, u.slug) as Row[])
      .some(other => prNumber(other.pr) === n && !!repo && cancellationRepository(store, other).toLowerCase() === repo.toLowerCase()));
}
export function clearCancellationWish(store: Store, m: Row, unit?: string, fulfilled = false): void {
  let cancel; try { cancel = JSON.parse(String(m.want_payload ?? "{}"))?.cancel; } catch {}
  if (m.want !== "gone" || !cancel || (unit && cancel.unit !== unit) || (!fulfilled && String(m.want_result ?? "").startsWith("done:"))) return;
  store.fact("cancel_wish_cleared", [{ table: "members", key: { id: m.id }, set: { want: null, want_payload: null, want_by: null, want_at: null, want_result: null } }],
    { project: String(m.project), squad: String(m.squad), member: String(m.wt), unit: cancel.unit });
}
export function unitOfCancellation(store: Store, a: Action): Row | null {
  const slug = (a.payload as Row | undefined)?.unit;
  return slug ? store.get("units", { project: a.project, squad: a.squad, slug }) : null;
}
export function stopping(store: Store, project: string, wt: string): boolean {
  const us = store.db.query("SELECT * FROM units WHERE project = ? AND builder_wt = ? AND status = 'cancelled'").all(project, wt) as Row[];
  if (us.some(u => !sharedBuilder(store, u))) return true;
  const ms = store.db.query("SELECT * FROM members WHERE project = ? AND wt = ? AND want = 'gone'").all(project, wt) as Row[];
  return ms.some(m => {
    let cancel; try { cancel = JSON.parse(String(m.want_payload ?? "{}"))?.cancel; } catch {}
    return !cancel || !us.some(u => u.slug === cancel.unit && sharedBuilder(store, u));
  });
}
// The worktree a cancelled Builder's id names: Orca's row, or (U11c) for a member of a squad on a contract
// backend (`local::<path>`) its provider's `worktrees` row, read the same way (seen when it was made).
// Read straight from the table: store.ts → pause.ts imports this file, so io/worktrees.ts would be a cycle.
function treeOf(store: Store, project: string, wt: string): Row | null {
  const orca = wt ? store.get("observed_worktrees", { project, wt }) : null;
  const r = !orca && wt.startsWith("local::") ? store.get("worktrees", { host: "local", path: wt.slice("local::".length) }) : null;
  return orca ?? (r ? { path: r.path, gone_at: r.gone_at, observed_at: r.created_at, doc: null } : null);
}
export function cancellationReality(store: Store, project: string, wt: string) {
  const tree = treeOf(store, project, wt);
  const tabs = wt ? store.db.query("SELECT handle, observed_at FROM observed_terminals WHERE project = ? AND wt = ? AND gone_at IS NULL ORDER BY handle").all(project, wt) as Row[] : [];
  const worker = wt ? store.get("observed_workers", { project, wt }) : null;
  let agents = 0; try { agents = Number(JSON.parse(String(tree?.doc ?? "{}")).agents ?? 0); } catch {}
  const live = tabs.length > 0 || (tree?.gone_at == null && agents > 0) || (worker?.gone_at == null && ["working", "waiting"].includes(String(worker?.state)));
  const path = String(tree?.path ?? (wt.includes("::") ? wt.split("::").at(-1) : "") ?? "");
  const present = !!wt && ((!!tree && tree.gone_at == null) || (!!path && existsSync(path)));
  const seen = Math.max(...tabs.map(t => Number(t.observed_at)), Number(tree?.observed_at ?? 0), Number(worker?.observed_at ?? 0));
  return { tree, live, path, present, seen };
}
export function cancellationActions(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx, out: Action[] = [];
  const us = store.db.query("SELECT * FROM units WHERE project = ? AND status = 'cancelled' ORDER BY squad, id").all(project) as Row[];
  for (const u of us) {
    const squad = String(u.squad), wt = String(u.builder_wt ?? ""), unit = String(u.slug);
    const m = wt ? store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC").get(project, squad, wt) as Row | null : null;
    const shared = sharedBuilder(store, u);
    if (shared && m) clearCancellationWish(store, m, undefined, true);
    if (!shared && m && m.want !== "gone") store.want("member", String(m.id), "gone", { by: "loop", payload: { cancel: { unit, into: u.superseded_by, why: u.cancel_reason } } });
    const { tree, live, path, present, seen } = cancellationReality(store, project, wt);
    const push = (kind: string, seen: number, payload: Row) => {
      const subject = kind === "cancel.pr" ? `${squad}/${unit}/pr` : wt;
      const prior = store.get("episodes", { project, subject, kind: `action:${kind}` });
      // Keep an in-flight or retrying episode; a successful call followed by fresh
      // evidence of drift gets another episode. No completed receipt hides reality.
      const pending = prior && ["acted", "running", "pending"].includes(String(prior.state));
      const episode = pending || (prior && seen <= Number(prior.ended_at ?? 0)) ? String(prior.episode_key) : `${u.cancelled_at ?? unit}@${seen}`;
      out.push({ project, squad, member: wt || null, subject, kind, episode, payload: { unit, wt, path, ...payload } });
    };
    if (!shared && live) push("cancel.stop", seen, {});
    else if (!shared && present && tree) push("cancel.remove", Number(tree?.observed_at ?? now), {});
    const repo = cancellationRepository(store, u);
    const n = prNumber(u.pr);
    const pr = n ? store.get("observed_prs", { project, ref: `${repo}#${n}` }) : null;
    if (n && !sharedPr(store, u) && pr?.state === "OPEN" && pr.gone_at == null)
      push("cancel.pr", Number(pr.observed_at), { repo: repo || pr.repo, pr: Number(n) });
    if (!shared && !live && !present && tree?.gone_at != null && m && (m.status !== "gone" || m.doc != null || m.want_result == null))
      store.fact("wish_done", [{ table: "members", key: { id: m.id }, set: { status: "gone", doc: null, want_result: "done: cancelled Builder removed", updated_at: now } }],
        { project, squad, member: wt, unit, payload: { want: "gone", result: "cancelled Builder removed" } });
  }
  return out;
}
