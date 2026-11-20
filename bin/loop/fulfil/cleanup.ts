// fulfil/cleanup.ts — kind `cleanup.report` (host-disk-cleanup U2): the project's one Host tidy card
// in the board's Needs-you, built from its `observed_cleanup` rows and verdicts (reconcilers/cleanup.ts):
// totals per class and per verdict, the 20 largest rows that are not a live member, each glob, the
// invalid globs and any refusal. The card is shown only when the operator has something to do
// (`needsYou`, U8): a refusal or failed backend list, an invalid glob, removable rows while host_tidy
// is not `apply`, or a removal that failed under `apply`; otherwise it is resolved, and `ds observed
// cleanup` still lists every row. Nothing is deleted or stopped here (AE6): with host_tidy `apply`
// that is fulfil/cleanup-act.ts, and the card says so, with what it removed in the last 24 hours and
// the error of any row it failed on (U3).
import { alert, resolveAlert, type Fulfiller } from "../core/actuator.ts";
import { cleanupGlobs, limit } from "../settings/limits.ts";
import { errOf } from "../io/orca.ts";
import { now, type Store } from "../core/store.ts";

export const CARD = "card";
export const CARD_KIND = "host_tidy";
const CLASSES: Record<string, string> = { a: "processes", b: "Claude temp dirs", c: "helper checkouts", d: "worktrees", e: "glob files" };
const LIST = 20;

type R = { class: string; key: string; path: string | null; pid: number | null; size_kb: number | null; verdict: string | null; facts: string | null };

