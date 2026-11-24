// ds trial — the record helper for a backend trial (orca-backend-alternatives U16a; docs/backends/trial-orca-lite.md,
// and the same fields for the tmux and herdr trials). Read-only: it opens loop.db read-only, walks /proc and, for a
// squad on orca or orca-lite, reads each worktree through the Orca adapter's `wt-show` (never the orca CLI itself).
//
//   snapshot <project> <squad> [--step <name>] [--no-orca] [--json]
//       one block for the record, taken before and after each drill step: the squad's backend, the loop's pid and
//       memory, the Orca CLI spawns of the last tick, the squad's ledgered backend calls by op and state, every
//       member with its generation and agent pids (RSS), the squad's `worktrees` rows and Orca's view of each
//       worktree (`parentWorktreeId`, `childWorktreeIds`: the nesting Orca's window shows)
//   events <project> <squad> [--since <iso|epoch>] [--json]
//       the events the record names by id: starts (fresh or resumed), stops, closes (the retirement), unit_done (the
//       merge), finish rows, shadow crashes and disagreements, the watchdog's loop restarts
//
// The loop's pid is DS_LOOP_PID, else ds-loop.service's MainPID; the Orca adapter is ORCA_ADAPTER, else
// bin/backend/orca.sh. The drill's crash itself is bin/host/shadow-drill.sh crash <worktree>.
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { openReadOnly, dbPath, type Row, type Store } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel, ROOT, stateRoot } from "../lib/shared";

export const help = "snapshot <project> <squad> [--step s] [--no-orca] [--json] | events <project> <squad> [--since t] [--json] — the record of a backend trial";

const USAGE = `usage: ds trial snapshot <project> <squad> [--step <name>] [--no-orca] [--json]
       ds trial events <project> <squad> [--since <iso|epoch>] [--json]`;

export const TRIAL_KINDS = ["member_started", "member_stopped", "member_closed", "unit_done", "finish_recorded",
  "shadow_crash", "shadow_disagree", "loop_restart", "leftover_recorded"] as const;

const iso = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : "-");
const pathOf = (wt: unknown) => { const v = String(wt ?? ""); const i = v.indexOf("::"); return i >= 0 ? v.slice(i + 2) : v; };
const labelOf = (m: Row) => `${m.role}${m.suffix ? `-${m.suffix}` : ""}`;

function when(v: string): number | null {
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/** A process's resident memory in MB, null when it is gone. */
export function rssMb(pid: number): number | null {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
  } catch { return null; }
}

/** The agent processes working in a folder: cwd at or under it, and argv[0] or argv[1] named for the agent. */
export function agentPids(path: string, agent: string, proc = "/proc"): number[] {
  if (!path) return [];
  const out: number[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(proc).filter((d) => /^\d+$/.test(d)); } catch { return []; }
  for (const id of ids) {
    let cwd = "", argv: string[] = [];
    try { cwd = readlinkSync(join(proc, id, "cwd")); argv = readFileSync(join(proc, id, "cmdline"), "utf8").split("\0"); } catch { continue; }
    if (cwd !== path && !cwd.startsWith(`${path}/`)) continue;
    if (argv.slice(0, 2).some((a) => basename(a).startsWith(agent))) out.push(Number(id));
  }
  return out.sort((a, b) => a - b);
}

function loopPid(): number | null {
  const env = process.env.DS_LOOP_PID;
  if (env !== undefined) return /^\d+$/.test(env) && env !== "0" ? Number(env) : null;
  const r = spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", "ds-loop.service"], { encoding: "utf8", timeout: 5000 });
  const v = (r.stdout ?? "").trim();
  return /^\d+$/.test(v) && v !== "0" ? Number(v) : null;
}

