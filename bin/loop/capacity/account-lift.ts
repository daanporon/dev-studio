// account-lift.ts — clear what blocks one account by hand (U107's `ds limit-lift`, U2's credits clear).
// It clears all three things the picker reads:
//   - the host-wide `account` episodes of that account (the `limit|<agent>/<account>` and
//     `credits|<agent>/<account>` rows and the imported `<wt>|<notice>` rows), and their source, the
//     account's lines in .accounts.episodes;
//   - observed_accounts.limited_until, and the accounts.tsv value it is read from, so
//     accounts-refresh.sh does not bring it back (it rebuilds the column from .accounts.episodes);
//   - members.limited_until of every member running on that account.
// It logs nothing: its callers record their own event.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store.ts";

export type Lifted = { agent: string; account: string; episodes: number; observed: number; members: number; files: number };

// A tab-separated state file with the lines `edit` refuses removed, or rewritten; written only when
// it changes, by rename, so a reader never sees half a file.
function rewrite(file: string, edit: (cols: string[], head: boolean) => string[] | null): number {
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, "utf8").split("\n"), out: string[] = [];
  let changed = 0;
  lines.forEach((l, i) => {
    if (!l) { out.push(l); return; }
    const cols = l.split("\t"), next = edit(cols, i === 0);
    if (next === null) { changed++; return; }
    const text = next.join("\t");
    if (text !== l) changed++;
    out.push(text);
  });
  if (changed) { writeFileSync(`${file}.tmp`, out.join("\n")); renameSync(`${file}.tmp`, file); }
  return changed;
}

export function liftAccount(store: Store, agent: string, account: string, at: number): Lifted {
  const state = `${agent}/${account}`;
  // Files first: accounts-refresh.sh reads .accounts.episodes, the state observer reads accounts.tsv.
  const files = rewrite(join(store.root, ".accounts.episodes"), (c) => (c[2] === agent && c[3] === account ? null : c))
    + rewrite(join(store.root, "accounts.tsv"), (c, head) => (!head && c[0] === agent && c[1] === account && c[6] !== undefined && c[6] !== "-" ? c.map((v, i) => (i === 6 ? "-" : v)) : c));
  return store.tx(() => {
    const episodes = store.db.run("DELETE FROM episodes WHERE kind = 'account' AND state = ?", [state]).changes;
    const observed = store.db.run("UPDATE observed_accounts SET limited_until = NULL, observed_at = ? WHERE agent = ? AND account = ? AND limited_until IS NOT NULL", [at, agent, account]).changes;
    const members = store.db.run("UPDATE members SET limited_until = NULL WHERE agent = ? AND account = ? AND limited_until IS NOT NULL", [agent, account]).changes;
    return { agent, account, episodes, observed, members, files };
  });
}
