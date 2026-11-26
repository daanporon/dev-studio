// fulfil/account-move.ts — kind `account-move` (issue #125, U8): `ds account move <account>`'s request. Copies a
// Claude account that lives in Orca's profile folder into dev-studio's accounts root and repoints its row, so
// dev-studio no longer depends on Orca's folder (KTD14).
//
//   refused   while a live member's configured or live account is this one (accountMembers), while a live agent
//             process runs on it (the backend's agent-accounts, host-wide: subs and non-members too), or while
//             Orca still lists it without `force` (the token-rotation risk, ROTATION); and for anything but a listed
//             Orca row of Claude (moveProblem). Nothing is copied or written.
//   copied    `cp -a` of the folder (links kept as links) through a staging folder into <accounts root>/claude/<id>
//             (copyAccountFolder), checked for `.credentials.json`
//   done      the row: the same id with config_dir on the copy and source 'ds' (moveAccountRow, one `account_moved`
//             event); every reader (the launch line, usage, the picker) follows the row. Orca's folder is only read
//             and left as it is, so the board shows the login in two folders until it is removed in Orca. The copy
//             is scanned (account-skills scan): a plugin installPath that no longer resolves, or one recorded through
//             Orca's folder (it breaks when that goes), is reported in the result. One forced accounts refresh.
// The copy runs in the background; a loop restart runs the request again, and a run that finds its own finished
// copy at the target keeps it (its marker), so a restart never copies twice or leaves a half copy in place. A
// refusal on the re-check after the copy removes that copy (its own marker only), so it never blocks the next move.
import { finishRequest, failRequest, requestActions, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Row } from "../core/store.ts";
import { moveAccountRow, moveProblem, ROTATION } from "../capacity/accounts.ts";
import { parseAgentAccounts } from "../observers/orca.ts";
import { refreshAccounts } from "./account-reset.ts";
import { accountFolder, type AccountRow } from "../../lib/account-dirs.ts";
import { accountDir, copyAccountFolder, removeMovedCopy } from "../../lib/account-folder.ts";
import { accountSkillsScan, registryRows } from "../../lib/account-skills.ts";
import { join } from "node:path";
import { errOf } from "../io/orca.ts";

type Env = Record<string, string | undefined>;
/** The live agent processes as {agent, account}, or why they could not be read. */
export type LiveRead = (x: Exec) => Promise<{ agent: string; account: string }[] | { error: string }>;

const agentAccounts: LiveRead = async (x) => {
  const o = await x.act.orca.run("agent-accounts", []);
  return o.code === 0 ? parseAgentAccounts(o.out) : { error: `agent-accounts: ${errOf(o, "agent-accounts")}` };
};

/** The copy's plugin installPaths that need the operator (KTD14): `dead`, recorded at a path that no longer
 *  resolves (account-skills scan's broken records), and `viaOld`, recorded through the old folder `from`, which
 *  resolve only while Orca's folder stays. Each as "<plugin> → <path>". */
export function pluginPathFaults(folder: string, from: string): { dead: string[]; viaOld: string[] } {
  const dead = accountSkillsScan(folder).map((l) => l.split("\t")).filter((f) => f[0] === "broken" && /registered at a path that does not exist/.test(f[1] ?? ""))
    .map((f) => `${(f[1] ?? "").replace(/ is registered at a path that does not exist$/, "")} → ${f[2] || "-"}`);
  const viaOld = registryRows(join(folder, "plugins", "installed_plugins.json")).filter((r) => (r[3] ?? "").startsWith(`${from}/`))
    .map((r) => `${r[0]} (${r[1]} scope) → ${r[3]}`);
  return { dead, viaOld };
}

export function accountMove(opts: { live?: LiveRead; refresh?: (root: string) => void; env?: Env } = {}): Fulfiller {
  const live = opts.live ?? agentAccounts, refresh = opts.refresh ?? refreshAccounts;
  return {
    name: "account-move",
    scope: "host",
    kinds: ["account-move"],
    run: (ctx) => requestActions(ctx, ["account-move"]),
    async exec(a, x): Promise<Result> {
      const p = payloadOf<"account-move">(a), id = Number(p.request), env = opts.env ?? process.env;
      const row = x.store.get("requests", { id }) as Row | null;
      if (!row) return { dropped: "no such request" };
      if (row.done_at != null) return { done: true, result: "already done" };
      const fail = (why: string): Result => { failRequest(a, x, why); return { done: true, result: `failed: ${why}` }; };
      const force = p.force === true, by = p.by ?? String(row.requested_by ?? "ds");
      const bad = moveProblem(x.store, p.agent, p.account, force, env);
      if (bad) return fail(bad);
      const procs = await live(x);
      if ("error" in procs) return fail(`cannot tell whether an agent runs on ${p.agent}:${p.account} (${procs.error}); try again`);
      const running = procs.filter((pr) => pr.agent === p.agent && pr.account === p.account).length;
      if (running) return fail(`${running} live ${p.agent} process${running > 1 ? "es run" : " runs"} on ${p.agent}:${p.account}; move it once ${running > 1 ? "they have" : "it has"} ended`);

      const from = accountFolder(x.store.get("accounts", { agent: p.agent, account: p.account }) as AccountRow, env);
      const to = accountDir(p.agent, p.account, env);
      return {
        background: (async (): Promise<Result> => {
          const why = await copyAccountFolder(from, to, id, ".credentials.json");
          if (why) return fail(why);
          // Re-read the table: the copy took a while, and the row may have changed under it.
          const still = moveProblem(x.store, p.agent, p.account, force, env);
          if (still) { removeMovedCopy(to, id); return fail(still); }
          moveAccountRow(x.store, { agent: p.agent, account: p.account, from, folder: to, force, by });
          const { dead, viaOld } = pluginPathFaults(to, from);
          const text = `moved ${p.agent}:${p.account} to ${to}; Orca's folder ${from} is left as it is`
            + (force ? `. Orca still lists it: ${ROTATION}; remove it in Orca to end that` : "")
            + (dead.length ? `. Plugin installPath no longer resolves: ${dead.join("; ")} (reinstall the plugin on this account)` : "")
            + (viaOld.length ? `. Plugin installPath still runs through Orca's folder and breaks when it goes: ${viaOld.join("; ")} (reinstall the plugin on this account)` : "");
          finishRequest(x.store, a, { ok: true, account: p.account, from, folder: to, forced: force, dead_install_paths: dead, old_install_paths: viaOld, text }, x.now);
          refresh(x.store.root);
          return { done: true, result: text };
        })(),
      };
    },
    giveUp: (a, x, why) => failRequest(a, x, why),
  };
}

export default accountMove();
