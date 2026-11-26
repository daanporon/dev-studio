// ds ask-operator-ts — a squad role raises a question to the operator (U260): what bin/role/ask-operator.sh
// runs. Same arguments, refusals, squad-state.sh and backend calls, receipt and exit codes as the shell
// body: 0 = on the board and pinged, 1 = not on the board, 2 = bad arguments, 3 = on the board, not pinged.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ROOT, backendPath, chomp, readJson, run as runCmd, writeErr, writeOut } from "../lib/shared";
import { prHealthLine } from "../lib/lib";
import { squadContract } from "../lib/contract-roles.ts";
import { alt, interp, truthy } from "./watch-ts";
import { LABEL_FORM, PLAIN_HEADING, PLAIN_LABELS, REVISION_LABELS, approvedCopyPath, planRevisions, plainSection } from "../lib/plan-plain";

export const help = `<state-file> <id> <asker> <true|false> --title "<~8 words>" --question "<markdown>" --option "<label>" "<what happens>" … --recommend <n|label> --why "<why>" [--unit <slug>] [--pr <n>] [--doc <path>] — raise a question to the operator (ask-operator.sh)`;

const USAGE = 'usage: ask-operator.sh <state-file> <id> <asker> <true|false> --title "<~8 words>" --question "<markdown>" --option "<label>" "<what happens>" --option … --recommend <n|label> --why "<why>" [--unit <slug>] [--pr <n>] [--doc <path>] [--picker <tool_use_id> <transcript_path> <true|false>]';

const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
const isLeadOrBuilder = (a: string): boolean => a === "lead" || a === "builder" || a.startsWith("builder-");
const codepoints = (s: string): number => Array.from(s).length;

class Exit { constructor(public code: number) {} }

export async function run(argv: string[]): Promise<number> {
  try { return await main(argv); } catch (e) { if (e instanceof Exit) return e.code; throw e; }
}

