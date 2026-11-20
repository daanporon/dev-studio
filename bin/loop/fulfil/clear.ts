// fulfil/clear.ts — kind `alert-clear`: the Studio alerts under a prefix (or one exact id) are resolved
// (bin/lib/alerts.sh resolve-prefix / resolve), the sweep's alert_clear. Ported from the removed sweep at origin/main
// 898381d. The state observer reads alerts.json again once the file changes.
import { join } from "node:path";
import type { Fulfiller } from "../core/actuator.ts";
import { errOf, spawn } from "../io/orca.ts";
import { ROOT } from "../core/store.ts";

const clear: Fulfiller = {
  name: "clear",
  kinds: ["alert-clear"],
  run: () => [],
  async exec(a, x) {
    // payload.prefix resolves every id under it; payload.id (U56) exactly that one alert.
    const p = a.payload as { prefix?: string; id?: string } | null, op = p?.id ? ["resolve", p.id] : p?.prefix ? ["resolve-prefix", p.prefix] : null;
    if (!a.project || !op) return { failed: "an alert-clear needs a project and a prefix or an id" };
    const o = await spawn([join(ROOT, "bin", "lib", "alerts.sh"), join(x.store.root, a.project, "alerts.json"), ...op], {}, 30_000);
    return o.code === 0 ? { done: true } : { retry: errOf(o, "alerts.sh") };
  },
};
export default clear;
