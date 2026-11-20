// fulfil/withdraw.ts — kind `withdraw`: a pending early switch request is taken back, the sweep's
// drop_early. Ported from the removed sweep at origin/main 898381d.
//
// The file is the result of the settled `action:<payload.of>` claim of that episode (fulfil/request.ts
// returns it). A request the sweep wrote has no claim: its imported `switch` row names the file, and
// goes with it, as drop_early removes the marker, so the next quiet point asks again. A request not
// written yet has its claim ended, so it never is. No file is done, not an error.
import { rmSync } from "node:fs";
import type { Fulfiller } from "../core/actuator.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

type P = ActionPayload<"withdraw">;

const withdraw: Fulfiller = {
  name: "withdraw",
  kinds: ["withdraw"],
  run: () => [],
  exec(a, x) {
    const { store, now } = x, p = payloadOf<"withdraw">(a);
    if (!p.of || !p.key || !p.episode) return { failed: "a withdraw needs the kind, the key and the episode it takes back" };
    const key = { project: a.project, subject: p.key, kind: `action:${p.of}` }, claim = store.get("episodes", key);
    let file: string | undefined;
    if (claim?.episode_key === p.episode) {
      if (claim.state === "done") file = claim.result == null ? undefined : String(claim.result);
      else if (claim.ended_at == null) store.upsert("episodes", key, { state: "dropped", ended_at: now, next_at: null, action: null, observed_at: now });
    } else {
      const sw = { project: a.project, subject: p.key, kind: "switch" }, imp = store.get("episodes", sw), base = p.episode.replace(/#\d+$/, "");
      if (imp?.source === "sweep" && imp.episode_key === base) {
        file = String(imp.state ?? "").match(/^request (.+)$/)?.[1];
        store.db.run("DELETE FROM episodes WHERE id = ?", [imp.id as number]);
      }
    }
    if (!file) return { done: true, result: "no file" };
    rmSync(file, { force: true });
    return { done: true, result: file };
  },
};
export default withdraw;