async function main(argv: string[]): Promise<number> {
  const BACKEND = backendPath();
  const SS = join(ROOT, "bin", "role", "squad-state.sh");
  const bad = (m: string): never => { writeErr(`ask-operator: ${m}\n${USAGE}\n`); throw new Exit(2); };
  const refuse = (m: string): never => { writeErr(`ask-operator: ${m}\n`); throw new Exit(1); };
  const ss = async (args: string[]): Promise<number> => {
    // "$SS" … >/dev/null: stderr passes through; under set -e a failure ends the script with its code.
    const r = await runCmd([SS, ...args]);
    if (r.err) writeErr(r.err);
    return r.rc;
  };

  if (argv.length < 5) bad("too few arguments");
  const [STATE, ID, ASKER, BLOCKING] = argv;
  let rest = argv.slice(4);
  if (BLOCKING !== "true" && BLOCKING !== "false") bad(`blocking must be true or false, got '${BLOCKING}'`);
  let TITLE = "", UNIT = "", PR = "", PR_EXPLICIT = false, PICKER_TID = "", PICKER_TPATH = "", PICKER_ANS = "", DOC = "";
  const CHOICES: { label: string; does: string }[] = [];
  let Q = "", SUG = "", WHY = "", OPTS = "";

  if (rest[0].startsWith("--")) {
    let REC = "";
    const labels: string[] = [];
    while (rest.length > 0) {
      const a = rest[0];
      if (a === "--title") { if (rest.length < 2) bad("--title needs a value"); TITLE = rest[1]; rest = rest.slice(2); }
      else if (a === "--question") { if (rest.length < 2) bad("--question needs a value"); Q = rest[1]; rest = rest.slice(2); }
      else if (a === "--option") {
        if (!(rest.length >= 3 && rest[1] !== "" && rest[2] !== "")) bad("--option needs a label and what happens");
        if (rest[1].includes("|")) bad("an option label can't contain '|'");
        labels.push(rest[1]); CHOICES.push({ label: rest[1], does: rest[2] }); rest = rest.slice(3);
      }
      else if (a === "--recommend") { if (rest.length < 2) bad("--recommend needs a value"); REC = rest[1]; rest = rest.slice(2); }
      else if (a === "--why") { if (rest.length < 2) bad("--why needs a value"); WHY = rest[1]; rest = rest.slice(2); }
      else if (a === "--unit") {
        if (!(rest.length >= 2 && rest[1] !== "")) bad("--unit needs a slug");
        if (UNIT) bad("one affected unit per question");
        UNIT = rest[1]; rest = rest.slice(2);
      }
      else if (a === "--pr") {
        PR_EXPLICIT = true;
        if (!(rest.length >= 2 && /^[0-9]+$/.test(rest[1]))) bad("--pr needs a PR number");
        if (PR) bad(`one question per PR: a second --pr (${rest[1]}) is refused — ask about #${PR} here and raise ${rest[1]} as its own question`);
        PR = rest[1]; rest = rest.slice(2);
      }
      else if (a === "--doc") {
        if (!(rest.length >= 2 && rest[1] !== "")) bad("--doc needs a path");
        DOC = rest[1]; rest = rest.slice(2);
      }
      else if (a === "--picker") {
        if (!(rest.length >= 4 && rest[1] !== "" && rest[2] !== "")) bad("--picker needs <tool_use_id> <transcript_path> <true|false>");
        if (rest[3] !== "true" && rest[3] !== "false") bad(`--picker answerable must be true or false, got '${rest[3]}'`);
        PICKER_TID = rest[1]; PICKER_TPATH = rest[2]; PICKER_ANS = rest[3]; rest = rest.slice(4);
      }
      else bad(`unknown argument '${a}'`);
    }
    if (!(TITLE !== "" && codepoints(TITLE) <= 80)) bad("--title is required, 80 characters at most (it is the board's one-line row)");
    if (!Q) bad("--question is required");
    if (labels.length < 2) bad("give at least 2 --option");
    // A mirrored picker keeps its own labels: the board's answer is pressed as that label, and a refusal would bury the question.
    const bare = PICKER_TID ? undefined : labels.find((l) => /^[\p{L}\p{N}]$/u.test(l.trim()));
    if (bare !== undefined) bad(`name the option: \`${bare}\` says nothing on the card — use 1–3 words`);
    if (!WHY) bad("--why is required");
    if (/^[0-9]+$/.test(REC)) {
      const n = Number(REC);
      if (n >= 1 && n <= labels.length) SUG = labels[n - 1];
    } else for (const l of labels) if (l === REC) SUG = l;
    if (!SUG) bad(`--recommend must name one of the options (1-${labels.length} or its label)`);
    OPTS = labels.join("|");
    if (codepoints(Q) > 300 && !Q.includes("\n")) writeErr("ask-operator: write it as markdown: a plain lead, bullets, the ask last (conventions/escalation.md)\n");
  } else {
    if (!((rest.length === 3 || rest.length === 4) && rest[1] !== "" && rest[2] !== "")) bad("suggestion and why are required");
    [Q, SUG, WHY] = rest; OPTS = rest[3] ?? "";
  }
  const HEAD = TITLE || Q; // what the card note, receipt and reply show

  // A bad --unit is checked first (before any PR check or gh read): its own line, exit 2, no usage, and the
  // squad's real unit slugs so the agent can retry.
  if (UNIT && existsSync(STATE)) {
    const units = arr(readJson(STATE)?.units);
    if (!units.some((u) => u?.slug === UNIT)) {
      const list = units.map((u) => interp(u?.slug) + (u?.plan_unit ? ` (${interp(u.plan_unit)})` : "")).filter((s) => s.trim());
      writeErr(`ask-operator: unknown unit '${UNIT}' in ${STATE} — ${list.length ? `this squad's units: ${list.join(", ")}` : "has no units yet — register the plan first, or leave out --unit"}\n`);
      throw new Exit(2);
    }
  }

  // The refusal for a PR question: who posts it, and the asker's next step. Reads only the state file and
  // loop.db (pr-ready.ts exit 4 = no observed row; no gh read here).
  const refuseLoopPr = async (prs: string[]): Promise<never> => {
    const j = existsSync(STATE) ? readJson(STATE) : undefined;
    const pr = prs.find((r) => isUnitPr(r)) ?? prs[0] ?? "";
    const unit = pr ? arr(j?.units).find((u) => interp(u?.pr) === pr && alt(u?.status, "") !== "done" && alt(u?.status, "") !== "cancelled") : undefined;
    const topic = basename(STATE, ".json");
    const slug = interp(unit?.slug) || "<slug>";
    const open = pr ? arr(j?.waiting_on_you).find((q) => q?.asker === "loop" && interp(q?.pr) === pr) : undefined;
    const base = "the loop asks PR questions";
    const isBuilder = ASKER === "builder" || ASKER.startsWith("builder-");
    const fix = (why: string): string => isBuilder
      ? `${base}; #${pr} ${why} — fix it in your unit, and if the cause is outside your unit tell your Lead: ~/.dev-studio/bin/role/send-role.sh ${topic} lead "<subject>" "<body>"`
      : `${base}; #${pr} ${why} — its Builder fixes it first: ~/.dev-studio/bin/role/send-role.sh ${topic} builder-${slug} "<subject>" "<body>"; if the operator must decide, ask about the unit with --unit ${slug} and no PR number in --title or --question`;
    if (open) refuse(`${base}; #${pr} already has its question on the board as ${interp(open.id)} — nothing to post, the operator answers it there`);
    let msg = "";
    if (pr && unit && existsSync(STATE)) {
      const r = await runCmd([process.execPath, join(ROOT, "bin", "loop", "squad", "pr-ready.ts"), STATE, pr]);
      if (r.rc === 0) msg = `${base}; #${pr} has only human gates left, so the loop posts it once its Builder has finished — nothing to post`;
      else if (r.rc === 1) msg = fix(`is not ready (${chomp(r.out)}), so nobody asks yet`);
      else msg = fix("is in a state the loop has not read yet, so nobody asks yet");
    } else msg = fix("is not one of this squad's unit PRs; the loop posts only those");
    return refuse(msg);
  };

  // One of this squad's live unit PRs (the ones the loop asks about).
  const isUnitPr = (pr: string): boolean => {
    if (!existsSync(STATE)) return false;
    const j = readJson(STATE);
    if (j === undefined) return false;
    return arr(j?.units).some((u) => interp(u?.pr) === pr && alt(u?.status, "") !== "done" && alt(u?.status, "") !== "cancelled");
  };

  if (!PR) {
    // U86: a PR reference in the title or question (`#<n>` not glued to an identifier, or `/pull/<n>`).
    const found: string[] = [];
    for (const line of `${TITLE}\n${Q}`.split("\n")) {
      for (const m of line.matchAll(/(^|[^A-Za-z0-9_.])#[0-9]+|\/pull\/[0-9]+/g)) found.push(...(m[0].match(/[0-9]+/g) ?? []));
    }
    const refs = [...new Set(found)].sort();
    if (refs.length === 1) PR = refs[0];
    else if (refs.length > 1 && !PICKER_TID) {
      // a mirrored picker is already open: not a PR question, however many it names
      if (isLeadOrBuilder(ASKER)) {
        if (refs.some((r) => isUnitPr(r))) await refuseLoopPr(refs);
      } else bad(`one question per PR: this question names ${refs.map((r) => "#" + r).join(" ")} — ask about one PR per question (add --pr <n> to be explicit)`);
    }
  }

  // The loop asks PR questions: an explicit --pr from a Builder or Lead is refused; a PR named in the
  // text only when it is one of this squad's unit PRs.
  if (PR && !PICKER_TID && isLeadOrBuilder(ASKER)) {
    if (PR_EXPLICIT || isUnitPr(PR)) await refuseLoopPr([PR]);
    PR = "";
  }
  if (PICKER_TID) PR = "";

  // U70: a question about a PR waits for the PR to be ready for a human.
  if (PR && existsSync(STATE)) {
    const bun = process.execPath;
    const prReady = join(ROOT, "bin", "loop", "squad", "pr-ready.ts");
    let r = await runCmd([bun, prReady, STATE, PR]);
    let verdict = chomp(r.out), vrc = r.rc;
    if (vrc === 4) { // the loop has no row for it: read it once
      const nwo = verdict.startsWith("fetch ") ? verdict.slice(6) : verdict;
      verdict = ""; vrc = 0;
      if (!nwo) writeErr(`ask-operator: cannot tell which GitHub repo PR #${PR} is in — asking without the readiness check\n`);
      else {
        const label = basename(dirname(dirname(STATE)));
        const h = await prHealthLine(nwo, PR, label);
        if (h.ok) {
          const line = chomp(h.line);
          const tab = line.indexOf("\t");
          const first = tab < 0 ? line : line.slice(0, tab), restH = tab < 0 ? line : line.slice(tab + 1);
          r = await runCmd([bun, prReady, "--judge", restH, ...(first === "closed" ? ["--closed"] : [])]);
          if (r.err) writeErr(r.err);
          verdict = chomp(r.out); vrc = r.rc;
        } else writeErr(`ask-operator: could not read PR #${PR} from GitHub — asking without the readiness check\n`);
      }
    }
    if (vrc !== 0 && vrc !== 1) writeErr(`ask-operator: the PR readiness check failed (exit ${vrc}) — asking without it\n`);
    if (vrc === 1) refuse(`PR #${PR} is not ready (${verdict}): send its Builder to fix it first`);
  }

  if (!existsSync(STATE)) refuse(`NOT on the board — no state file at ${STATE} (your spec's state= path; ls ~/.dev-studio/state/*/squads/)`);
  const st = readJson(STATE);
  const runId = st?.run_id;
  // A squad off Orca (U11b) has no Run: its loop.db row's backend says it is live all the same.
  const sqDir = dirname(resolve(STATE)), offOrca = basename(sqDir) === "squads"
    && squadContract(dirname(dirname(sqDir)), basename(dirname(sqDir)), basename(STATE, ".json")) !== null;
  if ((!truthy(runId) || runId === "") && !offOrca)
    refuse(`NOT on the board — ${STATE} has no run_id (not a live squad's state file)`);
  // U3: a linked document (--doc), or for a plan-* question the plan found by the id rule; a plan ask needs the plain section.
  let DOC_PATH = "", plainLines: { label: string; text: string }[] = [], revLines: { label: string; text: string }[] = [], revNum = 0;
  {
    const real = realpathSync(STATE);
    const dir = dirname(real); // …/<label>/squads
    const label = basename(dirname(dir));
    const root = dirname(dirname(dir)); // the real state root
    const topic = basename(real, ".json");
    const isPlan = ID.startsWith("plan-");
    let docFile = "";
    if (DOC) {
      let rp = "";
      try { rp = realpathSync(resolve(DOC)); } catch { refuse(`--doc ${DOC} does not exist`); }
      const where = `state/${label}/squads/ or state/${label}/archive/`;
      const okDir = dirname(rp) === join(realpathSync(root), label, "squads") || dirname(rp) === join(realpathSync(root), label, "archive");
      if (!(rp.endsWith(".md") && statSync(rp).isFile() && okDir)) refuse(`--doc must be an existing .md file directly in ${where} (got ${DOC})`);
      docFile = rp;
    } else if (isPlan && ID.length > 5) {
      const cand = join(dir, `${topic}-${ID.slice(5)}-plan.md`);
      if (!existsSync(cand)) refuse(`${ID}: the plan is not found — expected ${cand} (<topic>-<short>-plan.md beside the state file), or pass --doc <plan-path>`);
      docFile = cand;
    }
    if (docFile) {
      DOC_PATH = relative(realpathSync(root), docFile);
      if (isPlan) {
        const sec = plainSection(readFileSync(docFile, "utf8"));
        if (!sec) return refuse(`${ID}: the plan ${basename(docFile)} has no "## ${PLAIN_HEADING}" section — add it near the top with the five lines ${PLAIN_LABELS.map((l) => `- **${l}:**`).join(" ")} (conventions/plan-shape.md), then ask again`);
        if (sec.missing.length) refuse(`${ID}: the "## ${PLAIN_HEADING}" section of ${basename(docFile)} is missing ${sec.missing.map((l) => `- **${l}:**`).join(", ")} — add them, one per line like ${LABEL_FORM("What you get")} (conventions/plan-shape.md), then ask again`);
        plainLines = sec.lines;
        // R5: a plan already approved needs a complete revision note, newer than the saved approved copy's.
        const approved = chomp((await runCmd([SS, STATE, "plan-approved", docFile])).out) === "yes";
        if (approved) {
          const revs = planRevisions(readFileSync(docFile, "utf8"));
          const newest = revs[0];
          const copy = approvedCopyPath(docFile);
          const copyRev = existsSync(copy) ? (planRevisions(readFileSync(copy, "utf8"))[0]?.rev ?? 1) : 1;
          const fix = `add it right under "## ${PLAIN_HEADING}" (conventions/plan-shape.md, "The revisions section"), then ask again`;
          if (!newest) refuse(`${ID}: ${basename(docFile)} was approved before and has no "## Revisions" note — write "### Rev ${copyRev + 1} — <YYYY-MM-DD> — <short reason>" with the lines ${REVISION_LABELS.map((l) => `- **${l}:**`).join(" ")} (one per line, form ${LABEL_FORM("What changed")}); ${fix}`);
          if (newest.missing.length) refuse(`${ID}: the newest revision note (Rev ${newest.rev}) of ${basename(docFile)} is missing ${newest.missing.map((l) => `- **${l}:**`).join(", ")} (one per line, like ${LABEL_FORM("What changed")}) — ${fix}`);
          if (newest.rev <= copyRev) refuse(`${ID}: the newest revision note of ${basename(docFile)} is Rev ${newest.rev}, but the approved version already has Rev ${copyRev} (no earlier note counts as Rev 1) — add "### Rev ${copyRev + 1} — <YYYY-MM-DD> — <short reason>" for this change; ${fix}`);
          revLines = newest.lines; revNum = newest.rev;
        }
      } else {
        const sec = plainSection(readFileSync(docFile, "utf8"));
        if (sec && !sec.missing.length) plainLines = sec.lines;
      }
    }
  }

  const cur = await runCmd([BACKEND, "current"]);
  const wt = chomp(cur.out);
  // Only a BLOCKING question stops the squad; a non-blocking one (a follow-up to file) just queues.
  if (BLOCKING === "true") { const rc = await ss([STATE, "set-status", "waiting-on-you"]); if (rc !== 0) return rc; }
  let picker: Record<string, any> = {};
  if (PICKER_TID) picker = { source: "picker", tool_use_id: PICKER_TID, transcript_path: PICKER_TPATH, picker_answerable: PICKER_ANS === "true" };
  if (UNIT) picker = { ...picker, unit: UNIT };
  {
    const rc = await ss([STATE, "enqueue-question", ID, ASKER, BLOCKING, Q, wt, SUG, WHY, OPTS, TITLE, JSON.stringify(CHOICES), JSON.stringify(picker), PR, DOC_PATH]);
    if (rc !== 0) return rc; // wt: resolve clears its note
  }

  // Receipt: trust the file, not the commands above.
  const after = readJson(STATE);
  if (!arr(after?.waiting_on_you).some((q) => q?.id === ID)) refuse(`NOT on the board — '${ID}' is missing from ${STATE} after enqueue`);

  // U86: one PR has one open question — close the open one with a note naming the new id.
  if (PR) {
    for (const q of arr(after?.waiting_on_you)) {
      if (interp(q?.pr) !== PR || q?.id === ID) continue;
      const old = interp(q?.id);
      if (!old) continue;
      await runCmd([SS, STATE, "resolve-question", old, "--answer", `replaced by question ${ID}`, "--via", "reality"]);
    }
  }
  writeOut(`ON BOARD: ${ID} (${BLOCKING === "true" ? "blocking" : "non-blocking"}) — ${HEAD}\n`);
  if (!TITLE) writeErr('ask-operator: you used the old form — next time give --title, --option "<label>" "<what happens>" (2+), --recommend, --why (see conventions/escalation.md)\n');
  // A decision re-raised under a new id shows twice on the board; make the asker look at the others.
  const others = arr(readJson(STATE)?.waiting_on_you).filter((q) => q?.id !== ID)
    .map((q) => `  ${interp(q?.id)} (${truthy(q?.blocking) ? "blocking" : "non-blocking"}): ${interp(q?.question)}`);
  if (others.length) writeOut(`ALSO OPEN on this squad — if this question replaces one, resolve that one now (${SS} ${STATE} resolve-question <id>); next time re-ask under its id instead:\n${others.join("\n")}\n`);

  let rc = 0;
  if (!wt || (await runCmd([BACKEND, "ping", wt, `NEEDS YOU: ${HEAD}`])).rc !== 0) {
    writeErr(`ask-operator: on the board but NOT pinged (no card note on ${wt || "your worktree"}) — say so in your reply\n`);
    rc = 3;
  }

  // What the agent pastes into its own terminal reply, so the operator sees it where they read.
  writeOut(`\nPut this in your reply, then stop:\n  NEEDS YOU: ${HEAD}\n  Suggested: ${SUG} — ${WHY}\n  Answer here, or run /ds-q for the picker.\n${revLines.length ? `  Revision (Rev ${revNum}):\n${revLines.map((l) => `    ${l.label}: ${l.text}\n`).join("")}` : ""}${plainLines.map((l) => `  ${l.label}: ${l.text}\n`).join("")}`);
  return rc;
}
