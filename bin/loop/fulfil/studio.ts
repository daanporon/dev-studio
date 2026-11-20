// fulfil/studio.ts — the board's two Studio requests (U15):
//   studio   {action, topic?, line}  a request file for the Studio, as the board wrote it before:
//            <state root>/<label>/requests/_studio/board-<action>[-<topic>]-<request id>.txt holding
//            "board: the operator asks you to run: /ds-…"; watch.sh shows it and the Studio runs it.
//            The loop's morning brief (reconcilers/briefing.ts, action "briefing") is written as
//            requests/_studio/briefing-<request id>.txt, its first line "briefing: …".
//   dismiss  {id, answer?}           a Studio alert answered on the board: bin/lib/alerts.sh resolve <id>;
//            a card filed with `move: true` (limits.ts, studio_move ask) answered "move it" records the approval
//            (episode studio.move / studio:approved), and limits.ts then moves the Studio as in auto
//            U4: a card filed with `credits: {agent, account}` (credits-card.ts) answered "Fixed" ends the
//            account's credits hold (accounts.ts setAccountEnabled true, which clears it), "Switch it off"
//            switches the account off (setAccountEnabled false); by "board" either way
//   studio-move {handle, agent, account, model, effort, from}  U264, from limits.ts: move the Studio to the
//            picked account. Right before it closes anything the handle must still be the Studio's and
//            studioReady() must still hold, else nothing happens (limits.ts asks again after its settle
//            window). Then `terminal-close <handle>` (that tab only, never the worktree's), `studio-start`
//            in the Studio worktree on the pick, briefed from studio.md plus the journal, and the new
//            handle on the member with one `studio_moved` event. Its steps are kept in the studio:move
//            episode, so a replay after a crash never closes twice, and one that finds "starting" records the
//            terminal that start opened (or waits DS_LOOP_STUDIO_MOVE_START_S, 300) instead of starting again. A start that fails after the close
//            posts a card (subject studio.move, so limits.ts's studio.limit sweep never drops it) with the
//            manual command; the close is never retried.
// The file is named by the request, so a crash between the write and the claim's settle writes it
// again in place, never twice. Its requests row (the one the state observer would import, key
// file:<label>/_studio/<name>) is written at once, so the board refuses a second click meanwhile.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { alert, failRequest, finishRequest, requestActions, type Exec, type Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import { errOf, spawn } from "../io/orca.ts";
import { ROOT, type Row } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { setAccountEnabled } from "../capacity/accounts.ts";
import { FIXED, SWITCH_OFF } from "../capacity/credits-card.ts";
import { MOVE, studioPrompt, studioReady, studioRestartCmd, studioView } from "../squad/studio.ts";

type P = { action?: string; topic?: string; line?: string; framing?: string; id?: string; answer?: string; request?: number };
type Move = { handle?: string; agent?: string; account?: string; model?: string; effort?: string; from?: string };

// How long a replay that finds the "starting" step waits for that start's terminal before starting again:
// above the background timeout and studio-start's own wait for the new tab to settle.
const moveStartS = () => envInt("DS_LOOP_STUDIO_MOVE_START_S", 300);

