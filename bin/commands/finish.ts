// ds finish — the finish record (orca-backend-alternatives U3): a worker records that it ended its work,
// with its outcome, before it sends worker_done. A Tester's or Researcher's verdict is `--outcome
// verdict`; a Builder's end goes through finish-unit.sh, which writes the same row. Who you are is
// DS_MEMBER, else this worktree's member, else --as <squad>/<role[-suffix]> --project <label>; the
// generation is DS_GEN (none when unset). The row is written directly: no request, no action.
import { open, type Store } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { toplevel } from "../loop/squad/exposed.ts";
import { senderAt, splitRole } from "../loop/messages/messages.ts";
import { OUTCOMES, finishLine, isOutcome, listFinishes, memberName, parseMember, recordFinish, type Member } from "../loop/squad/finish.ts";

export const help = "<unit|-> --outcome ok|failed|no-pr|verdict --body <text> [--key k] [--as <squad>/<role> --project <label>] | list [--project p] [--squad s] [--member m] [--json] — record a worker's finish (finishes rows)";

const USAGE = `usage: ds finish <unit|-> --outcome ${OUTCOMES.join("|")} --body <text> [--key <key>] [--as <squad>/<role[-suffix]> --project <label>]
       ds finish list [--project <label>] [--squad <topic>] [--member <project>/<squad>/<role>] [--limit n] [--json]`;

/** The finishing member: --as with --project, else DS_MEMBER, else this worktree's member. */
function who(s: Store, opt: Record<string, string>): Member | { error: string } {
  if (opt.as) {
    const [squad, want, ...rest] = opt.as.split("/");
    const r = want && !rest.length ? splitRole(want) : null;
    if (!squad || !r) return { error: `--as is <squad>/<role[-suffix]>, not '${opt.as}'` };
    const project = opt.project ? dsLabel(opt.project) : "";
    if (!project) return { error: "--as needs --project <label>" };
    return { project, squad, ...r };
  }
  const env = process.env.DS_MEMBER;
  if (env) {
    const m = parseMember(env);
    if (!m) return { error: `DS_MEMBER is <project>/<squad>/<role[-suffix]>, not '${env}'` };
    return m;
  }
  const w = senderAt(s, toplevel());
  if (!w.project || !w.squad) return { error: "not in a squad member's worktree: pass --as <squad>/<role[-suffix]> --project <label>" };
  return { project: w.project, squad: w.squad, role: w.role, suffix: w.suffix };
}

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds finish: ${why}\n${USAGE}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["outcome", "body", "key", "as", "project", "squad", "member", "limit"], ["json"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  const s = open();
  try {
    if (pos[0] === "list") {
      if (pos.length !== 1) return usage("list takes no other words");
      const limit = opt.limit === undefined ? 50 : Number(opt.limit);
      if (!Number.isInteger(limit) || limit < 1) return usage(`--limit is a positive whole number, not '${opt.limit}'`);
      const rows = listFinishes(s, { project: opt.project ? dsLabel(opt.project) : undefined, squad: opt.squad, member: opt.member, limit });
      if (flag.has("json")) print(rows);
      else if (!rows.length) console.log("no finishes recorded");
      else for (const r of rows) console.log(finishLine(r));
      return 0;
    }
    if (pos.length !== 1) return usage("name one unit, or - for none");
    const outcome = opt.outcome ?? "";
    if (!isOutcome(outcome)) return usage(`--outcome is one of ${OUTCOMES.join(", ")}`);
    const body = opt.body ?? "";
    if (!body.trim()) return usage("--body <text> is required");
    const m = who(s, opt);
    if ("error" in m) { console.error(`ds finish: ${m.error}`); return 2; }
    const unit = pos[0] === "-" ? null : pos[0];
    const r = recordFinish(s, { member: m, unit, outcome, body, gen: process.env.DS_GEN || null, wt: toplevel(), key: opt.key || undefined });
    if (flag.has("json")) print({ created: r.created, finish: r.row });
    else console.log(`${r.created ? "finish recorded" : "finish already recorded"}: #${r.row.id} ${memberName(m)} ${unit ?? "-"} ${outcome}${r.row.gen ? ` gen=${r.row.gen}` : ""}`);
    return 0;
  } finally { s.close(); }
}
