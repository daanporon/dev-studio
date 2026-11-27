// drivers/contract.ts — Claude Code on a contract backend (orca-backend-alternatives U11): a squad whose
// backend is not `orca` (bin/backend/contract.ts). The member's worktree comes from the squad's
// provider (io/worktrees.ts) and its `wt` is `local::<path>`; the terminal is made in it with the
// member's env (DS_GEN, DS_BACKEND, DS_MEMBER, DS_WT: the actuator's contract seat adds them) and the
// launch line (claude-launch.ts) is typed in it. A member on a side host (side-loop-host U10) has the id
// `<host>::<path>`: its worktree and terminal are made there, over the link (core/actuator.ts contractSeat). Codex and Muse have no launch line here: spawn refuses
// such a roster (bin/commands/spawn-squad-ts.ts), and a start of one fails.
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { ROOT, stateRoot } from "../core/store.ts";
import { folderOf } from "../../lib/account-dirs.ts";
import { answerMenu, resumeSpec } from "./claude.ts";
import { claudeLine, markTrusted, systemJsonDir, utf8Locale, type ClaudeConfig } from "./claude-launch.ts";
import type { ContractSeat, Driver, DriverModule, Keyed, Member, Poked, Seat, StartMeta, Started } from "./types.ts";

export const LOCAL = "local::";
export const localPath = (wt: string | null | undefined): string | null => (wt?.startsWith(LOCAL) ? wt.slice(LOCAL.length) : null);
// The folder of a worktree id in either form: `local::<path>` or Orca's `<id>::<path>` (a Studio that runs on Orca).
export const wtFolder = (wt: string | null | undefined): string | null => {
  const i = wt ? wt.indexOf("::") : -1;
  return wt && i >= 0 && wt.charAt(i + 2) === "/" ? wt.slice(i + 2) : null;
};
// side-loop-host U6 (KTD9): on main a side member's worktree id is `<host>::<path>` and its terminal handle
// `<host>:<handle>`; on the side host they are `local::<path>` and `<handle>`. The link rewrites them at the
// boundary (bin/link/replica.ts), so the side's observers run unchanged. Each returns null for an id of another form.
export const hostWt = (host: string, path: string): string => `${host}::${path}`;
/** `local::<path>` (the side's view) → `<host>::<path>` (main's view). */
export const wtUp = (host: string, wt: string | null | undefined): string | null => {
  const p = localPath(wt);
  return p === null ? null : hostWt(host, p);
};
/** `<host>::<path>` (main's view) → `local::<path>` (the side's view). */
export const wtDown = (host: string, wt: string | null | undefined): string | null =>
  wt?.startsWith(`${host}::`) ? `${LOCAL}${wt.slice(host.length + 2)}` : null;
export const handleUp = (host: string, handle: string): string => `${host}:${handle}`;
export const handleDown = (host: string, handle: string | null | undefined): string | null =>
  handle?.startsWith(`${host}:`) ? handle.slice(host.length + 1) : null;
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The account's config for the launch line and the folder its .claude.json is in: none or `-` is
// the default login, `system` the system login without CLAUDE_CONFIG_DIR, any other the folder the
// accounts table names for it (bin/lib/account-dirs.ts).
function account(acct: string | null): { config: ClaudeConfig; dir: string } | { error: string } {
  const env = process.env;
  if (!acct || acct === "-") return { config: null, dir: systemJsonDir(env) };
  if (acct === "system") return { config: { system: true }, dir: systemJsonDir(env) };
  const home = folderOf(stateRoot(), "claude", acct, env);
  return isDir(home) ? { config: { home }, dir: home } : { error: `no Claude home for account ${acct} (${home})` };
}

// side-loop-host U10: whether the seat's terminals are on a side host, and the folder of member id `wt` on the
// seat's host: `local::<path>` here, `<host>::<path>` on a side host.
const onSideHost = (c: ContractSeat): boolean => !!c.host && c.host !== "local";
const pathOn = (c: ContractSeat, wt: string | null | undefined): string | null =>
  onSideHost(c) ? localPath(wtDown(c.host!, wt)) : localPath(wt);

// The terminal the member's agent runs in: the newest one in its folder.
async function terminalOf(c: ContractSeat, path: string): Promise<string | null> {
  const l = await c.ask("terminal.list", {});
  if (!l.ok) return null;
  return l.terminals.filter((t) => t.cwd === path).sort((a, b) => b.created_at - a.created_at)[0]?.id ?? null;
}

