// ds paths-check — U186: lists every old top-level bin/ path still named where a running agent
// or the host would call it. Run it on the host after a bin move; it must list nothing.
//   ds paths-check [--workspaces <dir>] [--home <dir>]
// Looks in: the settings files and CLAUDE.local.md of every worktree under the Orca workspaces
// root (default ~/orca/workspaces), the installed skills (~/.claude/skills, ~/.codex skills, prompts and top-level files), and the
// user systemd units. Exit 0 and no output when clean; exit 1 and one "file: old path" line each
// otherwise. A later move adds its old names to OLD_BIN (or OLD_LOOP) and reuses the check.
import { existsSync, lstatSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "../loop/core/cli.ts";
import { openReadOnly, stateRoot } from "../loop/core/store.ts";

export const help = `[--workspaces <dir>] [--home <dir>] — list old top-level bin/ and loose bin/loop/ paths still named in worktree settings, role briefs, installed skills and systemd units`;

// The top-level scripts U185 moved into folders (bin/ds, bin/ds.ts and bin/README.md stay).
export const OLD_BIN = ["accounts-refresh.sh", "add-role.sh", "alerts.sh", "approve-fix.sh", "approve-handoff.sh", "arm-picker.sh", "arm-rewake.sh", "ask-operator.sh", "board-data.ts", "board-server.ts", "board.sh", "close-role.sh", "close-squad.sh", "codex-models.sh", "codex-skills.sh", "directory.sh", "done-request.sh", "ds-feedback.sh", "finish-unit.sh", "install.sh", "install-skills.sh", "journal.sh", "lib.sh", "limits.sh", "loop.sh", "loop.ts", "no-broad-kill-hook.sh", "notes.sh", "notify-squads.sh", "orch.sh", "orphans.sh", "pause-checkpoint.sh", "picker-hook.sh", "reassert-roles.sh", "reclaim.sh", "restart-role.sh", "restart-squads.sh", "review-unit.sh", "rewake-hook.sh", "roles.sh", "send-peer.sh", "send-role.sh", "set-orca-depth.sh", "ship-mode.sh", "spawn-squad.sh", "squad-spent.sh", "squad-state.sh", "suspend-squad.sh", "team.sh", "token-usage.sh", "update-host.sh", "update-squads.sh", "up.sh", "watch.sh"];

// The loose bin/loop/ files docs-after-the-loop U1 moved into folders (main.ts stays), and limits/fingerprints.ts.
export const OLD_LOOP = ["account-lift.ts", "accounts.ts", "actuator.ts", "cancel.ts", "cards.ts", "check-activity.ts", "cli.ts", "close-busy.ts", "close-drift.ts", "coordinator.ts", "credits-card.ts", "credits.ts", "decide.ts", "derive.ts", "events.ts", "export-json.ts", "exposed.ts", "gate.ts", "git-dir.ts", "github-budget.ts", "handoff.ts", "import-config.ts", "import-json.ts", "import-markers.ts", "is-paused.ts", "kinds.ts", "lavish-up.ts", "limits.ts", "machine-level.ts", "member-ready.ts", "member-state.ts", "messages.ts", "migrate-host.ts", "orca.ts", "pause-conditions.ts", "pause.ts", "picks.ts", "pick.ts", "plan-lines.ts", "plugins.ts", "proc.ts", "projects.ts", "pr-ready.ts", "questions.ts", "reconcile-mark.ts", "redact.ts", "refusals.ts", "relay.ts", "replay.ts", "restart-roles.ts", "retest.ts", "roster.ts", "run-keep.ts", "schema.ts", "seed.ts", "settings-mark.ts", "settings-migrate.ts", "settings.ts", "skills.ts", "slot.ts", "squad-finish.ts", "squad-state.ts", "start-failed.ts", "stop-checkpoint.ts", "store.ts", "studio.ts", "switches.ts", "tailnet.ts", "tick.ts", "tidy.ts", "timers.ts", "unit-lanes.ts", "wake.ts", "watchdog.ts", "wt-probe.ts", "limits/fingerprints.ts"];

const ROOT = join(import.meta.dir, "../..");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function oldPathPattern(roots: string[]): RegExp {
  const prefixes = [...roots.map(esc), "[~\\w/.$-]*\\.dev-studio"].join("|");
  return new RegExp(`(?:${prefixes})/bin/(${OLD_BIN.map(esc).join("|")}|loop/(?:${OLD_LOOP.map(esc).join("|")}))(?![\\w./-])`, "g");
}

function walk(dir: string, depth: number, out: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === ".git" || n === "node_modules" || /\.(sqlite3?|db|wal|shm|log|jsonl)(-\w+)?$/.test(n)) continue;
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth > 0) walk(p, depth - 1, out); }
    else if (st.isFile() && st.size < 2_000_000) out.push(p);
  }
}

