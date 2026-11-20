// pr-ready.ts — is a PR ready for a human to look at (U70)? Shared by the lifecycle reconciler and by
// `ask-operator.sh --pr` (CLI below, Bun). A PR is ready for a review ask when nothing but a human
// gate stands in the way: a required review, `signoff`, a proof hold that waits for a review. A
// conflict, a draft, a red or missing (non-human) check, an open review thread or requested changes
// is the Builder's to fix first. A check that is still running is not red or missing.
//
// Human gates (the loop asks the PR questions): a required context, or a failing or pending check,
// whose name matches HUMAN_GATE or a per-project list in config (file `github`, key `human_checks`,
// a comma-separated list of check names). Nothing here learns what a gate means, only that a human
// clears it. A PR is ready for the loop to ask about only when every other (non-gate) check has
// finished, no review thread is open, no changes are requested, it is not a draft or conflicting,
// and at least one human gate is left.
//
//   bun pr-ready.ts <state-file> <pr>   exit 0 ready (prints "ready"), 1 not ready (prints the reasons),
//                                       4 no observed row (prints "fetch <owner/name>"), 2 bad arguments
//   bun pr-ready.ts --judge "<reasons csv>" [--closed]   the same verdict over a reasons list
import { basename, dirname } from "node:path";
import { limit } from "../settings/limits.ts";
import { openReadOnly, type Row, type Store } from "../core/store.ts";

// The project's expected checks, as the GitHub observer reads them: unset (or `-`) is none.
export function expectedChecks(store: Store, project: string): string[] {
  return (limit(store, project, "expected_checks") ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== "-");
}

export const HUMAN_GATE = /(^|[^a-z])(review|signoff|sign-off|approval|proof)([^a-z]|$)/i;
const OK = new Set(["checks-running", "mergeable-unknown", "behind"]);

export const isHumanGate = (name: string, extra: string[] = []): boolean => {
  if (HUMAN_GATE.test(name)) return true;
  const lower = name.toLowerCase(), tokens = lower.split(/[^a-z]+/).filter(Boolean);
  return extra.some((x) => { const xl = x.trim().toLowerCase(); return xl && (xl === lower || tokens.includes(xl)); });
};