export const contract: DriverModule = {
  agent: "claude",
  resumes: true,
  make(seat: Seat): Driver {
    const c = seat.contract;
    if (!c) throw new Error("drivers/contract: a seat with no contract backend");
    const gates = join(ROOT, "bin", "hooks", "path-gates");
    // Into the folder (made through the provider on a first start), trusted on the account, then the
    // terminal and its launch line through the seat's one ledgered start.
    // `opts` go before the --settings, `text` (the brief) last, as claude's one positional argument.
    const launch = async (m: Member, acct: string | null, meta: Omit<StartMeta, "line">, opts: string[], text: string): Promise<Started> => {
      if ((m.agent ?? "claude") !== "claude") return { ok: false, error: `agent ${m.agent} has no launch line on backend ${c.backend}` };
      // side-loop-host U10: on a side host the folder is that host's, so nothing here reads or marks it: the side's
      // `contract` channel marks it trusted for its login when it makes the terminal. Until the accounts units land
      // the agent runs on that host's own default login.
      const side = onSideHost(c);
      const a = side ? { config: null, dir: "" } : account(acct);
      if ("error" in a) return { ok: false, error: a.error };
      let path = pathOn(c, m.wt);
      if (!path) {
        const w = await c.worktree(m);
        if (!w.ok) return w;
        path = w.path;
      }
      if (!side && !existsSync(path)) return { ok: false, error: `worktree ${path} is gone` };
      if (!side) markTrusted(a.dir, path);   // claude stops at the folder-trust prompt otherwise
      const line = claudeLine({ config: a.config, gates: isDir(gates) ? gates : "", args: [...opts, ...c.settings(m.role, path), ...(text ? [text] : [])], utf8: utf8Locale(process.env), exec: true });
      const parent = side ? null : wtFolder(m.role === "lead" ? seat.squad.studio_wt : seat.squad.lead_wt);
      const r = await c.start({ cwd: path, label: `${m.role}${m.suffix ? `-${m.suffix}` : ""}`,
        ...(c.caps.parents === "groups" ? { group: m.squad } : {}), ...(c.caps.parents === "native" && parent ? { parent } : {}) }, { ...meta, line });
      return r.ok ? { ok: true, wt: side ? hostWt(c.host!, path) : `${LOCAL}${path}` } : { ok: false, error: r.error, ...(r.busy ? { busy: true } : {}) };
    };
    return {
      start: (m, model, acct, prompt) => launch(m, acct, { launch: "fresh", prompt, agent: "claude", model, effort: m.effort, account: acct },
        // U52a: a Studio's pick may name no model or effort (`-`), as studio-start takes them on Orca.
        [...(model && model !== "-" ? ["--model", model] : []), ...(m.effort && m.effort !== "-" ? ["--effort", m.effort] : [])], prompt),
      resume: (m) => {
        if (!m.wt || !m.model) return Promise.resolve({ ok: false, error: "resume needs a worktree and a model" });
        return launch(m, m.account, { launch: "continue", prompt: "", agent: "claude", model: m.model, effort: null, account: m.account },
          ["--continue", "--model", m.model], resumeSpec(m.role, ""));
      },
      async poke(m, text): Promise<Poked> {
        const path = pathOn(c, m.wt), id = path ? await terminalOf(c, path) : null;
        if (!id) return "failed";
        const s = await c.ask("terminal.send", { id, text, submit: true });
        return !s.ok ? "failed" : s.delivery === "turn_started" ? "started" : "accepted";
      },
      async keys(m, keys): Promise<Keyed> {
        if (c.caps.keys === "none") return { ok: false, error: `backend ${c.backend} cannot press keys` };
        const path = pathOn(c, m.wt), id = path ? await terminalOf(c, path) : null;
        if (!id) return { ok: false, error: "no terminal" };
        const s = await c.ask("terminal.send", { id, keys });
        return s.ok ? { ok: true } : { ok: false, error: s.error.message };
      },
      async stop(makeSeat, m) {
        const s = makeSeat("terminal.close").contract;
        const path = s ? pathOn(s, m.wt) : localPath(m.wt);
        if (!path) return { ok: false, error: `stop needs a worktree on the seat's host, not ${m.wt}` };
        return s ? s.close(path) : { ok: false, error: "stop: no contract seat" };
      },
      answerMenu,
    };
  },
};
export default contract;
