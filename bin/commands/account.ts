// ds account — the operator's on/off switch per account (plan "disable", U2; bin/loop/capacity/accounts.ts).
//   ds account [list]                                   every known account as JSON, with its state
//   ds account disable|enable <agent>:<account|label>   switch one off or on (host-wide)
//   ds account default <name> [--agent <agent>]         make one the agent's default (issue #125, KTD5)
//   ds account remove <name> [--agent <agent>]          take one off the list (a tombstone; its folder stays, KTD6)
//   ds account add <name> [--agent <agent>] [--project <label>] [--dir <folder>] [--host <host>] [--no-wait]
//                                                       a new login (issue #125, U5): files an `account-add` request the
//                                                       loop carries out (fulfil/account-add.ts): a 0700 folder under the
//                                                       accounts root and a login terminal beside the project's Studio
//                                                       (default: the one project with a live Studio); it follows the
//                                                       request, printing where the terminal is, the login URL and the
//                                                       end. --dir adds a logged-in folder as it is, with no terminal.
//                                                       --host <host> logs in on that accepted side host (U20): its
//                                                       link must be up; the folder and the terminal are there (the
//                                                       project names its terminal server), and no accounts row is
//                                                       written (an account on main with the same login gets the
//                                                       folder). Not with --dir. Ctrl-C leaves the request running. Exit 0 added (or already
//                                                       there), 1 failed or the loop down, 2 refused (nothing made).
//   ds account move <account|label> [--force] [--no-wait]
//                                                       copy a Claude account out of Orca's profile folder into the
//                                                       accounts root (issue #125, U8): files an `account-move` request
//                                                       (fulfil/account-move.ts) and follows it. The id stays; Orca's
//                                                       folder is left alone. Refused (exit 2, nothing filed) while a
//                                                       live member uses it, and while Orca still lists it unless
//                                                       --force (two copies of one login rotate its token). Exit 0
//                                                       moved, 1 failed (a live agent on it, the copy) or the loop down.
// A name is an account id, else a unique accounts.tsv label (such as an email); an unknown or
// ambiguous name is refused with exit 2. Disabling moves and restarts nobody: no pick puts a member
// on the account any more, and members running on it switch at their next restart. Enabling an account
// that is out of credits (a live credits hold, U2) also clears the hold: the operator fixed the billing.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { open, type Row, type Store } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { knownAccounts, moveProblem, removeAccount, resolveAccount, setAccountEnabled, setDefaultAccount } from "../loop/capacity/accounts.ts";
import { STUDIO_SQUAD } from "../loop/squad/studio.ts";
import { addHostProblem } from "../loop/squad/host-reach.ts";
import { LOCAL_HOST } from "../backend/registry.ts";
import { findKind } from "../lib/account-kinds/index.ts";
import { nameProblem } from "../lib/account-folder.ts";

export const help = "[list] | disable|enable <agent>:<account|label> [--by <who>] | default|remove <account|label> [--agent <agent>] [--by <who>] | add <name> [--agent <agent>] [--project <label>] [--dir <folder>] [--host <host>] [--no-wait] | move <account|label> [--force] [--no-wait] — list accounts, switch one off/on for every pick, set the default, remove one, add a login (a login terminal, on main or a --host side host, or a logged-in --dir folder), or move an Orca-folder account into dev-studio's folder";
export async function run(args: string[]): Promise<number> {
  const { pos, opt, flag } = parse(args, ["by", "agent", "dir", "project", "host"], ["no-wait", "force"]);
  const [verb = "list", name] = pos;
  if (verb === "add" && name && pos.length === 2) return add(name, opt, !flag.has("no-wait"));
  if (verb === "move" && name && pos.length === 2) return move(name, opt, flag.has("force"), !flag.has("no-wait"));
  if (!["list", "disable", "enable", "default", "remove"].includes(verb) || (verb === "list" ? pos.length > 1 : !name || pos.length > 2)) {
    console.error(`usage: ds account ${help}`);
    return 2;
  }
  const s = open();
  try {
    if (verb === "list") { print(knownAccounts(s)); return 0; }
    // default and remove take a bare name (claude by default) as well as <agent>:<name>.
    const full = (verb === "default" || verb === "remove") && !name!.includes(":") ? `${opt.agent ?? "claude"}:${name}` : name!;
    const r = resolveAccount(s, full);
    if ("error" in r) { console.error(`ds account: ${r.error}`); return 2; }
    if (verb === "default" || verb === "remove") {
      const done = (verb === "default" ? setDefaultAccount : removeAccount)(s, { ...r, by: opt.by ?? "cli" });
      if ("error" in done) { console.error(`ds account: ${done.error}`); return 2; }
      console.log(`${r.agent}:${r.account} ${verb === "default" ? "is the default" : "removed (its folder stays)"}${done.changed ? "" : " (already)"}`);
      return 0;
    }
    const enabled = verb === "enable";
    const { changed, cleared } = setAccountEnabled(s, { ...r, enabled, by: opt.by ?? "cli" });
    console.log(`${r.agent}:${r.account} ${enabled ? "enabled" : "disabled"}${changed ? "" : " (already)"}${cleared ? "; out-of-credits hold cleared" : ""}`);
    return 0;
  } finally { s.close(); }
}

const refuse = (why: string) => { console.error(`ds account add: ${why}. Nothing made.`); return 2; };

