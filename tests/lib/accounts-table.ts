// Test fixture: replaces loop.db's `accounts` rows under <state root> with the given ones.
//   bun tests/lib/accounts-table.ts <state root> [<agent> <account> <label> <source> <config_dir|-> <default 0|1>]…
import { open } from "../../bin/loop/core/store.ts";

const [root, ...rest] = process.argv.slice(2);
const store = open(root!);
store.db.run("DELETE FROM accounts");
for (let i = 0; i + 5 < rest.length; i += 6) {
  const [agent, account, label, source, dir, dflt] = rest.slice(i, i + 6);
  store.db.run("INSERT INTO accounts (agent, account, label, source, config_dir, is_default, observed_at) VALUES (?, ?, ?, ?, ?, ?, 0)",
    [agent!, account!, label!, source!, dir === "-" ? null : dir!, Number(dflt)]);
}
store.close();