function orcaShow(path: string): Record<string, unknown> | { error: string } {
  const adapter = process.env.ORCA_ADAPTER || join(ROOT, "bin", "backend", "orca.sh");
  const r = spawnSync(adapter, ["wt-show", `path:${path}`], { encoding: "utf8", timeout: 30000 });
  if (r.status === 3) return { error: "Orca has no worktree at this path" };
  if (r.status !== 0) return { error: `wt-show failed (${r.status ?? r.signal}): ${(r.stderr ?? "").trim().split("\n").pop() ?? ""}` };
  try { return JSON.parse((r.stdout ?? "").trim().split("\n")[0]); } catch { return { error: "wt-show printed no JSON" }; }
}

function spawnsLastTick(root: string): Record<string, unknown> | null {
  const f = join(root, "loop", "orca-spawns.json");
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

export function snapshot(s: Store, project: string, squad: string, o: { step?: string; orca?: boolean; root?: string; now?: number } = {}) {
  const sq = s.db.query("SELECT topic, status, backend, worktree_provider, run_id FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  if (!sq) return null;
  const members = (s.db.query("SELECT id, role, suffix, agent, wt, status, gen FROM members WHERE project = ? AND squad = ? ORDER BY id").all(project, squad) as Row[])
    .map((m) => {
      const path = pathOf(m.wt), live = m.status !== "gone";
      const pids = live ? agentPids(path, String(m.agent || "claude")) : [];
      return { id: Number(m.id), member: labelOf(m), status: m.status ?? null, gen: m.gen ?? null, wt: m.wt ?? null,
        pids: pids.map((pid) => ({ pid, rss_mb: rssMb(pid) })) };
    });
  const worktrees = s.db.query("SELECT path, role, provider, orca_id, parent_path, branch, lease, created_at, gone_at FROM worktrees WHERE project = ? AND squad = ? ORDER BY created_at, path").all(project, squad) as Row[];
  const ledger = s.db.query("SELECT op, state, count(*) AS n FROM orca_calls WHERE project = ? AND squad = ? GROUP BY op, state ORDER BY op, state").all(project, squad) as Row[];
  const onOrca = sq.backend === "orca" || sq.backend === "orca-lite";
  const orca = o.orca !== false && onOrca
    ? worktrees.filter((w) => !w.gone_at).map((w) => ({ path: String(w.path), role: w.role ?? null, show: orcaShow(String(w.path)) }))
    : null;
  const pid = loopPid();
  return {
    step: o.step ?? null, at: o.now ?? Math.floor(Date.now() / 1000),
    squad: { project, topic: squad, status: sq.status ?? null, backend: sq.backend ?? null, worktree_provider: sq.worktree_provider ?? null, run_id: sq.run_id ?? null },
    loop: { pid, rss_mb: pid ? rssMb(pid) : null },
    spawns: spawnsLastTick(o.root ?? stateRoot()),
    ledger, members, worktrees, orca,
  };
}

export function snapshotText(r: NonNullable<ReturnType<typeof snapshot>>): string[] {
  const out = [`### ${r.step ?? "snapshot"} · ${iso(r.at)}`, "",
    `- squad \`${r.squad.project}/${r.squad.topic}\`: backend ${r.squad.backend}, worktree_provider ${r.squad.worktree_provider}, status ${r.squad.status}, run ${r.squad.run_id ?? "none"}`,
    `- loop: ${r.loop.pid ? `pid ${r.loop.pid}, RSS ${r.loop.rss_mb ?? "?"} MB` : "no pid (ds-loop.service not running, or DS_LOOP_PID unset)"}`];
  const sp = r.spawns as { tick?: number; at?: number; total?: number; top?: { verb: string; n: number }[] } | null;
  out.push(`- Orca CLI spawns, last tick: ${sp ? `tick ${sp.tick} at ${iso(sp.at)}: ${sp.total} (${(sp.top ?? []).map((t) => `${t.verb} ${t.n}`).join(", ") || "none"})` : "no state/loop/orca-spawns.json"}`);
  out.push(`- ledgered backend calls for the squad: ${r.ledger.map((l) => `${l.op} ${l.state} ×${l.n}`).join(", ") || "none"}`);
  out.push("", "| member | status | gen | worktree | agent pids (RSS MB) |", "|---|---|---|---|---|");
  for (const m of r.members)
    out.push(`| ${m.member} | ${m.status ?? "-"} | ${m.gen ?? "-"} | ${m.wt ?? "-"} | ${m.pids.map((p) => `${p.pid} (${p.rss_mb ?? "?"})`).join(", ") || "none"} |`);
  out.push("", "| worktree | role | provider | orca_id | parent | branch | gone |", "|---|---|---|---|---|---|---|");
  for (const w of r.worktrees)
    out.push(`| ${w.path} | ${w.role ?? "-"} | ${w.provider ?? "-"} | ${w.orca_id ?? "-"} | ${w.parent_path ?? "-"} | ${w.branch ?? "-"} | ${w.gone_at ? iso(Number(w.gone_at)) : "-"} |`);
  if (r.orca) {
    out.push("", "Orca's `worktree show` per live worktree:");
    for (const w of r.orca) {
      const v = w.show as Record<string, unknown>;
      out.push(v.error ? `- ${w.role ?? "?"} ${w.path}: ${v.error}`
        : `- ${w.role ?? "?"} \`${v.id}\`: parentWorktreeId \`${v.parentWorktreeId ?? "none"}\`, childWorktreeIds ${JSON.stringify(v.childWorktreeIds ?? null)}`);
    }
  }
  return out;
}

export function events(s: Store, project: string, squad: string, since: number | null) {
  const names = new Map((s.db.query("SELECT wt, role, suffix FROM members WHERE project = ? AND squad = ?").all(project, squad) as Row[]).map((m) => [String(m.wt), labelOf(m)]));
  const kinds = TRIAL_KINDS.map(() => "?").join(", ");
  const rows = s.db.query(`SELECT id, at, kind, member, unit, payload FROM events
      WHERE kind IN (${kinds}) AND at >= ? AND ((project = ? AND squad = ?) OR (kind = 'loop_restart' AND project IS NULL))
      ORDER BY id`).all(...TRIAL_KINDS, since ?? 0, project, squad) as Row[];
  return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), kind: String(r.kind), member: r.member ? names.get(String(r.member)) ?? String(r.member) : null,
    unit: r.unit ?? null, payload: (() => { try { return JSON.parse(String(r.payload)); } catch { return r.payload ?? null; } })() }));
}

