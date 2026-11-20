// account-skills.ts — a Claude account that cannot load the role skills gets a Studio alert (account-skills U3).
//
// accounts.tsv's `skills` column (bin/lib/accounts-refresh.sh, from accountSkillsCheck --tsv in bin/lib/account-skills.ts)
// lands in observed_accounts.skills. Each project gets ONE alert per broken spell of an account:
//   - a row whose skills starts `broken:` opens a spell (an `account-skills` episode on subject
//     account-skills.<account>, started at the tick that saw it) and raises an alert through alertAction,
//     key account-skills.<account>. Its id is sweep-account-skills.<account>-<cksum of the spell>.
//   - a reason that changes inside a spell raises no second alert: the spell, not the reason, is the episode.
//   - `ok`, `warn: …` or a row that is gone closes the spell. The alert itself clears through the alerts
//     reconciler's alertGone. A later re-break opens a new spell, with a new alert id (the idEpisode
//     pattern of compaction.ts's Studio alert).
//   - `warn:` never alerts; the board shows it on the account.
//   - skills NULL (a 10-column accounts.tsv, a non-claude row) is unknown: the spell is left as it is.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Store } from "../core/store.ts";
import { alertAction } from "./alerts.ts";

const KIND = "account-skills";
const keyOf = (account: string) => `account-skills.${account}`;
const REPAIR = "bin/host/install-skills.sh";

// The skills value of a claude account, or undefined when its row is gone.
export function skillsOf(store: Store, account: string): string | null | undefined {
  const r = store.get("observed_accounts", { agent: "claude", account });
  return r ? ((r.skills as string | null) ?? null) : undefined;
}

export function accountSkills(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx, out: Action[] = [];
  const rows = store.db.query("SELECT account, label, skills FROM observed_accounts WHERE agent = 'claude' ORDER BY rowid").all() as { account: string; label: string | null; skills: string | null }[];
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.account);
    const key = keyOf(r.account), spell = { project, subject: key, kind: KIND };
    const ep = store.get("episodes", spell), open = !!ep && ep.ended_at == null;
    if (r.skills == null) continue;
    if (!r.skills.startsWith("broken:")) {
      if (open) store.upsert("episodes", spell, { state: "closed", ended_at: now, observed_at: now });
      continue;
    }
    let started = Number(ep?.started_at ?? now);
    if (!open) {
      started = now;
      store.upsert("episodes", spell, { squad: null, started_at: now, ended_at: null, state: "broken", episode_key: String(now), source: "loop", observed_at: now });
    }
    const reason = r.skills.slice("broken:".length).trim() || "unknown fault";
    const name = r.label && r.label !== r.account ? `${r.label} (${r.account})` : r.account;
    const episode = `skills|${r.account}|${started}`;
    out.push(...alertAction(store, { project, squad: null, key, episode, idEpisode: episode,
      text: `Claude account ${name} cannot load the role skills: ${reason}. A role started on it stalls (no ce-code-review, no review receipt). Repair: run ${REPAIR} on the host.`,
      option: "done — I ran bin/host/install-skills.sh", why: `run ${REPAIR} on the host; install-skills.sh --check names the broken path` }));
  }
  // An account no longer listed ends its spell.
  const spells = store.db.query("SELECT subject FROM episodes WHERE project = ? AND kind = ? AND ended_at IS NULL").all(project, KIND) as { subject: string }[];
  for (const s of spells) {
    if (seen.has(s.subject.slice("account-skills.".length))) continue;
    store.upsert("episodes", { project, subject: s.subject, kind: KIND }, { state: "closed", ended_at: now, observed_at: now });
  }
  return out;
}

export default {
  name: "account-skills",
  run(ctx: TickCtx) { return accountSkills(ctx); },
} satisfies Reconciler;
