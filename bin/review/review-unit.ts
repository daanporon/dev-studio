// review-unit.ts — the work of review-unit.sh (U228 port): run a Builder's code review on the
// roster's review model and write the receipt finish-unit.sh checks. review-unit.sh keeps the
// header (exit codes, files, rules) and execs `ds review-unit-ts`; every argument, receipt, log
// line, proof check, carry rule, retry and stderr line here is the shell's, in its order. The
// shell's globals are the closure state of `main`; `Exit` is the shell's `exit`, and the EXIT
// trap (cleanup) runs for every exit once it is set, as `trap cleanup_receipt EXIT` did.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { ROOT, dsLabel, writeErr, writeOut } from "../lib/shared";
import {
  alt, awkFields, chompAll, childEnv, each, exists, flat, get, git, gitOut, gitTry, globRe, isDir, isExec, isFile, isLink,
  jtype, limit, limitSrc, museResolve, newer, now, onPath, out, owned, parseStream, path, probeRead, rawOut, readSep,
  readTab, readText, realpathF, repairCmd, reviewLens, effectiveRosterRows, sh, sha256File, skillProbe, skipLensesProblem,
  splitIfs, truthy, unitTier, writable, writeErrLine,
} from "./review-lib";
import { type Rev, metaOk, proofMatches, reviewJson, shaMatches } from "./review-proof";

/** The shell's `exit <code>`. */
export class Exit extends Error { constructor(public code: number) { super(`exit ${code}`); } }

export const USAGE = 'usage: review-unit.sh <project> [<base-ref>] [--full "<reason>"] [--retry "<reason>"]';
const ABOUT = "review-unit.sh — run a Builder's code review on the review model, not the Builder's own.";
const TEST_RE = /(^|\/)(tests?|spec|__tests__)\/|(^|\/)[^/]+[._-](test|spec)\.[^/]+$|(^|\/)(test_[^/]+|conftest)\.[^/]+$/;
const SPACE = /[ \t\n\v\f\r]/;

/** The class of a counted review failure (ds-review-stop's 5th field; a file without one is
 *  `tooling`): `tooling` is a complete run that fails a proof field, `off-script` a reviewer that
 *  left the skill or answered without it, after its one retry. Each class stops at its own count;
 *  a failure of the other class starts a fresh count. */
export type StopClass = "tooling" | "off-script";
export const STOP_AFTER: Record<StopClass, number> = { tooling: 2, "off-script": 3 };
const STOP_WHY: Record<StopClass, string> = { tooling: "the review tooling failed the run-file proof", "off-script": "the reviewer left ce-code-review each time" };
export const stopClass = (s: string | undefined): StopClass => (s?.trim() === "off-script" ? "off-script" : "tooling");

/** ce-code-review's own run-folder name: `<yyyymmdd>-<hhmmss>-<8 hex>` (its RUN_ID). */
export const SKILL_RUN_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
/** The run folders before an engine call: name → its review.json's `mtimeMs:size` ("" with none). */
export type RunSnap = Map<string, string>;
const reviewStamp = (d: string): string => { try { const s = statSync(join(d, "review.json")); return `${s.mtimeMs}:${s.size}`; } catch { return ""; } };
const runNames = (runs: string): string[] => { try { return readdirSync(runs).filter((n) => !n.startsWith(".")).sort(); } catch { return []; } };
export const runSnap = (runs: string): RunSnap => new Map(runNames(runs).map((n) => [n, reviewStamp(join(runs, n))]));
/** The head_sha a run folder's metadata.json names, or "" (none yet: the skill writes it last). */
const runHead = (d: string): string => {
  const t = readText(join(d, "metadata.json"));
  if (t === null) return "";
  for (const v of parseStream(t).values) { const x = alt(() => get(v, "head_sha"), ""); if (typeof x === "string" && x) return x; }
  return "";
};
/** A run's stage log: the last stage it names ("none" without one), and whether it ended
 *  (a `receipt` or `report` end, as the proof requires). */
const runStages = (d: string): { stage: string; ended: boolean } => {
  let stage = "none", ended = false;
  for (const l of (readText(join(d, "stages.jsonl")) ?? "").split("\n")) {
    let e: any; try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e.stage !== "string") continue;
    stage = e.stage;
    if (e.phase === "end" && (e.stage === "receipt" || e.stage === "report")) ended = true;
  }
  return { stage, ended };
};

/** U2: did the reviewer leave the skill part-way and write its own result? Against `before` (the
 *  folders when the call started): a new skill folder whose stage log never ended, a new folder
 *  outside the skill's name shape, or an older folder whose review.json changed. A folder whose
 *  metadata names another HEAD is another worktree's review and is skipped. `folder` is the
 *  hand-made or rewritten folder when there is one, else the stalled one; `stage` is where the
 *  stalled skill run stopped ("none" when no skill run of this call started). */
export function leftSkill(runs: string, before: RunSnap, head: string): { stage: string; folder: string } | null {
  let stalled = "", stage = "none", own = "";
  for (const n of runNames(runs)) {
    const d = join(runs, n);
    if (!isDir(d)) continue;
    const was = before.get(n);
    if (was !== undefined && (was === "" || reviewStamp(d) === was)) continue; // older and untouched
    const h = runHead(d);
    if (h && head && h !== head) continue;
    if (was === undefined && SKILL_RUN_RE.test(n)) {
      const s = runStages(d);
      if (!s.ended && !stalled) { stalled = d; stage = s.stage; }
    } else own ||= d;
  }
  return stalled || own ? { stage, folder: own || stalled } : null;
}

/** The files whose change lifts a stop and voids a saved run (rev_script_hash): the shell entry
 *  and the TypeScript that does its work, as one sha256. */
export function scriptHash(): string {
  const h = createHash("sha256");
  for (const f of ["bin/review/review-unit.sh", "bin/review/review-unit.ts", "bin/review/review-lib.ts",
    "bin/review/review-proof.ts", "bin/commands/review-unit-ts.ts"]) h.update(`${sha256File(join(ROOT, f))}  ${f}\n`);
  return h.digest("hex");
}

/** The roster row a review starts on: `builder-review` for a hard unit, else
 *  `builder-review-standard` when the roster has it. */
export const reviewRowName = (rows: Map<string, string[]>, tier: string): string =>
  tier !== "hard" && rows.has("builder-review-standard") ? "builder-review-standard" : "builder-review";

/** The headless session's `--settings` args: the `review` role's skillOverrides (U229), its denied MCP
 *  servers (U283) and the plugins it has off (`enabledPlugins`, review-unit-no-receipt U1), or none when the resolver fails or lists nothing (the session then has every skill and
 *  server, as before; never blocks). DS_SKILLS_RESOLVE replaces the resolver command (a word list); it
 *  is asked with `--all`, and a resolver that prints the bare skillOverrides object still works. */
export function reviewSettings(label: string): string[] {
  const cmd = (process.env.DS_SKILLS_RESOLVE || `${ROOT}/bin/ds skills resolve`).split(/[ \t\n]+/).filter(Boolean);
  const r = sh([...cmd, label, "review", "--all"]);
  const st = r.rc === 0 ? parseStream(r.out) : { values: [], ok: false };
  const last = st.values[st.values.length - 1];
  if (!st.ok || st.values.length === 0 || jtype(last) !== "object") {
    writeErrLine("review-unit: skill list unavailable (ds skills resolve failed) — starting with every skill");
    return [];
  }
  const full = (last as any).skillOverrides && typeof (last as any).skillOverrides === "object" && Array.isArray((last as any).deniedMcpServers);
  const so = full ? (last as any).skillOverrides : last, denied = full ? (last as any).deniedMcpServers : [];
  const ep = full && jtype((last as any).enabledPlugins) === "object" ? (last as any).enabledPlugins : {};
  const hasPlugins = Object.keys(ep).length > 0;
  if (Object.keys(so).length === 0 && denied.length === 0 && !hasPlugins) {
    writeErrLine("review-unit: skill list unavailable (ds skills resolve failed) — starting with every skill");
    return [];
  }
  return ["--settings", JSON.stringify({ ...(Object.keys(so).length > 0 ? { skillOverrides: so } : {}), ...(denied.length > 0 ? { deniedMcpServers: denied } : {}), ...(hasPlugins ? { enabledPlugins: ep } : {}) })];
}

/** `mktemp`: a new empty 0600 file under ${TMPDIR:-/tmp}. */
function mktemp(): string {
  const dir = process.env.TMPDIR || "/tmp";
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 100; i++) {
    const p = join(dir, "tmp." + [...randomBytes(10)].map((b) => abc[b % abc.length]).join(""));
    try { closeSync(openSync(p, "wx", 0o600)); return p; } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
  }
  throw new Error(`mktemp: failed to create a file in ${dir}`);
}
const rmF = (p: string): void => { try { rmSync(p, { force: true }); } catch { /* rm -f */ } };
const writeOk = (p: string, s: string): boolean => { try { writeFileSync(p, s); return true; } catch { return false; } };
const appendOk = (p: string, s: string): boolean => { try { appendFileSync(p, s); return true; } catch { return false; } };
const mvOk = (a: string, b: string): boolean => { try { renameSync(a, b); return true; } catch { return false; } };
const cpOk = (a: string, b: string): boolean => { try { copyFileSync(a, b); return true; } catch { return false; } };
/** `printf … > f.tmp && mv f.tmp f` */
const writeVia = (p: string, s: string): boolean => writeOk(`${p}.tmp`, s) && mvOk(`${p}.tmp`, p);
/** `cat <file>` to stdout / stderr; a missing file prints nothing. */
const catOut = (p: string): void => { const t = readText(p); if (t) writeOut(t); };
/** `cat <file> >&2`: the bytes as they are. */
const catErrFile = (p: string): void => { const t = readText(p); if (t) writeErr(t); };
/** `$(pwd)`: the logical working directory. */
function pwdL(): string {
  const p = process.env.PWD;
  if (p && p.startsWith("/") && realpathF(p) === realpathF(process.cwd())) return p;
  return process.cwd();
}
const first = (s: string): string => s.split("\n")[0];
/** awk -F'\t' 'NR==1 {exit !($n == "proof=1")}' <file>: an empty file passes, an unreadable one fails. */
function proofField(file: string, n: number): boolean {
  const t = readText(file);
  if (t === null) return false;
  if (t === "") return true;
  return (first(t).split("\t")[n - 1] ?? "") === "proof=1";
}
/** `$(cmd1 | git patch-id --verbatim | awk '{print $1}')` for a git diff. */
function patchId(a: string, b: string): string {
  const d = git("diff", "--no-color", a, b).out;
  const p = sh(["git", "patch-id", "--verbatim"], { stdin: d }).out;
  return chompAll(p.split("\n").slice(0, p.endsWith("\n") ? -1 : undefined).map((l) => awkFields(l)[0] ?? "").join("\n"));
}
/** `${s:0:12}` */
const s12 = (s: string): string => s.slice(0, 12);

