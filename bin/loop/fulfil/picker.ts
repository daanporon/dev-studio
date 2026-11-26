// fulfil/picker.ts — kind `picker`, op `resolve` (permission-prompt-needs-you U5): reapPickers
// (reconcilers/alerts.ts) files one for a picker entry whose prompt is gone (its picker closed, its worktree or
// terminal is gone, or it is over age). It is resolved the way `squad-state.sh resolve-question` does, which also
// clears the card worktree's NEEDS YOU note: `--via terminal` for a closed picker (answered in the terminal, the chat
// key pad, or Claude's auto-block, which all end in a tool_result), `--via reality` for the rest. An id with no open
// question (answered from the board meanwhile, or never in the state) finishes done with no change.
import { join } from "node:path";
import type { Row } from "../core/store.ts";
import { ROOT } from "../core/store.ts";
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import { errOf, spawn } from "../io/orca.ts";

export const viaOf = (reason: string): "terminal" | "reality" => (reason.startsWith("its picker closed") ? "terminal" : "reality");

const picker: Fulfiller = {
  name: "picker",
  scope: "host",
  kinds: ["picker"],
  run: (ctx) => requestActions(ctx, ["picker"]),
  async exec(a, x) {
    const p = payloadOf<"picker">(a);
    if (p.op !== "resolve") return { failed: `picker: unknown op '${p.op}' (only resolve)` };
    const squad = p.squad || a.squad;
    if (!a.project || !squad || !p.id) return { failed: "a picker resolve needs a project, a squad and an id" };
    const open = x.store.db.query("SELECT 1 FROM questions WHERE project = ? AND squad = ? AND id = ? AND status = 'open'").get(a.project, squad, p.id) as Row | null;
    if (!open) {
      finishRequest(x.store, a, { ok: true, changed: false, why: "no open question with this id" }, x.now);
      return { done: true, result: "already resolved" };
    }
    const reason = p.reason || "its prompt is gone", via = viaOf(reason);
    const state = join(x.store.root, a.project, "squads", `${squad}.json`);
    const o = await spawn([join(ROOT, "bin", "role", "squad-state.sh"), state, "resolve-question", p.id, "--answer", reason, "--via", via],
      { DS_STATE_ROOT: x.store.root }, 30_000);
    if (o.code !== 0) return { retry: errOf(o, "squad-state.sh resolve-question") };
    finishRequest(x.store, a, { ok: true, changed: true, via }, x.now);
    return { done: true, result: via };
  },
  giveUp: failRequest,
};
export default picker;
