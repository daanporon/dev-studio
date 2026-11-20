// unexposed.ts — the ports a squad's members listen on that no `ds expose` entry covers (exposed-cleanup U3).
// Read by the unexposed reconciler (one message per new port) and, read-only, by the board. It reads only:
// the squad, its live members (and its Lead's worktree), their observed_procs `listen` (observers/procs.ts)
// and the squad's open `exposed` entries.
// Covered: the port of every open entry's URL (any audience, `--self` included) and its `--ports`.
// Kept: a port of a live member's worktree, or the Lead's, not covered and listened on for `warnMin` minutes.
// A done or closing squad has none.
import type { Store } from "../core/store.ts";
import { target } from "../observers/exposed.ts";

type Db = Store["db"];
export type Unexposed = {
  wt: string; role: string; suffix: string;
  member: number | null;   // the members row id; null for a Lead known only by the squad's lead_wt
  squadId: number;
  port: number; since: number; comm: string; addr: string; src: string; pid: number | null;
};

// The ports the squad's open entries cover.
export function coveredPorts(db: Db, project: string, squad: string): Set<number> {
  const out = new Set<number>();
  const rows = db.query("SELECT url, ports FROM exposed WHERE project = ? AND squad = ? AND gone_at IS NULL").all(project, squad) as { url: string; ports: string | null }[];
  for (const r of rows) {
    const t = target(String(r.url));
    if (t) out.add(t.port);
    let ps: unknown = [];
    try { ps = JSON.parse(r.ports ?? "[]"); } catch { /* unreadable: none */ }
    for (const p of Array.isArray(ps) ? ps : []) if (Number.isInteger(Number(p))) out.add(Number(p));
  }
  return out;
}

export function unexposedPorts(db: Db, project: string, squad: string, now: number, warnMin: number): Unexposed[] {
  const sq = db.query("SELECT id, status, want, lead_wt FROM squads WHERE project = ? AND topic = ?").get(project, squad) as
    { id: number; status: string | null; want: string | null; lead_wt: string | null } | null;
  if (!sq || ["closed", "gone", "done"].includes(String(sq.status ?? "")) || sq.want === "gone") return [];
  const who = db.query(`SELECT id, wt, role, suffix FROM members WHERE project = ? AND squad = ? AND wt IS NOT NULL AND wt != ''
    AND COALESCE(status, '') != 'gone' ORDER BY id`).all(project, squad) as { id: number; wt: string; role: string; suffix: string }[];
  const members: { wt: string; role: string; suffix: string; member: number | null }[] = who.map((m) => ({ wt: m.wt, role: m.role, suffix: m.suffix ?? "", member: m.id }));
  if (sq.lead_wt && !who.some((m) => m.wt === sq.lead_wt)) members.push({ wt: sq.lead_wt, role: "lead", suffix: "", member: null });
  if (!members.length) return [];
  const covered = coveredPorts(db, project, squad);
  const out: Unexposed[] = [];
  const q = db.query("SELECT listen FROM observed_procs WHERE project = ? AND wt = ?");
  for (const m of members) {
    let raw: string | null = null;
    try { raw = (q.get(project, m.wt) as { listen: string | null } | null)?.listen ?? null; } catch { return []; }   // before migration 0049
    let list: unknown = [];
    try { list = JSON.parse(raw ?? "[]"); } catch { /* unreadable: none */ }
    for (const l of (Array.isArray(list) ? list : []) as Record<string, unknown>[]) {
      const port = Number(l.port), since = Number(l.since);
      if (!Number.isInteger(port) || !Number.isFinite(since) || covered.has(port) || now - since < warnMin * 60) continue;
      out.push({ ...m, squadId: sq.id, port, since, comm: String(l.comm ?? "?"), addr: String(l.addr ?? "any"), src: String(l.src ?? "proc"),
        pid: l.pid == null ? null : Number(l.pid) });
    }
  }
  return out;
}

// The subject of a member's "already named" marker: its members row, or the squad's Lead by squad id.
export const warnSubject = (u: Pick<Unexposed, "member" | "squadId">) => (u.member !== null ? `unexposed:${u.member}` : `unexposed:lead:${u.squadId}`);

// A name `ds expose` accepts for a port's suggested entry: the process or container name and the port.
export function suggestName(comm: string, port: number): string {
  const base = comm.split(/\s+/)[0].replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 30);
  return base ? `${base}-${port}` : `port-${port}`;
}

// The message body: the ports, then the command per port.
export function warnBody(squad: string, role: string, ports: Unexposed[], warnMin: number): string {
  const squadFlag = role === "tester" ? " --squad" : "";
  const lines = [`You have listened for ${warnMin}+ minutes on port${ports.length > 1 ? "s" : ""} that no \`ds expose\` entry of squad ${squad} covers:`];
  for (const p of ports) lines.push(`- ${p.port}: ${p.src === "docker" ? `container ${p.comm}` : `${p.comm}${p.pid !== null ? ` (pid ${p.pid})` : ""}`}, ${p.addr === "loopback" ? "loopback only" : "all addresses"}`);
  lines.push("", "Register each so the board lists it and the loop stops it when you finish:");
  for (const p of ports) {
    const stop = p.src === "docker" ? `docker stop ${p.comm}` : "<command that stops it>";
    lines.push(`  ds expose ${suggestName(p.comm, p.port)} http://127.0.0.1:${p.port}${squadFlag} --stop "${stop}"`);
  }
  lines.push("Not a web page (a database, a queue)? Cover its port from an entry instead: re-run that entry's `ds expose` with all its flags and `--ports` listing every port it covers (`--ports` replaces the list).",
    "A tool only you use? Add `--self`.",
    `Each port is named to you once; nothing to reply.`);
  return lines.join("\n");
}