/** jq's `fromjson`: exactly one value, else an error. */
function fromJson(t: string): any {
  const s = parseStream(t);
  if (!s.ok || s.values.length !== 1) throw new Error("fromjson");
  return s.values[0];
}
/** jq's join of `.text` values: null is "", strings as is, numbers and booleans as JSON, others error. */
function jqJoin(xs: any[], sep: string): string {
  return xs.map((x) => {
    if (x === null || x === undefined) return "";
    if (typeof x === "string") return x;
    if (typeof x === "number" || typeof x === "boolean") return JSON.stringify(x);
    throw new Error("join");
  }).join(sep);
}
/** rev_stream_text: the last assistant text that is a complete report; else the last assistant
 *  text, else the last result string; "" when none or the stream does not parse. With jq -r's newline. */
export function streamText(file: string): string {
  const t = readText(file);
  if (t === null) return "";
  const s = parseStream(t);
  if (!s.ok) return "";
  try {
    const texts: string[] = [];
    for (const v of s.values) {
      if (get(v, "type") !== "assistant") continue;
      const parts: any[] = [];
      for (const c of each(get(get(v, "message"), "content"), true)) if (get(c, "type") === "text") parts.push(get(c, "text"));
      const j = jqJoin(parts, "\n");
      if (j.length > 0) texts.push(j);
    }
    const reports = texts.filter((x) => {
      let r: any = null;
      try { r = fromJson(x); } catch { r = null; }
      return jtype(r) === "object" && get(r, "status") === "complete" && jtype(get(r, "actionable_findings")) === "array";
    });
    let pick: any = reports.length ? reports[reports.length - 1] : null;
    if (!truthy(pick)) pick = texts.length ? texts[texts.length - 1] : null;
    if (!truthy(pick)) {
      const res = s.values.filter((v) => get(v, "type") === "result").map((v) => get(v, "result")).filter((r) => typeof r === "string");
      pick = res.length ? res[res.length - 1] : null;
    }
    return truthy(pick) ? rawOut(pick) + "\n" : "";
  } catch { return ""; }
}

/** jq's `tonumber? // 0` on `.limited_until // 0`. */
function untilNum(r: any): number {
  const lu = alt(() => get(r, "limited_until"), 0);
  if (typeof lu === "number") return lu;
  if (typeof lu === "string" && /^\s*-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(lu)) return Number(lu);
  return 0;
}

/** Run one engine as the shell did: stdin /dev/null, ORCA_TERMINAL_HANDLE unset, stdout and stderr
 *  to files (one file for both when errPath is null). The exit code, 128+n on a signal. */
async function runEngine(cmd: string[], outPath: string, errPath: string | null): Promise<number> {
  let o = -1, e = -1;
  try {
    o = openSync(outPath, "w");
    e = errPath === null ? o : openSync(errPath, "w");
    const p = Bun.spawn({ cmd, stdin: "ignore", stdout: o, stderr: e, env: childEnv({ ORCA_TERMINAL_HANDLE: undefined }) });
    const code = await p.exited;
    if (p.signalCode) return 128 + ((osConstants.signals as Record<string, number>)[p.signalCode] ?? 0);
    return code;
  } catch {
    return 127;
  } finally {
    if (o >= 0) try { closeSync(o); } catch { /* closed */ }
    if (e >= 0 && e !== o) try { closeSync(e); } catch { /* closed */ }
  }
}

