// review-proof.ts — the run-file contract a review must meet before review-unit writes a receipt
// (U228 port of rev_proof_checks and its helpers in review-unit.sh). One contract for every
// project and engine: missing, partial or mismatched evidence fails closed; the printed output
// alone never attests that the review ran. Every check and message is the shell's, in its order.
import { copyFileSync } from "node:fs";
import {
  JqError, all, alt, any, at, each, get, gitTry, index, isDir, isFile, jeq, jlength, jqE, jqR, jqSE, jtype,
  nonEmpty, path, rawOut, readable, realpathF, slurp, strOf, unique, writeErrLine,
} from "./review-lib";

/** What the proof reads from the run and writes back (the shell's rev_* globals). */
export interface Rev {
  sha: string; branch: string; base: string; kind: string; deltaBase: string;
  out: string; logReason: string; proofError: string; outRunDir: string;
  /** U250: the run folder review-unit found (or saved) for this HEAD; "" = repair nothing, as before. */
  foundRunDir?: string;
  /** U250: the fields the proof worked out itself from that folder, for the receipt log. */
  repaired?: string[];
  /** U250: log slips accepted because the folder holds the work (stderr and the log reason). */
  slipNotes?: string[];
}

export const reviewJson = (file: string): boolean =>
  jqSE(file, (s) => s.length === 1 && path(s, 0, "status") === "complete" && jtype(path(s, 0, "actionable_findings")) === "array");

/** rev_sha_matches: a 7–40 hex prefix of HEAD, ignoring case. */
export function shaMatches(rev: Rev, cand: string): boolean {
  const c = cand.toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(c) && rev.sha.toLowerCase().startsWith(c);
}

/** `<file>`'s `<path> // empty | strings`, raw, as `$(jq -r …)` gives it. */
const str = (file: string, ...p: string[]): string => jqR(file, (v) => strOf(() => path(v, ...p)));

// ---- U219: a swapped stage pair ----------------------------------------------------------------

export function swappedStages(ev: any[]): string[] {
  const names = unique(ev.map((e) => get(e, "stage")));
  return names.filter((n) => {
    const m = ev.map((v, k) => ({ k, v })).filter((x) => jeq(get(x.v, "stage"), n));
    return m.length === 2 && get(m[0].v, "phase") === "end" && get(m[1].v, "phase") === "start" && m[1].k < ev.length - 1;
  });
}
function unswap(ev: any[]): any[] {
  const s = swappedStages(ev);
  return ev.map((e) => {
    if (index(s, get(e, "stage")) === null) return e;
    if (jtype(e) !== "object") throw new JqError("Cannot index");
    return { ...e, phase: get(e, "phase") === "end" ? "start" : "end" };
  });
}

/** rev_meta_ok: cost.status complete, or partial with every dangling stage a swapped pair. */
export function metaOk(meta: string, stages: string, id: string, slipNotes?: string[]): boolean {
  const m = slurp(meta), s = slurp(stages);
  if (m === null || s === null) return false;
  try {
    if (!(m.length === 1 && (id === "" || jeq(path(m, 0, "run_id"), id)))) return false;
    const status = path(m, 0, "cost", "status");
    if (jeq(status, "complete")) return true;
    if (!jeq(status, "partial")) return false;
    const d = path(m, 0, "cost", "dangling_stages");
    if (!(jtype(d) === "array" && d.length > 0 && all(d, (x) => typeof x === "string"))) return false;
    const sw = swappedStages(s);
    if (all(d, (x) => index(sw, x) !== null)) return true;
    // U250 (proof only): a stage the cost summary calls dangling but the stage log shows ended is a
    // bookkeeping slip, not missing work; the stage checks still need every stage's end.
    if (slipNotes && all(d, (x) => any(s, (e) => jeq(get(e, "stage"), x) && jeq(get(e, "phase"), "end")))) {
      slipNotes.push(`metadata.json lists ${d.join(", ")} as dangling, the stage log shows them ended`);
      return true;
    }
    return false;
  } catch { return false; }
}

// ---- peers ------------------------------------------------------------------------------------