async function move(a: Action, x: Exec) {
  const p = (a.payload ?? {}) as Move, { store, now: at } = x, P = a.project;
  if (!P || !p.handle || !p.agent || !p.account) return { failed: "a Studio move needs a project, the Studio's handle and a pick" };
  const key = { project: P, subject: MOVE, kind: "studio:move" };
  const step = (state: string, ended = false) => store.upsert("episodes", key, { episode_key: a.episode, state, source: "loop", observed_at: at,
    ...(state === "closing" ? { started_at: at, ended_at: null } : {}), ...(ended ? { ended_at: at } : {}) });
  const row = store.get("episodes", key), was = row?.episode_key === a.episode ? String(row.state) : null;
  if (was === "started" || was === "failed" || was === "not moved") return { done: true, result: `already ${was}` };
  const v = studioView(store, P);
  if (!v) return { failed: "the project has no Studio worktree" };
  const to = `${p.agent}:${p.account}`, seat = x.act.seat(store, P, null, `${a.subject}:${a.episode}`, v.wt, at);
  // A closing step a crash cut short: a tab Orca no longer lists was closed, so start the new one;
  // one still listed is checked again from the start.
  const closedBefore = was === "closing" && !v.terms.some((t) => t.handle === p.handle);
  if (was !== "closed" && was !== "starting" && !closedBefore) {
    const ready = studioReady(store, P, at);
    const why = v.member?.handle !== p.handle ? `${p.handle} is no longer the Studio's terminal` : ready.ready ? null : ready.why;
    if (why) {
      store.upsert("episodes", key, { episode_key: a.episode, state: "not moved", started_at: at, ended_at: at, source: "loop", observed_at: at });
      return { done: true, result: `not moved: ${why}` };
    }
    step("closing");
    const c = await seat.send("terminal-close", [p.handle]);
    if (c.code !== 0) {
      step("not moved", true);
      store.event("studio_move_failed", { project: P, squad: "_studio", member: v.wt, payload: { handle: p.handle, to, step: "close", error: errOf(c, "terminal-close") } });
      return { done: true, result: `not moved: ${errOf(c, "terminal-close")}` };
    }
    // The tab is closed: no handle until the new one is recorded, and gone for the coordinator (a Run the
    // Studio's tab held is bound again from a fresh pane, coordinator.ts gone()) and for adoption.
    store.db.transaction(() => {
      store.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND handle = ? AND gone_at IS NULL", [at, P, p.handle!]);
      if (v.member) store.upsert("members", { id: v.member.id }, { handle: null, updated_at: at });
      step("closed");
    })();
  }
  // A replay after "starting" (a crash, or the background call timing out while studio-start still runs):
  // a new Studio terminal in the worktree is that start's, so it is recorded instead of opening another;
  // with none yet, wait out the start window before starting again.
  let handle = "", s: { code: number; out: string; err: string } | null = null;
  if (was === "starting") {
    handle = (v.member?.handle && v.member.handle !== p.handle ? String(v.member.handle) : v.candidates.find((c) => c.handle !== p.handle)?.handle) ?? "";
    const since = Number(row?.observed_at ?? 0);
    if (!handle && at - since < moveStartS()) return { wait: "the Studio's studio-start may still be running", at: since + moveStartS() };
  }
  if (!handle) {
    store.upsert("episodes", key, { episode_key: a.episode, state: "starting", source: "loop", observed_at: at });
    const proj = store.get("projects", { label: P });
    const prompt = studioPrompt(ROOT, P, String(proj?.home_repo ?? ""), join(store.root, P), `${p.from ?? "its account"} hit its limit, now on ${to}`);
    s = await seat.send("studio-start", [v.wt, p.account, p.model || "-", p.effort || "-", seat.window("studio") || "-", prompt]);
    handle = s.code === 0 ? s.out.trim().split("\n").pop()!.trim() : "";
  }
  if (!handle) {
    step("failed", true);
    const err = errOf(s!, "studio-start");
    store.event("studio_move_failed", { project: P, squad: "_studio", member: v.wt, payload: { handle: p.handle, to, step: "start", error: err } });
    const cmd = studioRestartCmd(v.wt, p.model, p.account);
    await alert(store, P, MOVE, `failed|${a.episode}`, `The loop closed the Studio's tab to move it to ${to}, but could not start it there (${err}) — start it yourself: ${cmd}`,
      { title: "Studio move failed", option: "done — restarted it", why: cmd, fields: { kind: "out_of_credits" } });
    return { done: true, result: `closed, not started: ${err}` };
  }
  const set: Row = { handle, agent: p.agent, account: p.account === "-" ? null : p.account, limited_until: null, observed_at: at, updated_at: at };
  if (p.model && p.model !== "-") set.model = p.model;
  const moved = { project: P, squad: "_studio", member: v.wt, payload: { handle, previous: p.handle, from: p.from ?? null, to, model: p.model ?? null } };
  store.db.transaction(() => {
    if (v.member) store.fact("studio_moved", [{ table: "members", key: { id: v.member.id }, set }], moved);
    else store.event("studio_moved", moved);
    step("started", true);
    store.db.run("UPDATE episodes SET ended_at = ?, state = 'ended', observed_at = ? WHERE project = ? AND subject = ? AND kind = 'studio:approved' AND ended_at IS NULL", [at, at, P, MOVE]);
  })();
  return { done: true, result: `moved to ${to}: ${handle}` };
}