export async function main(argv: string[]): Promise<number> {
  for (const a of argv) if (a === "-h" || a === "--help") { writeOut(`${USAGE}\n${ABOUT}\n`); return 0; }
  if (argv.length < 1) { writeErrLine(USAGE); return 2; }
  if (argv[0].startsWith("-")) {
    writeErrLine(`review-unit: the first argument is the project, got '${argv[0]}'`); writeErrLine(USAGE); return 2;
  }
  const LABEL = dsLabel(argv[0]);
  let BASE = "", FULL_REASON = "", RETRY_REASON = "", forced = false, retry = false;
  for (let i = 1; i < argv.length;) {
    const a = argv[i];
    if (a === "--full" || a === "--retry") {
      const name = a.slice(2);
      if (i + 1 >= argv.length || argv[i + 1].replace(new RegExp(SPACE, "g"), "") === "") {
        writeErrLine(`review-unit: --${name} needs a reason (review-unit.sh <project> [<base-ref>] --${name} "<reason>")`); return 2;
      }
      if (a === "--full") { FULL_REASON = flat(argv[i + 1]); forced = true; } else { RETRY_REASON = flat(argv[i + 1]); retry = true; }
      i += 2;
    } else if (a.startsWith("-")) { writeErrLine(`review-unit: unknown option '${a}'; ${USAGE}`); return 2; }
    else { if (BASE) { writeErrLine(USAGE); return 2; } BASE = a; i++; }
  }

  // Validate policy before launching a reviewer, including env and project overrides.
  const sev: Record<string, string> = {
    review_block_severity: limit(LABEL, "review_block_severity"),
    review_block_severity_risky: limit(LABEL, "review_block_severity_risky"),
  };
  const riskPaths = limit(LABEL, "review_risk_paths");
  for (const [k, v] of Object.entries(sev)) {
    if (!/^P[0-3]$/.test(v)) { writeErrLine(`review-unit: ${k} must be P0, P1, P2 or P3 (got '${v}')`); return 2; }
  }
  if (riskPaths === "" || SPACE.test(riskPaths) || riskPaths.startsWith(",") || riskPaths.endsWith(",") || riskPaths.includes(",,")) {
    writeErrLine(`review-unit: review_risk_paths must be comma-separated shell globs, or - (got '${riskPaths}')`); return 2;
  }
  const [wideV, wideSrc] = limitSrc(LABEL, "review_delta_wide_lines");
  let wideThreshold = wideV, wideFrom = "review_delta_wide_lines";
  if (wideSrc !== "env" && wideSrc !== "override") {
    const legacy = limit(LABEL, "review_delta_full_lines");
    if (legacy) { wideThreshold = legacy; wideFrom = "review_delta_full_lines"; }
  }
  const skipLenses = limit(LABEL, "review_skip_lenses");
  if (!/^[0-9]+$/.test(wideThreshold)) {
    writeErrLine(`review-unit: ${wideFrom} must be a non-negative integer (got '${wideThreshold}')`); return 2;
  }
  const skipProblem = skipLensesProblem(skipLenses);
  if (skipProblem) { writeErrLine(`review-unit: ${skipProblem}`); return 2; }

  // ---- the shell's globals ------------------------------------------------------------------
  const rev: Rev = { sha: "", branch: "", base: BASE, kind: "", deltaBase: "", out: "", logReason: "", proofError: "", outRunDir: "" };
  let gdir = "", stamped = false, legacyReceipt = "", deltaRef = "";
  let wide = false, wideLines = "0", baseDesc = "", plainWhy = "", mergedFork = "", mergedBase = false;
  let stopNote = "", stopRecorded = false, countable = false, statusFailed = false;
  let logKind = "", logLenses = "-", logEngine = "", logLeaf = "";
  let agent = "", model = "", effort = "", fallbacks = "", rowName = "";
  let revAgent = "", engine = "", clean = false, errFile = "", runDir = "", foundAny = false;
  let probe = { state: "", scope: "", path: "" };
  let muse = "", candModel = "", limitMatch = "", skillCopy = "", callStarted = "", marker = "", log = "";
  let why = "", prev = "", src = "", srcName = "", prevBase = "", prevCount = "", prevEngine = "", prevClean = "";
  let trapSet = false;
  let startFile = "";   // U4: <git-dir>/ds-review-start while the engine runs (the board's "reviewing")

  const riskPath = (files: string): string | null => {
    if (riskPaths === "-") return null;
    const risks = splitIfs(riskPaths, ",");
    for (const f of files.split("\n")) {
      if (!f) continue;
      for (const g of risks) if (globRe(g).test(f)) return `${g}: ${f}`;
    }
    return null;
  };

  // Preserve each finding verbatim; unknown severities always block.
  const splitFindings = (): boolean => {
    const t = readText(rev.out) ?? "";
    const vals = parseStream(t).values;
    let dir = "";
    try { dir = vals.length ? rawOut(get(vals[0], "artifact_path")) : ""; } catch { dir = ""; }
    if (rev.repaired?.includes("artifact_path") && rev.outRunDir) dir = rev.outRunDir; // U250: the report did not name it
    const blocking: any[] = [], noted: any[] = [];
    for (const v of vals) {
      let fs: any[];
      try { fs = each(get(v, "actionable_findings")); } catch { continue; }
      for (const f of fs) {
        let severity = "", file = "";
        try { severity = rawOut(alt(() => { const s = get(f, "severity"); return s; }, "unknown")); get(f, "severity"); } catch { severity = ""; }
        try { const x = alt(() => get(f, "file"), ""); file = typeof x === "string" ? x : ""; get(f, "file"); } catch { file = ""; }
        const threshold = riskPath(file) !== null ? sev.review_block_severity_risky : sev.review_block_severity;
        if (/^P[0-3]$/.test(severity)) {
          if (Number(severity.slice(1)) <= Number(threshold.slice(1))) blocking.push(f); else noted.push(f);
        } else blocking.push(f);
      }
    }
    if (!writeOk(`${dir}/blocking-findings.json`, JSON.stringify(blocking) + "\n")
      || !writeOk(`${dir}/noted-findings.json`, JSON.stringify(noted) + "\n")) {
      writeErrLine(`review-unit: could not write blocking/noted findings in ${dir} — no receipt written`);
      return false;
    }
    let sevs = "";
    try {
      sevs = [...new Set(blocking.map((f) => { const s = get(f, "severity"); return /^P[0-3]$/.test(String(s)) && typeof s === "string" ? s : "unknown"; }))].sort().join(",");
    } catch { sevs = ""; }
    writeErrLine(`review-unit: blocking ${blocking.length} (${sevs})`);
    writeErrLine(`review-unit: noted ${noted.length}`);
    writeErrLine(`review-unit: blocking findings: ${dir}/blocking-findings.json`);
    writeErrLine(`review-unit: noted findings: ${dir}/noted-findings.json`);
    return true;
  };

  const home = process.env.HOME ?? "";
  const claudeCfg = (): string => process.env.CLAUDE_CONFIG_DIR || `${home}/.claude`;
  /** rev_skill_copy_dir: probes when no probe ran yet, without keeping it (the shell ran it in `$(…)`). */
  const skillCopyDir = (a: string): string => {
    if (a === "claude") {
      const p = probe.state ? probe : probeRead(skillProbe("ce-code-review", pwdL()));
      return p.state === "ok" ? `${p.scope}/skills/ce-code-review` : `${claudeCfg()}/plugins`;
    }
    if (a === "codex") {
      return isFile(`${home}/.agents/skills/ce-code-review/SKILL.md`) ? realpathF(`${home}/.agents/skills/ce-code-review`) : (process.env.CODEX_HOME || `${home}/.codex`);
    }
    if (a === "muse") return `${process.env.XDG_CONFIG_HOME || `${home}/.config`}/muse/skills/ce-code-review`;
    return "";
  };
  const fingerprint = (): string => {
    const copy = skillCopyDir(agent);
    let md = "";
    if (copy && isFile(`${copy}/SKILL.md`)) md = sha256File(`${copy}/SKILL.md`);
    else if (copy && isFile(copy)) md = sha256File(copy);
    return `${scriptHash()}|${copy || "unknown"}|${md || "missing"}`;
  };

  // U250: what the operator needs to answer a stopped review without asking: the last clean receipt
  // (commit, findings), the commits since with a one-line --stat each, and every failure's message.
  const stopFacts = (err: string): string => {
    const lines: string[] = [];
    const g = gdir;
    let last = "";
    for (const f of ["ds-review", "ds-review-base"]) {
      const t = g && isFile(`${g}/${f}`) ? readText(`${g}/${f}`) : null;
      if (t === null) continue;
      const c = t.split("\n")[0].split("\t");
      if (!/^[0-9a-f]{7,40}$/.test(c[0] ?? "") || (f === "ds-review-base" && c[5] === "0")) continue;
      last = `${s12(c[0])} (${c[3] || "0"} finding${c[3] === "1" ? "" : "s"}, ${c[4] || "engine unknown"})`;
      break;
    }
    lines.push(`last clean receipt: ${last || "none"}`);
    const base = last ? last.split(" ")[0] : "";
    if (base) {
      const [log, ok] = gitTry("log", "--format=%h %s", "--shortstat", "--no-merges", "-n", "12", `${base}..HEAD`);
      if (ok && log) {
        const commits: string[] = [];
        let cur = "";
        for (const l of log.split("\n")) {
          if (!l.trim()) continue;
          if (/^\s*\d+ files? changed/.test(l)) { if (cur) commits.push(`${cur} — ${l.trim()}`); cur = ""; }
          else { if (cur) commits.push(cur); cur = l; }
        }
        if (cur) commits.push(cur);
        lines.push(`commits since: ${commits.length ? commits.join("; ") : "none"}`);
      } else lines.push("commits since: none");
    }
    else lines.push("commits since: none to compare (no clean receipt yet)");
    lines.push(`failures: ${err}`);
    return lines.join("\n");
  };

  const stopAlert = (err: string, count: number, cls: StopClass): void => {
    const alerts = `${ROOT}/state/${LABEL}/alerts.json`, branch = rev.branch || "detached";
    const [top, ok] = gitTry("rev-parse", "--show-toplevel");
    const wt = ok ? top : pwdL();
    let unit: any = null;
    const sq = join(ROOT, "state", LABEL, "squads");
    let files: string[] = [];
    try { files = readdirSync(sq).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort().map((f) => join(sq, f)); } catch { files = []; }
    scan: for (const f of files) {
      const t = readText(f);
      if (t === null) continue;
      const s = parseStream(t);
      const topic = basename(f).replace(/\.json$/, "");
      for (const v of s.values) {
        try {
          for (const u of each(alt(() => get(v, "units"), []))) {
            const bw = alt(() => get(u, "builder_wt"), "");
            if (typeof bw !== "string") throw new Error("sub");
            const hit = bw.replace(/^[\s\S]*::/, "") === wt || (branch !== "detached" && alt(() => get(u, "branch"), "") === branch);
            if (hit) {
              unit = { squad: topic, unit: alt(() => get(u, "plan_unit"), ""), slug: alt(() => get(u, "slug"), ""), title: alt(() => get(u, "title"), alt(() => get(u, "slug"), "")) };
              break scan;
            }
          }
        } catch { /* jq's error for this value; the next value */ }
      }
      if (!s.ok) break;
    }
    let title: string, text: string, fields: string;
    const tail = cls === "off-script"
      ? `reviews stopped for this unit after ${count} off-script failures in a row: the reviewer left ce-code-review each time, after one retry each. This is not the unit's code and not broken tooling; the Lead may allow one more run.\n${stopFacts(err)}`
      : `reviews stopped for this unit after ${count} tooling failures in a row. This is not the unit's code: fix the review tooling, then the Lead may allow one more run.\n${stopFacts(err)}`;
    if (unit) {
      const who = typeof unit.squad === "string" && typeof unit.unit === "string" ? `${unit.squad} ${unit.unit}` : "";
      title = `Reviews stopped: ${who}`;
      text = `${who} "${rawOut(unit.title)}": ${tail}`;
      fields = JSON.stringify({ kind: "review_stopped", squad: unit.squad, unit: unit.unit, slug: unit.slug, branch, wt, failures: count, class: cls });
    } else {
      title = `Reviews stopped: branch ${branch}`;
      text = `branch ${branch} (no squad unit found): ${tail}`;
      fields = JSON.stringify({ kind: "review_stopped", branch, wt, failures: count, class: cls });
    }
    sh([`${ROOT}/bin/lib/alerts.sh`, alerts, "add", `review-stopped:${branch}`, title, text,
      `cd ${wt} && review-unit.sh ${LABEL}${BASE ? ` ${BASE}` : ""} --retry "<reason>"`,
      cls === "off-script" ? `${STOP_AFTER[cls]} off-script review runs in a row (the reviewer left ce-code-review, each after one retry)`
        : `${STOP_AFTER[cls]} review proof failures in a row with the same tooling`, fields]);
  };

  // rev_stop_record — one countable proof failure of class `cls` in ds-review-stop, and the
  // failures-left note. A failure of the other class than the file's starts a fresh count.
  const stopRecord = (cls: StopClass = "tooling"): void => {
    if (!gdir) return;
    const stop = `${gdir}/ds-review-stop`;
    let count = "0", prevErr = "", prevCls = "";
    if (isFile(stop)) { const r = readTab(readText(stop), 5); count = r.ok ? r.f[0] : "0"; prevErr = r.ok ? r.f[3] : ""; prevCls = r.ok ? r.f[4] : ""; }
    if (!/^[0-9]+$/.test(count) || stopClass(prevCls) !== cls) count = "0";
    const n = Number(count) + 1, at = STOP_AFTER[cls];
    stopRecorded = true;
    const fp = fingerprint();
    // Every failure's message is kept (the stop question names them all), the newest last.
    const errs = [...(prevErr && Number(count) > 0 ? prevErr.split(" || ") : []), rev.proofError || "no receipt (see stderr)"].slice(-6).join(" || ");
    writeVia(stop, `${n}\t${now()}\t${fp}\t${flat(errs)}\t${cls}\n`);
    if (n >= at) {
      stopAlert(errs, n, cls);
      stopNote = `reviews stop now (${n} ${cls} failures in a row): the next call exits 6 until the tooling changes or the Lead passes --retry`;
    } else stopNote = at - n === 1 ? `1 more such failure stops reviews for this unit (${cls})` : `${at - n} more such failures stop reviews for this unit (${cls})`;
  };

  // rev_stop_check — exit 6 once this unit stopped reviewing, unless the tooling changed or --retry.
  const stopCheck = (): void => {
    if (!gdir || !isFile(`${gdir}/ds-review-stop`)) return;
    const stop = `${gdir}/ds-review-stop`;
    const r = readTab(readText(stop), 5);
    if (!r.ok) { rmF(stop); return; }
    const [count, , fp, err, c] = r.f;
    const cls = stopClass(c);
    if (!/^[0-9]+$/.test(count)) { rmF(stop); return; }
    if (Number(count) < STOP_AFTER[cls]) return;
    if (fingerprint() !== fp) { rmF(stop); return; }
    if (retry) { writeErrLine(`review-unit: --retry "${RETRY_REASON}": running one more review despite ${count} stopped ${cls} failures`); return; }
    writeErrLine(`reviews stopped for this unit after ${count} ${cls} failures in a row (${STOP_WHY[cls]}). This is not your code. Do not run the review again: tell your Lead.\n${stopFacts(err || "no receipt (see stderr)")}`);
    stopAlert(err || "no receipt (see stderr)", Number(count), cls);
    throw new Exit(6);
  };

  const rows = effectiveRosterRows(LABEL);
  const useRow = (name: string): void => {
    rowName = name;
    const row = rows.get(name) ?? [];
    agent = row[1] || "claude";
    model = row[2] || "opus";
    effort = row[4] ?? ""; if (effort === "-") effort = "";
    if (agent !== "claude" && agent !== "codex") { writeErrLine(`review-unit: ${rowName} agent '${agent}' is not supported (claude or codex)`); throw new Exit(2); }
    fallbacks = row[5] ?? "";
  };

  const exitCode = (e: unknown): number => {
    if (e instanceof Exit) return e.code;
    writeErrLine(`review-unit: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  };

  // ---- cleanup (the EXIT trap) --------------------------------------------------------------
  const writeLog = (): void => {
    if (!logKind || !gdir) return;
    appendOk(`${gdir}/ds-review-log`, `${now()}\t${rev.sha || "-"}\t${logKind}\t${flat(rev.logReason || "-")}\t${logLenses || "-"}\t${logEngine || "-"}${logLeaf && logEngine ? ` leaf=${logLeaf}` : ""}\n`);
  };
  const logProofError = (): void => {
    const dir = `${ROOT}/state/${LABEL}`;
    try { mkdirSync(dir, { recursive: true }); } catch { return; }
    appendOk(`${dir}/review-proof-errors.log`, `${now()}\t${LABEL}\t${engine || `${revAgent || "?"}:${model || "?"}`}\t${rev.proofError || "no receipt (see stderr)"}\n`);
  };
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    writeLog();
    if (deltaRef) git("update-ref", "-d", deltaRef, rev.deltaBase);
    if (!stamped && gdir) {
      if (legacyReceipt) cpOk(legacyReceipt, `${gdir}/ds-review`); else rmF(`${gdir}/ds-review`);
    }
    if (stamped && gdir) {
      rmF(`${gdir}/ds-review-stop`);
      sh([`${ROOT}/bin/lib/alerts.sh`, `${ROOT}/state/${LABEL}/alerts.json`, "resolve", `review-stopped:${rev.branch || "detached"}`]);
    }
    if (legacyReceipt) rmF(legacyReceipt);
    if (startFile) rmF(startFile);
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    if (trapSet) cleanup();
    process.exit(128 + ((osConstants.signals as Record<string, number>)[sig] ?? 0));
  };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[]) process.on(s, onSignal);

  try {
    useRow("builder-review");
    const tierRow = reviewRowName(rows, unitTier(LABEL, realpathF(process.cwd())));
    if (tierRow !== rowName) useRow(tierRow);

    // Accounts: the home's `ds account list`, as the picker sees it.
    const operatorPeers = process.env.CROSS_MODEL_PEERS ?? "";
    let dsHome = `${home}/.dev-studio`;
    if (!isExec(`${dsHome}/bin/ds`)) dsHome = ROOT;
    const me = join(ROOT, "bin", "review");
    if ((realpathF(ROOT) || ROOT) !== (realpathF(dsHome) || dsHome)) {
      writeErrLine(`review-unit: info: running from ${me}, outside the dev-studio home (${dsHome}); the account list still comes from the home`);
    }
    let accounts: any[] = [], accountsEmpty = true;
    {
      const s = parseStream(sh([`${dsHome}/bin/ds`, "account", "list"]).out);
      const last = s.values[s.values.length - 1];
      if (s.ok && s.values.length && Array.isArray(last) && last.length > 0) { accounts = last; accountsEmpty = false; }
    }
    const agentUsable = (a: string): boolean => {
      try {
        const rs = accounts.filter((r) => get(r, "agent") === a);
        const t = now();
        return rs.length === 0 || rs.some((r) => get(r, "state") !== "disabled" && untilNum(r) <= t);
      } catch { return false; }
    };
    const peers = (own: string): string => {
      if (accountsEmpty) return "none";
      let o: string[] = ["codex", "claude"].filter((a) => a !== own && agentUsable(a));
      if (operatorPeers && o.length) o = o.filter((p) => `,${operatorPeers},`.includes(`,${p},`));
      return o.join(",") || "none";
    };

    const skillRunRoot = (): string => {
      const uid = process.getuid!();
      const root = `/tmp/compound-engineering-${uid}`, fb = `${process.env.TMPDIR || "/tmp"}/compound-engineering-${uid}`;
      if (isLink(root)) return fb;
      if (exists(root)) return owned(root) && writable(root) ? root : fb;
      let made = false;
      const um = process.umask(0o077);
      try { mkdirSync(root, { recursive: true }); made = true; } catch { made = false; } finally { process.umask(um); }
      return made && !isLink(root) && owned(root) && writable(root) ? root : fb;
    };
    const noRun = (): string => `no complete ce-code-review run for HEAD ${rev.sha} on ${rev.branch || "detached HEAD"} since ${callStarted}`;
    // rev_find_run — the newest run folder since this call started for this HEAD and branch.
    const runsDir = (): string => `${process.env.REVIEW_UNIT_SCRATCH_ROOT || skillRunRoot()}/ce-code-review`;
    // U2: the run folders as the engine call starts; a folder already there is never this call's run.
    let snap: RunSnap = new Map();
    const findRun = (): boolean => {
      runDir = ""; foundAny = false; rev.foundRunDir = "";
      const runs = runsDir();
      if (!isDir(runs)) { rev.proofError = noRun(); return false; }
      for (const n of runNames(runs)) {
        const d = `${runs}/${n}`;
        if (!isDir(d)) continue;
        // U2: only a folder the skill made in this call (its name shape) is a run; a hand-made one
        // is the reviewer leaving the skill, which leftSkill names.
        if (snap.has(n) || !SKILL_RUN_RE.test(n) || !newer(d, marker)) continue;
        foundAny = true;
        const meta = readText(`${d}/metadata.json`);
        let hs = "";
        if (meta !== null) for (const v of parseStream(meta).values) { try { const x = get(v, "head_sha"); if (typeof x === "string" && truthy(x)) hs = hs ? `${hs}\n${x}` : x; } catch { /* next */ } }
        if (!shaMatches(rev, hs)) continue;
        if (!jqELast(`${d}/metadata.json`, (v) => { const b = alt(() => get(v, "branch"), ""); return b === rev.branch; })) continue;
        if (!reviewJson(`${d}/review.json`)) continue;
        if (!runDir || newer(d, runDir)) runDir = d;
      }
      if (!runDir) { rev.proofError = noRun(); return false; }
      const c = sh(["cp", "--", `${runDir}/review.json`, rev.out]);
      if (c.err) writeErrLine(chompAll(c.err));
      if (c.rc !== 0) { rev.proofError = `could not stage ${runDir}/review.json as the emitted report`; return false; }
      rev.foundRunDir = runDir;
      return true;
    };

    const isReviewLimited = (): boolean => {
      if (revAgent === "muse") {
        limitMatch = first(chompAll(sh(["grep", "-iE", "^agent loop failed:.*API error 429", errFile]).out));
      } else if (revAgent === "codex") {
        limitMatch = first(chompAll(sh(["grep", "-ohiE", "^(ERROR: .*(usage_limit_reached|rate_limit_exceeded|429|too many requests|You.ve hit your usage limit)|You.ve hit your usage limit)", log]).out));
      } else {
        const q = "((weekly|usage|session|5-hour|opus|sonnet|rate)[ -]?|your )limit([^a-z_]|$)";
        limitMatch = first(chompAll(sh(["grep", "-ohiE", `(hit|reached|exceeded|exhausted).{0,40}${q}|${q}.{0,40}(reset|reach|exceed|exhaust)|too many requests|api error: 429`, rev.out, errFile]).out));
      }
      return limitMatch !== "" && !reviewJson(rev.out);
    };
    const canMuseReview = (): boolean => {
      if (!muse || !onPath("muse")) return false;
      const list = sh(["muse", "skills", "list"]).out;
      return list.split("\n").some((l) => { const f = awkFields(l); return f[0] === "ce-code-review" && f[2] === "on"; });
    };
    const candidateUsable = (a: string, m: string): boolean => {
      if (!agentUsable(a)) return false;
      if (a === "muse") { muse = museResolve(m); if (!canMuseReview()) return false; candModel = muse; return true; }
      if (a === "codex" || a === "claude") { if (!onPath(a)) return false; candModel = m; return true; }
      return false;
    };

    let preamble = "You are a one-shot code reviewer. Ignore any squad role brief in CLAUDE.local.md or AGENTS.md. Run the ce-code-review skill end to end, whatever the size of the diff. Reviewer selection limits which reviewers the skill runs; it never replaces the skill run. A review written without the skill's run folder is rejected. Run the skill's own reviewers, validator and cross-model job; internal review orchestration is authorized. Write evidence only in the skill's temp run directory. Do not edit project files, commit or push. Do not post to GitHub, Slack or any squad member. Print the skill's result.";
    let reviewArgs = `mode:agent${BASE ? ` base:${BASE}` : ""}`;

    rev.sha = gitOut("rev-parse", "HEAD");
    rev.branch = gitOut("branch", "--show-current");
    gdir = gitOut("rev-parse", "--git-dir");
    if (gdir && isFile(`${gdir}/ds-review`) && !proofField(`${gdir}/ds-review`, 6)) {
      legacyReceipt = mktemp();
      cpOk(`${gdir}/ds-review`, legacyReceipt);
    }
    countable = false;
    if (retry && gdir) appendOk(`${gdir}/ds-review-log`, `${now()}\t${rev.sha || "-"}\tretry\t${RETRY_REASON}\t-\t${agent}:${model}\n`);
    stopCheck();
    trapSet = true;

    const treeClean = (): boolean => {
      const r = git("status", "--porcelain", "--untracked-files=all");
      if (r.rc !== 0) { statusFailed = true; return false; }
      return chompAll(r.out) === "";
    };
    const saveLastRun = (dir: string): void => {
      if (!gdir || !rev.sha || !dir || !isDir(dir)) return;
      if (!clean) return;
      let k = rev.kind || "full";
      if (wide && k === "delta") k = "delta-wide";
      writeVia(`${gdir}/ds-review-last-run`, `${rev.sha}\t${BASE || "-"}\t${k}\t${dir}\t${engine || `${revAgent || "?"}:${model || "?"}`}\t${rev.deltaBase || "-"}\t${scriptHash()}\n`);
    };
    const clearLastRun = (): void => { if (gdir) rmF(`${gdir}/ds-review-last-run`); };
    const findingsCount = (): string => {
      const t = readText(rev.out);
      const s = t === null ? null : parseStream(t);
      if (!s || !s.ok) return "?";
      try { return String(jlen(path(s.values, 0, "actionable_findings"))); } catch { return "?"; }
    };
    const reviewersRan = (): string => {
      const t = readText(rev.out);
      const s = t === null ? null : parseStream(t);
      if (!s || !s.ok) return "";
      try {
        return each(alt(() => path(s.values, 0, "reviewers"), [])).map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(",");
      } catch { return ""; }
    };
    /** The receipt pair for a proven report (ds-review-base always, ds-review on a clean tree). */
    /** U250: a receipt whose proof worked a field out from the run folder says which, after proof=1. */
    const repTail = (): string => (rev.repaired?.length ? `\trepaired=${rev.repaired.join(",")}` : "");
    const stampBase = (count: string, g: string): void => {
      if (rev.sha && g) writeVia(`${g}/ds-review-base`, `${rev.sha}\t${now()}\t${BASE || "-"}\t${count}\t${engine}\t${clean ? 1 : 0}\tproof=1${repTail()}\n`);
    };
    const stamp = (count: string, g: string): void => {
      if (g && writeVia(`${g}/ds-review`, `${rev.sha}\t${now()}\t${BASE || "-"}\t${count}\t${engine}\tproof=1${repTail()}\n`)) stamped = true;
      else { rev.proofError = "could not write the review receipt"; writeErrLine("review-unit: warning: couldn't write the review receipt (continuing)"); }
    };

    // U171: re-check a saved run on the same HEAD instead of running a new review.
    if (!forced && gdir && rev.sha && isFile(`${gdir}/ds-review-last-run`)) {
      const [sSha, sBase, sKind, sDir, sEngine, sDelta, sHash] = readTab(readText(`${gdir}/ds-review-last-run`), 7).f;
      if (sSha && sSha === rev.sha && (sBase || "-") === (BASE || "-") && sDir && isDir(sDir)
        && ((sKind || "full") === "full" || sKind === "delta" || sKind === "delta-wide")
        && treeClean()
        && (sHash !== scriptHash() || (writeErrLine(`review-unit: saved run ${basename(sDir)} already failed this check; running a new review`), false))) {
        let metaOkNow = false;
        const runId = (f: string): string => jqRawStr(f, "run_id");
        const savedRunId = runId(`${sDir}/review.json`);
        if (reviewJson(`${sDir}/review.json`) && shaMatches(rev, headSha(`${sDir}/metadata.json`))
          && metaOk(`${sDir}/metadata.json`, `${sDir}/stages.jsonl`, savedRunId)) {
          if (runId(`${sDir}/review.json`) === runId(`${sDir}/metadata.json`) && runId(`${sDir}/review.json`) !== "") metaOkNow = true;
        }
        let reuseDir = "", reuseId = "";
        if (metaOkNow) {
          reuseDir = sDir; reuseId = basename(sDir);
          rev.kind = sKind;
          if (rev.kind === "delta-wide") { rev.kind = "delta"; wide = true; }
          if (rev.kind === "delta" && sDelta && sDelta !== "-") rev.deltaBase = sDelta;
          else if (rev.kind === "delta") { rev.deltaBase = sDir; metaOkNow = false; }
        }
        if (metaOkNow) {
          const sAgent = sEngine.split(":")[0];
          if (sAgent) revAgent = sAgent;
          if (sEngine) engine = sEngine;
          logEngine = engine;
          process.env.CROSS_MODEL_PEERS = peers(revAgent);
          clean = true;
          rev.out = mktemp(); errFile = mktemp();
          cpOk(`${reuseDir}/review.json`, rev.out);
          rev.foundRunDir = reuseDir;
          logKind = rev.kind;
          if (wide && rev.kind === "delta") logKind = "delta-wide";
          rev.logReason = `reused ${reuseId}`; logLenses = "-";
          let rc = 0;
          if (proofMatches(rev)) {
            if (splitFindings()) {
              const count = findingsCount();
              const g = gitOut("rev-parse", "--git-dir");
              stampBase(count, g);
              stamp(count, g);
              if (stamped) {
                if (reviewJson(rev.out)) { const ran = reviewersRan(); if (ran) logLenses = ran; }
                writeErrLine(`review-unit: ${rev.kind} review (reused ${reuseId}) for ${rev.sha}`);
                catOut(rev.out);
                clearLastRun();
                rmF(rev.out); rmF(errFile);
                throw new Exit(0);
              }
            } else rc = 4;
          } else {
            // A failed re-check is a proof failure like any other: it counts toward the stop.
            stopRecord();
            writeErrLine(`review-unit: ce-code-review proof failed (${engine}; re-check of ${reuseId}): ${rev.proofError} — no receipt written; the saved folder cannot change; a new call runs a new review, or commit a fix (${stopNote})`);
            rc = 4;
          }
          if (rc === 0 && !stamped) rc = 4;
          catOut(rev.out);
          if (rc === 4) {
            logProofError();
            if (!stopRecorded) {
              rev.proofError ||= "could not write blocking/noted findings";
              stopRecord();
              writeErrLine(`review-unit: ${rev.proofError} — no receipt written (${stopNote})`);
            }
          }
          rmF(rev.out); rmF(errFile);
          throw new Exit(rc);
        }
      }
    }

    // Full, delta or carried? Read the prior receipt before it is invalidated below.
    rev.kind = "full"; why = "no usable previous review: no ds-review receipt or ds-review-base"; prev = "";
    const sameForkPoint = (): boolean => {
      if ((prevBase || "-") === (BASE || "-")) return true;
      if ((prevBase || "-") === "-" || (BASE || "-") === "-") { why = "base-ref changed since the previous review"; return false; }
      if (git("rev-parse", "-q", "--verify", `${prevBase}^{commit}`).rc !== 0) {
        why = `base-ref changed since the previous review: the stored base ${prevBase} no longer resolves`; return false;
      }
      const o = gitOut("merge-base", prevBase, rev.sha), n = gitOut("merge-base", BASE, rev.sha);
      if (o && o === n) return true;
      why = `base-ref changed since the previous review: fork point ${s12(o)} is now ${s12(n)}`; return false;
    };
    if (gdir) {
      if (isFile(`${gdir}/ds-review`)) { src = `${gdir}/ds-review`; srcName = "ds-review"; }
      else if (isFile(`${gdir}/ds-review-base`)) { src = `${gdir}/ds-review-base`; srcName = "ds-review-base"; }
    }
    if (rev.sha && src) {
      const f = readTab(readText(src), 7).f;
      const prevSha = f[0]; prevBase = f[2]; prevCount = f[3]; prevEngine = f[4]; prevClean = f[5];
      if (!proofField(src, srcName === "ds-review" ? 6 : 7)) why = `previous ${srcName} is a legacy row without proof=1`;
      else if (!prevSha || git("cat-file", "-e", `${prevSha}^{commit}`).rc !== 0) why = `previous ${srcName} unreadable`;
      else if (prevSha === rev.sha) why = `HEAD is unchanged since the previous review (${srcName})`;
      else if (!sameForkPoint()) { /* why is set */ }
      else if (git("merge-base", "--is-ancestor", prevSha, rev.sha).rc === 0) { rev.kind = "delta"; prev = prevSha; }
      else if (srcName === "ds-review-base" && (prevClean || "0") !== "1") why = "the previous review (ds-review-base) saw uncommitted changes";
      else if (BASE) {
        const mbOld = gitOut("merge-base", BASE, prevSha), mbNew = gitOut("merge-base", BASE, rev.sha);
        if (mbOld && mbNew) {
          const pidOld = patchId(mbOld, prevSha), pidNew = patchId(mbNew, rev.sha);
          if (pidOld === pidNew && (pidOld !== "" || gitOut("diff", "--name-only", mbNew, rev.sha) === "")) {
            if (gitOut("status", "--porcelain", "--untracked-files=all") === "") { rev.kind = "carried"; prev = prevSha; }
            else why = "rebase kept the unit's patch but the tree is dirty";
          } else why = "rebase changed the unit's own code";
        } else why = "could not find the previous fork point";
      } else why = "previous review is not on this branch's history";
    }

    // Prove that earlier base merges contributed no unit edits before skipping them.
    const defaultMergeDrivers = (): boolean => git("config", "--get-regexp", "^merge\\..*\\.driver$").rc === 1;
    const automaticBaseMerge = (merge: string, tip: string): boolean => {
      const [parents, ok] = gitTry("show", "-s", "--format=%P", merge);
      if (!ok) return false;
      const p = awkFields(first(parents));
      const [fp, bp] = p, extra = p.slice(2).join(" ");
      if (!fp || !bp || extra) return false;
      if (git("merge-base", "--is-ancestor", bp, tip).rc !== 0) return false;
      if (!defaultMergeDrivers()) return false;
      const e = sh(["git", "merge-tree", "--write-tree", fp, bp], { env: { LC_ALL: "C" } });
      if (e.rc !== 0) return false;
      const [recorded, rok] = gitTry("rev-parse", `${merge}^{tree}`);
      if (!rok) return false;
      return first(chompAll(e.out)) === recorded;
    };
    const conflictsHaveMarkers = (tree: string, paths: string): boolean => {
      if (!defaultMergeDrivers()) return false;
      let seen = false;
      for (const p of paths.split("\n")) {
        if (!p) break;
        if (p.startsWith('"')) return false;
        seen = true;
        for (const m of ["^<<<<<<<", "^=======", "^>>>>>>>"]) {
          if (git("--literal-pathspecs", "grep", "-I", "-q", "-e", m, tree, "--", p).rc !== 0) return false;
        }
      }
      return seen;
    };
    const unitAbsorbed = (commit: string, tip: string): boolean => {
      const [paths, ok] = gitTry("diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", commit);
      if (!ok) return true;
      if (!paths) return false;
      return git("--literal-pathspecs", "diff", "--quiet", "--no-ext-diff", "--no-textconv", tip, commit, "--", ...paths.split("\n")).rc !== 1;
    };
    const mergeExtraVisible = (merge: string, tip: string): number => {
      const a = sh(["git", "merge-tree", "--write-tree", "--name-only", `${merge}^1`, `${merge}^2`], { env: { LC_ALL: "C" } });
      if (a.rc !== 0 && a.rc !== 1) return 2;
      const expected = first(chompAll(a.out));
      if (git("cat-file", "-e", `${expected}^{tree}`).rc !== 0) return 2;
      const [extra, ok] = gitTry("diff", "--no-color", "--no-renames", "--name-only", expected, merge);
      if (!ok) return 2;
      if (!extra) return 0;
      const c = git("--literal-pathspecs", "diff", "--quiet", "--no-ext-diff", "--no-textconv", tip, merge, "--", ...extra.split("\n")).rc;
      if (c === 1) return 0;
      if (c === 0) return 1;
      return 2;
    };
    const plain = (w: string): boolean => { writeErrLine(`review-unit: ${w}; keeping the plain delta`); plainWhy = w; return true; };
    // The skill resolves base: through merge-base; a parentless commit makes it use the expected merge tree.
    const mergeDeltaBase = (): boolean => {
      const oldFork = gitOut("merge-base", BASE, prev), newFork = gitOut("merge-base", BASE, rev.sha);
      if (!oldFork || !newFork || oldFork === newFork) return true;
      if (git("merge-base", "--is-ancestor", prev, newFork).rc === 0) return plain("base contains post-review unit history");
      const [unitCommits, uok] = gitTry("rev-list", "--no-merges", `${prev}..${rev.sha}`, "--not", newFork);
      if (!uok) return plain("could not identify post-review unit commits");
      if (unitCommits) for (const c of unitCommits.split("\n")) if (unitAbsorbed(c, newFork)) return plain("unit work absorbed by the base");
      const [merges, mok] = gitTry("rev-list", "--merges", `${prev}..${rev.sha}`, "--not", newFork);
      if (!mok) return plain("could not identify post-review unit merges");
      if (merges) {
        for (const m of merges.split("\n")) {
          if (git("merge-base", "--is-ancestor", newFork, m).rc === 0) continue;
          if (automaticBaseMerge(m, newFork)) continue;
          const x = mergeExtraVisible(m, newFork);
          if (x === 0) continue;
          if (x === 1) return plain("earlier merge content absorbed by the base");
          return plain("earlier merge cannot be proven automatic");
        }
      }
      mergedFork = newFork;
      const mt = sh(["git", "merge-tree", "--write-tree", "--name-only", prev, newFork], { env: { LC_ALL: "C" } });
      const merged = chompAll(mt.out);
      if (mt.rc !== 0 && mt.rc !== 1) { why = `could not construct the expected base merge: merge-tree exited ${mt.rc}`; return false; }
      const tree = first(merged);
      if (git("cat-file", "-e", `${tree}^{tree}`).rc !== 0) { why = "merge-tree returned no usable expected merge tree"; return false; }
      const nl = merged.indexOf("\n");
      const rest = nl < 0 ? merged : merged.slice(nl + 1);
      if (mt.rc === 1) {
        const conflicts = merged.split("\n").filter((l) => l.startsWith("CONFLICT ("));
        if (conflicts.length === 0 || conflicts.some((l) => !l.startsWith("CONFLICT (content):"))
          || merged.includes("Cannot merge binary files") || !conflictsHaveMarkers(tree, rest)) {
          why = "expected base merge has conflicts without text markers"; return false;
        }
        for (const p of rest.split("\n")) {
          if (!p) break;
          if (git("--literal-pathspecs", "diff", "--quiet", "--no-ext-diff", "--no-textconv", tree, rev.sha, "--", p).rc !== 1) {
            why = "expected base conflict is unchanged or could not be checked"; return false;
          }
        }
      }
      const headTree = git("rev-parse", `${rev.sha}^{tree}`);
      if (headTree.err) writeErrLine(chompAll(headTree.err));
      if (tree === chompAll(headTree.out) && treeClean()) {
        if (srcName === "ds-review-base" && (prevClean || "0") !== "1") { why = "the previous review (ds-review-base) saw uncommitted changes"; return false; }
        if (unitCommits) return plain("post-review unit commits remain");
        rev.kind = "carried"; return true;
      }
      const ct = git("-c", "user.name=dev-studio", "-c", "user.email=review@dev-studio.local", "commit-tree", tree, "-m", "Expected merge of reviewed unit with current base");
      rev.deltaBase = chompAll(ct.out);
      if (ct.rc !== 0) { why = "could not wrap the expected merge tree for delta review"; return false; }
      deltaRef = `refs/dev-studio/review-delta/${rev.sha}-${process.pid}`;
      if (git("update-ref", deltaRef, rev.deltaBase, "").rc !== 0) { why = "could not hold the expected merge commit for delta review"; return false; }
      mergedBase = true;
      return true;
    };
    rev.deltaBase = prev; mergedBase = false; plainWhy = ""; mergedFork = "";
    if (rev.kind === "delta" && BASE && !mergeDeltaBase()) rev.kind = "full";

    // rev_delta_lines: the delta's non-test executable changed lines.
    const deltaLines = (): string => {
      let n = "";
      if (probe.state === "ok") {
        const helper = `${probe.scope}/skills/ce-code-review/scripts/review-scope.py`;
        if (isFile(helper)) {
          const r = sh(["python3", "-I", helper, "--base", rev.deltaBase, "--head", rev.sha]);
          const lines: string[] = [];
          for (const v of parseStream(r.out).values) { try { const x = get(v, "exec_nontest_lines"); if (truthy(x)) lines.push(rawOut(x)); } catch { /* jq error */ } }
          n = chompAll(lines.join("\n"));
        }
      }
      if (/^[0-9]+$/.test(n)) return n;
      let sum = 0;
      for (const l of git("diff", "--no-color", "--numstat", rev.deltaBase, rev.sha).out.split("\n")) {
        if (!l) continue;
        const f = l.split("\t");
        if (f[0] !== "-" && !TEST_RE.test(f[2] ?? "")) sum += awkNum(f[0]) + awkNum(f[1] ?? "");
      }
      return String(sum);
    };
    probe = { state: "", scope: "", path: "" };
    const doProbe = (): void => {
      if (agent !== "claude" || probe.state) return;
      probe = probeRead(skillProbe("ce-code-review", pwdL()));
    };
    let udFiles = "", udLines = 0;
    const unitInterdelta = (oldFork: string, newFork: string): void => {
      udFiles = ""; udLines = 0;
      const names = git("diff", "--no-color", "--no-renames", "--name-only", oldFork, prev).out + git("diff", "--no-color", "--no-renames", "--name-only", newFork, rev.sha).out;
      const sorted = sh(["sort", "-u"], { stdin: names }).out;
      const hunks = (a: string, b: string, f: string): string => chompAll(
        git("--literal-pathspecs", "diff", "-U0", "--no-color", "--no-renames", a, b, "--", f).out.split("\n")
          .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).join("\n"));
      for (const f of sorted.split("\n")) {
        if (!f) continue;
        const o = hunks(oldFork, prev, f), n = hunks(newFork, rev.sha, f);
        if (o === n) continue;
        udFiles += `${f}\n`;
        if (!TEST_RE.test(f)) {
          const a = mktemp(), b = mktemp();
          try {
            writeFileSync(a, o ? `${o}\n` : ""); writeFileSync(b, n ? `${n}\n` : "");
            udLines += sh(["diff", a, b]).out.split("\n").filter((l) => /^[<>]/.test(l)).length;
          } finally { rmF(a); rmF(b); }
        }
      }
      udFiles = udFiles.replace(/\n$/, "");
    };

    // The receipt is one full review plus deltas; only --full and a delta touching
    // review_risk_paths still run a full review.
    if (rev.kind === "delta" && !forced) {
      let ud = false;
      if (BASE && !mergedBase) {
        const udOld = gitOut("merge-base", BASE, prev), udNew = gitOut("merge-base", BASE, rev.sha);
        if (udOld && udNew && udOld !== udNew) { unitInterdelta(udOld, udNew); ud = true; }
      }
      const deltaFiles = ud && !plainWhy ? udFiles : gitOut("diff", "--no-color", "--name-only", rev.deltaBase, rev.sha);
      if (deltaFiles) {
        const risk = riskPath(deltaFiles);
        if (risk !== null) { rev.kind = "full"; why = `the delta touches review_risk_paths (${risk})`; }
        else {
          let lines: string;
          if (ud && !plainWhy) lines = String(udLines);
          else { doProbe(); lines = deltaLines(); }
          if (Number(lines) > Number(wideThreshold)) { wide = true; wideLines = lines; }
        }
      }
      if (ud && plainWhy) {
        if (udFiles) {
          const list = udFiles.split("\n").join(",").replace(/,/g, ", ");
          preamble = `${preamble} Main was merged in since the last review. Review only the changes to these unit files: ${list}. Every other file in the diff is the base's change and was reviewed there.`;
        } else {
          preamble = `${preamble} Main was merged in since the last review. Every other file in the diff besides the unit's own change is the base's change and was reviewed there.`;
        }
      }
      baseDesc = "";
      if (mergedBase) baseDesc = `against the expected merge with ${s12(mergedFork)}`;
      else if (plainWhy) baseDesc = `plain delta (${plainWhy})`;
    }
    if (forced) { rev.kind = "full"; why = `--full: ${FULL_REASON}`; reviewArgs = `mode:agent depth:full${BASE ? ` base:${BASE}` : ""}`; }

    // review_skip_lenses: lenses this project drops.
    let skip: string[] = skipLenses !== "-" ? splitIfs(skipLenses, ",") : [];
    let skipActive = false;
    const partition = (list: string): { kept: string; dropped: string } => {
      const kept: string[] = [], dropped: string[] = [];
      for (const l of splitIfs(list.replace(/, /g, ","), ",")) {
        (skip.some((s) => reviewLens(s) === reviewLens(l)) ? dropped : kept).push(l);
      }
      return { kept: kept.join(", "), dropped: dropped.join(", ") };
    };
    const lensSkipped = (l: string): boolean => skip.some((s) => reviewLens(s) === reviewLens(l));

    if (rev.kind === "carried") {
      // No engine runs: re-validate HEAD and the tree at stamp time and re-stamp the earlier review.
      if (gitOut("rev-parse", "HEAD") === rev.sha && treeClean()
        && writeVia(`${gdir}/ds-review`, `${rev.sha}\t${now()}\t${BASE || "-"}\t${prevCount || "0"}\t${prevEngine}\tproof=1\n`)) {
        writeVia(`${gdir}/ds-review-base`, `${rev.sha}\t${now()}\t${BASE || "-"}\t${prevCount || "0"}\t${prevEngine}\t1\tproof=1\n`);
        writeErrLine(`review-unit: carried review from ${s12(prev)} to ${s12(rev.sha)} (from ${srcName})`);
        logKind = "carried"; rev.logReason = `the unit's patch is unchanged since ${s12(prev)} (from ${srcName})`; logLenses = "-"; logEngine = prevEngine || "-";
        stamped = true;
        throw new Exit(0);
      }
      rev.kind = "full"; why = "the tree changed during a carried review";
    }
    // U177: a delta review never stays on `builder-review`.
    if (rev.kind === "delta" && rowName === "builder-review" && rows.has("builder-review-standard")) {
      writeErrLine("review-unit: delta review on builder-review-standard (a full review of this unit would run on builder-review)");
      useRow("builder-review-standard");
    }
    // A unit that touches review_risk_paths keeps every lens; no resolvable base fails closed.
    if (skip.length > 0 && riskPaths !== "-") {
      const [fork, fok] = BASE ? gitTry("merge-base", BASE, rev.sha) : ["", false];
      const [unitFiles, dok] = BASE && fok ? gitTry("diff", "--no-color", "--name-only", fork, rev.sha) : ["", false];
      if (!BASE || !fok || !dok) {
        writeErrLine("review-unit: review_skip_lenses not applied: no base to check the unit against review_risk_paths");
        skip = [];
      } else {
        const risk = riskPath(unitFiles);
        if (risk !== null) { writeErrLine(`review-unit: review_skip_lenses not applied: the unit touches review_risk_paths (${risk})`); skip = []; }
      }
    }
    const descTail = baseDesc ? `; ${baseDesc}` : "";
    const mergedSentence = " The base is the expected merge of that reviewed commit with the latest fork point. Any conflict markers on the old side are expected; the diff shows how they were resolved.";
    const skipSentence = ` Do not select these reviewers: ${skipLenses.replace(/,/g, ", ")}. Every other reviewer still runs as the skill selects it.`;
    if (rev.kind === "delta") {
      if (wide) {
        if (skip.length > 0) { skipActive = true; preamble += skipSentence; }
        logKind = "delta-wide"; rev.logReason = `since ${s12(prev)} (from ${srcName}; ${wideLines} lines, over ${wideFrom} ${wideThreshold}${descTail})`; logLenses = "-";
        reviewArgs = `mode:agent base:${rev.deltaBase}`;
        preamble += ` This is a WIDE DELTA re-review: the unit was already reviewed at ${prev}. Review only the diff from ${rev.deltaBase} to HEAD plus the code that diff touches; do not re-review the rest of the unit. Run the full reviewer set you would select for a full review of this scope, not correctness-only. Do not run any other conditional reviewers beyond that set.`;
        if (mergedBase) preamble += mergedSentence;
        writeErrLine(`review-unit: delta-wide (full reviewer set) review (since ${s12(prev)}, from ${srcName}; ${wideLines} lines${descTail})`);
      } else {
        let reviewers = "correctness";
        if (skip.length > 0) {
          const p = partition(reviewers);
          reviewers = p.kept; skipActive = true;
          if (p.dropped) writeErrLine(`review-unit: skipped by review_skip_lenses: ${p.dropped}`);
        }
        logKind = "delta"; rev.logReason = `since ${s12(prev)} (from ${srcName}${descTail})`; logLenses = reviewers.replace(/, /g, ",");
        reviewArgs = `mode:agent base:${rev.deltaBase}`;
        preamble += ` This is a DELTA re-review: the unit was already reviewed at ${prev}. Review only the diff from ${rev.deltaBase} to HEAD plus the code that diff touches; do not re-review the rest of the unit. Run only these reviewers: ${reviewers}. Do not run any other conditional reviewers.`;
        if (mergedBase) preamble += mergedSentence;
        writeErrLine(`review-unit: delta (${reviewers}) review (since ${s12(prev)}, from ${srcName}${descTail})`);
      }
    } else {
      if (skip.length > 0) { skipActive = true; preamble += skipSentence; }
      writeErrLine(`review-unit: full review (${why})`);
      logKind = "full"; rev.logReason = why;
    }

    // U167: a disabled or limited first agent never starts a review: walk the row's fallbacks.
    const reviewFallbacks = splitIfs(fallbacks, ",");
    if (!candidateUsable(agent, model)) {
      let found = false;
      for (const c of reviewFallbacks) {
        const [na, nm, ne] = readSep(c, ":", 3);
        if (na === agent) continue;
        if (!candidateUsable(na, nm)) continue;
        writeErrLine(`review-unit: ${agent} has no usable account (disabled or limited) — reviewing on ${na}:${candModel}`);
        agent = na; model = candModel; effort = ne; found = true;
        break;
      }
      if (!found) { writeErrLine(`review-unit: no usable review agent on ${rowName} (${agent} and every fallback disabled or limited)`); throw new Exit(5); }
    }
    logEngine = `${agent}:${model}`;
    // U282: the merge, report and validator steps run on the `review-leaf` row's Claude model.
    if (agent === "claude" && rows.has("review-leaf")) {
      const lr = rows.get("review-leaf")!;
      const cands: [string, string][] = [[lr[1] || "claude", lr[2] || ""], ...splitIfs(lr[5] ?? "", ",").map((c): [string, string] => { const [a, m] = readSep(c, ":", 3); return [a, m]; })];
      for (const [la, lm] of cands) {
        if (la === "claude" && lm && candidateUsable("claude", lm)) { logLeaf = lm; break; }
      }
      if (logLeaf) preamble += ` Run the merge, report and validator subagents on model \`${logLeaf}\`; every reviewer stays on this session's model.`;
    }
    if (peers(agent) !== "none") {
      if (rev.kind === "delta" && !wide && !lensSkipped("adversarial")) preamble += " Also run the cross-model peer pass (CROSS_MODEL_PEERS limits which agents it may use).";
    } else {
      preamble += " No cross-model peer is allowed on this host: skip the cross-model pass and do not substitute a same-model adversarial reviewer.";
      if (accountsEmpty) {
        writeErrLine("review-unit: info: this review has no cross-model peer (the account list is empty or unreadable); that is not an error");
        rev.logReason = `${rev.logReason}; no cross-model peer (empty or unreadable account list)`;
      } else {
        writeErrLine("review-unit: info: this review has no cross-model peer (no enabled, unlimited account for another agent); that is not an error");
        rev.logReason = `${rev.logReason}; no cross-model peer (no enabled, unlimited account)`;
      }
    }

    if (gdir) rmF(`${gdir}/ds-review`);
    clean = false;
    if (rev.sha && treeClean()) clean = true;

    // Preflight: a headless claude whose plugin registry points at a missing install has no ce-* skills.
    doProbe();
    if (agent === "claude") {
      if (probe.state === "missing-path" || probe.state === "not-installed") {
        const cfg = claudeCfg();
        writeErrLine("review-unit: the ce-code-review skill is not available — no review started, no receipt (exit 3).");
        writeErrLine(`  config dir: ${cfg}`);
        let repair: string;
        if (probe.state === "missing-path") {
          writeErrLine(`  compound-engineering (${probe.scope} scope) is registered at a path that does not exist:`);
          writeErrLine(`    ${probe.path}`);
          const [top, ok] = gitTry("rev-parse", "--show-toplevel");
          repair = repairCmd("full", probe.scope, ok ? top : pwdL());
        } else {
          writeErrLine("  compound-engineering is not installed (enabled) for this config dir.");
          repair = repairCmd("install-only");
        }
        if (isLink(`${cfg}/plugins`)) { let l = ""; try { l = readlinkSync(`${cfg}/plugins`); } catch { l = ""; } writeErrLine(`  ${cfg}/plugins is a symlink to ${l}`); }
        else if (!exists(`${cfg}/plugins`)) writeErrLine(`  ${cfg}/plugins does not exist`);
        writeErrLine("  repair (the operator runs this; do not retry the review until it is done):");
        writeErrLine(`    ${repair}`);
        writeErrLine("  Raise this to your Lead.");
        throw new Exit(3);
      }
      if (probe.state === "unknown") writeErrLine(`review-unit: warning: couldn't verify the ce-code-review skill (${probe.path}) — running the review anyway`);
    }

    rev.out = mktemp(); errFile = mktemp(); marker = mktemp();
    let rc = 0;
    callStarted = out(["date", "+%Y-%m-%d %H:%M:%S %Z"]);
    let logTmp = false;
    if (gdir && writeOk(`${gdir}/ds-review.log`, "")) log = `${resolve(pwdL(), gdir)}/ds-review.log`;
    else { log = mktemp(); logTmp = true; }
    const showCodexLog = (): void => {
      if (revAgent !== "codex") return;
      if (rc !== 0 || !reviewJson(rev.out)) {
        writeErrLine(`review-unit: codex run failed — last 40 lines of its log (${log}):`);
        const t = sh(["tail", "-n", "40", log]);
        if (t.out) writeErr(t.out); if (t.err) writeErr(t.err);
      }
    };
    const runReview = async (eng: string, selected: string, reasoning: string): Promise<number> => {
      writeOk(rev.out, ""); writeOk(errFile, "");
      snap = runSnap(runsDir());
      process.env.CROSS_MODEL_PEERS = peers(eng);
      if (eng === "claude") {
        skillCopy = `${claudeCfg()}/plugins (ce-code-review)`;
        if (probe.state === "ok") skillCopy = `${probe.scope}/skills/ce-code-review`;
        const opts = ["--model", selected, ...(reasoning ? ["--effort", reasoning] : []), ...reviewSettings(LABEL)];
        const stream = mktemp();
        const code = await runEngine(["claude", ...opts, "--setting-sources", "user,project", "--append-system-prompt", preamble,
          "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose",
          "-p", `/compound-engineering:ce-code-review ${reviewArgs}`], stream, errFile);
        writeOk(rev.out, streamText(stream)); rmF(stream);
        return code;
      }
      if (eng === "codex") {
        skillCopy = `${process.env.CODEX_HOME || `${home}/.codex`} (ce-code-review via ~/.agents/skills or plugins)`;
        if (isFile(`${home}/.agents/skills/ce-code-review/SKILL.md`)) skillCopy = realpathF(`${home}/.agents/skills/ce-code-review`);
        const opts = ["--model", selected, ...(reasoning ? ["--config", `model_reasoning_effort=${reasoning}`] : [])];
        return runEngine(["codex", "--dangerously-bypass-approvals-and-sandbox", "exec", ...opts, "--output-last-message", rev.out,
          `${preamble} Run the ce-code-review skill with arguments: ${reviewArgs}`], log, null);
      }
      if (eng === "muse") {
        skillCopy = `${process.env.XDG_CONFIG_HOME || `${home}/.config`}/muse/skills/ce-code-review`;
        const opts = reasoning ? ["--reasoning-effort", reasoning] : [];
        return runEngine(["muse", "exec", "--yolo", "--disable-approval", "--disable-sandbox", "--model", selected, "--workspace", pwdL(), ...opts,
          `${preamble} Run the ce-code-review skill with arguments: ${reviewArgs}`], rev.out, errFile);
      }
      return 0;
    };
    // U4: the review is under way. Only the loop's reviews observer reads this (no gate does); a
    // failed write changes nothing, and the cleanup above removes it on every exit.
    if (gdir && writeOk(`${gdir}/ds-review-start`, `${now()}\t${rev.sha || "-"}\t${logKind}\t${process.pid}\n`)) startFile = `${gdir}/ds-review-start`;
    revAgent = agent; engine = `${agent}:${model}`; limitMatch = "";
    let agentModel = model, agentEffort = effort;
    rc = await runReview(agent, model, effort);
    // Follow cross-agent fallbacks in roster order on a limit, keeping each fallback's effort.
    for (const c of reviewFallbacks) {
      if (!(rc !== 0 && isReviewLimited())) break;
      const [na, nm0, ne] = readSep(c, ":", 3);
      if (na === revAgent) continue;
      if (!candidateUsable(na, nm0)) continue;
      const nm = candModel;
      writeErrLine(`review-unit: headless ${revAgent} is limited (matched: "${limitMatch}") — retrying the review via ${na} with ce-code-review on ${nm}`);
      catErrFile(errFile); showCodexLog(); catErrFile(rev.out);
      revAgent = na; engine = `${na}:${nm}`; rc = 0;
      agentModel = nm; agentEffort = ne;
      rc = await runReview(na, nm, ne);
    }
    catErrFile(errFile);
    showCodexLog();
    catOut(rev.out);
    logEngine = engine;
    if (reviewJson(rev.out)) {
      const ran = reviewersRan();
      if ((logKind === "full" || logKind === "delta-wide") && ran) logLenses = ran;
      if (skipActive && ran) {
        const p = partition(ran);
        if (p.dropped) {
          writeErrLine(`review-unit: warning: review_skip_lenses: the review still ran ${p.dropped}`);
          rev.logReason = `${rev.logReason}; warning: review_skip_lenses: the review still ran ${p.dropped}`;
        }
      }
    }
    if (rc === 0) {
      const headNow = gitOut("rev-parse", "HEAD");
      if (clean && (headNow !== rev.sha || !treeClean())) clean = false;
      countable = true;
      let ready = false, offScript = false;
      // U2: one model step up for the retry of a run that left the skill: builder-review (its
      // first usable agent) for a run that started on builder-review-standard, else the same row.
      const stepUp = (): string => {
        if (rowName !== "builder-review-standard" || !rows.has("builder-review")) return "";
        useRow("builder-review");
        for (const [a, m, e] of [[agent, model, effort], ...splitIfs(fallbacks, ",").map((c) => readSep(c, ":", 3))]) {
          if (!candidateUsable(a, m)) continue;
          revAgent = a; agentModel = candModel; agentEffort = e; engine = `${a}:${candModel}`; logEngine = engine;
          return ` on ${rowName} (${engine})`;
        }
        return ` (${rowName} has no usable agent: staying on ${engine})`;
      };
      if (findRun()) ready = true;
      else {
        const left = leftSkill(runsDir(), snap, rev.sha);
        if (left || !foundAny) {
          if (left) {
            writeErrLine(`review-unit: the reviewer left ce-code-review at stage ${left.stage} and wrote its own result (${left.folder}) — retrying once in a fresh session${stepUp()}`);
            preamble = `Your previous run left the ce-code-review skill part-way and wrote its own result, which was rejected. Run the skill end to end; use only the run folder the skill itself makes in this run, never write into another folder and never write its files yourself. ${preamble}`;
          } else {
            writeErrLine(`review-unit: no ce-code-review run folder for HEAD ${rev.sha} since ${callStarted} — the reviewer answered without running the skill; retrying once with a stricter instruction`);
            preamble = `Your previous answer did not run the ce-code-review skill and was rejected. Run the skill now; do not answer directly. ${preamble}`;
          }
          rc = 0;
          rc = await runReview(revAgent, agentModel, agentEffort);
          catErrFile(errFile);
          showCodexLog();
          catOut(rev.out);
          if (rc === 0 && findRun()) {
            ready = true;
            rev.logReason = `${rev.logReason ? `${rev.logReason}; ` : ""}retried: ${left ? "left the skill" : "answered without a skill run"}`;
          } else if (rc === 0) {
            // Off-script again counts toward the off-script stop; any other miss stays a tooling one.
            const again = leftSkill(runsDir(), snap, rev.sha);
            if (again) rev.proofError = `reviewer left ce-code-review at stage ${again.stage} and wrote its own result (${again.folder}), after one retry`;
            else if (!foundAny) rev.proofError = `reviewer answered without running ce-code-review (no run folder for HEAD ${rev.sha} since ${callStarted}, after one stricter retry)`;
            offScript = Boolean(again) || !foundAny;
          }
        }
      }
      if (!ready && rc === 0) {
        stopRecord(offScript ? "off-script" : "tooling");
        writeErrLine(`review-unit: ${rev.proofError} — no receipt written (${stopNote})`);
      } else if (ready && !proofMatches(rev)) {
        stopRecord();
        writeErrLine(`review-unit: ce-code-review proof failed (${engine}; skill copy: ${skillCopy}): ${rev.proofError} — no receipt written; update that skill copy if it writes less than the run-file contract. The finished run is saved: re-checking it on the same HEAD runs no new review (${stopNote}).`);
      } else if (ready && !splitFindings()) {
        rev.proofError = "could not write blocking/noted findings";
        rc = 4;
      } else if (ready) {
        // A usable report exists for this HEAD: remember it as the delta base, receipt or not.
        const count = findingsCount();
        const g = gitOut("rev-parse", "--git-dir");
        stampBase(count, g);
        if (clean) stamp(count, g);
        else if (rev.sha) {
          // The Builder's own causes never count toward the stop: fix and re-run.
          countable = false;
          if (headNow !== rev.sha) {
            rev.proofError = "HEAD changed during the review";
            writeErrLine("review-unit: HEAD changed during the review — no receipt written; re-run review-unit.sh");
          } else if (statusFailed) {
            rev.proofError = "git status failed";
            writeErrLine("review-unit: git status failed — reviewed, but no receipt written; repair status and re-run");
          } else {
            rev.proofError = "uncommitted changes";
            writeErrLine("review-unit: uncommitted changes — reviewed, but no receipt written; commit and re-run");
          }
        }
      }
    }
    // A finished review that left no receipt is saved for a proof-only re-check.
    if (stamped) clearLastRun();
    else if (reviewJson(rev.out)) { if (runDir && isDir(runDir)) saveLastRun(runDir); }
    rmF(rev.out); rmF(errFile); rmF(marker);
    if (logTmp) rmF(log);
    // Exit 0 ⇔ receipt written.
    if (rc === 0 && !stamped) rc = 4;
    if (rc === 4) {
      logProofError();
      if (countable && !stopRecorded) {
        rev.proofError ||= "no receipt (see stderr)";
        stopRecord();
        writeErrLine(`review-unit: ${rev.proofError} — no receipt written (${stopNote})`);
      }
    }
    throw new Exit(rc);
  } catch (e) {
    const code = exitCode(e);
    if (trapSet) cleanup();
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[]) process.off(s, onSignal);
    return code;
  }
}