/** rev_no_peer_ok: no peer was allowed (CROSS_MODEL_PEERS=none) and none was folded. */
export function noPeerOk(runDir: string): boolean {
  if (process.env.CROSS_MODEL_PEERS !== "none") return false;
  return jqR(`${runDir}/finish-input.json`, (v) => [alt(() => path(v, "peer", "outcome"), undefined)].filter((x) => x !== undefined)) !== "folded";
}

/** rev_peer_no_output_ok: the peer ran but folded nothing usable; returns the coverage note, or null. */
export function peerNoOutputNote(runDir: string): string | null {
  const fin = `${runDir}/finish-input.json`;
  if (jqR(fin, (v) => [alt(() => path(v, "peer", "selected"), false)]) !== "true") return null;
  if (jqR(fin, (v) => [alt(() => path(v, "peer", "outcome"), undefined)].filter((x) => x !== undefined)) !== "no-usable-output") return null;
  const peer = str(fin, "peer", "artifact");
  if (peer && isFile(peer) && jqSE(peer, (s) => s.length === 1 && jtype(path(s, 0, "findings")) === "array" && jlength(path(s, 0, "findings")) > 0)) return null;
  const route = jqR(fin, (v) => strOf(() => alt(() => alt(() => path(v, "peer", "route"), path(v, "peer", "target")), null)));
  const coverage = str(fin, "peer", "coverage");
  const first = coverage === "" ? "" : coverage.split("\n").map((l) => l.replace(/^([^.?!]*[.?!])[\s\S]*$/, "$1")).join("\n");
  return `cross-model peer ran with no usable output${route ? ` (${route})` : ""}${first ? `: ${first}` : ""}`;
}

export const isAdversarialLens = (n: string): boolean =>
  n === "adversarial" || n === "adversarial-reviewer" || /^adversarial-[a-z][a-z0-9_-]*$/.test(n);

/** rev_folded_peer_ok: a folded provider artifact covers the adversarial lens (and the roster
 *  name, when one is given). */
export function foldedPeerOk(runDir: string, report: string, selected: string): boolean {
  const fin = `${runDir}/finish-input.json`;
  if (jqR(fin, (v) => [alt(() => path(v, "peer", "outcome"), undefined)].filter((x) => x !== undefined)) !== "folded") return false;
  const peer = str(fin, "peer", "artifact");
  if (!(peer && isFile(peer) && readable(peer) && nonEmpty(peer))) return false;
  const name = jqR(peer, (v) => strOf(() => alt(() => get(v, "reviewer"), null)));
  if (!/^adversarial-[a-z][a-z0-9_-]*$/.test(name)) return false;
  if (selected && selected !== "adversarial" && selected !== "adversarial-reviewer" && selected !== name) return false;
  if (realpathF(peer) !== `${realpathF(runDir)}/${name}.json`) return false;
  const rep = slurp(report), f = slurp(fin);
  if (rep === null || f === null) return false;
  return jqSE(peer, (s) => s.length === 1 && jtype(at(s, 0)) === "object" && jeq(path(s, 0, "reviewer"), name)
    && jtype(path(s, 0, "findings")) === "array"
    && (index(path(rep, 0, "reviewers"), name) !== null
      || any(each(path(f, 0, "roster", "selected"), true), (e) => {
        const lens = get(e, "reviewer");
        return (jeq(lens, "adversarial") || jeq(lens, "adversarial-reviewer")) && index(path(rep, 0, "reviewers"), lens) !== null;
      })));
}

// ---- the proof --------------------------------------------------------------------------------

