// fulfil/close.ts — kind `member.close` (U155): the decider's close of a member wished
// stopped, archived or (through its squad) suspended, in Bun. Two phases, one act each:
//   stop    its agent is present: the driver's stop (worker-stop, worker-release, close its
//           terminals but the loop's pane). Worktree, branch and PR are kept; a stopped
//           member is never restarted.
//   remove  (archived/suspended only) no agent and a worktree: close its terminals, remove
//           the worktree when clean and pushed, otherwise record a leftover in the squad
//           doc (close-role.sh's mechanics); then prune the roster (status gone). The PR is
//           never touched. A cancelled Builder is cancel.ts's, never this fulfiller's.
//           Before any of that (lavish-docs-not-stored U3, io/rescue.ts) its review pages and working
//           notes are copied to state/<label>/pages/<topic>/rescued/<role[-suffix]>/, kept or removed
//           alike; a copy that fails keeps the worktree as a leftover (`rescue failed: <why>`).
// Busy (U203, close-busy.ts, shared with decide.ts closeOK): worker state working/waiting, except a
// finished unit's member that is `working` only through background tasks (its turn has ended: no
// foreground tool call open): that one is closed. An unreadable transcript counts as busy.
import { existsSync } from "node:fs";
import { memberOf, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { effective } from "../pause/pause.ts";
import { isCancel } from "../core/decide.ts";
import { view } from "../squad/member-state.ts";
import { closeBusy } from "../squad/close-busy.ts";
import { wtProbe } from "../io/wt-probe.ts";
import { actionBlock } from "../pause/pause.ts";
import { closeTidy } from "../io/tidy.ts";
import { removalHold } from "../squad/exposed.ts";
import { rescuePages } from "../io/rescue.ts";
import type { Row, Store } from "../core/store.ts";
import type { Action } from "../core/plugins.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { onContract } from "../squad/backend.ts";
import { byContract, contractCloseTerminals, contractRemoveTree } from "../squad/removal.ts";
import { worktreeAt } from "../io/worktrees.ts";
import { errOf } from "../io/orca.ts";

type P = ActionPayload<"member.close">;
const CLOSE_VIEWS = ["stopped", "archived", "suspended"];

function rowOf(x: Exec, a: Action): Row | null {
  const id = payloadOf<"member.close">(a)?.id;
  return id == null ? null : x.store.get("members", { id });
}
function presence(x: Exec, r: Row): string | null {
  return r.wt ? String(x.store.get("observed_workers", { project: r.project, wt: r.wt })?.presence ?? "none") : "none";
}
// `rescued` (U3): the folder its pages and notes were copied to, when anything is there.
type Rescue = { rescued?: string };
function prune(store: Store, r: Row, at: number, result: string, extra: Rescue = {}): void {
  store.fact("wish_done", [{ table: "members", key: { id: r.id }, set: { status: "gone", doc: null, want_result: `done: ${result}`, updated_at: at } }],
    { project: String(r.project), squad: String(r.squad), member: (r.wt as string | null) ?? null, payload: { want: "gone", result, ...extra } });
}

// A suspended member keeps its row, journal and branch: only the worktree goes, and its wt
// clears so the resume's standing wish starts it fresh in a new worktree (U158).
function suspendPrune(store: Store, r: Row, at: number, result: string, extra: Rescue = {}): void {
  store.fact("member_suspended", [{ table: "members", key: { id: r.id }, set: { status: "suspended", wt: null, updated_at: at } }],
    { project: String(r.project), squad: String(r.squad), member: (r.wt as string | null) ?? null, payload: { id: r.id, result, ...extra } });
  if (r.role === "lead") store.db.run("UPDATE squads SET lead_wt = NULL WHERE project = ? AND topic = ? AND lead_wt = ?", [String(r.project), String(r.squad), String(r.wt)]);
}

// Record a leftover the way close-role.sh did: an entry in the squad doc's leftovers, so
// lifecycle step 1d keeps trying to remove it once provably safe.
function recordLeftover(store: Store, r: Row, wt: string, path: string, branch: string, reason: string, files: string[], n: number, unpushed: number, extra: Rescue = {}): void {
  const squad = store.get("squads", { project: r.project, topic: r.squad });
  if (!squad?.doc) { store.event("leftover_recorded", { project: String(r.project), squad: String(r.squad), member: wt, payload: { wt, path, branch, reason, ...extra } }); return; }
  const doc = JSON.parse(String(squad.doc)) as Row;
  const left = (Array.isArray(doc.leftovers) ? doc.leftovers as Row[] : []).filter((l) => l.wt !== wt);
  const unit = r.role === "builder" && r.suffix ? store.get("units", { project: r.project, squad: r.squad, slug: r.suffix }) : null;
  const waits = unit?.pr ? `PR #${unit.pr} merged — inspect, then close-squad --force or remove by hand` : "the Lead/operator decision";
  doc.leftovers = [...left, { wt, path, branch, reason, waits_on: waits, files: files.slice(0, 20), n_files: n, unpushed, ...(unit ? { unit: String(unit.slug) } : {}) }];
  store.db.run("UPDATE squads SET doc = ? WHERE project = ? AND topic = ?", [JSON.stringify(doc), String(r.project), String(r.squad)]);
  store.event("leftover_recorded", { project: String(r.project), squad: String(r.squad), member: wt, payload: { wt, path, branch, reason, waits_on: waits, ...extra } });
}

async function remove(a: Action, x: Exec, r: Row): Promise<Result> {
  const { store, now: at } = x, wt = String(r.wt ?? "");
  const suspended = view(store, r) === "suspended";
  let extra: Rescue = {};
  const finish = (result: string) => suspended ? suspendPrune(store, r, at, result, extra) : prune(store, r, at, result, extra);
  // Release its settled dispatch (close-role.sh always did): a member archived while its
  // agent was already gone goes straight here and would otherwise keep its long-poll slot.
  const runId = String(store.get("squads", { project: r.project, topic: r.squad })?.run_id ?? "");
  if (runId && wt) await x.act.orca.run("worker-release", [runId, wt], { env: x.act.childActivity(x.store, a) });
  const tree = store.get("observed_worktrees", { project: r.project, wt });
  const path = String(tree?.path ?? (wt.includes("::") ? wt.split("::").at(-1) : "") ?? "");
  // U11c: a squad on a contract backend has no Orca worktree row: its provider's row names the branch.
  const contract = byContract(store, { project: String(r.project), squad: String(r.squad) });
  const branch = String(tree?.branch ?? (contract && path ? worktreeAt(store, path)?.branch : "") ?? "");
  const w = { project: String(r.project), squad: String(r.squad), wt, path };
  if (!path || !existsSync(path)) { finish("archived: worktree already gone"); return { done: true, result: "removed: already gone" }; }
  // U3: copy its pages and notes out first, whatever the probe says next; a replay copies nothing twice.
  const saved = await rescuePages(store, String(r.project), String(r.squad), r.suffix ? `${r.role}-${r.suffix}` : String(r.role), path);
  if (saved.count + saved.same > 0) extra = { rescued: saved.dest };
  if (saved.count > 0) store.event("pages_rescued", { project: String(r.project), squad: String(r.squad), member: wt,
    payload: { wt, path, dest: saved.dest, count: saved.count, bytes: saved.bytes, same: saved.same, capped: saved.capped, listed: saved.listed, files: saved.files.slice(0, 20) } });
  if (!saved.ok) {
    recordLeftover(store, r, wt, path, branch || "unknown", `rescue failed: ${saved.why}`, [], 0, 0, extra);
    finish("leftover kept (rescue failed)");
    return { done: true, result: "left: rescue-failed" };
  }
  // A dirty or unpushed tree is kept as a leftover, untouched; `tidied` says the close-time tidy ran.
  const check = async (tidied: boolean): Promise<Result | { dirty: number; unpushed: number; files: string[] }> => {
    const probe = await wtProbe(path, 60_000);
    if (probe.code !== 0) {
      recordLeftover(store, r, wt, path, branch || "unknown", "unknown (probe failed)", [], 0, 0, extra);
      finish("leftover kept (probe failed)");
      return { done: true, result: "left: probe-failed" };
    }
    const lines = probe.out.split("\n"), [d, u] = lines[0].split("\t");
    const dirty = Number(d || 0), unpushed = Number(u || 0), files = lines.slice(1).filter(Boolean);
    if (dirty > 0 || unpushed > 0) {
      const reason = dirty > 0 && unpushed > 0 ? "both" : dirty > 0 ? "uncommitted changes" : "unpushed commits";
      recordLeftover(store, r, wt, path, branch || "unknown", tidied ? `${reason} (after cleanup_on_close)` : reason, files, dirty, unpushed, extra);
      finish("leftover kept");
      return { done: true, result: dirty > 0 ? "left: dirty" : "left: unpushed" };
    }
    return { dirty, unpushed, files };
  };
  const first = await check(false);
  if (!("files" in first)) return first;
  const block = actionBlock(store, a);
  if (block) return { wait: block };
  // exposed-cleanup U2: end what this worktree exposed and run its stop commands before the tree goes.
  const stops = removalHold(store, String(r.project), wt, suspended ? "worktree-removed" : "owner-gone", at);
  if (stops) return { wait: stops };
  if (contract) {
    // No backend drops a contract terminal with its tree (Orca's worktree-rm does): one left open keeps it.
    const c = await contractCloseTerminals(a, x, w);
    if (c.code !== 0) return { retry: errOf(c, "terminal.close") };
  } else await x.act.orca.run("terminal-close-worktree", [`id:${wt}`], { env: x.act.childActivity(x.store, a) });
  // U1 (KTD10): the project's cleanup_on_close, then stop what is still running in the tree, then probe again.
  const tidy = await closeTidy.before(a, x, path);
  const again = await check(true);
  if (!("files" in again)) return again;
  const { dirty, unpushed, files } = again;
  const rm = contract ? await contractRemoveTree(a, x, w) : await x.act.orca.run("worktree-rm", [`id:${wt}`], { env: x.act.childActivity(x.store, a) });
  if (rm.code === 75) return { wait: "activity changed before removal" };   // the backend's pause/generation fence: not a refusal
  if (rm.code !== 0) {
    const err = (rm.err || rm.out).split("\n").filter((l) => l.trim()).at(-1)?.slice(0, 200) || "no detail from backend";
    recordLeftover(store, r, wt, path, branch || "unknown", `worktree-rm refused: ${err}`, files, dirty, unpushed, extra);
    finish("leftover kept (worktree-rm refused)");
    return { done: true, result: "left: rm-refused" };
  }
  await closeTidy.after(a, x, path, tidy);
  finish("archived: worktree removed");
  return { done: true, result: "removed: clean, pushed" };
}

const close: Fulfiller = {
  name: "close",
  kinds: ["member.close"],
  run: () => [],

  stale(a, x) {
    const r = rowOf(x, a);
    if (!r || r.status === "gone" || isCancel(x.store, r)) return true;
    const v = view(x.store, r);
    if (!v || !CLOSE_VIEWS.includes(v)) return true;
    const phase = payloadOf<"member.close">(a)?.phase;
    if (phase === "stop") {
      if (v === "suspended") return true;   // the pause flow closes a suspended agent first
      if (presence(x, r) !== "running") return true;
      // A unit-derived archived view (its own wish still running) waits until the member is
      // not working or waiting, as lifecycle 1c's retire did; the decider re-emits it then.
      const squadArchived = effective(x.store, r).why === "squad";   // the decider's own test (pause.ts effective)
      return closeBusy(x.store, r) && !["stopped", "gone"].includes(String(r.want ?? "")) && !squadArchived;
    }
    if (phase === "remove") return v === "stopped" || presence(x, r) === "running" || !r.wt;
    return true;
  },

  ready(a, x) {
    if (payloadOf<"member.close">(a)?.phase !== "stop") return true;
    const r = rowOf(x, a), m = r ? memberOf(x.store, { id: Number(r.id) }) : null;
    return !!m && (onContract(x.store, m.project, m.squad) || !!x.store.get("coordinators", { project: m.project, squad: m.squad })?.handle);
  },

  async exec(a, x): Promise<Result> {
    const r = rowOf(x, a);
    if (!r) return { dropped: "member gone" };
    const phase = payloadOf<"member.close">(a)?.phase;
    if (phase === "remove") return { background: remove(a, x, r) };
    const { store, now: at } = x, m = memberOf(store, { id: Number(r.id) });
    if (!m?.wt) return { dropped: "no worktree" };
    const keep = String(store.get("coordinators", { project: m.project, squad: m.squad })?.handle ?? "");
    // U11: a squad on a contract backend has no coordinator: its stop closes the member's terminals.
    if (!keep && !onContract(store, m.project, m.squad)) return { wait: "no coordinator pane" };
    const run = String(store.get("squads", { project: m.project, topic: m.squad })?.run_id ?? "");
    const makeSeat = (op: string) => x.act.seat(store, m.project, m.squad, `close:${a.episode}:${op}`, m.wt, at);
    const res = await x.act.driver(makeSeat("worker-stop"), m.agent).stop(makeSeat, m, run, keep);
    if (!res.ok) return { retry: res.error ?? "stop failed" };
    const why = payloadOf<"member.close">(a)?.why ?? view(store, r) ?? "stopped";
    store.event("member_closed", { project: m.project, squad: m.squad, member: m.wt, payload: { id: m.id, why, phase: "stop" } });
    if (why === "stopped") store.upsert("members", { id: m.id }, { want_result: "done: stopped", updated_at: at });
    return { done: true, result: { stopped: m.wt, why } };
  },
};
export default close;