export const eventLine = (e: ReturnType<typeof events>[number]) =>
  `#${e.id} ${iso(e.at)} ${e.kind}${e.member ? ` ${e.member}` : ""}${e.unit ? ` unit ${e.unit}` : ""} ${JSON.stringify(e.payload).slice(0, 160)}`;

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds trial: ${why}\n${USAGE}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["step", "since"], ["json", "no-orca"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  const [sub, proj, squad, ...rest] = pos;
  if (sub !== "snapshot" && sub !== "events") return usage(`unknown subcommand '${sub ?? ""}'`);
  if (!proj || !squad || rest.length) return usage(`${sub} takes a project and a squad`);
  if (!existsSync(dbPath())) { console.error(`ds trial: no loop.db at ${dbPath()}`); return 1; }
  const project = dsLabel(proj);
  const s = openReadOnly();
  try {
    if (sub === "snapshot") {
      const r = snapshot(s, project, squad, { step: opt.step, orca: !flag.has("no-orca") });
      if (!r) { console.error(`ds trial: no squad ${project}/${squad}`); return 1; }
      if (flag.has("json")) print(r); else for (const l of snapshotText(r)) console.log(l);
      return 0;
    }
    const since = opt.since === undefined ? null : when(opt.since);
    if (opt.since !== undefined && since === null) return usage(`--since is an ISO date or an epoch, not '${opt.since}'`);
    const evs = events(s, project, squad, since);
    if (flag.has("json")) print(evs); else for (const e of evs) console.log(eventLine(e));
    return 0;
  } finally { s.close(); }
}
