// fulfil/override.ts — kind `override`: the board's model/account override on one member (U15).
// Payload {model?, effort?, plan?, account?} (plan and account never both; U205) sets one "until done" (scope member, set_by board): pick.ts honours it
// on the member's next pick and picks.ts clears it once the member's work is done. A new
// one replaces the member's open one. {clear: true} is "back to auto": the open one is cleared now.
// U24: `scope` (member default, squad, role, project; `role` names the role for scope role) makes a broader pin: its row's `member` holds
// <project>/<squad>, <project>/<role> or <project>; an unknown scope or a missing target is refused. Clear with {clear, scope} drops that scope's open row.
// The request's member is the worktree; the row is keyed by it, as pick.ts's overrideOf looks it up.
// An account the operator disabled (accounts.ts) is refused, so the board toasts it rather than leave
// the member waiting on it (pick.ts would: an override never falls to another account). A model that is
// not in the member's role roster, not in models.conf and not a live model of any agent is refused too
// (`unknown model`), so a typo never reaches a start. The effort and plan ride along: pick.ts runs the model
// on that effort and picks only among that plan's accounts.
import { failRequest, finishRequest, memberOf, requestActions, type Fulfiller } from "../core/actuator.ts";
import { DISABLED } from "../capacity/accounts.ts";
import { agentOf, memberIds, sameModel, SCOPES } from "../capacity/pick.ts";
import type { Row, Store } from "../core/store.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

// The account is disabled on the agent the override runs on (its model's, else the member's), or,
// when that agent is unknown or does not have the account, on any agent that does.
export function disabledFor(store: Store, account: string, agent: string | null): boolean {
  const off = (store.db.query("SELECT agent FROM accounts WHERE account = ? AND state = ?").all(account, DISABLED) as Row[]).map((r) => String(r.agent));
  if (!off.length) return false;
  const owns = !!agent && !!store.db.query("SELECT 1 FROM accounts WHERE agent = ?1 AND account = ?2 UNION SELECT 1 FROM observed_accounts WHERE agent = ?1 AND account = ?2").get(agent, account);
  return owns ? off.includes(agent!) : true;
}

// The model names a pin may use: the role's roster rows (model and fallbacks), models.conf and the live
// models of every agent (the board's catalog sources), the project's own rows and the defaults.
function knownModel(store: Store, project: string, role: string | null, model: string): boolean {
  const rows = store.db.query("SELECT file, key, value FROM config WHERE project IN (?, '') AND file IN ('models.conf', 'codex-models', 'roles.conf')").all(project) as Row[];
  for (const r of rows) {
    if (r.file === "roles.conf") {
      if (role && !(r.key === role || String(r.key).startsWith(`${role}-`))) continue;
      const [, m = "", , , fbs = "-"] = String(r.value ?? "").trim().split(/\s+/);
      if (sameModel(model, m) || (fbs !== "-" && fbs.split(",").some((f) => sameModel(model, f.split(":")[1] ?? "")))) return true;
    } else if (sameModel(model, String(r.key).split("|")[1] ?? "")) return true;
  }
  return false;
}

const override: Fulfiller = {
  name: "override",
  scope: "host",
  kinds: ["override"],
  run: (ctx) => requestActions(ctx, ["override"]),
  exec(a, x) {
    const p = payloadOf<"override">(a);
    const { store, now: at } = x;
    const scope = p.scope || "member", project = a.project ?? "";
    if (!(SCOPES as readonly string[]).includes(scope)) return { failed: `unknown scope '${scope}' (${SCOPES.join(", ")})` };
    const wt = a.member;
    if (!wt && scope === "member") return { failed: "an override needs a member and a model or an account (or clear)" };
    if (!p.clear && !p.model && !p.account) return { failed: "an override needs a member and a model or an account (or clear)" };
    if (!p.clear && p.account && p.plan) return { failed: "a pin names an account or a plan, not both" };
    const m = wt ? memberOf(store, { wt }) : null;
    // U24: a broader override's `member` column holds its target; it must exist.
    let target = wt ?? "";
    if (scope !== "member") {
      if (scope === "squad") {
        const sq = a.squad ? store.get("squads", { project, topic: a.squad }) : null;
        if (!sq || ["closed", "gone"].includes(String(sq.status ?? ""))) return { failed: `no open squad '${a.squad ?? ""}' in project '${project}'` };
        target = `${project}/${a.squad}`;
      } else if (scope === "role") {
        const role = p.role || (m?.role as string | null) || "";
        const known = !!role && (!!store.db.query("SELECT 1 FROM members WHERE project = ? AND role = ?").get(project, role)
          || !!store.db.query("SELECT 1 FROM config WHERE file = 'roles.conf' AND project IN (?1, '') AND (key = ?2 OR key LIKE ?2 || '-%')").get(project, role));
        if (!known) return { failed: `no role '${role}' in project '${project}'` };
        target = `${project}/${role}`;
      } else {
        const known = !!project && (!!store.db.query("SELECT 1 FROM squads WHERE project = ?").get(project) || !!store.db.query("SELECT 1 FROM members WHERE project = ?").get(project));
        if (!known) return { failed: `no project '${project}'` };
        target = project;
      }
    }
    const role = scope === "member" ? (m?.role as string | null) ?? null : scope === "role" ? target.slice(project.length + 1) : null;
    if (!p.clear && p.model && !knownModel(store, project, role, p.model)) return { failed: `unknown model '${p.model}': pick one from the list` };
    const agent = p.model ? agentOf(store, project, p.model, []) : (m?.agent as string | null) ?? null;
    if (!p.clear && p.account && disabledFor(store, p.account, agent)) return { failed: `account ${p.account} is disabled (ds account enable to use it)` };
    const ids = scope === "member" ? (m ? memberIds({ ...m, wt }) : [wt!]) : [target];
    const ctx = { project: a.project, squad: a.squad, member: wt };
    const id = store.tx(() => {
      const cleared = store.db.run("UPDATE overrides SET cleared_at = ? WHERE cleared_at IS NULL AND COALESCE(scope, 'member') = ? AND member IN (SELECT value FROM json_each(?))", [at, scope, JSON.stringify(ids)]).changes;
      if (cleared) store.event("override_cleared", { ...ctx, payload: { by: "board", scope, cleared, reason: p.clear ? "back to auto" : "replaced" } });
      if (p.clear) return null;
      const r = store.db.run("INSERT INTO overrides (member, model, effort, plan, account, scope, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, 'board', ?)",
        [target, p.model || null, p.effort || null, p.plan || null, p.account || null, scope, at]);
      store.event("override_set", { ...ctx, payload: { id: Number(r.lastInsertRowid), scope, model: p.model || null, effort: p.effort || null, plan: p.plan || null, account: p.account || null, by: "board" } });
      return Number(r.lastInsertRowid);
    });
    finishRequest(store, a, { ok: true, override: id }, at);
    return { done: true, result: id };
  },
  giveUp: failRequest,
};
export default override;