// The project's extra human-gate check names (config file `github`, key `human_checks`).
export function humanCheckNames(store: Store, project: string): string[] {
  for (const p of [project, ""]) {
    const v = store.get("config", { project: p, file: "github", key: "human_checks" })?.value;
    if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

// The reasons a PR is not ready for a human; empty = ready. `strict` (the ask-time check) also counts a
// `required:<check>` that is not a human gate; the loop's close path is not strict, because a check that
// has not reported yet right after a push also reads required:<check> (it is waiting, not wrong).
export function notReady(reasons: string[], closed = false, strict = true, extra: string[] = []): string[] {
  const out = reasons.filter((r) => r && !OK.has(r) && !(r.startsWith("required:") && (!strict || isHumanGate(r.slice(9), extra))));
  return closed ? ["closed", ...out] : out;
}

// An observed_prs row's verdict for this: null when it is merged (nothing left to ask).
export function rowNotReady(r: Row, strict = true, extra: string[] = []): string[] | null {
  if (r.state === "MERGED") return null;
  const reasons = r.reasons ? String(JSON.parse(String(r.reasons))).split(",") : [];
  return notReady(reasons, r.state === "CLOSED", strict, extra);
}

type Check = { name: string; failed: boolean; pending: boolean; required: boolean; kind: "run" | "status" };
// The checks on a full PR node (its observed doc), judged as the GitHub observer judges them.
export function checksOf(r: Row, expected: string[] = []): Check[] {
  let doc: Row = {};
  try { doc = JSON.parse(String(r.doc ?? "{}")) as Row; } catch { return []; }
  const commits = doc.commits as Row | undefined;
  const nodes = (commits?.nodes ?? []) as Row[];
  const commit = nodes[0]?.commit as Row | undefined;
  const rollup = commit?.statusCheckRollup as Row | undefined;
  const contexts = rollup?.contexts as Row | undefined;
  let ctx: unknown[] = (contexts?.nodes ?? []) as unknown[];
  // A head keeps every run of a check (a retarget may cancel the older): only the newest
  // non-skipped run of an expected check is judged, as the observer judges them.
  const runs = ctx.filter((c) => { const x = c as Row; return x.__typename === "CheckRun" && x.databaseId != null && expected.includes(String(x.name ?? "")) && !["SKIPPED", "NEUTRAL"].includes(String(x.conclusion ?? "")); });
  ctx = ctx.filter((c) => !runs.some((r) => (r as Row).name === (c as Row)?.name && Number((r as Row).databaseId) > Number((c as Row)?.databaseId ?? 0)));
  // Judged as the observer judges them: the required checks plus the expected ones, when any
  // check is required; otherwise all of them.
  const anyRequired = ctx.some((c) => (c as Row).isRequired === true);
  const judged = anyRequired ? ctx.filter((c) => (c as Row).isRequired === true || expected.includes(String((c as Row).name ?? (c as Row).context ?? ""))) : ctx;
  return (Array.isArray(judged) ? judged : []).map((c) => {
    const x = c as Row, name = String(x.name ?? x.context ?? "");
    const failed = x.__typename === "CheckRun"
      ? x.status === "COMPLETED" && ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(x.conclusion ?? ""))
      : ["FAILURE", "ERROR"].includes(String(x.state ?? ""));
    const pending = x.__typename === "CheckRun" ? String(x.status ?? "") !== "COMPLETED" : ["EXPECTED", "PENDING"].includes(String(x.state ?? ""));
    return { name, failed, pending, required: x.isRequired === true, kind: x.__typename === "CheckRun" ? "run" as const : "status" as const };
  }).filter((c) => c.name);
}

const reasonsOf = (r: Row): string[] => (r.reasons ? String(JSON.parse(String(r.reasons))) : "").split(",").filter(Boolean);

// The human gates still standing on a PR: required contexts and failing or pending checks whose
// name is a human gate, in the order they were read.
export function humanGates(r: Row, extra: string[] = [], expected: string[] = []): string[] {
  const out: string[] = [];
  const add = (n: string) => { if (n && !out.includes(n)) out.push(n); };
  for (const x of reasonsOf(r)) if (x.startsWith("required:") && isHumanGate(x.slice(9), extra)) add(x.slice(9));
  for (const c of checksOf(r, expected)) if ((c.failed || c.pending) && isHumanGate(c.name, extra)) add(c.name);
  return out;
}

// Ready for the loop to ask the operator about, or why not. Null when the PR is merged or closed
// (nothing left to ask). `blockers` empty and `gates` non-empty is ready to ask.
export function askState(r: Row, extra: string[] = [], expected: string[] = []): { gates: string[]; blockers: string[] } | null {
  if (r.state === "MERGED" || r.state === "CLOSED" || r.gone_at != null) return null;
  const reasons = reasonsOf(r), gates = humanGates(r, extra, expected), checks = checksOf(r, expected), blockers: string[] = [];
  const add = (b: string) => { if (!blockers.includes(b)) blockers.push(b); };
  if (Number(r.draft ?? 0)) add("draft");
  for (const x of reasons) {
    if (x === "conflicting" || x === "changes-requested" || x.startsWith("threads:")) add(x);
    else if (x.startsWith("required:") && !isHumanGate(x.slice(9), extra)) add(x);
  }
  if (String(r.review ?? "") === "changes") add("changes-requested");
  if (Number(r.threads ?? 0) > 0 && !blockers.some((b) => b.startsWith("threads:"))) add(`threads:${r.threads}`);
  for (const c of checks) {
    if (c.failed && !isHumanGate(c.name, extra)) add("checks-failing");
    // A running check holds the ask (a review bot can still add threads), unless it is itself a
    // human gate waiting on the human: a pending status-context gate, or a required gate.
    if (c.pending && !((c.kind === "status" || c.required) && isHumanGate(c.name, extra))) add("checks-running");
  }
  // With no check detail on the row, the reasons alone judge the checks.
  if (!checks.length) {
    if (reasons.includes("checks-failing")) add("checks-failing");
    if (reasons.includes("checks-running")) add("checks-running");
  }
  return { gates, blockers };
}

// The PR's head commit, when its observed doc carries one.
export const headOf = (r: Row): string => {
  try { return String((JSON.parse(String(r.doc ?? "{}")) as Row).headRefOid ?? ""); } catch { return ""; }
};

// The latest review body on the PR, when its observed doc carries one: quoted under the loop's
// question so the operator sees the newest review without leaving the board.
export function latestReview(r: Row): string {
  let doc: Row = {};
  try { doc = JSON.parse(String(r.doc ?? "{}")) as Row; } catch { return ""; }
  const reviews = ((doc.reviews as Row)?.nodes ?? []) as Row[];
  for (let i = reviews.length - 1; i >= 0; i--) {
    const b = reviews[i].body ?? reviews[i].text;
    if (typeof b === "string" && b.trim()) return b.trim();
  }
  return "";
}

// The pr-question episode key for a PR row: one ask per head and gate set.
export const prQuestionKey = (n: number, r: Row, extra: string[] = [], expected: string[] = []): string =>
  `${n}|${headOf(r)}|${humanGates(r, extra, expected).join(",")}`;

export function main(args: string[]): number {
  const err = (m: string) => { console.error(`pr-ready: ${m}`); return 2; };
  if (args[0] === "--judge") {
    const bad = notReady((args[1] ?? "").split(","), args.includes("--closed"));
    console.log(bad.length ? bad.join(",") : "ready");
    return bad.length ? 1 : 0;
  }
  const [file, n] = args;
  if (!file || !/^\d+$/.test(n ?? "")) return err("usage: pr-ready.ts <state-file> <pr>");
  const squads = dirname(file), project = basename(dirname(squads)), topic = basename(file, ".json");
  if (basename(squads) !== "squads") return err(`${file} is not under <state>/<project>/squads/`);
  let store: Store;
  try { store = openReadOnly(dirname(dirname(squads))); } catch { console.log("fetch "); return 4; } // no loop.db yet: ask GitHub
  try {
    const sq = store.get("squads", { project, topic });
    const nwo = sq?.repo ? (store.get("config", { project, file: "github", key: `repo:${sq.repo}` })?.value as string) || "" : "";
    const row = nwo ? store.get("observed_prs", { project, ref: `${nwo}#${n}` })
      : (store.db.query("SELECT * FROM observed_prs WHERE project = ? AND pr = ? AND gone_at IS NULL ORDER BY observed_at DESC").get(project, Number(n)) as Row | null);
    if (!row) { console.log(`fetch ${nwo}`); return 4; }
    const extra = humanCheckNames(store, project);
    // With check detail on the row, judge as the loop's ask does (a failing human gate is the
    // gate itself, not a red check); without it, the reasons alone judge.
    const st = checksOf(row, expectedChecks(store, project)).length ? askState(row, extra, expectedChecks(store, project)) : null;
    const bad = st ? st.blockers : rowNotReady(row, true, extra);
    if (!bad || !bad.length) { console.log("ready"); return 0; }
    console.log(bad.join(","));
    return 1;
  } catch { return 3; }   // 1 means "not ready" and nothing else: a crash must not read as a verdict
  finally { store.close(); }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
