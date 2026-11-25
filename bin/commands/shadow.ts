// ds shadow — the shadow signals (orca-backend-alternatives U10): the loop computes the new
// backend-neutral inputs beside the old Orca ones and logs each disagreement as a `shadow_disagree`
// event (bin/loop/reconcilers/shadow.ts). `report` counts them by decision point with the finishes and
// crashes seen and says whether the exit for the switch is met; `explain` records why one is not a
// fault of the new signals, which takes it out of the unexplained count.
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { explain, report, reportText } from "../loop/squad/shadow-report.ts";

export const help = "report [--project p] [--since <iso|epoch>] [--json] | explain <event> <why> — the shadow signals' disagreements and whether the switch's exit is met";

const USAGE = `usage: ds shadow report [--project <label>] [--since <iso|epoch>] [--json]
       ds shadow explain <event id> <why>`;

/** An epoch in seconds from an ISO date or a number; null when it is neither. */
function when(v: string): number | null {
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds shadow: ${why}\n${USAGE}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["project", "since", "by"], ["json"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  const s = open();
  try {
    if (pos[0] === "report") {
      if (pos.length !== 1) return usage("report takes no other words");
      const since = opt.since === undefined ? null : when(opt.since);
      if (opt.since !== undefined && since === null) return usage(`--since is an ISO date or an epoch, not '${opt.since}'`);
      const r = report(s, { project: opt.project ? dsLabel(opt.project) : null, since });
      if (flag.has("json")) print(r);
      else for (const l of reportText(r)) console.log(l);
      return 0;
    }
    if (pos[0] === "explain") {
      const [, ev, ...why] = pos;
      if (!ev || !/^\d+$/.test(ev) || !why.length) return usage("explain takes an event id and why");
      const r = explain(s, Number(ev), why.join(" "), opt.by ?? process.env.DS_MEMBER);
      if (!r.ok) { console.error(`ds shadow: ${r.error}`); return 1; }
      console.log(`explained #${ev} (event #${r.id})`);
      return 0;
    }
    return usage(`unknown subcommand '${pos[0] ?? ""}'`);
  } finally { s.close(); }
}
