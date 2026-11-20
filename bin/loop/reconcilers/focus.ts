// focus.ts — the focus of a squad that ended (squad-priority U1). A project's `focus_squad` row that names
// a done, closed or gone squad is removed through settings.ts with actor `loop`, so the change has its
// config_history row and its `focus_set` event like any other. A suspended or on-hold squad keeps its
// focus (it counts again on resume); slot.ts ignores it meanwhile (squad/focus.ts focusSquad).
import type { Reconciler } from "../core/plugins.ts";
import { rm } from "../settings/settings.ts";
import { ENDED, FOCUS_KEY, NO_FOCUS, squadRow } from "../squad/focus.ts";

const focus: Reconciler = {
  name: "focus",
  run({ store, project: P }) {
    const row = store.get("config", { project: P, file: "limits.conf", key: FOCUS_KEY });
    const squad = row ? String(row.value ?? "").trim().split(/\s+/)[0] : "";
    if (!squad || squad === NO_FOCUS) return [];
    const s = squadRow(store, P, squad);
    if (s && ENDED.includes(String(s.status ?? ""))) rm(store, P, "limits.conf", FOCUS_KEY, "loop");
    return [];
  },
};
export default focus;
