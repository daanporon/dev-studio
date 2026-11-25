// ds finish-unit-ts — a Builder ends its unit with one call (U192): what bin/role/finish-unit.sh runs.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, backendPath, callerScript, dsLoopArgs, dsLoopFront, dsLoopOn, readJson, run as runCmd, writeErr, writeOut } from "../lib/shared";
import { prHealthLine, repoSlug } from "../lib/lib";
import { shipMode } from "../lib/operator";
import { open } from "../loop/core/store";
import { toplevel } from "../loop/squad/exposed";
import { parseMember, recordFinish, type Member, type Outcome } from "../loop/squad/finish";

export const help = `<state> <unit> [--check | --no-pr | --failed <why>] — end a Builder's unit: record its branch PR and its finish, journal, send worker_done (finish-unit.sh)`;

const USAGE_TEXT = [
  "usage: finish-unit.sh <state> <unit> [--check | --no-pr | --failed <why>]",
  "  end a Builder's unit: record its branch PR in state and its finish in loop.db, journal, send worker_done",
  "  --check prints the merge-ready verdict without writing or sending anything",
  "  --no-pr ends a local-only or no-code unit; --failed <why> ends a unit that cannot be built (worker_done --outcome failed)",
].join("\n") + "\n";

const trim = (s: string): string => s.replace(/\n+$/, "");

