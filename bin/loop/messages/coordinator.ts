// coordinator.ts — the loop as each Run's coordinator (U1's answer, docs/spikes/loop-coordinator.md):
// a plain shell terminal in the Lead's worktree, bound to the squad's Run with run-use (backend
// `adopt`), sends every worker-start as `--from <handle>`. One pane coordinates one Run, so each
// squad gets its own. The handle lives in `coordinators`; when `observed_terminals` marks it gone
// (a restarted Orca, a closed tab) or an Orca call from it fails the loop looks for the same pane under a new handle, else makes
// a new terminal, and binds it again before the next call. A terminal whose run-use failed is kept
// (run_id '') and bound on the next try. A Lead's own restart can't run from
// there (restart-role.sh refuses a terminal in its target's worktree and closes that worktree's
// terminals): outside() is a project's plain pane in the Studio's worktree for that.
import { errOf, type Orca } from "../io/orca.ts";
import type { Row, Store } from "../core/store.ts";

// terminal-find's handle for a pane, or "" when Orca no longer has it. A failed read says nothing
// about the pane, so it throws: the caller falls back to what it holds, or retries (U93).
async function findPane(orca: Orca, pane: string): Promise<string> {
  const res = await orca.run("terminal-find", [pane]);
  if (res.code !== 0) throw new Error(`coordinator: terminal-find ${pane} failed: ${errOf(res, "terminal-find")}`);
  return res.out.trim();
}

// Gone only when the terminal observer recorded this handle and then marked it gone (gone_at set).
// The observer records role terminals, never the loop's own `ds-loop <squad>` panes, so a handle it
// never recorded is not evidence either way (U72). A pane that really closed fails the next Orca
// call from it, and the actuator retries with `fresh`.
export function gone(store: Store, project: string, handle: string): boolean {
  const row = store.db.query("SELECT gone_at FROM observed_terminals WHERE project = ? AND handle = ?").get(project, handle) as { gone_at: number | null } | null;
  return row?.gone_at != null;
}

// Write the binding; log a `coordinator` event only when the handle, pane or Run changed. A re-bind
// to the same ones just moves bound_at.
function bind(store: Store, key: Row, set: Row, prev: Row | null, ctx: { project: string; squad?: string; payload: Row }): void {
  const same = prev != null && prev.handle === set.handle && (prev.pane_key ?? null) === (set.pane_key ?? null) && prev.run_id === set.run_id;
  if (same) store.upsert("coordinators", key, set);
  else store.fact("coordinator", [{ table: "coordinators", key, set }], ctx);
}

// A project's pane outside every squad, row squad '' with no Run: restart-role.sh binds it to the
// Run of the Lead it restarts. Throws when the project has no Studio worktree to open it in.
// `avoid`: a handle that just failed with stable_pane_required (U93's fresh retry) — a find that
// returns it counts as missing, so the retry binds a fresh pane instead of the same terminal.
// A replaced pane is left alone, never closed: the outside pane is shared across the project's
// squads, so a concurrent start may still run from it (sender() abandons replaced panes the same way).
export async function outside(store: Store, orca: Orca, project: string, at: number, fresh = false, avoid = ""): Promise<string> {
  const key = { project, squad: "" }, row = store.get("coordinators", key);
  let pane = row?.pane_key ? String(row.pane_key) : "", wt = row?.wt ? String(row.wt) : "", handle = "";
  if (!fresh && row?.handle && pane) {
    // gone() cannot see the loop's own panes (U72), so resolve the stored pane first (U93): no
    // pane, or a different handle, makes or binds a pane as fresh does today. A Lead restart is
    // rare, so one extra read per restart is enough.
    let found = "";
    try { found = await findPane(orca, pane); } catch { return String(row.handle); }
    if (found && found !== avoid) {
      if (found !== String(row.handle))
        bind(store, key, { run_id: "", handle: found, pane_key: pane, wt: row.wt ?? null, created_at: row.created_at ?? at, bound_at: at }, row,
          { project, payload: { handle: found, pane, was: row.handle ?? null } });
      return found;
    }
    pane = "";   // already looked: the find below is only for a fresh restart
  } else if (!fresh && row?.handle && !gone(store, project, String(row.handle))) {
    return String(row.handle);
  }
  if (pane) {
    const found = await findPane(orca, pane);
    if (found !== avoid) handle = found;
  }
  if (!handle) {
    wt = String(store.get("projects", { label: project })?.studio_wt ?? "");
    if (!wt) throw new Error(`coordinator: project ${project} has no Studio worktree to restart a Lead from`);
    const c = await orca.run("terminal-create", [wt, "ds-loop restart"]);
    [handle = "", pane = ""] = c.out.trim().split("\t");
    if (c.code !== 0 || !handle) throw new Error(`coordinator: terminal-create failed: ${errOf(c, "terminal-create")}`);
  }
  bind(store, key, { run_id: "", handle, pane_key: pane || null, wt: wt || null, created_at: row?.created_at ?? at, bound_at: at }, row,
    { project, payload: { handle, pane, was: row?.handle ?? null } });
  return handle;
}

