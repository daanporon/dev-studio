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
import { mainAgents, liveModel, shellAdapter, type LiveAccount, type Walk } from "./orca.ts";

export type ContractObserverOpts = {
  backends?: MakeContract;                 // a test's fake; the shared resolver by default
  walk?: () => Promise<LiveAccount[]>;      // the host's process walk; orca.sh agent-accounts by default
};

type Seen = { m: Row; path: string; t: Terminal | null };

// The member's terminal: of its own generation first, else the newest in its folder.
export function terminalFor(ts: Terminal[], path: string, gen: unknown): Terminal | null {
  const here = ts.filter((t) => t.cwd.replace(/\/+$/, "") === path).sort((a, b) => b.created_at - a.created_at);
  return here.find((t) => gen != null && t.gen === String(gen)) ?? here[0] ?? null;
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
      if (!squads.length) return;
      const procs = await host(ctx.tick, now);
      const quiet = limitInt(store, project, "chat_quiet_s", 10);
      for (const sq of squads) {
        const topic = String(sq.topic);
        const members = (store.db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND wt LIKE 'local::%'
            AND COALESCE(status, '') != 'gone' ORDER BY id`).all(project, topic) as Row[])
          .filter((m) => localPath(String(m.wt)));
        if (!members.length) continue;
        let c: Contracted;
        try { c = resolve(store, String(sq.backend), project); } catch (e) {
          store.event("plugin_error", { project, squad: topic, payload: { plugin: "observer:contract", error: (e as Error).message } });
          continue;
        }
        const l = await c.backend.call("terminal.list", {});
        if (!l.ok) continue; // no evidence: nothing written, nothing marked gone
        const seen: Seen[] = members.map((m) => {
          const path = localPath(String(m.wt))!.replace(/\/+$/, "");
          return { m, path, t: terminalFor(l.terminals, path, m.gen) };
        });
        const walks: Map<string, Walk> | null = Array.isArray(procs)
          ? mainAgents(seen.map((s) => ({ worktreeId: String(s.m.wt), path: s.path })), procs) : null;
        // The backend reads per live terminal, outside the write.
        const reads = await Promise.all(seen.map(async (s) => {
          if (!s.t) return null;
          const id = s.t.id;
          const [out, screen, st] = await Promise.all([
            c.backend.call("terminal.last_output", { id }),
            c.backend.call("terminal.read", { id, screen: true }),
            c.caps.state === "native" ? c.backend.call("agent.state", { id }) : Promise.resolve(null),
          ]);
          return { out: out.ok ? out.at : null, tail: screen.ok ? redact(screen.text).trimEnd() : null, native: st?.ok ? st.state : null };
        }));
        store.tx(() => {
          seen.forEach((s, i) => write(store, project, topic, s, reads[i], walks, procs === "failed", now, quiet));
        });
      }
    },
  };
}

function write(store: Store, project: string, topic: string, s: Seen, r: { out: number | null; tail: string | null; native: string | null } | null,
  walks: Map<string, Walk> | null, failed: boolean, now: number, quiet: number): void {
  const wt = String(s.m.wt), prev = store.get("observed_workers", { project, wt });
  const wtRow = store.db.query("SELECT branch, parent_path FROM worktrees WHERE host = 'local' AND path = ?").get(s.path) as Row | null;
  const tree = (agents: number | null) => store.upsert("observed_worktrees", { project, wt }, { path: s.path, branch: wtRow?.branch ?? null,
    parent: wtRow?.parent_path ? `local::${wtRow.parent_path}` : null, doc: { agents, backend: "contract" }, observed_at: now, gone_at: null });
  if (!s.t || !r) {
    // Its terminal is gone: the worker with it. The walk's last verdict stays for the decider.
    if (prev && prev.gone_at == null) store.upsert("observed_workers", { project, wt }, { gone_at: now, observed_at: now, presence: "none" });
    store.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND wt = ? AND gone_at IS NULL", [now, project, wt]);
    tree(0);
    return;
  }
  let ran: Row = failed ? { walk: "unknown" } : {};
  if (walks) {
    const { walk, main } = walks.get(wt) ?? { walk: "none" as const, main: null };
    const live = main ? liveModel(store, project, wt, main) : { model: null, effort: null };
    ran = { walk, agent: main?.agent ?? null, account: main?.account ?? null, account_at: now, pid: main?.pid ?? null,
      started_at: main?.start ?? null, rss_kb: main?.rss ?? null, live_model: live.model, live_effort: live.effort };
  }
  const walk = String(ran.walk ?? prev?.walk ?? "unknown");
  const tail = r.tail ?? String(prev?.tail ?? "");
  const tr = store.db.query("SELECT MAX(mtime) AS t FROM observed_transcripts WHERE project = ? AND wt = ?").get(project, wt) as { t: number | null };
  const state = readState({ native: r.native, out: r.out, transcript: tr.t, tail, walk, now, quiet });
  store.upsert("observed_terminals", { project, handle: s.t.id }, { wt, title: `${topic}/${s.t.label}`,
    doc: { agent: walk === "running", squad: topic, role: s.m.role, suffix: s.m.suffix ?? "", newest: true, gen: s.t.gen, last_output_at: r.out, unread: 0 },
    ...(r.tail != null ? { tail: r.tail, tail_at: now } : {}), observed_at: now, gone_at: null });
  store.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND wt = ? AND gone_at IS NULL AND handle != ?", [now, project, wt, s.t.id]);
  store.upsert("observed_workers", { project, wt }, { state, unread: 0, last_output_at: r.out, name: s.t.label,
    since: prev?.state === state && prev?.gone_at == null ? prev.since ?? now : now,
    doc: { squad: topic, role: s.m.role, suffix: s.m.suffix ?? "", backend: "contract", terminal: s.t.id, agent_states: [state], terminals_seen_at: now },
    ...(r.tail != null ? { tail: r.tail, tail_at: now, suspect: 0 } : { suspect: 1 }),
    ...ran, presence: walk === "running" ? "running" : walk === "none" ? "none" : "unknown", observed_at: now, gone_at: null });
  tree(walk === "running" ? 1 : walk === "none" ? 0 : null);
}

export default contractObserver();