const studio: Fulfiller = {
  name: "studio",
  scope: "host",
  kinds: ["studio", "dismiss", "studio-move"],
  run: (ctx) => requestActions(ctx, ["studio", "dismiss"]),
  async exec(a, x) {
    const p = (a.payload ?? {}) as P, { store, now: at } = x;
    if (a.kind === "studio-move") return move(a, x);
    if (a.kind === "dismiss") {
      if (!a.project || !p.id) return { failed: "a dismiss needs a project and an alert id" };
      const card = store.db.query("SELECT doc FROM observed_alerts WHERE project = ? AND id = ?").get(a.project, p.id) as Row | null;
      // A move card (studio_move ask) approves the move only when answered with its own suggestion
      // ("move it"); Dismiss (an empty answer) or any other text, e.g. after restarting it by hand, only clears it.
      let askMove = false, credits: { agent: string; account: string; enabled: boolean } | null = null;
      const said = (p.answer ?? "").trim().toLowerCase();
      try {
        const doc = JSON.parse(String(card?.doc ?? "{}"));
        askMove = doc?.move === true && !!p.answer && said === String(doc.suggestion ?? "move it").trim().toLowerCase();
        // U4: an account out of credits (credits-card.ts) answered Fixed ends the hold, Switch it off disables it.
        const c = doc?.credits, fixed = said === FIXED.toLowerCase();
        if (c && typeof c.agent === "string" && typeof c.account === "string" && (fixed || said === SWITCH_OFF.toLowerCase()))
          credits = { agent: c.agent, account: c.account, enabled: fixed };
      } catch { /* not a move card */ }
      const o = await spawn([join(ROOT, "bin", "lib", "alerts.sh"), join(store.root, a.project, "alerts.json"), "resolve", p.id], {}, 30_000);
      if (o.code !== 0) return { retry: errOf(o, "alerts.sh") };
      store.db.run("DELETE FROM observed_alerts WHERE project = ? AND id = ?", [a.project, p.id]);
      const acct = credits ? setAccountEnabled(store, { ...credits, by: "board" }, at) : null;
      if (askMove) store.fact("studio_move_approved", [{ table: "episodes", key: { project: a.project, subject: MOVE, kind: "studio:approved" },
        set: { episode_key: p.id, state: "approved", started_at: at, ended_at: null, source: "board", observed_at: at } }], { project: a.project, squad: "_studio", payload: { alert: p.id } });
      finishRequest(store, a, { ok: true, dismissed: p.id, ...(askMove ? { move: "approved" } : {}),
        ...(credits && acct ? { account: `${credits.agent}/${credits.account}`, enabled: credits.enabled, cleared: acct.cleared === true } : {}) }, at);
      return { done: true };
    }
    if (!a.project || !p.action || !p.line || p.request == null) return { failed: "a Studio request needs a project, an action and its line" };
    const dir = join(store.root, a.project, "requests", "_studio");
    const file = join(dir, p.action === "briefing" ? `briefing-${p.request}.txt` : `board-${p.action}${p.topic ? `-${p.topic}` : ""}-${p.request}.txt`);
    mkdirSync(dir, { recursive: true });
    // tmp+rename: a watch.sh peek in the same instant never sees a half-written first line.
    // A start with a brief (the board's dialog): the brief goes to a file named by the request, exactly the
    // bytes received, and the line names it. Not under requests/_studio/: watch.sh lists every .txt there.
    let line = p.line;
    if (p.action === "start" && typeof p.framing === "string") {
      const fdir = join(store.root, a.project, "framings"), ff = join(fdir, `board-start-${p.request}.md`);
      mkdirSync(fdir, { recursive: true });
      writeFileSync(`${ff}.tmp`, p.framing);
      renameSync(`${ff}.tmp`, ff);
      line = `${line} --framing-file ${ff}`;
    }
    writeFileSync(`${file}.tmp`, `${line}\n`);
    renameSync(`${file}.tmp`, file);
    store.request("board", { file: relative(store.root, file), text: line },
      { key: `file:${a.project}/_studio/${basename(file)}`, project: a.project, by: "board" });
    finishRequest(store, a, { ok: true, file }, at);
    return { done: true, result: file };
  },
  giveUp: failRequest,
};
export default studio;