export function scan(roots: string[], workspaces: string, home: string): { file: string; path: string }[] {
  const files: string[] = [];
  // Role worktrees sit two levels down: <workspaces>/<project>/<worktree>/.
  for (const proj of existsSync(workspaces) ? readdirSync(workspaces) : []) {
    const pdir = join(workspaces, proj);
    let wts: string[]; try { wts = readdirSync(pdir); } catch { continue; }
    for (const wt of wts) {
      const dir = join(pdir, wt);
      for (const f of [".claude/settings.local.json", ".claude/settings.json", ".codex/config.toml", ".codex/hooks.json", "CLAUDE.local.md"]) {
        const p = join(dir, f);
        try { if (lstatSync(p).isFile() || statSync(p).isFile()) files.push(p); } catch { /* absent */ }
      }
    }
  }
  // ~/.codex also holds session logs, so only its skills, prompts and top-level config are read.
  for (const d of [join(home, ".claude/skills"), join(home, ".codex/skills"), join(home, ".codex/prompts")]) walk(d, 4, files);
  walk(join(home, ".codex"), 0, files);
  const units = join(home, ".config/systemd/user");
  try { for (const f of readdirSync(units)) files.push(join(units, f)); } catch { /* none */ }
  const hits: { file: string; path: string }[] = [];
  for (const file of new Set(files)) {
    let text: string; try { text = readFileSync(file, "utf8"); } catch { continue; }
    const seen = new Set<string>();
    for (const m of text.matchAll(oldPathPattern(roots))) {
      const path = m[0];
      if (!seen.has(path)) { seen.add(path); hits.push({ file, path }); }
    }
  }
  return hits;
}

// U208: open requests in loop.db whose argv[0] is an old top-level path. The loop runs a moved
// script from its folder (replay.ts), so these are a count, not a failure.
export function openRequestsOnOldPaths(roots: string[], root = stateRoot()): number {
  if (!existsSync(join(root, "loop.db"))) return 0;
  const re = oldPathPattern(roots);
  const s = openReadOnly(root);
  try {
    const rows = s.db.query("SELECT payload FROM requests WHERE done_at IS NULL AND payload IS NOT NULL").all() as { payload: string }[];
    return rows.filter((r) => { try { const a = (JSON.parse(r.payload) as { argv?: unknown[] }).argv?.[0]; re.lastIndex = 0; return typeof a === "string" && re.test(a); } catch { return false; } }).length;
  } catch { return 0; } finally { s.close(); }
}

export async function run(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(`usage: ds paths-check ${help}`); return 0; }
  const { opt } = parse(args, ["workspaces", "home"], []);
  const home = opt.home ?? homedir();
  const workspaces = opt.workspaces ?? join(home, "orca/workspaces");
  // This checkout, and the host checkout behind ~/.dev-studio when that is another one.
  const roots = [ROOT];
  try { roots.push(realpathSync(join(home, ".dev-studio"))); } catch { /* no host link */ }
  const hits = scan(roots, workspaces, home);
  for (const h of hits) console.log(`${h.file}: ${h.path}`);
  if (hits.length) console.error(`paths-check: ${hits.length} old bin/ path(s) still named`);
  const open = openRequestsOnOldPaths(roots);
  if (open) console.error(`paths-check: ${open} open request(s) in loop.db name an old top-level bin/ path (the loop runs them from their folder)`);
  return hits.length ? 1 : 0;
}
