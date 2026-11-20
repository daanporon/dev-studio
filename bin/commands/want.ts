// ds want — write a wish (KTD15): the `want` column of a squad or member row. The loop makes it true;
// asking again for the same wish is a no-op (one row, one event). --wait polls until the row's
// observed status matches (or the loop records a result) and exits 1 when it does not in time, or
// when the loop gave up (`failed: …`). It follows the wish to whichever row holds it by then (an
// import may rekey it). --fill sets the row's own columns with the wish (a lifecycle script's
// repo, type, tier, …).
// A member also takes one-time wishes (U151), with or without a state: --restart [now|idle] (default
// now), --reload, --clear; --model/--account pins it (an overrides row and a restart once idle, in one
// transaction) and --unpin clears the pin. Each write is one event (field, old, new, --by, --why).
// `ds want board …` is the web board's wish (U16): bin/commands/services.ts.
import { follow, replayOf } from "../loop/messages/replay.ts";
import { open, pendingWishes, storedWant, WANTS, type OneTime, type Row, type RestartMode, type Subject } from "../loop/core/store.ts";
import { effective } from "../loop/pause/pause.ts";
import { parse, print, seconds, shape, waitFor } from "../loop/core/cli.ts";
import { wantBoard, wantHelp } from "./services.ts";

const MEMBER_FLAGS = "[--restart [now|idle]] [--reload] [--clear] [--model <m>] [--account <a>] [--unpin]";
export const help = `<squad|member> <id> <${WANTS.join("|")}> [--payload <json>] [--fill <json>] [--by <who>] [--why <text>] [--wait <s>] — id: row id, worktree id, <project>/<topic>[/<role>[/<suffix>]]; `
  + `member <id> [running|stopped|archived] ${MEMBER_FLAGS} — a member's state and one-time wishes; or: board ${wantHelp}`;

export async function run(args: string[]): Promise<number> {
  if (args[0] === "board") return wantBoard(args.slice(1));
  // --restart takes an optional mode: the next word only when it is one.
  let restart: RestartMode | null = null;
  args = args.filter((a, i) => {
    if (a === "--restart") { restart = args[i + 1] === "idle" ? "idle" : "now"; return false; }
    return !(args[i - 1] === "--restart" && (a === "now" || a === "idle"));
  });
  const { pos, opt, flag } = parse(args, ["payload", "fill", "by", "why", "wait", "model", "account"], ["reload", "clear", "unpin"]);
  const [subject, id, state] = pos;
  const once: OneTime[] = [...(restart ? ["restart" as const] : []), ...(["reload", "clear"] as const).filter((k) => flag.has(k))];
  const pin = opt.model !== undefined || opt.account !== undefined;
  const memberOnly = once.length > 0 || pin || flag.has("unpin");
  const usage = (why?: string) => { console.error(`${why ? `ds want: ${why}\n` : ""}usage: ds want ${help}`); return 2; };
  if ((subject !== "squad" && subject !== "member") || !id || pos.length > 3 || (!state && !memberOnly)) return usage();
  if (memberOnly && subject !== "member") return usage("one-time wishes and pins are for a member");
  if (pin && flag.has("unpin")) return usage("--unpin clears a pin: not with --model/--account");
  if (pin && !opt.model && !opt.account) return usage("--model or --account needs a value");
  if (!state && opt.wait !== undefined) return usage("--wait waits for a state");
  const wait = seconds(opt.wait);
  const payload = opt.payload === undefined ? undefined : JSON.parse(opt.payload);
  const fill = opt.fill === undefined ? undefined : JSON.parse(opt.fill);
  const s = open();
  try {
    const by = opt.by ?? process.env.DS_WHO ?? "ds", why = opt.why;
    const account = opt.account || null, model = opt.model || null;
    // A pin on a disabled account is refused before anything is written.
    if (pin && account) {
      // Loaded only for a pin: the picker pulls in most of the loop.
      const [{ agentOf }, { disabledFor }] = await Promise.all([import("../loop/capacity/pick.ts"), import("../loop/fulfil/override.ts")]);
      const known = s.resolve("member", id, false);
      const agent = model ? agentOf(s, String(known?.project ?? ""), model, []) : (known?.agent as string | null) ?? null;
      if (disabledFor(s, account, agent)) { console.error(`ds want: account ${account} is disabled (ds account enable to use it)`); return 2; }
    }
    let row: Row, changed = false;
    if (state) {
      ({ row, changed } = s.want(subject as Subject, id, state, { payload, fill, by, why }));
    } else {
      const found = s.resolve("member", id, false);
      if (!found) { console.error(`ds want: no member '${id}'`); return 2; }
      row = found;
    }
    const mid = String(row.id);
    if (pin) { row = s.pin(mid, { model, account }, { by, why }).row; changed = true; }
    if (flag.has("unpin")) { const u = s.unpin(mid, { by, why }); row = u.row; changed ||= u.changed; }
    for (const k of once) {
      const w = s.wishOnce(mid, k, { by, why, ...(k === "restart" ? { mode: restart! } : {}) });
      row = w.row; changed ||= w.changed;
    }
    const view = (r: Row) => subject === "member" ? { ...shape(r), effective: effective(s, r).state, pending: pendingWishes(r) } : shape(r);
    if (wait === null || !state) { print({ ...view(row), changed }); return 0; }
    let last = row;
    const replay = replayOf(row.want_payload) !== null, table = subject === "squad" ? "squads" : "members", stored = storedWant(subject, state);
    const met = await waitFor(wait, () => {
      last = follow(s, table, Number(row.id), row.want_at, row.want_payload) ?? { ...last, status: "gone" };
      const res = String(last.want_result ?? "");
      if (/^(done|failed|dropped)/.test(res)) return true;
      if (stored === "gone" && (last.status === "gone" || last.status === "closed")) return true;
      return !replay && (last.status === stored || res !== "");
    });
    print({ ...view(last), changed });
    if (/^(failed|dropped)/.test(String(last.want_result ?? ""))) { console.error(`the loop gave up (row ${row.id}): ${last.want_result}`); return 1; }
    if (met) return 0;
    console.error(`still wanted (row ${row.id}); asking again is a no-op`);
    return 1;
  } finally { s.close(); }
}
