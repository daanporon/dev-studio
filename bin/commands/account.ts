// ds account — the operator's on/off switch per account (plan "disable", U2; bin/loop/capacity/accounts.ts).
//   ds account [list]                                   every known account as JSON, with its state
//   ds account disable|enable <agent>:<account|label>   switch one off or on (host-wide)
//   ds account default <name> [--agent <agent>]         make one the agent's default (issue #125, KTD5)
//   ds account remove <name> [--agent <agent>]          take one off the list (a tombstone; its folder stays, KTD6)
// A name is an account id, else a unique accounts.tsv label (such as an email); an unknown or
// ambiguous name is refused with exit 2. Disabling moves and restarts nobody: no pick puts a member
// on the account any more, and members running on it switch at their next restart. Enabling an account
// that is out of credits (a live credits hold, U2) also clears the hold: the operator fixed the billing.
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { knownAccounts, removeAccount, resolveAccount, setAccountEnabled, setDefaultAccount } from "../loop/capacity/accounts.ts";

export const help = "[list] | disable|enable <agent>:<account|label> [--by <who>] | default|remove <account|label> [--agent <agent>] [--by <who>] — list accounts, switch one off/on for every pick, set the default or remove one";
export async function run(args: string[]): Promise<number> {
  const { pos, opt } = parse(args, ["by", "agent"]);
  const [verb = "list", name] = pos;
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
