// ds request — a Lead asks for a role (U12, KTD1): one member wish, and the loop does the rest. The
// pick reconciler (U9) picks it an agent, model and account through the ladder (tier from the unit,
// or --tier), the member fulfiller (U11) starts it with add-role.sh's worktree name and prompt and
// records the members and units rows, and reconcilers/requests.ts tells the Lead once it started.
// Nothing free at or above the floor: the unfinished wish stays idle and re-picks every tick. Asking again for a live member is a no-op; asking again after its start
// failed starts it afresh, and placement picks its side host again unless --host forced it.
import { execFileSync } from "node:child_process";
import { now, open, type Row, type Store } from "../loop/core/store.ts";
import { parse, print, seconds, shape, waitFor } from "../loop/core/cli.ts";
import { unknownRole } from "../loop/reconcilers/requests.ts";
import { movable } from "../loop/capacity/place.ts";
import { onSide } from "../loop/squad/backend.ts";

export const help = `<role> [--unit <slug>] [--suffix <s>] [--tier standard|hard] [--spec <text>] [--squad <project>/<topic>] [--by <who>] [--wait <s>] — start a role in the squad: a builder takes --unit (its suffix), other roles --suffix; the squad defaults to the one this worktree belongs to; --host <name> starts it on that side host`;

// The squad whose member (or Lead) worktree holds the current directory.
function here(s: Store): { project: string; topic: string } | null {
  let top: string;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  const tail = `%::${top}`;
  const m = s.db.query("SELECT project, squad AS topic FROM members WHERE (wt LIKE ? OR wt = ?) AND COALESCE(status, '') != 'gone' ORDER BY id DESC").get(tail, top) as Row | null;
  const r = m ?? s.db.query("SELECT project, topic FROM squads WHERE lead_wt LIKE ? OR lead_wt = ?").get(tail, top) as Row | null;
  return r ? { project: String(r.project), topic: String(r.topic) } : null;
}

// A unit named loosely (`U15`, `u15`) is the squad's unit with that slug or that slug prefix; null
// when the squad has no such unit.
function unitSlug(s: Store, project: string, topic: string, unit: string): string | null {
  const rows = s.db.query("SELECT slug FROM units WHERE project = ? AND squad = ?").all(project, topic) as { slug: string }[];
  const lc = unit.toLowerCase();
  return (rows.find((r) => r.slug === unit) ?? rows.find((r) => r.slug.toLowerCase() === lc) ?? rows.find((r) => r.slug.toLowerCase().startsWith(`${lc}-`)))?.slug ?? null;
}

function out(s: Store, row: Row, changed: boolean) {
  const p = s.get("picks", { member: row.id });
  print({ ...shape(row), changed, pick: p ? { agent: p.agent, model: p.model, effort: p.effort, account: p.account, slot: p.slot, wait_until: p.wait_until, reason: p.reason } : null });
}

