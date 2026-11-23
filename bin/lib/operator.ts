// operator.ts — helpers the ported operator commands share (U263): a `ds … want|request` call that keeps
// this process's stdio, jq's raw/@tsv/string-interpolation renderings of a JSON value, bash's `read` split,
// and the helpers those commands call (limitSrc, shipMode, skipLensesProblem).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, stateRoot, readIfs } from "./shared";
import { BACKEND_NAMES, PROVIDER_SETTINGS } from "../backend/registry";
import { confWord, textWord } from "./lib";
import { ownText } from "./settings-rows.ts";

/** `exec "$ROOT/bin/ds" --state "$STATE" <args>`: the loop's CLI with this process's stdio; returns its exit code. */
export async function dsExec(args: string[]): Promise<number> {
  try {
    const p = Bun.spawn([join(ROOT, "bin", "ds"), "--state", stateRoot(), ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await p.exited;
  } catch { return 127; }
}

/** `--wait <s>` for a `ds` call when the front gave one (`wait_args`). */
export const waitArgs = (wait: string): string[] => (wait ? ["--wait", wait] : []);

/** jq -r of a value: a string raw, null `null`, anything else compact JSON. */
export function jqRaw(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "null";
  return JSON.stringify(v);
}
/** jq's `// ""`: null, false and a missing field read as empty. */
export const jqOr = (v: unknown): unknown => (v === null || v === undefined || v === false ? "" : v);

/** jq @tsv of one value (null empty; \t \n \r \\ escaped). */
export function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** `read -r a b c` on the default IFS: n-1 whitespace-separated words, the rest of the line (trimmed) in the last. */
export const readFields = (line: string, n: number): string[] => readIfs(line, n);

/** The non-blank, non-comment lines of a conf (`grep -vE '^[[:space:]]*(#|$)'`). */
export function confLines(text: string): string[] {
  return text.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "") && !/^[ \t\n\v\f\r]*(#|$)/.test(l));
}

/** awk's `$1==k` first row of a conf text: its whitespace-split fields, or null. */
export function awkRow(text: string, k: string): string[] | null {
  for (const line of text.split("\n")) {
    const f = line.split(/[ \t]+/).filter((w) => w !== "");
    if (f[0] === k) return f;
  }
  return null;
}

/** The effective roster of a project's roles.conf text over the default's (U267, bin/loop/settings/roster.ts):
 *  the default's lines in order, a project line in its role's place, a project-only role after them.
 *  A role named twice keeps its last line, as the loop does. */
export function rosterLines(own: string, dflt: string): string[] {
  const name = (l: string): string => l.split(/[ \t]+/).filter((w) => w !== "")[0] ?? "";
  return [...new Map([...confLines(dflt), ...confLines(own)].map((l): [string, string] => [name(l), l])).values()];
}

/** The ds_limit env var name (the old shell lib ds_limit_env). */
const ENV_NAMES: Record<string, string> = { context_warn: "DS_RESUME_MAX_CTX", limit_pct: "DS_SWEEP_LIMIT_PCT",
  pick_session_max: "DS_PICK_SESSION_MAX", pick_weekly_max: "DS_PICK_WEEKLY_MAX", unit_token_x: "DS_UNIT_TOKEN_X",
  unit_token_max: "DS_UNIT_TOKEN_MAX", auto_merge: "DS_LOOP_AUTO_MERGE" };
export const limitEnvName = (key: string): string => ENV_NAMES[key] ?? `DS_LIMIT_${key.toUpperCase()}`;

/** ds_limit_src <label> <key>: [value, env|override|default|unset]; the override is the project's limits.conf rows. */
export function limitSrc(label: string, key: string): [string, string] {
  const ev = process.env[limitEnvName(key)] ?? "";
  if (ev) return [ev, "env"];
  const own = textWord(ownText(label, "limits.conf"), key);
  if (own) return [own, "override"];
  const v = confWord(join(ROOT, "conventions", "limits.conf"), key);
  return v ? [v, "default"] : ["", "unset"];
}

/** ds_ship_mode <label> [<repo>]: the project's override (its ship-mode row), else the first projects.conf row
 *  naming the label (or, given a repo, a selector the repo path contains), else ce-pipeline. */
export function shipMode(label: string, repo = ""): string {
  const mode = (ownText(label, "ship-mode").split("\n")[0] ?? "").replace(/[ \t\n\v\f\r]/g, "");
  if (mode) return mode;
  const conf = join(ROOT, "conventions", "projects.conf");
  if (existsSync(conf)) {
    for (const line of readFileSync(conf, "utf8").split("\n")) {
      const [sel, mode] = readFields(line, 3);
      if (!sel || sel.startsWith("#") || !mode) continue;
      if (sel === label || (repo && repo.includes(sel))) return mode;
    }
  }
  return "ce-pipeline";
}

export const SHIP_MODES = "ce-pipeline no-mistakes direct-PR local-only";

/** ds_review_skip_lenses_problem: why a review_skip_lenses value is invalid; "" when it is valid. */
export function skipLensesProblem(v: string): string {
  if (v === "-") return "";
  let lenses = v.split(",");
  if (v === "" || v.startsWith(",") || v.endsWith(",") || v.includes(",,")) lenses = [""];
  for (const lens of lenses) {
    if (!/^[a-z][a-z0-9_-]*$/.test(lens)) return `review_skip_lenses must be comma-separated lowercase lens names, or - (got '${v}')`;
    const n = lens.replace(/-reviewer$/, "").replace(/-researcher$/, "");
    if (n === "correctness") return `review_skip_lenses cannot drop correctness: every review runs it (got '${v}')`;
  }
  return "";
}

function briefingDaysOk(v: string): boolean {
  if (v === "daily") return true;
  if (v === "") return false;
  const d = "(mon|tue|wed|thu|fri|sat|sun)";
  const re = new RegExp(`^${d}(-${d})?$`);
  return v.split(",").every((part) => re.test(part));
}

const posNum = (v: string): boolean => /^[0-9]+(\.[0-9]+)?$/.test(v) && Number(v) > 0;

/** Why `val` is not a valid value for the limits.conf `key` (the shape checks limits.sh set makes once
 *  the key is known); "" when it is valid. Shared by limits-ts.ts and bin/loop/settings/settings.ts. */
export function limitValueProblem(key: string, val: string): string {
  const WS = /[ \t\n\v\f\r]/;
  if (key === "briefing_time" || key === "briefing_days") { /* validated by the shape checks below */ }
  else if (key === "review_risk_paths") {
    if (val === "" || WS.test(val)) return "review_risk_paths must be comma-separated shell globs, or -";
  } else if (key === "feedback_repo") {
    // ds-feedback-github-issues U1: the GitHub repo feedback issues go to, owner/name, or - (off).
    if (val !== "-" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(val)) return `feedback_repo must be owner/name, or - (got '${val}')`;
  } else {
    const wide = key === "expected_checks" || key === "review_skip_lenses";
    if (val === "" || (wide ? /[^A-Za-z0-9._,-]/ : /[^A-Za-z0-9._-]/).test(val)) return `bad value '${val}'`;
  }
  if (key === "briefing_time" && !/^(off|([01][0-9]|2[0-3]):[0-5][0-9])$/.test(val)) return `briefing_time must be off or HH:MM, 24h (00:00-23:59) (got '${val}')`;
  if (key === "briefing_days" && !briefingDaysOk(val)) return `briefing_days must be daily, or comma-separated mon..sun days and ranges like mon-fri, mon,wed,fri, mon-wed,fri (got '${val}')`;
  if (key === "compact_mode_studio") { if (!["compact", "off"].includes(val)) return `${key} must be compact or off (got '${val}')`; }
  else if (key === "studio_move") { if (!["auto", "ask", "off"].includes(val)) return `${key} must be auto, ask or off (got '${val}')`; }
  else if (key.startsWith("compact_mode_")) { if (!["compact", "clear", "off"].includes(val)) return `${key} must be compact, clear or off (got '${val}')`; }
  if (key === "auto_merge" && !["off", "squash", "merge", "rebase"].includes(val)) return `${key} must be off, squash, merge or rebase (got '${val}')`;
  if (key === "base_update" && !["merge", "rebase"].includes(val)) return `${key} must be merge or rebase (got '${val}')`;
  if (key === "builder_host_brake" && !["on", "off"].includes(val)) return `${key} must be on or off (got '${val}')`;
  if (key === "unblock_first" && !["on", "off"].includes(val)) return `${key} must be on or off (got '${val}')`;
  if (key === "default_backend" && !(BACKEND_NAMES as readonly string[]).includes(val)) return `${key} must be ${BACKEND_NAMES.join(", ")} (got '${val}')`;
  if (key === "worktree_provider" && !(PROVIDER_SETTINGS as readonly string[]).includes(val)) return `${key} must be ${PROVIDER_SETTINGS.join(", ")} (got '${val}')`;
  switch (key) {
    case "review_block_severity": case "review_block_severity_risky":
      if (!["P0", "P1", "P2", "P3"].includes(val)) return `${key} must be P0, P1, P2 or P3 (got '${val}')`;
      break;
    case "review_risk_paths":
      if (val.startsWith(",") || val.endsWith(",") || val.includes(",,")) return "review_risk_paths must be comma-separated shell globs, or -";
      break;
    case "review_skip_lenses":
      return skipLensesProblem(val);
    case "review_delta_wide_lines": case "review_delta_full_lines": case "flow_stuck_floor_min": case "flow_quiet_min": case "needs_grace_min": case "refusal_needs_min":
    case "loop_stall_banner_n": case "loop_stall_banner_min": case "expose_down_min": case "expose_warn_min": case "chat_quiet_s": case "chat_queue_min": case "msg_chase_min": case "msg_reply_alert_min": case "archive_debrief_min": case "prompt_wait_min":
      if (/[^0-9]/.test(val)) return `${key} must be a non-negative integer (got '${val}')`;
      break;
    case "feedback_draft_batch":
      if (!/^\d+$/.test(val) || Number(val) < 1 || Number(val) > 100) return `feedback_draft_batch must be a whole number from 1 to 100 (got '${val}')`;
      break;
    case "tick_alarm_ms":
      if (!/^\d+$/.test(val)) return `tick_alarm_ms must be a non-negative integer of ms, 0 = off (got '${val}')`;
      break;
    case "tick_alarm_windows":
      if (!/^\d+$/.test(val) || Number(val) < 1 || Number(val) > 20) return `tick_alarm_windows must be a whole number from 1 to 20 (got '${val}')`;
      break;
    case "briefing_merges_lag_min":
      if (!/^\d+$/.test(val) || Number(val) > 120) return `briefing_merges_lag_min must be whole minutes from 0 to 120 (got '${val}')`;
      break;
    case "chat_files_keep_d":
      if (!/^\d+$/.test(val) || Number(val) < 1 || Number(val) > 365) return `chat_files_keep_d must be whole days from 1 to 365 (got '${val}')`;
      break;
    case "notes_cap":
      if (!/^\d+$/.test(val) || Number(val) < 1 || Number(val) > 100) return `notes_cap must be a whole number from 1 to 100 (got '${val}')`;
      break;
    case "expose_stop_s":
      if (!/^\d+$/.test(val) || Number(val) < 10 || Number(val) > 100) return `expose_stop_s must be whole seconds from 10 to 100 (got '${val}')`;
      break;
    case "max_builders":
      if (val !== "-" && (val.startsWith("0") || /[^0-9]/.test(val))) return `max_builders must be a positive integer, or - for no limit (got '${val}')`;
      break;
    case "max_light_builders":
      if (val === "" || /[^0-9]/.test(val)) return `max_light_builders must be a non-negative integer (got '${val}')`;
      break;
    case "light_lane_cpu_h":
      if (!posNum(val)) return `light_lane_cpu_h must be a positive number of CPU-hours (got '${val}')`;
      break;
    case "github_budget_share":
      if (!posNum(val) || Number(val) > 1) return `github_budget_share must be a number above 0 and at most 1 (got '${val}')`;
      break;
    case "restart_rss_gb":
      if (val !== "-" && !posNum(val)) return `restart_rss_gb must be a positive number of GB, or - for off (got '${val}')`;
      break;
  }
  return "";
}