export async function run(raw: string[]): Promise<number> {
  const script = callerScript("finish-unit.sh");
  const BACKEND = backendPath();
  const GH = (process.env.DS_GH || "gh").split(/\s+/).filter(Boolean);
  const usage = (): number => { writeErr(USAGE_TEXT); return 2; };
  const la = dsLoopArgs(basename(script), raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  const argv = la.argv;
  if (argv.some((a) => a === "-h" || a === "--help")) { writeOut(USAGE_TEXT); return 0; }
  if (argv.length < 2) return usage();
  const STATE = argv[0], UNIT = argv[1]; let rest = argv.slice(2);
  let NO_PR = false, CHECK = false, FAILED = "";
  if (rest[0] === "--no-pr") { NO_PR = true; rest = rest.slice(1); }
  else if (rest[0] === "--check") { CHECK = true; rest = rest.slice(1); }
  else if (rest[0] === "--failed") {
    FAILED = (rest[1] ?? "").trim();
    if (!FAILED) { writeErr("finish-unit: --failed needs the reason the unit cannot be built\n"); return usage(); }
    NO_PR = true; rest = rest.slice(2);
  }
  if (rest.length) return usage();

  let isFile = false; try { isFile = statSync(STATE).isFile(); } catch { /* none */ }
  if (!isFile) { writeErr(`finish-unit: state file '${STATE}' not found\n`); return 1; }
  const st = readJson(STATE);
  if (st === undefined || st === null) { writeErr(`finish-unit: state file '${STATE}' is not valid JSON\n`); return 1; }
  if (!(Array.isArray(st.units) && st.units.some((u: any) => u?.slug === UNIT))) { writeErr(`finish-unit: unit '${UNIT}' is not in ${STATE}\n`); return 1; }
  const repo: string = st.repo ? String(st.repo) : "";

  let PR = "", verdict = "", br = "", detail = "", reviewNote = "";
  const sd = dirname(STATE);
  const label = basename(sd) === "squads" ? basename(dirname(sd)) : "";
  if (!NO_PR) {
    const b = await runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    br = b.rc === 0 ? trim(b.out) : "";
    if (br === "" || br === "HEAD") { writeErr("finish-unit: not on a branch — check out the unit branch first\n"); return 1; }
    if (br === "main" || br === "master") { writeErr(`finish-unit: checked out on '${br}' — check out the unit branch first\n`); return 1; }
    const slug = await repoSlug(repo);
    if (!slug) { writeErr("finish-unit: no GitHub remote found for the squad repo — can't look up the PR\n"); return 1; }
    const l = await runCmd([...GH, "pr", "list", "--repo", slug, "--head", br, "--state", "all", "--json", "number,state"]);
    try {
      const prs: any[] = JSON.parse(l.out);
      const pick = (state: string) => prs.filter((p) => p.state === state).reduce((m: any, p) => (m === undefined || p.number > m.number ? p : m), undefined);
      const hit = pick("OPEN") ?? pick("MERGED");
      PR = hit?.number !== undefined && hit?.number !== null ? String(hit.number) : "";
    } catch { PR = ""; }
    if (!PR) { writeErr(`finish-unit: no PR for branch '${br}' (repo ${slug}) — push the branch and open the PR first, then re-run\n`); return 1; }

    const ph = await prHealthLine(slug, PR, label);
    let reasons = "";
    if (ph.ok) {
      const h = trim(ph.line); const t = h.indexOf("\t");
      verdict = t < 0 ? h : h.slice(0, t); reasons = t < 0 ? h : h.slice(t + 1);
    } else verdict = "unknown";
    switch (verdict) {
      case "ready": case "merged": detail = ""; break;
      case "waiting": {
        const rs = reasons.split(",");
        if (rs.includes("checks-running")) detail = "checks still running";
        if (rs.includes("mergeable-unknown")) detail = `${detail ? `${detail}, ` : ""}GitHub is still computing mergeability — retry`;
        const req = rs.filter((r) => r.startsWith("required:")).map((r) => `'${r.slice("required:".length)}'`);
        if (req.length > 0) {
          if (detail) detail += "; ";
          detail += req.length === 1
            ? `required check ${req.join(", ")} not reported yet — if CI posts it, wait; if the repo's AGENTS.md names a step that posts it, run that step`
            : `required checks ${req.join(", ")} not reported yet — if CI posts them, wait; if the repo's AGENTS.md names a step that posts one, run that step`;
        }
        break;
      }
      case "closed": detail = "closed"; break;
      case "unknown": detail = "couldn't read the PR's health from GitHub — retry"; break;
      default: detail = reasons;
    }
    let rRefuse = "";
    if (verdict === "ready" && label) {
      const mode = shipMode(label, repo);
      if (mode === "ce-pipeline") {
        const gd = await runCmd(["git", "rev-parse", "--git-dir"]);
        const gdir = gd.rc === 0 ? trim(gd.out) : "";
        let rsha = "", engine = "", proof = "";
        const rfile = gdir ? join(gdir, "ds-review") : "";
        if (rfile && existsSync(rfile)) {
          const lines = readFileSync(rfile, "utf8").split("\n");
          rsha = (lines[0] ?? "").split("\t")[0] ?? "";
          const c = (lines[0] ?? "").split("\t"); engine = c[4] ?? ""; proof = c[5] ?? "";
        }
        const short = async (sha: string) => { const r = await runCmd(["git", "rev-parse", "--short", sha]); return r.rc === 0 && trim(r.out) ? trim(r.out) : sha.slice(0, 7); };
        if (!rsha) {
          const d = await runCmd(["git", "symbolic-ref", "refs/remotes/origin/HEAD"]);
          const defbr = d.rc === 0 ? trim(d.out).replace(/^refs\/remotes\/origin\//, "") : "";
          rRefuse = `no review receipt — run review-unit.sh ${label} origin/${defbr || "main"}, apply its findings, then re-run`;
        } else if (proof !== "proof=1") {
          rRefuse = "legacy review receipt has no artifact proof — run review-unit.sh for a fresh review, apply its findings, then re-run";
        } else if ((await runCmd(["git", "merge-base", "--is-ancestor", rsha, "HEAD"])).rc === 0) {
          const cnt = await runCmd(["git", "rev-list", "--count", `${rsha}..HEAD`]);
          const n = cnt.rc === 0 ? trim(cnt.out) : "0";
          reviewNote = `Reviewed at ${await short(rsha)}${engine ? ` on ${engine}` : ""}; ${n} commit(s) since.`;
        } else {
          rRefuse = `review receipt is for ${await short(rsha)}, not on this branch's history (rebased?) — re-run review-unit.sh`;
        }
      }
    }
    if (CHECK) {
      switch (verdict) {
        case "ready":
          if (rRefuse) { writeOut(`PR #${PR}: not ready — ${rRefuse}\n`); return 1; }
          writeOut(reviewNote ? `PR #${PR}: ready — ${reviewNote}\n` : `PR #${PR}: ready\n`); return 0;
        case "merged": writeOut(`PR #${PR}: merged\n`); return 0;
        default: writeOut(`PR #${PR}: not ready — ${detail}\n`); return 1;
      }
    }
    switch (verdict) {
      case "ready": if (rRefuse) { writeErr(`finish-unit: ${rRefuse}\n`); return 1; } break;
      case "merged": break;
      default:
        writeErr(`finish-unit: PR #${PR} is not merge-ready: ${detail} — keep babysitting (ce-babysit-pr), then re-run; finish-unit.sh ${STATE} ${UNIT} --check shows the verdict. If a blocker isn't yours to fix (changes requested, a thread you disputed), orch.sh ask your Lead.\n`);
        return 1;
    }
  }

  const topic = basename(STATE, ".json");
  const hd = await runCmd(["git", "rev-parse", "HEAD"]);
  const head = hd.rc === 0 && trim(hd.out) ? trim(hd.out) : "none";
  if (dsLoopOn()) {
    return dsLoopFront({ label, kind: "finish-unit", subject: topic, id: "", key: `finish-unit:${label || "?"}/${topic}/${UNIT}@${head}${FAILED ? ":failed" : ""}`, script, argv, wait: la.wait });
  }

  if (!NO_PR) {
    const sp = await runCmd([join(ROOT, "bin", "role", "squad-state.sh"), STATE, "set-unit-pr", UNIT, PR]);
    writeErr(sp.err);
    if (sp.rc !== 0) return sp.rc;
  }

  let subject: string, body: string;
  if (FAILED) {
    subject = `failed ${UNIT}`;
    body = `Unit \`${UNIT}\` cannot be built: ${FAILED}. Nothing is merged for it; the Lead decides what happens to the unit.`;
  } else if (NO_PR) {
    subject = `finished ${UNIT} (no PR)`;
    body = `Unit \`${UNIT}\` is finished with no PR (--no-pr: a local-only or no-code unit). Its work is committed in the Builder worktree. Nothing is left for the Builder.`;
  } else if (verdict === "merged") {
    subject = `finished ${UNIT}: PR #${PR}`;
    body = `PR #${PR} already merged. Unit ${UNIT} on branch ${br} is recorded in state; the loop marks it done.`;
  } else {
    subject = `finished ${UNIT}: PR #${PR}`;
    body = `PR #${PR} merge-ready: checks green, no open review threads, mergeable. Unit ${UNIT} on branch ${br} is recorded in state and waits on the operator's merge. Stay at your prompt: if the PR goes stale before the merge (conflict, base moved, red check, new review comment), the dev-studio loop pokes you to fix it — then babysit until --check passes; don't send worker_done again.${reviewNote ? ` ${reviewNote}` : ""}`;
  }

  // U3 (orca-backend-alternatives): the finish row, on every path, then the journal, then worker_done. Its
  // key is the unit, HEAD and outcome, so a replayed or re-run finish writes no second row.
  // U11: a squad on a contract backend (DS_BACKEND, set on its terminals; else its loop.db row) has no
  // Run: the finish row is its whole finish, and no worker_done is sent.
  let squadOn = process.env.DS_BACKEND || "";
  if (label) {
    const env = process.env.DS_MEMBER ? parseMember(process.env.DS_MEMBER) : null;
    const member: Member = env ?? { project: label, squad: topic, role: "builder", suffix: UNIT };
    const outcome: Outcome = FAILED ? "failed" : NO_PR ? "no-pr" : "ok";
    try {
      const s = open();
      try {
        recordFinish(s, { member, unit: UNIT, outcome, body, gen: process.env.DS_GEN || null, wt: toplevel(),
          key: `finish-unit:${label}/${topic}/${UNIT}@${head}:${outcome}` });
        squadOn ||= String(s.get("squads", { project: label, topic })?.backend ?? "");
      } finally { s.close(); }
    } catch (e) {
      writeErr(`finish-unit: could not record the finish in loop.db (${(e as Error).message}) — fix it and re-run; nothing was sent\n`);
      return 1;
    }
    const sent = squadOn && squadOn !== "orca" ? "no worker_done (no Run)" : "";
    const [jt, jw] = FAILED
      ? [`unit failed: ${FAILED}`, `finish-unit.sh --failed recorded the finish and sent ${sent || "worker_done --outcome failed"}`]
      : NO_PR
      ? ["unit finished without a PR (--no-pr)", `finish-unit.sh sent ${sent || "worker_done"} with no PR recorded`]
      : [`unit finished: PR #${PR} on ${br}`, `finish-unit.sh recorded the PR and sent ${sent || "worker_done"}`];
    const j = await runCmd([join(ROOT, "bin", "role", "journal.sh"), label, topic, `builder-${UNIT}`, "add", "keep", jt, jw]);
    if (j.rc !== 0) writeErr("finish-unit: warning: journal note failed (continuing)\n");
  } else writeErr(`finish-unit: warning: '${STATE}' is not state/<project>/squads/<topic>.json — skipping the finish record and journal note\n`);

  const done = FAILED ? `finish-unit: unit '${UNIT}' ended failed\n` : NO_PR ? `finish-unit: unit '${UNIT}' finished (no PR)\n` : `finish-unit: unit '${UNIT}' finished (PR #${PR})\n`;
  if (squadOn && squadOn !== "orca") {
    writeOut(`finish-unit: squad on backend ${squadOn}: no worker_done (the finish row is the finish)\n${done}`);
    return 0;
  }
  const wd = await runCmd([BACKEND, "worker-done", ...(FAILED ? ["--outcome", "failed"] : []), subject, body]);
  const wdOut = trim(wd.out + wd.err);
  if (wd.rc !== 0) {
    if (wdOut.includes("no active dispatch")) {
      writeOut("finish-unit: worker_done was already sent for this dispatch — nothing more to send; the PR is merge-ready again and the loop will see it\n");
      return 0;
    }
    if (wdOut) writeErr(wdOut + "\n");
    writeErr(`finish-unit: worker_done failed${PR ? ` (PR #${PR} is recorded)` : ""} — fix the backend error above and re-run\n`);
    return 1;
  }
  if (wdOut) writeOut(wdOut + "\n");
  writeOut(done);
  return 0;
}
