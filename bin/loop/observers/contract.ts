// observers/contract.ts — what the members of the squads off Orca are doing (U12, orca-backend-alternatives).
// The Orca observer (observers/orca.ts) reads only squads on Orca and the Studio; this one fills the same
// rows for every other squad, from its backend's contract (squad/contracts.ts) and the host's process walk:
//   observed_terminals  each member's terminal: the newest one `terminal.list` shows in its folder, one of
//                       the member's own generation first (handle = the backend's terminal id)
//   observed_workers    per member worktree: state, last_output_at (`terminal.last_output`), the screen tail
//                       (`terminal.read`), and from the walk (orca.sh agent-accounts, at most every
//                       DS_LOOP_LIVE_ACCOUNT_S) walk, agent, account, pid, started_at, rss_kb and presence;
//                       a failed walk reads walk unknown, as on Orca
//   observed_worktrees  path, branch and parent from the loop's `worktrees` row, and doc.agents (1 while the
//                       walk sees the agent process, else 0), which liveness's "exited" cause reads
// The state: idle when the walk sees no agent process (a backend may still call a dead agent's pane
// busy); else `agent.state` on a backend with `state: native`; on one with `state: none` (tmux), or when
// the backend answers unknown, the loop reads it: working while the agent's transcript or the terminal's output
// moved within `chat_quiet_s`, or the screen says `esc to interrupt`; idle once the screen shows an empty
// prompt and the agent process is alive; otherwise unknown. A shell left open after
// its agent died is never the agent: presence and the decider read the walk alone (decide.ts walkReality).
// A member whose terminal is not listed is gone (a stamp, not a delete); a failed list stamps nothing.
// Only rows of members of these squads are written or marked gone here. A member wanted gone is still read
// until its status is gone: its close needs the closed terminal seen gone (decide.ts walkReality none).
import type { Observer, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { redact } from "../core/redact.ts";
import type { Terminal } from "../../backend/contract.ts";
import { contracts, sharedContracts, type MakeContract, type Contracted } from "../squad/contracts.ts";
import { localPath } from "../drivers/contract.ts";
import { promptDraft, workingOnScreen } from "../squad/member-ready.ts";
import { limitInt } from "../settings/limits.ts";
import { mainAgents, subAgents, liveModel, shellAdapter, type LiveAccount, type SubAgent, type Walk } from "./orca.ts";
import { studioContract } from "../squad/backend.ts";
import { adoptStudio, contractCandidates, STUDIO_SQUAD, studioAgent, studioMember } from "../squad/studio.ts";

export type ContractObserverOpts = {
  backends?: MakeContract;                 // a test's fake; the shared resolver by default
  walk?: () => Promise<LiveAccount[]>;      // the host's process walk; orca.sh agent-accounts by default
};

type Seen = { m: Row; path: string; t: Terminal | null; others: Terminal[] };
type Group = { topic: string; backend: string; members: Row[]; studio?: boolean };
type Walk2 = { main: Map<string, Walk>; subs: Map<string, SubAgent[]> };

const inFolder = (ts: Terminal[], path: string) => ts.filter((t) => t.cwd.replace(/\/+$/, "") === path).sort((a, b) => b.created_at - a.created_at);
// The member's terminal: of its own generation first, else the newest in its folder.
export function terminalFor(ts: Terminal[], path: string, gen: unknown): Terminal | null {
  const here = inFolder(ts, path);
  return here.find((t) => gen != null && t.gen === String(gen)) ?? here[0] ?? null;
}

// U51: the project's Studio when it runs off Orca (studio_backend) in a `local::` folder, as one group of
// squad `_studio`: its member row once adopted, else a stand-in, so its folder is read before the first adoption.
export function studioGroup(store: Store, project: string): Group | null {
  const sc = studioContract(store, project);
  const wt = String(store.get("projects", { label: project })?.studio_wt ?? "");
  if (!sc || !localPath(wt)) return null;
  const m = studioMember(store, project, wt) ?? { project, squad: STUDIO_SQUAD, role: "studio", suffix: "", wt, gen: null, handle: null };
  return { topic: STUDIO_SQUAD, backend: sc.backend, members: [m], studio: true };
}

// The Studio's terminal: the one adoptStudio holds or would hold (squad/studio.ts contractCandidates, by DS_GEN),
// else the newest in its folder, so a folder with no single candidate is still read and its terminals listed.
export function studioTerminal(ts: Terminal[], path: string, m: Row): Terminal | null {
  const here = inFolder(ts, path);
  const cands = contractCandidates(here.map((t) => ({ handle: t.id, title: t.label, identity: null, gen: t.gen })), m.gen);
  const held = cands.find((t) => t.handle === m.handle) ?? (cands.length === 1 ? cands[0] : undefined);
  return (held && here.find((t) => t.id === held.handle)) || terminalFor(ts, path, m.gen);
}

// The state the loop reads for a terminal (see the header).
export function readState(o: { native: string | null; out: number | null; transcript: number | null; tail: string; walk: string; now: number; quiet: number }): string {
  if (o.walk === "none") return "idle";
  if (o.native && o.native !== "unknown") return o.native;
  const moved = Math.max(o.out ?? 0, o.transcript ?? 0);
  if ((moved > 0 && o.now - moved < o.quiet) || workingOnScreen(o.tail)) return "working";
  if (o.walk === "running" && promptDraft(o.tail) === "") return "idle";
  return "unknown";
}

export function contractObserver(opts: ContractObserverOpts = {}): Observer {
  const resolve = opts.backends ? contracts(opts.backends) : sharedContracts;
  const walk = opts.walk ?? (() => shellAdapter().agentAccounts!());
  let walkedAt = -Infinity, walkTick = -1, walkRead: Promise<LiveAccount[] | "failed" | null> = Promise.resolve(null);
  // The walk is host-wide: read once per tick whichever project asks first, and only on its cadence.
  const host = (tick: number, now: number) => {
    if (walkTick !== tick) {
      walkTick = tick;
      const due = now - walkedAt >= envInt("DS_LOOP_LIVE_ACCOUNT_S", 30);
      if (due) walkedAt = now;
      walkRead = due ? walk().catch(() => "failed" as const) : Promise.resolve(null);
    }
    return walkRead;
  };

  return {
    name: "contract",
    async run(ctx: TickCtx) {
      const { store, project, now } = ctx;
      const squads = store.db.query(`SELECT topic, backend FROM squads WHERE project = ? AND COALESCE(backend, 'orca') != 'orca'
          AND COALESCE(status, '') NOT IN ('closed', 'gone') ORDER BY topic`).all(project) as Row[];
      const groups: Group[] = squads.map((sq) => ({ topic: String(sq.topic), backend: String(sq.backend), members: (store.db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND wt LIKE 'local::%' AND COALESCE(host, '') NOT IN (SELECT name FROM hosts)
            AND COALESCE(status, '') != 'gone' ORDER BY id`).all(project, String(sq.topic)) as Row[]).filter((m) => localPath(String(m.wt))) }));
      // U51: a Studio off Orca, read whether or not the project has a squad off Orca.
      // A side host runs no Studio: its copy of the projects row names main's.
      const studio = ctx.role === "side" ? null : studioGroup(store, project);
      if (studio) groups.push(studio);
      if (!groups.some((g) => g.members.length)) return;
      const procs = await host(ctx.tick, now);
      const quiet = limitInt(store, project, "chat_quiet_s", 10);
      for (const g of groups) {
        const { topic, members } = g;
        if (!members.length) continue;
        let c: Contracted;
        try { c = resolve(store, g.backend, project); } catch (e) {
          store.event("plugin_error", { project, squad: topic, payload: { plugin: "observer:contract", error: (e as Error).message } });
          continue;
        }
        const l = await c.backend.call("terminal.list", {});
        if (!l.ok) continue; // no evidence: nothing written, nothing marked gone
        const seen: Seen[] = members.map((m) => {
          const path = localPath(String(m.wt))!.replace(/\/+$/, "");
          const t = g.studio ? studioTerminal(l.terminals, path, m) : terminalFor(l.terminals, path, m.gen);
          return { m, path, t, others: t ? inFolder(l.terminals, path).filter((o) => o.id !== t.id) : [] };
        });
        const ps = seen.map((s) => ({ worktreeId: String(s.m.wt), path: s.path }));
        // The Studio's walk counts only its own agent, as on Orca (its folder may hold other agents).
        const pin = new Map(g.studio ? [[String(members[0]!.wt), studioAgent(store.get("projects", { label: project }))]] : []);
        const walks: Walk2 | null = Array.isArray(procs) ? { main: mainAgents(ps, procs, pin), subs: subAgents(ps, procs) } : null;
        // The backend reads per live terminal, outside the write.
        const reads = await Promise.all(seen.map(async (s) => {
          if (!s.t) return null;
          const id = s.t.id;
          const [out, screen, st] = await Promise.all([
            c.backend.call("terminal.last_output", { id }),
            c.backend.call("terminal.read", { id, screen: true }),
            c.caps.state === "native" ? c.backend.call("agent.state", { id }) : Promise.resolve(null),
          ]);
          // U12b: the other terminals in its folder, for the stray and duplicate checks (reconcilers/members.ts).
          const others = await Promise.all(s.others.map(async (o) => { const r = await c.backend.call("terminal.last_output", { id: o.id }); return r.ok ? r.at : null; }));
          return { out: out.ok ? out.at : null, tail: screen.ok ? redact(screen.text).trimEnd() : null, native: st?.ok ? st.state : null, others };
        }));
        // U21f: a backend whose worktrees are Orca's (`parents native`) keeps the tree in Orca: read the parent it shows.
        const trees = await Promise.all(seen.map(async (s) => {
          if (c.caps.parents !== "native") return undefined;
          const r = await c.backend.call("worktree.parent", { cwd: s.path });
          return r.ok ? r.parent : undefined;   // no answer: the loop's own record stands
        }));
        store.tx(() => {
          seen.forEach((s, i) => write(store, project, topic, s, reads[i], walks, procs === "failed", now, quiet, trees[i]));
          // U51: after a list that succeeded, as the Orca observer adopts an Orca Studio (observers/orca.ts).
          if (g.studio) adoptStudio(store, project, now);
        });
      }
    },
  };
}

function write(store: Store, project: string, topic: string, s: Seen, r: { out: number | null; tail: string | null; native: string | null; others: (number | null)[] } | null,
  walks: Walk2 | null, failed: boolean, now: number, quiet: number, shown?: string | null): void {
  const wt = String(s.m.wt), prev = store.get("observed_workers", { project, wt });
  const wtRow = store.db.query("SELECT branch, parent_path FROM worktrees WHERE host = 'local' AND path = ?").get(s.path) as Row | null;
  const tree = (agents: number | null) => store.upsert("observed_worktrees", { project, wt }, { path: s.path, branch: wtRow?.branch ?? null,
    parent: shown !== undefined ? (shown ? `local::${shown}` : null) : wtRow?.parent_path ? `local::${wtRow.parent_path}` : null, doc: { agents, backend: "contract" }, observed_at: now, gone_at: null });
  if (!s.t || !r) {
    // Its terminal is gone: the worker with it. The walk's last verdict stays for the decider. Stamped each
    // tick, as on Orca, with no terminal seen this tick, so a pause (fulfil/pause.ts) can finish after its close.
    if (prev) store.upsert("observed_workers", { project, wt }, { gone_at: prev.gone_at ?? now, observed_at: now, presence: "none",
      doc: { squad: topic, role: s.m.role, suffix: s.m.suffix ?? "", backend: "contract", terminal: null, agent_states: [], terminals_seen_at: now } });
    store.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND wt = ? AND gone_at IS NULL", [now, project, wt]);
    tree(0);
    return;
  }
  let ran: Row = failed ? { walk: "unknown" } : {};
  if (walks) {
    const { walk, main } = walks.main.get(wt) ?? { walk: "none" as const, main: null };
    const live = main ? liveModel(store, project, wt, main) : { model: null, effort: null };
    // Its sub-agents as on Orca: NULL once none are live (a pause closes only with none).
    const sub = JSON.stringify(walks.subs.get(wt) ?? []);
    ran = { walk, agent: main?.agent ?? null, account: main?.account ?? null, account_at: now, pid: main?.pid ?? null,
      started_at: main?.start ?? null, rss_kb: main?.rss ?? null, live_model: live.model, live_effort: live.effort, sub_agents: sub !== "[]" ? sub : null };
  }
  const walk = String(ran.walk ?? prev?.walk ?? "unknown");
  const tail = r.tail ?? String(prev?.tail ?? "");
  const tr = store.db.query("SELECT MAX(mtime) AS t FROM observed_transcripts WHERE project = ? AND wt = ?").get(project, wt) as { t: number | null };
  const state = readState({ native: r.native, out: r.out, transcript: tr.t, tail, walk, now, quiet });
  store.upsert("observed_terminals", { project, handle: s.t.id }, { wt, title: `${topic}/${s.t.label}`,
    doc: { agent: walk === "running", squad: topic, role: s.m.role, suffix: s.m.suffix ?? "", newest: true, gen: s.t.gen, last_output_at: r.out, unread: 0 },
    ...(r.tail != null ? { tail: r.tail, tail_at: now } : {}), observed_at: now, gone_at: null });
  // Every other terminal in the folder, as Orca lists them: one the loop started (a generation) counts
  // as an agent, one with none is a plain shell. `extra` marks it as not the member's own.
  s.others.forEach((o, i) => store.upsert("observed_terminals", { project, handle: o.id }, { wt, title: `${topic}/${o.label}`,
    doc: { agent: o.gen != null, squad: topic, role: s.m.role, suffix: s.m.suffix ?? "", newest: false, gen: o.gen, last_output_at: r.others[i], unread: 0, extra: true },
    observed_at: now, gone_at: null }));
  store.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND wt = ? AND gone_at IS NULL AND handle NOT IN (SELECT value FROM json_each(?))",
    [now, project, wt, JSON.stringify([s.t.id, ...s.others.map((o) => o.id)])]);
  store.upsert("observed_workers", { project, wt }, { state, unread: 0, last_output_at: r.out, name: s.t.label,
    since: prev?.state === state && prev?.gone_at == null ? prev.since ?? now : now,
    doc: { squad: topic, role: s.m.role, suffix: s.m.suffix ?? "", backend: "contract", terminal: s.t.id, agent_states: [state], terminals_seen_at: now },
    ...(r.tail != null ? { tail: r.tail, tail_at: now, suspect: 0 } : { suspect: 1 }),
    ...ran, presence: walk === "running" ? "running" : walk === "none" ? "none" : "unknown", observed_at: now, gone_at: null });
  tree(walk === "running" ? 1 : walk === "none" ? 0 : null);
}

export default contractObserver();