// The handle to send this squad's Orca calls from, bound to its Run. The asker's terminal serves only
// until the squad's Lead has a worktree; after that the loop opens its own `ds-loop <squad>` pane. Throws when there is no Run or
// no terminal can be made; the actuator turns that into a retry. `fresh`: Orca fenced the stored
// handle, so look for its pane again (or make a terminal) and bind that.
export async function sender(store: Store, orca: Orca, project: string, squad: string, at: number, fresh = false): Promise<string> {
  const sq = store.db.query("SELECT run_id, lead_wt FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  const run = sq?.run_id ? String(sq.run_id) : "";
  if (!run) throw new Error(`coordinator: squad ${project}/${squad} has no run`);
  const row = store.get("coordinators", { project, squad });
  // A handle with no pane_key is the asker's terminal that created the squad (fulfil/squad.ts), not a
  // pane the loop opened: it holds the Run only until the Lead has a worktree (U210).
  const borrowed = row != null && !row.pane_key && !!sq?.lead_wt;
  const live = !fresh && !borrowed && row != null && !gone(store, project, String(row.handle));
  if (live && row.run_id === run) return String(row.handle);

  let handle = live ? String(row.handle) : "";
  let pane = row?.pane_key ? String(row.pane_key) : "", wt = row?.wt ? String(row.wt) : "";
  const open = async () => {
    if (!handle && pane) handle = (await orca.run("terminal-find", [pane])).out.trim();
    if (handle) return;
    // A squad being created (U158) has no Lead worktree yet: open its sender in the
    // project's Studio worktree, as spawn-squad.sh's Studio-held seat did.
    const lead = sq?.lead_wt ? String(sq.lead_wt) : String(store.get("projects", { label: project })?.studio_wt ?? "");
    if (!lead) throw new Error(`coordinator: squad ${project}/${squad} has no Lead worktree to open a sender terminal in`);
    const c = await orca.run("terminal-create", [lead, `ds-loop ${squad}`]);
    [handle = "", pane = ""] = c.out.trim().split("\t");
    if (c.code !== 0 || !handle) throw new Error(`coordinator: terminal-create failed: ${errOf(c, "terminal-create")}`);
    wt = lead;
  };
  await open();
  let a = await orca.run("adopt", [run], { from: handle });
  // The stored handle was taken on trust (the terminal observer lags a closed tab or a restarted
  // Orca): look for its pane again, else make a terminal, and bind that (U59).
  if (a.code !== 0 && live) {
    handle = "";
    await open();
    a = await orca.run("adopt", [run], { from: handle });
  }
  const created_at = row && row.handle === handle ? row.created_at : at;
  if (a.code !== 0) {
    // Keep the terminal, unbound (run_id ''): the next try binds this one instead of opening another
    // `ds-loop <squad>` tab per retry (21 leaked on the host while run-use kept failing).
    if (!row || row.handle !== handle || row.run_id !== "") {
      store.fact("coordinator", [{ table: "coordinators", key: { project, squad },
        set: { run_id: "", handle, pane_key: pane || null, wt: wt || null, created_at, bound_at: null } }],
      { project, squad, payload: { run, handle, pane, was: row?.handle ?? null, bound: false } });
    }
    throw new Error(`coordinator: run-use ${run} from ${handle} failed: ${errOf(a, "run-use")}`);
  }
  bind(store, { project, squad }, { run_id: run, handle, pane_key: pane || null, wt: wt || null, created_at, bound_at: at }, row,
    { project, squad, payload: { run, handle, pane, was: row?.handle ?? null } });
  return handle;
}

// The Run's seat went elsewhere (a Lead restart-role adopts it from outside()): the squad's sender is
// no longer bound, so the next sender() binds it again before any start (U59).
export function unbind(store: Store, project: string, squad: string): void {
  const row = store.get("coordinators", { project, squad });
  if (!row || row.run_id === "") return;
  store.fact("coordinator", [{ table: "coordinators", key: { project, squad }, set: { run_id: "", bound_at: null } }],
    { project, squad, payload: { run: row.run_id, handle: row.handle, bound: false, why: "the Run was adopted from another terminal" } });
}
