// fulfil/plan-revoke.ts — kind `plan-revoke`: the board's "Take back approval" on a squad's Plans list
// (hold-cancels-queue-undo-approval U3). Payload {plan, why, keep_started?}: `plan` is the plan file's name
// in the squad's state folder. It runs U2's command, `squad-state.sh <state> revoke-plan <plan> --why
// "<why> (board)" [--keep-started]`, and finishes the request with the lines it printed. The command does
// the work (queued Builders dropped, started ones paused, the Lead told); the board never writes state.
// Running it again is safe: a plan that is no longer approved prints one line and changes nothing.
import { basename, join } from "node:path";
import { failRequest, finishRequest, requestActions, type Exec, type Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import { spawn } from "../io/orca.ts";
import { ROOT } from "../core/store.ts";
import { payloadOf } from "../core/kinds.ts";

const planRevoke: Fulfiller = {
  name: "plan-revoke",
  scope: "host",
  kinds: ["plan-revoke"],
  run: (ctx) => requestActions(ctx, ["plan-revoke"]),
  async exec(a: Action, x: Exec) {
    const p = payloadOf<"plan-revoke">(a);
    const project = a.project, squad = a.squad ?? "";
    const why = String(p.why ?? "").trim();
    if (!project || !squad || !p.plan || !why) return { failed: "a plan revoke needs a project, a squad, a plan and a reason" };
    if (basename(p.plan) !== p.plan || !p.plan.endsWith("-plan.md")) return { failed: `${p.plan} is not a plan file of ${project}/${squad}` };
    const dir = join(x.store.root, project, "squads");
    const r = await spawn([join(ROOT, "bin", "role", "squad-state.sh"), join(dir, `${squad}.json`), "revoke-plan", join(dir, p.plan), "--why", `${why} (board)`, ...(p.keep_started ? ["--keep-started"] : [])],
      { DS_STATE_ROOT: x.store.root, DS_WHO: "operator" }, 60_000);
    if (r.code !== 0) return { retry: `revoke-plan ${p.plan}: ${(r.err || r.out).trim().split("\n").pop()}` };
    const lines = r.out.trim().split("\n").filter(Boolean);
    finishRequest(x.store, a, { ok: true, plan: p.plan, lines }, x.now);
    return { done: true, result: lines[0] ?? `revoked ${p.plan}` };
  },
  giveUp: failRequest,
};
export default planRevoke;