// The projects with a live Studio: a Studio worktree and a `_studio` member row with a terminal.
const liveStudios = (s: Store): string[] => (s.db.query(`SELECT label FROM projects p WHERE studio_wt IS NOT NULL AND EXISTS
  (SELECT 1 FROM members m WHERE m.project = p.label AND m.squad = ? AND m.handle IS NOT NULL AND COALESCE(m.status, '') != 'gone') ORDER BY label`)
  .all(STUDIO_SQUAD) as Row[]).map((r) => String(r.label));

// The loop is running when its health row moved within 12 ticks (remove-project.ts's test).
function loopDown(s: Store): string | null {
  const h = s.db.query("SELECT tick_at, started_at, progress_at FROM health WHERE id = 1").get() as Row | null;
  if (!h) return "the loop has never run here";
  const tickS = Number(process.env.DS_LOOP_TICK_S) > 0 ? Number(process.env.DS_LOOP_TICK_S) : 5;
  const age = Math.floor(Date.now() / 1000) - Math.max(Number(h.tick_at ?? 0), Number(h.started_at ?? 0), Number(h.progress_at ?? 0));
  return age > 12 * tickS ? `the loop has not ticked for ${age}s (start it: ds loop start)` : null;
}

async function add(name: string, opt: Record<string, string>, wait: boolean): Promise<number> {
  const agent = opt.agent ?? "claude", kind = findKind(agent);
  if (!kind) return refuse(`no account kind for agent '${agent}'`);
  if (!kind.multi) return refuse(kind.why ?? `${agent} keeps one login`);
  const host = opt.host && opt.host !== LOCAL_HOST ? opt.host : undefined;
  if (host && opt.dir) return refuse(`--dir names a folder on main: leave it out to log in on ${host}`);
  const dir = opt.dir ? resolve(opt.dir) : undefined;
  if (dir && !(existsSync(dir) && statSync(dir).isDirectory())) return refuse(`${dir} is not a folder`);
  if (dir && !existsSync(join(dir, kind.credentialsFile))) return refuse(`${dir} has no ${kind.credentialsFile}: it is not logged in (log in there first, or add without --dir)`);
  if (!dir && !kind.login) return refuse(`${agent} has no login command yet`);
  const s = open();
  try {
    const bad = nameProblem(name, (s.db.query("SELECT account FROM accounts WHERE agent = ?").all(agent) as Row[]).map((r) => String(r.account)));
    if (bad) return refuse(bad);
    let project = opt.project;
    if (!dir && !project) {
      const live = liveStudios(s);
      if (live.length !== 1) return refuse(live.length ? `several projects have a live Studio (${live.join(", ")}): pick one with --project` : "no project has a live Studio to open the login terminal beside: start one (ds up), or name a project with --project");
      project = live[0];
    }
    if (project && !s.get("projects", { label: project })) return refuse(`no project '${project}'`);
    const off = host ? addHostProblem(s, host) : null;
    if (off) return refuse(off);
    const down = loopDown(s);
    if (down) return refuse(`${down}; an add is carried out by the loop`);
    const by = opt.by ?? process.env.DS_WHO ?? "cli";
    const id = Number(s.requestAny("account-add", { agent, name, ...(project ? { project } : {}), ...(dir ? { dir } : {}), ...(host ? { host } : {}), by }, { by, project: project ?? null }).row.id);
    console.log(`Filed the add of ${agent}:${name} (request ${id})${dir ? ` on ${dir}` : host ? ` on host ${host}` : ""}.`);
    for (const v of kind.keyEnv ?? []) if (process.env[v]) console.error(`ds account add: warning: ${v} is set here; where ${agent} sees it, it can use that key instead of this account's login`);
    return wait ? await follow(s, id) : 0;
  } finally { s.close(); }
}

async function move(name: string, opt: Record<string, string>, force: boolean, wait: boolean): Promise<number> {
  const no = (why: string) => { console.error(`ds account move: ${why}. Nothing moved.`); return 2; };
  const s = open();
  try {
    const r = resolveAccount(s, name.includes(":") ? name : `${opt.agent ?? "claude"}:${name}`);
    if ("error" in r) return no(r.error);
    const bad = moveProblem(s, r.agent, r.account, force);
    if (bad) return no(bad);
    const down = loopDown(s);
    if (down) return no(`${down}; a move is carried out by the loop`);
    const by = opt.by ?? process.env.DS_WHO ?? "cli";
    const id = Number(s.requestAny("account-move", { agent: r.agent, account: r.account, ...(force ? { force: true } : {}), by }, { by, project: null }).row.id);
    console.log(`Filed the move of ${r.agent}:${r.account} (request ${id}).`);
    return wait ? await follow(s, id, "move") : 0;
  } finally { s.close(); }
}

// Print each new line of the request's progress until it ends; Ctrl-C leaves it running.
async function follow(s: Store, id: number, verb = "add"): Promise<number> {
  let last = "";
  for (;;) {
    const r = s.db.query("SELECT result, done_at FROM requests WHERE id = ?").get(id) as Row | null;
    let res: Record<string, unknown> = {};
    try { res = JSON.parse(String(r?.result ?? "{}")) ?? {}; } catch { /* no progress yet */ }
    const text = typeof res.text === "string" ? res.text : "";
    if (r?.done_at != null) {
      if (res.ok === true) { console.log(text || `${verb} done`); return 0; }
      console.error(`ds account ${verb}: ${String(res.error ?? "failed")}`);
      return 1;
    }
    if (text && text !== last) { console.log(`  ${text}`); last = text; }
    const down = loopDown(s);
    if (down) { console.error(`ds account ${verb}: ${down}; the ${verb} goes on when it runs again (request ${id})`); return 1; }
    await Bun.sleep(Number(process.env.DS_ACCOUNT_ADD_POLL_MS) || 1000);
  }
}