// ---- small helpers ----------------------------------------------------------------------------

/** awk's numeric value of a field: its leading number, else 0. */
function awkNum(s: string): number { const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)/.exec(s); return m ? Number(m[0]) : 0; }
/** jq length (numbers as their absolute value). */
function jlen(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (typeof v === "number") return Math.abs(v);
  if (jtype(v) === "object") return Object.keys(v).length;
  throw new Error("boolean has no length");
}
/** `jq -e '<f>' file`, last value decides; a parse error fails. */
function jqELast(file: string, f: (v: any) => any): boolean {
  const t = readText(file);
  if (t === null) return false;
  const s = parseStream(t);
  if (!s.ok || !s.values.length) return false;
  let last: any = undefined, bad = false;
  for (const v of s.values) { try { last = f(v); bad = false; } catch { bad = true; } }
  return !bad && truthy(last);
}
/** `$(jq -r '.<k> // empty' file 2>/dev/null)` */
function jqRawStr(file: string, k: string): string {
  const t = readText(file);
  if (t === null) return "";
  const o: string[] = [];
  for (const v of parseStream(t).values) { try { const x = get(v, k); if (truthy(x)) o.push(rawOut(x)); } catch { /* jq error */ } }
  return chompAll(o.join("\n"));
}
/** `$(jq -r '.head_sha // empty | strings' file 2>/dev/null)` */
function headSha(file: string): string {
  const t = readText(file);
  if (t === null) return "";
  const o: string[] = [];
  for (const v of parseStream(t).values) { try { const x = get(v, "head_sha"); if (typeof x === "string" && truthy(x)) o.push(x); } catch { /* jq error */ } }
  return chompAll(o.join("\n"));
}
