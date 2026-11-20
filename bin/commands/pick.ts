// ds pick — the loop's account pick for a role (U9, bin/loop/capacity/pick.ts), printed like
// the tuple "<agent>\t<model>\t<effort>\t<account>\t<fallback 0|1>" (`-` = none), or
// "WAIT <epoch>" with exit 3 when nothing at or above the floor has room, or "WAIT slot: <project> at
// max_builders <n>" with exit 3 for a Builder over the project's limit (U145; --squad/--suffix name
// the unit of a start with no member row yet), or "WAIT host: <metric> <value> ≥ crit <line>" with exit 3
// for a Builder start under the host brake (U4, builder_host_brake). Records one `pick` event.
// --json prints the whole pick (rung, reason, why) instead.
import { open, now, type Row } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { pick, tuple } from "../loop/capacity/pick.ts";
import { startWait } from "../loop/capacity/slot.ts";

export const help = "<project> <role> [--tier standard|hard] [--phase build] [--member <id|wt>] [--squad <topic> --suffix <unit>] [--agent <a>] [--model <m>] [--effort <e>] [--account <id>] [--limited <agent>:<account>=<epoch>[,…]] [--json] — the account pick (tuple, or WAIT <epoch> / WAIT slot: … / WAIT host: … exit 3)";
export async function run(args: string[]): Promise<number> {
  const { pos, opt, flag } = parse(args, ["tier", "phase", "member", "squad", "suffix", "agent", "model", "effort", "account", "limited"], ["json"]);
  const [project, role] = pos;
  if (!project || !role || pos.length > 2 || (opt.tier && !["standard", "hard"].includes(opt.tier)) ||
      (opt.limited && !opt.limited.split(",").every((l) => /^[^:]+:.+=\d+$/.test(l)))) {
    console.error(`usage: ds pick ${help}`);
    return 2;
  }
  const s = open();
  try {
    let member: Row | null = null;
    if (opt.member) {
      member = (/^\d+$/.test(opt.member) ? s.db.query("SELECT * FROM members WHERE id = ?").get(Number(opt.member))
        : s.db.query("SELECT * FROM members WHERE wt = ? ORDER BY id DESC").get(opt.member)) as Row | null;
      if (!member) { console.error(`ds pick: no member '${opt.member}'`); return 1; }
    }
    const tier = opt.tier ?? (member?.tier as string | null) ?? null, phase = opt.phase ?? (member?.phase as string | null) ?? "build";
    const at = now();
    const squad = (member?.squad as string | null) ?? opt.squad ?? null;
    const suffix = (member?.suffix as string | null) ?? opt.suffix ?? null;
    // One immediate transaction: a Builder slot this gives is recorded (the event) before another
    // `ds pick` can check, so two shell starts never take the same slot (bin/loop/capacity/slot.ts `held`).
    const p = s.tx(() => {
      const r = pick(s, { project, role, tier, phase, squad, member: member ? Number(member.id) : null, suffix: opt.suffix ?? null,
        agent: opt.agent ?? null, model: opt.model ?? null, effort: opt.effort ?? null, account: opt.account ?? null, limited: opt.limited ? opt.limited.split(",") : [] }, at);
      if (!("error" in r)) s.event("pick", { project, squad, member: (member?.wt as string | null) ?? null, payload: { role, tier, phase, suffix, source: "ds pick", ...r } });
      return r;
    });
    if ("error" in p) { console.error(p.error); return 1; }
    if (flag.has("json")) print(p);
    else console.log("wait" in p ? (startWait(p) ? p.reason : `WAIT ${p.wait}`) : tuple(p));
    return "wait" in p ? 3 : 0;
  } finally { s.close(); }
}
