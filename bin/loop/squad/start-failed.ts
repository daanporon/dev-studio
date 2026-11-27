// start-failed.ts — U270: a failed Claude launch keeps its evidence. The adapter (bin/backend/orca.ts,
// `launched` and `openTab`) prints one `orca adapter: start_failed <json>` line after the failure's own
// line: the tab's last 40 screen lines (what Claude printed before it quit), or what Orca's `terminal create`
// said when no tab opened. Every Orca mutation goes through the actuator's call(), which hands its answer
// here: each such line becomes one `start_failed` event (project, squad, member, worktree, account, the
// failure, the screen or Orca's output, and the load1 of this host's last machine sample), and leaves the answer.
// The failure's line gains only a pointer ("screen in event start_failed <id>"), so the refusal text, its
// class, its card and every fingerprint stay as they were.
import type { Out } from "../io/orca.ts";
import type { Store } from "../core/store.ts";

export const START_FAILED = "orca adapter: start_failed ";

type Who = { project: string; squad: string | null; member: string | null };
type Doc = { failure?: unknown; worktree?: unknown; account?: unknown; screen?: unknown; orca?: unknown };

function load1(store: Store): number | null {
  const r = store.db.query("SELECT load1 FROM observed_machine WHERE host = 'local' ORDER BY observed_at DESC LIMIT 1").get() as { load1: number | null } | null;
  return r?.load1 ?? null;
}

function keep(store: Store, text: string, who: Who): string {
  if (!text.includes(START_FAILED)) return text;
  const lines = text.split("\n"), out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(START_FAILED)) { out.push(line); continue; }
    let doc: Doc;
    try { doc = JSON.parse(line.slice(START_FAILED.length)) as Doc; } catch { out.push(line); continue; }
    const failure = typeof doc.failure === "string" ? doc.failure : "";
    const id = store.event("start_failed", { project: who.project, squad: who.squad, member: who.member, payload: {
      worktree: doc.worktree ?? null, account: doc.account ?? null, failure, screen: doc.screen ?? null, orca: doc.orca ?? null, load1: load1(store),
    } });
    const pointer = `(screen in event start_failed ${id})`, own = `orca adapter: ${failure}`;
    const at = out.lastIndexOf(own);
    if (failure && at >= 0) out[at] = `${own} ${pointer}`;
    else out.push(`orca adapter: ${pointer}`);
  }
  return out.join("\n");
}

/** The answer with each start_failed line turned into its event (none: the answer as it was). */
export function keepStartFailed(store: Store, o: Out, who: Who): Out {
  if (!o.err.includes(START_FAILED) && !o.out.includes(START_FAILED)) return o;
  return { ...o, err: keep(store, o.err, who), out: keep(store, o.out, who) };
}
