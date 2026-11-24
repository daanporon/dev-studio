// ds tmux-drill — the helper for the tmux trial (orca-backend-alternatives U16b, docs/backends/trial-tmux.md).
//   ds tmux-drill version --new <tmux> [--old <tmux>] [--json]
//       the version-change drill: a server of the old build (default: tmux on PATH) on a private socket in a
//       temp folder, started through server-unit as the loop starts one, one terminal running a stand-in agent
//       (`sleep`), then every contract op through a client of the new build against that server. It prints
//       whether the new client is refused, whether the agent outlived it and whether the old client still
//       answers, then stops that server. It never touches a project's socket.
//   ds tmux-drill snapshot <project> [--json]
//       read-only: the project's tmux server (`-L ds-<project>`: pid, version, RSS), each window (session,
//       pane, pane pid, label, gen, the agent processes under it) and the live `worktrees` rows of the
//       project's squads on tmux. Run before and after each trial step and paste both into the record.
// A second tmux build: `nix build --no-link --print-out-paths nixpkgs#tmux` prints a prefix holding bin/tmux.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parse } from "../loop/core/cli.ts";
import { stateRoot } from "../lib/shared.ts";
import { tmuxBackend } from "../backend/tmux.ts";
import { serverAlive } from "../backend/server-unit.ts";
import { readCmdline, scanProc, type Proc } from "../loop/io/proc.ts";

export const help = "version --new <tmux> [--old <tmux>] | snapshot <project> [--json] — the tmux trial's version-change drill and before/after snapshot (U16b)";

const USAGE = "usage: ds tmux-drill version --new <tmux> [--old <tmux>] [--json]\n       ds tmux-drill snapshot <project> [--json]\n";
const REFUSED = /version mismatch|version is too old/i;