/** rev_base_commit: a scope base resolved with local Git alone ("" when it does not resolve). */
export function baseCommit(rev: Rev, ref0: string): string | null {
  let ref = ref0.replace(/^base:/, "");
  if (ref.startsWith("pr:")) {
    ref = ref.slice(3);
    if (!/^[0-9]+$/.test(ref)) return null;
    const [head, ok] = gitTry("rev-parse", "--verify", `refs/pull/${ref}/merge^2^{commit}`);
    if (!ok || head !== rev.sha) return null;
    const [b, ok2] = gitTry("rev-parse", "--verify", `refs/pull/${ref}/merge^1^{commit}`);
    return ok2 ? b : null;
  }
  const [b, ok] = gitTry("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  return ok ? b : null;
}

/** rev_scope_base_sha: the commit sha a review's scope.base names, else the input unchanged. */
export function scopeBaseSha(b: string): string {
  let m = /^([0-9A-Fa-f]{7,40})\s+\([^()]*\)$/.exec(b);
  if (m) return m[1];
  m = /^[^()]+\s+\(([^()]*)\)$/.exec(b);
  if (m) {
    let found = "";
    for (const w of m[1].replace(/[,;:]/g, " ").split(/[ \t\n]+/).filter(Boolean)) {
      if (/^[0-9A-Fa-f]{7,40}$/.test(w)) {
        if (!found) found = w; else if (found !== w) return b;
      }
    }
    if (found) return found;
  }
  return b;
}

const DEPTH_RANK: Record<string, number> = { pending: 0, lite: 1, focused: 2, full: 3 };

/** The stages.jsonl program: "" when the stage log proves the run, else the problem. */
function stagesProblem(file: string, depth: string, validatorOutcome: string, peerProof: number, adversarialProof: number, reviewProof: number,
  outputsOk = false, slipNotes?: string[]): string {
  const ev0 = slurp(file);
  if (ev0 === null) throw new JqError("parse");
  const ended = (ev: any[], n: string) => any(ev, (e) => jeq(get(e, "stage"), n) && jeq(get(e, "phase"), "end"));
  if (depth !== "lite" && depth !== "focused" && depth !== "full") return "coverage.depth is missing or unknown";
  if (any(ev0, (e) => jtype(e) !== "object" || jtype(get(e, "stage")) !== "string" || (!jeq(get(e, "phase"), "start") && !jeq(get(e, "phase"), "end")))) return "stages.jsonl has malformed events";
  const ev = unswap(ev0);
  const depths: any[] = [];
  for (const e of ev) {
    let d: any;
    try { d = get(get(e, "facts"), "depth"); } catch { continue; }
    if (d !== null) depths.push(d);
  }
  const open = new Map<string, boolean>();
  let bad = false;
  const orphans: string[] = [];
  for (const e of ev) {
    if (e.phase === "start") { bad = bad || open.get(e.stage) === true; open.set(e.stage, true); }
    else if (open.get(e.stage) === true) open.set(e.stage, false);
    else orphans.push(e.stage);
  }
  // U250: a log slip is accepted, with a note, when the folder holds the stage's output (outputsOk).
  const slip = (m: string): string => {
    if (!outputsOk || !slipNotes) return m;
    slipNotes.push(`stage log: ${m.replace(/^stages\.jsonl has /, "")}; the run folder holds the ${depth} review's output, accepted`);
    return "";
  };
  if (bad || [...open.values()].some((x) => x)) { const r = slip("stages.jsonl has an unmatched stage start/end"); if (r) return r; }
  else if (orphans.length !== unique(orphans).length || orphans.some((o) => o !== "peer" && o !== "dispatch" && o !== "review")
    || (orphans.includes("peer") && peerProof !== 1) || (orphans.includes("dispatch") && depth !== "full")
    || (orphans.includes("review") && (depth !== "focused" || reviewProof !== 1))) {
    // The peer's own file is the evidence for an end-only peer stage: without it nothing is accepted.
    // A stage with its own evidence file (the peer's result, a focused review's cost record) gets no pass without it.
    const own = (orphans.includes("peer") && peerProof !== 1) || (orphans.includes("review") && depth === "focused" && reviewProof !== 1);
    const r = own ? "stages.jsonl has an end-only stage without supporting artifact"
      : slip("stages.jsonl has an end-only stage without supporting artifact");
    if (r) return r;
  }
  const scopeEnds = ev.filter((e) => e.stage === "scope" && e.phase === "end");
  if (scopeEnds.length !== 1) return "scope stage did not finish";
  const scopeDepths = scopeEnds.map((e) => path(e, "facts", "depth"));
  if (scopeDepths.some((d) => !jeq(d, depth) && !jeq(d, "pending"))) return "scope stage depth does not match coverage.depth";
  if (depth === "lite" && !jeq(scopeDepths, ["lite"])) return "lite scope stage did not choose lite";
  const ranks = depths.map((d) => typeof d === "string" && d in DEPTH_RANK ? DEPTH_RANK[d] : null);
  if (ranks.some((r) => r === null) || ranks.some((r, i) => i > 0 && (r as number) < (ranks[i - 1] as number))) return "stages.jsonl stage depth decreased or is unknown";
  if (!jeq(depths.length ? depths[depths.length - 1] : null, depth)) return "last stage depth does not match coverage.depth";
  if (!(ended(ev, "receipt") || ended(ev, "report"))) return "receipt/report stage did not end";
  if (depth === "full") {
    const need = ["select", "dispatch", "merge", "report", ...(validatorOutcome === "empty-batch" ? [] : ["validate"])];
    const done = ev.filter((e) => e.phase === "end").map((e) => e.stage);
    if (need.some((n) => !done.includes(n))) return "full review stages did not finish";
  }
  if (depth === "focused" && !ended(ev, "review")) return "focused review stage did not finish";
  if (depth === "focused" && adversarialProof !== 1) return "focused review lacks a matching adversarial result file";
  if (depth === "full" && !any(ev, (e) => typeof get(e, "reviewers") === "number" && get(e, "reviewers") > 0)) return "stages.jsonl shows zero reviewers";
  return "";
}

/** rev_proof_checks: true when the run folder proves the review; else rev.proofError says why. */
export function proofChecks(rev: Rev): boolean {
  const fail = (m: string) => { rev.proofError = m; return false; };
  rev.proofError = "";
  rev.repaired = [];
  const found = rev.foundRunDir ?? "";
  const foundMeta = found ? `${found}/metadata.json` : "";
  // U250: what review-unit already knows from the folder it found is taken from there, not demanded.
  let scopeSha = str(rev.out, "scope", "head_sha");
  if (!scopeSha && found) {
    const ms = str(foundMeta, "head_sha");
    if (shaMatches(rev, ms)) { scopeSha = ms; rev.repaired.push("scope.head_sha"); }
  }
  if (!shaMatches(rev, scopeSha)) return fail(`scope.head_sha is missing or does not match HEAD ${rev.sha} (got '${scopeSha}')`);
  let scopeBase = str(rev.out, "scope", "base");
  if (!scopeBase) return fail("scope.base is missing");
  scopeBase = scopeBaseSha(scopeBase);
  const requested = rev.kind !== "delta" ? rev.base : rev.deltaBase;
  if (requested) {
    const actual = baseCommit(rev, scopeBase);
    if (actual === null) return fail(`scope.base '${scopeBase}' base-unverifiable from local Git`);
    const expected = baseCommit(rev, requested);
    if (expected === null) return fail(`requested base '${requested}' base-unverifiable from local Git`);
    const [fork] = gitTry("merge-base", expected, rev.sha);
    if (actual !== expected && (!fork || actual !== fork)) return fail(`scope.base '${scopeBase}' does not match requested base '${requested}'`);
  }
  let runDir = str(rev.out, "artifact_path");
  let runId = str(rev.out, "run_id");
  if (!runId && found) {
    const name = found.replace(/\/+$/, "").split("/").pop() ?? "";
    if (name && str(foundMeta, "run_id") === name) { runId = name; rev.repaired.push("run_id"); }
  }
  if (!runId) return fail("run_id is missing");
  if ((!runDir || !isDir(runDir)) && found) { runDir = found; rev.repaired.push("artifact_path"); }
  else if (found && isDir(runDir) && realpathF(runDir) !== realpathF(found)) {
    return fail(`artifact_path ${runDir} is not the run folder found for this HEAD (${found})`);
  }
  if (!runDir || !isDir(runDir)) return fail("artifact_path is missing or unreadable");
  rev.outRunDir = runDir;
  for (const f of ["review.json", "metadata.json", "stages.jsonl"]) {
    if (!readable(`${runDir}/${f}`) || !nonEmpty(`${runDir}/${f}`)) return fail(`${f} is missing or unreadable in ${runDir}`);
  }
  if (!reviewJson(`${runDir}/review.json`)) return fail("review.json is missing or not a complete report");
  try { copyFileSync(`${runDir}/review.json`, rev.out); } catch {
    writeErrLine(`cp: cannot copy '${runDir}/review.json' to '${rev.out}'`);
    return fail("could not stage review.json as the emitted report");
  }
  const slipNotes: string[] = [];
  rev.slipNotes = slipNotes;
  if (!shaMatches(rev, str(`${runDir}/metadata.json`, "head_sha")) || !metaOk(`${runDir}/metadata.json`, `${runDir}/stages.jsonl`, runId, found ? slipNotes : undefined)) {
    return fail("metadata.json must match run_id and head_sha and have cost.status complete");
  }
  const depth = str(rev.out, "coverage", "depth");
  let validatorOutcome = "";
  if (depth === "full") {
    const vo = `${runDir}/validator-outcome.json`;
    if (!jqSE(vo, (s) => s.length === 1 && (jeq(path(s, 0, "outcome"), "verdicts") || jeq(path(s, 0, "outcome"), "empty-batch")))) {
      return fail("validator-outcome.json is missing, unreadable, or reports failed validation");
    }
    validatorOutcome = jqR(vo, (v) => [get(v, "outcome")]);
    if (validatorOutcome === "empty-batch" && !jqSE(`${runDir}/validator-input.json`, (s) => {
      if (!(s.length === 1 && jtype(at(s, 0)) === "object")) return false;
      const sc = alt(() => path(s, 0, "selected_count"), 0);
      if (!jeq(sc, 0)) return false;
      return all(["selected", "selected_findings", "selected_numbers", "findings"].map((k) => path(s, 0, k)),
        (x) => x === null || (Array.isArray(x) && x.length === 0));
    })) {
      return fail("empty-batch needs validator-input.json to select no findings (selected_count 0 or absent, selection lists empty)");
    }
    if (validatorOutcome === "verdicts") {
      const vp = str(vo, "verdicts");
      if (!vp || !readable(vp) || realpathF(vp) !== realpathF(`${runDir}/validator-verdicts.json`)
        || !jqSE(vp, (s) => s.length === 1 && jtype(at(s, 0)) === "object" && jtype(path(s, 0, "verdicts")) === "array" && jlength(path(s, 0, "verdicts")) > 0)) {
        return fail("verdicts outcome needs a completed validator-verdicts.json artifact");
      }
    }
  }
  let peerProof = 0, adversarialProof = 0;
  const advNames = jqR(rev.out, (v, emit) => {
    for (const r of each(get(v, "reviewers"), true)) if (typeof r === "string" && (r === "adversarial" || /^adversarial-[a-z][a-z0-9_-]*$/.test(r))) emit(r);
  });
  for (const r of advNames === "" ? [] : advNames.split("\n")) {
    if (jqSE(`${runDir}/${r}.json`, (s) => s.length === 1 && jeq(path(s, 0, "reviewer"), r) && jtype(path(s, 0, "findings")) === "array")) {
      adversarialProof = 1;
      if (r !== "adversarial") peerProof = 1;
    }
  }
  const reviewProof = jqSE(`${runDir}/metadata.json`, (s) => s.length === 1 && any(each(path(s, 0, "cost", "stages"), true), (e) =>
    jeq(get(e, "stage"), "review") && typeof get(e, "ended_at") === "string" && get(e, "ended_at").length > 0
    && typeof get(e, "candidates") === "number" && get(e, "candidates") >= 0)) ? 1 : 0;
  let problem: string;
  // Does the folder hold the work the stage log should have shown? lite/focused: review.json names its
  // reviewers; full: the validator outcome (checked above) and the reviewers' raw returns.
  const outputsOk = found !== "" && (depth === "full"
    ? jqSE(`${runDir}/raw-returns.json`, (x) => x.length === 1 && Array.isArray(at(x, 0)) && any(at(x, 0), (e) => jtype(e) === "object" && jtype(get(e, "findings")) === "array"))
    : jqE(rev.out, (v) => { const r = get(v, "reviewers"); return Array.isArray(r) && (depth === "lite" || r.length > 0); }));
  try { problem = stagesProblem(`${runDir}/stages.jsonl`, depth, validatorOutcome, peerProof, adversarialProof, reviewProof, outputsOk, slipNotes); }
  catch { return fail("stages.jsonl is unreadable JSON"); }
  if (problem) return fail(problem);
  if (depth !== "lite" && !jqE(rev.out, (v) => { const r = get(v, "reviewers"); return Array.isArray(r) && r.length > 0; })) {
    return fail("reviewers list is empty or missing");
  }
  if (depth === "full") return fullChecks(rev, runDir, runId);
  return true;
}

function fullChecks(rev: Rev, runDir: string, runId: string): boolean {
  const fail = (m: string) => { rev.proofError = m; return false; };
  const fin = `${runDir}/finish-input.json`;
  if (!shaMatches(rev, str(fin, "scope", "head_sha"))
    || !jqSE(fin, (s) => s.length === 1 && jtype(at(s, 0)) === "object" && jeq(path(s, 0, "run_id"), runId))) {
    return fail("finish-input.json is missing, unreadable, or mismatched to run/head");
  }
  if (!jqSE(fin, (s) => {
    if (s.length !== 1) return false;
    const fr = path(s, 0, "collection", "failed_reviewers");
    if (!(Array.isArray(fr) && fr.length === 0)) return false;
    const be = path(s, 0, "collection", "bound_exceeded");
    return Array.isArray(be) && be.length === 0;
  })) return fail("finish-input.json has a failed or bound-exceeded reviewer");
  const stages = slurp(`${runDir}/stages.jsonl`);
  let count: number;
  try {
    const sel = (stages ?? []).filter((e) => jeq(get(e, "stage"), "select") && jeq(get(e, "phase"), "end"));
    const r = sel.length === 1 ? get(sel[0], "reviewers") : null;
    if (stages === null || !(typeof r === "number" && r > 0)) throw new JqError("invalid select count");
    count = r;
  } catch { return fail("selected reviewer lacks a completed return (select count invalid)"); }
  const finS = slurp(fin);
  let names: string[];
  try {
    if (finS === null) throw new JqError("parse");
    const sel = path(finS, 0, "roster", "selected");
    const okRoster = finS.length === 1 && Array.isArray(sel) && sel.length > 0
      && all(sel, (e) => typeof get(e, "reviewer") === "string" && /^[a-z][a-z0-9_-]*$/.test(get(e, "reviewer")))
      && unique(sel.map((e: any) => get(e, "reviewer"))).length === sel.length && sel.length >= count;
    if (!okRoster) throw new JqError("invalid roster");
    names = sel.map((e: any) => rawOut(get(e, "reviewer")));
  } catch { return fail("selected reviewer lacks a completed return (roster invalid or unreadable)"); }
  if (names.join("\n") === "") return fail("selected reviewer lacks a completed return (roster empty)");
  const returns = str(fin, "collection", "returns");
  const report = slurp(rev.out);
  if (!returns || !readable(returns) || realpathF(returns) !== realpathF(`${runDir}/raw-returns.json`)
    || report === null || finS === null || !jqSE(returns, (s) => {
      const f = at(finS, 0);
      const selected = each(path(f, "roster", "selected")).map((e) => get(e, "reviewer"));
      const failedIn = alt(() => path(f, "collection", "failed_reviewers"), []);
      const boundIn = alt(() => path(f, "collection", "bound_exceeded"), []);
      const failed = jplus(failedIn, boundIn).map((e: any) => jtype(e) === "object" ? get(e, "reviewer") : e);
      return s.length === 1 && Array.isArray(at(s, 0)) && any(at(s, 0), (e) =>
        jtype(e) === "object" && typeof get(e, "reviewer") === "string" && jtype(get(e, "findings")) === "array"
        && index(selected, get(e, "reviewer")) !== null && index(path(report, 0, "reviewers"), get(e, "reviewer")) !== null
        && index(failed, get(e, "reviewer")) === null);
    })) {
    return fail("finish-input.json/raw-returns.json show no completed selected reviewer");
  }
  const runReal = realpathF(runDir);
  let localAdversarial = 0;
  for (const sel of names) {
    if (jqSE(returns, (s) => s.length === 1 && Array.isArray(at(s, 0)) && index(path(report, 0, "reviewers"), sel) !== null
      && any(at(s, 0), (e) => jeq(get(e, "reviewer"), sel) && jtype(get(e, "findings")) === "array"))) {
      if (sel === "adversarial" || sel === "adversarial-reviewer") localAdversarial = 1;
      continue;
    }
    let accounted = false;
    const pair: [string, string] | null =
      sel === "learnings" || sel === "learnings-researcher" ? ["learnings", "learnings-researcher"]
      : sel === "agent-native" || sel === "agent-native-reviewer" ? ["agent-native", "agent-native-reviewer"]
      : sel === "deployment-verification-agent" ? ["deployment-verification-agent", "deployment-verification-agent"] : null;
    if (pair) {
      const [first, second] = pair;
      const paths = jqR(fin, (v, emit) => {
        const u = path(v, "collection", "unstructured_returns");
        if (!Array.isArray(u)) return;
        for (const e of u) {
          if (jeq(get(e, "reviewer"), first) || jeq(get(e, "reviewer"), second)) { const p = get(e, "path"); if (typeof p === "string") emit(p); }
        }
      });
      for (const p of paths.split("\n")) {
        if (!(p && isFile(p) && readable(p) && nonEmpty(p))) continue;
        const real = realpathF(p);
        if ((real === `${runReal}/${first}.md` || real === `${runReal}/${second}.md`)
          && jqE(rev.out, (v) => index(get(v, "reviewers"), first) !== null || index(get(v, "reviewers"), second) !== null)) { accounted = true; break; }
      }
    }
    if (accounted) continue;
    if (isAdversarialLens(sel) && foldedPeerOk(runDir, rev.out, sel)) accounted = true;
    if (!accounted && isAdversarialLens(sel) && noPeerOk(runDir)) accounted = true;
    if (!accounted) return fail(`selected reviewer lacks a completed return: ${sel}`);
  }
  if (jqE(fin, (v) => jeq(path(v, "peer", "selected"), true)) && localAdversarial === 0 && !foldedPeerOk(runDir, rev.out, "") && !noPeerOk(runDir)) {
    const note = peerNoOutputNote(runDir);
    if (note === null) return fail("selected peer lacks a completed adversarial result");
    writeErrLine(`review-unit: info: ${note}`);
    rev.logReason = `${rev.logReason}; ${note}`;
  }
  return true;
}

/** jq `a + b` for the failed-reviewer lists: null is the identity, arrays concatenate. */
function jplus(a: any, b: any): any[] {
  if (a === null) return b === null ? [] : each(b);
  if (b === null) return each(a);
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  throw new JqError("cannot add");
}

/** rev_proof_matches: the proof, plus a note (stderr and the log reason) for an accepted swapped pair. */
export function proofMatches(rev: Rev): boolean {
  if (!proofChecks(rev)) return false;
  const s = slurp(`${rev.outRunDir}/stages.jsonl`);
  let swapped = "";
  try { swapped = s === null ? "" : swappedStages(s).join(", "); } catch { swapped = ""; }
  if (swapped) {
    const note = `stage log: ${swapped} end/start swapped (skill log order), accepted`;
    writeErrLine(`review-unit: ${note}`);
    rev.logReason = rev.logReason ? `${rev.logReason}; ${note}` : note;
  }
  for (const note of rev.slipNotes ?? []) {
    writeErrLine(`review-unit: ${note}`);
    rev.logReason = rev.logReason ? `${rev.logReason}; ${note}` : note;
  }
  if (rev.repaired?.length) {
    const note = `repaired: ${rev.repaired.join(", ")}`;
    writeErrLine(`review-unit: ${note} (taken from the run folder ${rev.outRunDir})`);
    rev.logReason = rev.logReason ? `${rev.logReason}; ${note}` : note;
  }
  return true;
}