export async function run(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(`usage: ds request ${help}`); return 0; }
  const { pos, opt } = parse(args, ["unit", "suffix", "tier", "spec", "squad", "by", "wait", "host"]);
  const [role] = pos;
  const usage = (why: string) => { console.error(`ds request: ${why}\nusage: ds request ${help}`); return 2; };
  if (!role || pos.length > 1) return usage("name one role");
  const bad = unknownRole(role);
  if (bad) return usage(bad);
  if (opt.tier !== undefined && !["standard", "hard"].includes(opt.tier)) return usage(`--tier is standard or hard, not '${opt.tier}'`);
  if (role === "builder" && !opt.unit) return usage("a builder works a unit: --unit <slug>");
  const wait = seconds(opt.wait);
  const s = open();
  try {
    let sq: { project: string; topic: string } | null = null;
    if (opt.squad) {
      const [project, topic, ...rest] = opt.squad.split("/");
      if (!project || !topic || rest.length) return usage(`--squad is <project>/<topic>, not '${opt.squad}'`);
      sq = { project, topic };
    } else sq = here(s);
    if (!sq) return usage("not in a squad worktree: pass --squad <project>/<topic>");
    if (!s.get("squads", { project: sq.project, topic: sq.topic })) { console.error(`ds request: no squad '${sq.topic}' in project '${sq.project}'`); return 1; }

    const unit = opt.unit ? unitSlug(s, sq.project, sq.topic, opt.unit) : undefined;
    if (unit === null) return usage(`no unit '${opt.unit}' in squad ${sq.project}/${sq.topic}`);
    const suffix = role === "builder" ? unit! : opt.suffix ?? unit;
    if (!suffix) return usage(`a ${role} needs --suffix <s> (or --unit <slug>)`);
    if (!/^[A-Za-z0-9._-]+$/.test(suffix)) return usage(`bad suffix '${suffix}'`);
    const id = `${sq.project}/${sq.topic}/${role}/${suffix}`, by = opt.by ?? process.env.DS_WHO ?? "lead";
    // side-loop-host U10: --host forces the side host the member runs on (tests, the operator); `local` is this host.
    const host = opt.host === undefined || opt.host === "local" ? null : opt.host;
    if (host !== null && !s.get("hosts", { name: host })) { console.error(`ds request: no host '${host}' (ds host list)`); return 1; }

    // A live member with this slot running, or wanted running and not yet settled: the request is
    // already in hand. One whose start failed (or ended otherwise) is wished again, as a new episode.
    const live = s.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
      .get(sq.project, sq.topic, role, suffix) as Row | null;
    let row: Row, changed = false;
    if (live && (live.status === "running" || (live.want === "running" && live.want_result == null))) row = live;
    else if (opt.host !== undefined && live?.wt && String(live.host ?? "local") !== (host ?? "local")) {
      console.error(`ds request: ${role}/${suffix} has a worktree on ${live.host ?? "local"}; --host ${opt.host} can't move it`); return 1;
    } else {
      const payload: Row = { why: "start", request: true, ...(unit && role === "builder" ? { unit } : {}), ...(opt.spec ? { spec: opt.spec } : {}) };
      row = s.tx(() => {
        // U11b: a side host placement chose (movable: no worktree, and the member's picks row still names it) is
        // cleared with that row, so the new start is placed again; left alone it would read as a --host pin.
        const repick = opt.host === undefined && !!live && onSide(live.host) && movable(s, live, role);
        const wanted = s.want("member", id, "running", { payload, by, rearm: true }).row;
        s.db.run("DELETE FROM picks WHERE member = ?", [wanted.id as number]);
        // No doc yet: squadDoc exports members with one, and a wt-less member in the squad doc would
        // round-trip onto every other wt-less member. The fulfiller writes it with the worktree.
        s.fact("member_requested", [{ table: "members", key: { id: wanted.id }, set: {
          phase: "build", ...(opt.tier ? { tier: opt.tier } : {}), ...(opt.host !== undefined || repick ? { host } : {}), status: "wanted", updated_at: now(),
        } }], { project: sq!.project, squad: sq!.topic, member: `${role}/${suffix}`, payload: { id: wanted.id, role, suffix, unit: unit ?? null, tier: opt.tier ?? null, by } });
        return s.wish("member", Number(wanted.id))!;
      });
      changed = true;
    }
    if (wait === null) { out(s, row, changed); return 0; }
    const met = await waitFor(wait, () => {
      row = s.wish("member", Number(row.id)) ?? row;
      const p = s.get("picks", { member: row.id });
      const accepted = p?.slot === 0 && (p.reason === "no account free" || String(p.reason ?? "").startsWith("queued:"));
      return row.status === "running" || row.status === "waiting" || (row.want_result ?? null) !== null || accepted;
    });
    out(s, row, changed);
    return met && !/^(failed|rejected)/.test(String(row.want_result ?? "")) ? 0 : 1;
  } finally { s.close(); }
}