type Ran = { code: number; out: string; err: string };
function tmux(bin: string, sock: string[], args: string[]): Ran {
  const env = { ...process.env };
  delete env.TMUX; delete env.TMUX_PANE;
  const r = Bun.spawnSync([bin, "-N", ...sock, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
const versionOf = (bin: string): string => {
  const r = Bun.spawnSync([bin, "-V"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : `unknown (${r.stderr.toString().trim() || `exit ${r.exitCode}`})`;
};
const rssKb = (procs: Proc[], pid: number): number | null => procs.find((p) => p.pid === pid)?.rss_kb ?? null;

type Step = { op: string; ok: boolean; detail: string };

export async function versionDrill(o: { oldBin: string; newBin: string }) {
  const dir = mkdtempSync(join(tmpdir(), "ds-tmux-drill-"));
  const sockPath = join(dir, "drill.sock"), sock = ["-S", sockPath];
  const old = tmuxBackend({ socket: sockPath, tmux: o.oldBin, shell: "/bin/sh",
    server: { name: `tmux-drill-${process.pid}-${Date.now()}`, log: join(dir, "server.log") } });
  const fresh = tmuxBackend({ socket: sockPath, tmux: o.newBin, shell: "/bin/sh" });
  const steps: Step[] = [];
  const note = (op: string, a: { ok: boolean; error?: { code: string; message: string } }, detail = "") =>
    steps.push({ op, ok: a.ok, detail: a.ok ? detail : `${a.error?.code}: ${a.error?.message}` });
  try {
    const made = await old.call("terminal.create", { cwd: dir, env: { DS_GEN: "drill-old" }, label: "agent", group: "drill" });
    if (!made.ok) throw new Error(`old server: create failed: ${made.error.message}`);
    const id = made.terminal.id;
    await old.call("terminal.send", { id, text: "exec sleep 86400", submit: true });
    let agentPid = 0;
    for (let t = 0; t < 5000 && !agentPid; t += 100) {
      const p = Number(tmux(o.oldBin, sock, ["display-message", "-p", "-t", id, "#{pane_pid}"]).out);
      if (p && readCmdline("/proc", p)[0] === "sleep") agentPid = p;
      else await Bun.sleep(100);
    }
    if (!agentPid) throw new Error("old server: the stand-in agent never started");
    const server = tmux(o.oldBin, sock, ["display-message", "-p", "-t", id, "#{pid} #{version}"]).out.split(" ");
    const serverPid = Number(server[0]), serverVersion = server[1] ?? "unknown";

    const raw = tmux(o.newBin, sock, ["list-sessions", "-F", "#{session_name}"]);
    steps.push({ op: "list-sessions (new client)", ok: raw.code === 0, detail: raw.code === 0 ? raw.out : raw.err || `exit ${raw.code}` });
    const l = await fresh.call("terminal.list", {});
    note("terminal.list", l, l.ok ? `${l.terminals.length} terminal(s), gen ${l.terminals.map((t) => t.gen).join(",")}` : "");
    const rd = await fresh.call("terminal.read", { id });
    note("terminal.read", rd, rd.ok ? `${rd.text.split("\n").filter(Boolean).length} line(s)` : "");
    const lo = await fresh.call("terminal.last_output", { id });
    note("terminal.last_output", lo, lo.ok ? String(lo.at) : "");
    const second = await fresh.call("terminal.create", { cwd: dir, env: { DS_GEN: "drill-new" }, label: "second", group: "drill" });
    note("terminal.create", second, second.ok ? second.terminal.id : "");
    if (second.ok) {
      const s = await fresh.call("terminal.send", { id: second.terminal.id, text: "echo drill-new", submit: true });
      note("terminal.send", s, s.ok ? s.delivery : "");
      const c = await fresh.call("terminal.close", { id: second.terminal.id });
      note("terminal.close", c);
    }
    const refused = steps.some((s) => !s.ok && REFUSED.test(s.detail));
    const agentAlive = serverAlive(agentPid);
    const back = await old.call("terminal.list", {});
    return {
      old: { bin: o.oldBin, version: versionOf(o.oldBin) }, new: { bin: o.newBin, version: versionOf(o.newBin) },
      server: { pid: serverPid, version: serverVersion, rss_kb: rssKb(scanProc().procs, serverPid) },
      agent_pid: agentPid, steps, refused, failed: steps.filter((s) => !s.ok).length,
      agent_alive: agentAlive, old_client_after: back.ok ? `ok (${back.terminals.length} terminal(s))` : back.error.message,
    };
  } finally {
    await old.killServer();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The processes under a pane (its descendants), each `<pid> <cmdline, 80 chars>`.
function descendants(procs: Proc[], root: number): string[] {
  const kids = new Map<number, number[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const out: string[] = [], todo = [...(kids.get(root) ?? [])];
  while (todo.length) {
    const pid = todo.shift()!;
    const argv = readCmdline("/proc", pid);
    if (!argv.length) continue;
    out.push(`${pid} ${argv.join(" ").slice(0, 80)}`);
    todo.push(...(kids.get(pid) ?? []));
  }
  return out;
}

export function snapshot(project: string, o: { root?: string } = {}) {
  const sock = ["-L", `ds-${project.replace(/[^A-Za-z0-9_.-]/g, "-")}`], bin = Bun.which("tmux") ?? "tmux";
  const { procs } = scanProc();
  const at = new Date().toISOString();
  // display-message answers for a server with no session left too (exit-empty is off); list-sessions would print nothing.
  const srv = tmux(bin, sock, ["display-message", "-p", "#{pid} #{version}"]);
  const [pid, version] = srv.code === 0 ? srv.out.split(" ") : [];
  const windows = srv.code !== 0 ? [] : tmux(bin, sock, ["list-panes", "-a", "-F", "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{@ds_meta}"])
    .out.split("\n").filter(Boolean).map((line) => {
      const [session, pane, panePid, meta] = line.split("\t");
      let m: { label?: string; gen?: string | null; cwd?: string } = {};
      try { m = JSON.parse(decodeURIComponent(meta ?? "")); } catch { /* not ours */ }
      return { session, pane, pane_pid: Number(panePid), label: m.label ?? null, gen: m.gen ?? null, cwd: m.cwd ?? null,
        processes: descendants(procs, Number(panePid)) };
    });
  const db = join(o.root ?? stateRoot(), "loop.db");
  let worktrees: unknown[] = [], members: unknown[] = [];
  if (existsSync(db)) {
    const d = new Database(db, { readonly: true });
    try {
      worktrees = d.query(`SELECT w.squad, w.role, w.path, w.branch, w.provider, w.created_at FROM worktrees w
        JOIN squads s ON s.project = w.project AND s.topic = w.squad
        WHERE w.project = ? AND s.backend = 'tmux' AND w.gone_at IS NULL ORDER BY w.squad, w.path`).all(project);
      members = d.query(`SELECT m.squad, m.role, m.suffix, m.wt, m.gen, m.status FROM members m
        JOIN squads s ON s.project = m.project AND s.topic = m.squad
        WHERE m.project = ? AND s.backend = 'tmux' ORDER BY m.squad, m.role, m.suffix`).all(project);
    } finally { d.close(); }
  }
  return {
    at, project, socket: sock[1],
    server: srv.code === 0 ? { pid: Number(pid), version, rss_kb: rssKb(procs, Number(pid)) } : { down: srv.err || `exit ${srv.code}` },
    windows, members, worktrees,
  };
}

function versionText(r: Awaited<ReturnType<typeof versionDrill>>): string {
  const lines = [
    `old: ${r.old.version} (${r.old.bin}) — server pid ${r.server.pid}, server reports ${r.server.version}, rss ${r.server.rss_kb ?? "?"} kB`,
    `new: ${r.new.version} (${r.new.bin})`,
    ...r.steps.map((s) => `  ${s.ok ? "ok    " : "FAILED"} ${s.op}${s.detail ? `: ${s.detail}` : ""}`),
    `new client on the old server: ${r.refused ? "refused" : r.failed ? `${r.failed} op(s) failed, not a version refusal` : "accepted"}`,
    `agent pid ${r.agent_pid} after the new client: ${r.agent_alive ? "alive" : "gone"}`,
    `old client after: ${r.old_client_after}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function run(args: string[]): Promise<number> {
  const { pos, opt, flag } = parse(args, ["new", "old"], ["json"]);
  const [cmd, project] = pos;
  if (cmd === "version" && opt.new && pos.length === 1) {
    const oldBin = opt.old ?? Bun.which("tmux");
    if (!oldBin) { process.stderr.write("ds tmux-drill: no tmux on PATH; name the old build with --old\n"); return 2; }
    for (const b of [oldBin, opt.new]) if (!existsSync(b)) { process.stderr.write(`ds tmux-drill: no such tmux: ${b}\n`); return 2; }
    const r = await versionDrill({ oldBin, newBin: opt.new });
    process.stdout.write(flag.has("json") ? `${JSON.stringify(r, null, 2)}\n` : versionText(r));
    return r.agent_alive ? 0 : 1;
  }
  if (cmd === "snapshot" && project && pos.length === 2) {
    const s = snapshot(project);
    process.stdout.write(`${JSON.stringify(s, null, flag.has("json") ? 2 : 0)}\n`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}
