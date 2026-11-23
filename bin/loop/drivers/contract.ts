// drivers/contract.ts — Claude Code on a contract backend (orca-backend-alternatives U11): a squad whose
// backend is not `orca` (bin/backend/contract.ts). The member's worktree comes from the squad's
// provider (io/worktrees.ts) and its `wt` is `local::<path>`; the terminal is made in it with the
// member's env (DS_GEN, DS_BACKEND, DS_MEMBER, DS_WT: the actuator's contract seat adds them) and the
// launch line (claude-launch.ts) is typed in it. Codex and Muse have no launch line here: spawn refuses
// such a roster (bin/commands/spawn-squad-ts.ts), and a start of one fails.
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { ROOT } from "../core/store.ts";
import { answerMenu, resumeSpec } from "./claude.ts";
import { accountHome, claudeLine, markTrusted, systemJsonDir, utf8Locale, type ClaudeConfig } from "./claude-launch.ts";
import type { ContractSeat, Driver, DriverModule, Member, Poked, Seat, StartMeta, Started } from "./types.ts";

export const LOCAL = "local::";
export const localPath = (wt: string | null | undefined): string | null => (wt?.startsWith(LOCAL) ? wt.slice(LOCAL.length) : null);
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The account's config for the launch line and the folder its .claude.json is in: none or `-` is
// the default login, `system` the system login without CLAUDE_CONFIG_DIR, any other a managed profile.
function account(acct: string | null): { config: ClaudeConfig; dir: string } | { error: string } {
  const env = process.env;
  if (!acct || acct === "-") return { config: null, dir: systemJsonDir(env) };
  if (acct === "system") return { config: { system: true }, dir: systemJsonDir(env) };
  const home = accountHome(env, acct);
  return isDir(home) ? { config: { home }, dir: home } : { error: `no Claude home for account ${acct} (${home})` };
}

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
      const a = account(acct);
      if ("error" in a) return { ok: false, error: a.error };
      let path = localPath(m.wt);
      if (!path) {
        const w = await c.worktree(m);
        if (!w.ok) return w;
        path = w.path;
      }
      if (!existsSync(path)) return { ok: false, error: `worktree ${path} is gone` };
      markTrusted(a.dir, path);   // claude stops at the folder-trust prompt otherwise
      const line = claudeLine({ config: a.config, gates: isDir(gates) ? gates : "", args: [...opts, ...c.settings(m.role, path), ...(text ? [text] : [])], utf8: utf8Locale(process.env) });
      const parent = localPath(m.role === "lead" ? seat.squad.studio_wt : seat.squad.lead_wt);
      const r = await c.start({ cwd: path, label: `${m.role}${m.suffix ? `-${m.suffix}` : ""}`,
        ...(c.caps.parents === "groups" ? { group: m.squad } : {}), ...(c.caps.parents === "native" && parent ? { parent } : {}) }, { ...meta, line });
      return r.ok ? { ok: true, wt: `${LOCAL}${path}` } : { ok: false, error: r.error, ...(r.busy ? { busy: true } : {}) };
    };
    return {
      start: (m, model, acct, prompt) => launch(m, acct, { launch: "fresh", prompt, agent: "claude", model, effort: m.effort, account: acct },
        ["--model", model, ...(m.effort ? ["--effort", m.effort] : [])], prompt),
      resume: (m) => {
        if (!m.wt || !m.model) return Promise.resolve({ ok: false, error: "resume needs a worktree and a model" });
        return launch(m, m.account, { launch: "continue", prompt: "", agent: "claude", model: m.model, effort: null, account: m.account },
          ["--continue", "--model", m.model], resumeSpec(m.role, ""));
      },
      async poke(m, text): Promise<Poked> {
        const path = localPath(m.wt), id = path ? await terminalOf(c, path) : null;
        if (!id) return "failed";
        const s = await c.ask("terminal.send", { id, text, submit: true });
        return !s.ok ? "failed" : s.delivery === "turn_started" ? "started" : "accepted";
      },
      async stop(makeSeat, m) {
        const path = localPath(m.wt);
        if (!path) return { ok: false, error: `stop needs a local worktree, not ${m.wt}` };
        const s = makeSeat("terminal.close").contract;
        return s ? s.close(path) : { ok: false, error: "stop: no contract seat" };
      },
      answerMenu,
    };
  },
};
export default contract;