export function human(kb: number): string {
  const u = ["kB", "MB", "GB", "TB"];
  let v = kb, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

const facts = (r: R): Record<string, unknown> => { try { return JSON.parse(r.facts ?? "{}") ?? {}; } catch { return {}; } };
const what = (r: R): string => {
  const f = facts(r);
  if (r.class === "a") return `pid ${r.pid} ${f.comm ?? ""} in ${f.cwd ?? r.path}`.replace(/\s+/g, " ");
  if (r.class === "e") return `${f.count} files matching ${r.key}`;
  if (r.class === "d" && typeof f.entity === "string") return `Orca worktree ${f.name ?? f.entity}${r.path ? ` (${r.path})` : ""}`;
  return String(r.path ?? r.key);
};

// The card text, or null when the project has nothing to report.
export function cardText(store: Store, project: string, o: { refused?: string | null; now?: number } = {}): string | null {
  const rows = store.db.query("SELECT class, key, path, pid, size_kb, verdict, facts FROM observed_cleanup WHERE project = ? AND gone_at IS NULL ORDER BY class, key").all(project) as R[];
  const globs = cleanupGlobs(store, project);
  const shown = rows.filter((r) => r.verdict !== "live member");
  const scan = store.db.query("SELECT ps_error, loose_count, loose_kb FROM observed_cleanup_scan ORDER BY observed_at DESC LIMIT 1").get() as
    { ps_error: string | null; loose_count: number | null; loose_kb: number | null } | null;
  if (!shown.length && !globs.rejected.length && !o.refused && !scan?.ps_error) return null;
  const kb = (rs: R[]) => rs.reduce((s, r) => s + (r.class === "a" ? 0 : Number(r.size_kb ?? 0)), 0);
  const word = (v: string | null) => (v?.startsWith("in use by pid") ? "in use" : v ?? "unjudged");
  const removable = rows.filter((r) => r.verdict === "removable");
  const memory = removable.filter((r) => r.class === "a").reduce((s, r) => s + Number(r.size_kb ?? 0), 0);
  const out = [
    limit(store, project, "host_tidy") === "apply" ? "Apply: the loop removes what reads removable, one at a time, after reading it again."
      : "Report only: the loop deletes and stops nothing here.",
    `${rows.length} rows, ${removable.length} removable (${human(kb(removable))} disk${removable.some((r) => r.class === "a") ? `, ${human(memory)} memory` : ""}).`,
    `By class: ${[...Map.groupBy(rows, (r) => r.class)].map(([c, rs]) => `${c} ${CLASSES[c] ?? c} ${rs.length}${c === "a" ? "" : ` (${human(kb(rs))}${rs.some((r) => facts(r).partial) ? "+" : ""})`}`).join(" · ")}`,
    `By verdict: ${[...Map.groupBy(rows, (r) => word(r.verdict))].sort((a, b) => b[1].length - a[1].length).map(([v, rs]) => `${v} ${rs.length}`).join(" · ")}`,
  ];
  const done = removedSince(store, project, (o.now ?? now()) - 86_400);
  if (done) out.push(done);
  if (o.refused) out.push(`Refused: ${o.refused}. Every row is report only.`);
  if (scan?.ps_error) out.push(`Refused for classes c and d: the backend worktree list ${scan.ps_error}.`);
  if (shown.length) {
    out.push(`Largest${shown.length > LIST ? ` ${LIST} of ${shown.length}` : ""}:`);
    const order = [...shown].sort((a, b) => Number(b.verdict === "removable") - Number(a.verdict === "removable") || Number(b.size_kb ?? 0) - Number(a.size_kb ?? 0) || a.key.localeCompare(b.key));
    for (const r of order.slice(0, LIST)) out.push(`- [${r.class}] ${r.verdict ?? "unjudged"} · ${r.size_kb === null ? "?" : human(Number(r.size_kb))}${facts(r).partial ? "+" : ""} · ${what(r)}${facts(r).act_error ? ` · failed: ${facts(r).act_error}` : ""}`);
  }
  for (const r of rows.filter((x) => x.class === "e")) {
    const f = facts(r);
    out.push(`Glob ${r.key}: ${f.count} matched, ${f.removable ?? 0} removable, too new ${f.too_new ?? 0}, not ours ${f.not_ours ?? 0}, in use ${f.in_use ?? 0}.`);
  }
  for (const g of globs.rejected) out.push(`Invalid glob ${g.glob}: ${g.reason} (matches nothing).`);
  if (scan?.loose_count) out.push(`Host: ${scan.loose_count} loose files in the Claude temp root (${human(Number(scan.loose_kb ?? 0))}), report only.`);
  out.push(`Every row: ds observed cleanup --project ${project}`);
  return out.join("\n");
}

// Why the operator is needed, or null when the loop has it (U8). Reads the same rows as `cardText`.
export function needsYou(store: Store, project: string, o: { refused?: string | null } = {}): string | null {
  const rows = store.db.query("SELECT class, key, path, pid, size_kb, verdict, facts FROM observed_cleanup WHERE project = ? AND gone_at IS NULL").all(project) as R[];
  const scan = store.db.query("SELECT ps_error FROM observed_cleanup_scan ORDER BY observed_at DESC LIMIT 1").get() as { ps_error: string | null } | null;
  const mode = limit(store, project, "host_tidy");
  const why: string[] = [];
  if (o.refused) why.push(`refused: ${o.refused}.`);
  if (scan?.ps_error) why.push(`the backend worktree list ${scan.ps_error}, classes c and d are refused.`);
  for (const g of cleanupGlobs(store, project).rejected) why.push(`invalid glob ${g.glob}: ${g.reason}.`);
  if (mode === "apply") {
    const failed = rows.filter((r) => facts(r).act_error).length;
    if (failed) why.push(`${failed} removal${failed === 1 ? "" : "s"} failed.`);
  } else {
    const n = rows.filter((r) => r.verdict === "removable").length;
    if (n) why.push(`${n} removable, host_tidy is ${mode || "report"} — switch it to apply or leave it.`);
  }
  return why.length ? why.join(" ") : null;
}

// What cleanup.act did since `since`: one line, or null when it did nothing.
function removedSince(store: Store, project: string, since: number): string | null {
  const ev = store.db.query("SELECT kind, payload FROM events WHERE project = ? AND at >= ? AND kind IN ('cleanup_removed', 'cleanup_stopped', 'cleanup_failed')").all(project, since) as { kind: string; payload: string | null }[];
  if (!ev.length) return null;
  let items = 0, kb = 0, stopped = 0, failed = 0;
  for (const e of ev) {
    const p = (() => { try { return JSON.parse(e.payload ?? "{}") ?? {}; } catch { return {}; } })() as { count?: number; kb?: number | null; pids?: unknown[] };
    if (e.kind === "cleanup_failed") failed++;
    else if (e.kind === "cleanup_stopped") stopped += Array.isArray(p.pids) ? p.pids.length : 1;
    else { items += p.count ?? 1; kb += Number(p.kb ?? 0); }
  }
  return `Last 24 hours: removed ${items} (${human(kb)}), stopped ${stopped} process${stopped === 1 ? "" : "es"}, failed ${failed}.`;
}

const cleanup: Fulfiller = {
  name: "cleanup-card",
  kinds: ["cleanup.report"],
  run: () => [],
  async exec(a, x) {
    const refused = ((a.payload ?? {}) as { refused?: string | null }).refused ?? null;
    const why = needsYou(x.store, a.project, { refused });
    const body = why === null ? null : cardText(x.store, a.project, { refused });
    const text = why === null ? null : `Needs you: ${why}${body === null ? "" : `\n${body}`}`;
    const removable = Number((x.store.db.query("SELECT COUNT(*) AS n FROM observed_cleanup WHERE project = ? AND gone_at IS NULL AND verdict = 'removable'").get(a.project) as { n: number }).n);
    const o = text === null
      ? await resolveAlert(x.store, a.project, a.subject, CARD)
      : await alert(x.store, a.project, a.subject, CARD, text, { title: `Host tidy: ${a.project}`, fields: { kind: CARD_KIND, removable, refused } });
    return o.code === 0 ? { done: true } : { retry: errOf(o, "alerts.sh") };
  },
};
export default cleanup;
