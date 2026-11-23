// fulfil/feedback-draft.ts — kind `feedback.draft` (ds-feedback-github-issues U2): one pass of the Studio's
// feedback drafter, in the background (actuator BACKGROUND_KINDS; its own limit, DS_FEEDBACK_DRAFT_S + 60).
//   1. the action's notes that are still due (dueNotes: `new`, not kept within a day); none: done, so a
//      replay after the pass wrote finds nothing and writes nothing,
//   2. no leak word list: dropped (the reconciler's card asks for it; no draft is ever made without it),
//   3. the GitHub budget (github-budget.ts) has room, else wait for its reset; then the open issues of
//      `repo` that carry the marker (`gh issue list --search`), a rate limit waits too,
//   4. the `studio` pick on claude (capacity/pick.ts) and its account's config dir (the backend's
//      `claude-config-dir`),
//   5. one headless `claude -p` in a snapshot of the checkout's HEAD (`git archive` into a temp folder, so
//      no state/ and no untracked file is in reach), with Read, Grep and Glob only (no Bash: a git command
//      can run a pager or write a file) and Read denied on the state root; the issue bodies in the prompt
//      come from anyone, so the drafter gets nothing that writes, runs or reaches private state. The
//      prompt (feedback/prompt.ts) goes on stdin; the run ends after DS_FEEDBACK_DRAFT_S (900),
//   6. the answer parsed (parseAnswer); each draft's final text (title + body + marker + ds-key) through
//      the leak guard (feedback/leak.ts), a hit stored as leak `blocked` with the kinds it found,
//   7. writeVerdicts (feedback/draft.ts): drafts, notes and one `feedback_drafted` event in one transaction.
// A failed pass writes nothing; the reconciler offers the notes again after DS_FEEDBACK_RETRY_S.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Exec, Fulfiller, Result } from "../core/actuator.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { ROOT } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { redact } from "../core/redact.ts";
import { pick } from "../capacity/pick.ts";
import { budgetBackAt, budgetOf, hasBudget, isRateLimit } from "../io/github-budget.ts";
import { childEnv } from "../io/orca.ts";
import { dueNotes, draftKey, hostProject, writeVerdicts, type Checked } from "../feedback/draft.ts";
import { hasWords, leakCheck } from "../feedback/leak.ts";
import { buildPrompt, finalBody, parseAnswer, type IssueIn } from "../feedback/prompt.ts";

type P = ActionPayload<"feedback.draft">;
type Run = { code: number; out: string; err: string };

export const draftS = () => envInt("DS_FEEDBACK_DRAFT_S", 900);
const RATE_WAIT_S = 900;
export const TOOLS = "Read,Grep,Glob";
// Every tool that writes, runs or fetches, and Read on the state root and the host's own state.
export const denied = (stateRoot: string) => ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent",
  ...[...new Set([stateRoot, join(ROOT, "state"), join(homedir(), ".dev-studio", "state")])].map((d) => `Read(/${resolve(d)}/**)`)].join(",");

async function run(argv: string[], env: Record<string, string>, opts: { cwd?: string; stdin?: string; timeoutMs: number }): Promise<Run> {
  try {
    const p = Bun.spawn(argv, { env, cwd: opts.cwd, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) { return { code: -1, out: "", err: String((e as Error)?.message ?? e) }; }
}
const why = (r: Run) => redact((r.err || r.out).trim().split("\n").slice(-3).join(" ").slice(0, 300)) || `exit ${r.code}`;

// The open issues of `repo` whose body carries the marker.
async function openIssues(repo: string): Promise<{ issues: IssueIn[] } | { limited: string } | { error: string }> {
  const r = await run(["gh", "issue", "list", "-R", repo, "--state", "open", "--search", "\"ds-feedback v1\" in:body", "--limit", "100", "--json", "number,title,body"],
    childEnv(), { timeoutMs: 60_000 });
  if (r.code !== 0) return isRateLimit(r.err + r.out) ? { limited: why(r) } : { error: `gh issue list: ${why(r)}` };
  try {
    const rows = JSON.parse(r.out) as { number: number; title?: string; body?: string }[];
    return { issues: rows.filter((i) => Number.isInteger(i.number) && String(i.body ?? "").includes("ds-feedback v1"))
      .map((i) => ({ number: i.number, title: String(i.title ?? ""), body: String(i.body ?? "") })) };
  } catch { return { error: "gh issue list: the answer is not JSON" }; }
}

async function draft(x: Exec, p: P): Promise<Result> {
  const { store, now } = x;
  const notes = dueNotes(store, now, p.keys.length, p.keys);
  if (!notes.length) return { done: true, result: "nothing new" };
  if (!hasWords()) return { dropped: "no leak word list: no draft is made without it" };

  const b = budgetOf(store);
  if (!hasBudget(b, now)) return { wait: "GitHub budget used up", at: budgetBackAt(b, now) ?? now + RATE_WAIT_S };
  const gh = await openIssues(p.repo);
  if ("limited" in gh) return { wait: `GitHub rate limit: ${gh.limited}`, at: now + RATE_WAIT_S };
  if ("error" in gh) return { failed: gh.error };

  const project = hostProject(store);
  if (!project) return { failed: "no project to pick the studio role on" };
  const pk = pick(store, { project, role: "studio", agent: "claude" }, now);
  if ("error" in pk) return { failed: `studio pick: ${pk.error}` };
  if ("wait" in pk) return { wait: `no studio account free: ${pk.reason}`, at: pk.wait };

  const env = childEnv();
  delete env.CLAUDE_CONFIG_DIR;
  if (pk.account && pk.account !== "system") {
    const c = await x.act.orca.run("claude-config-dir", [pk.account]);
    if (c.code !== 0) return { failed: `claude-config-dir ${pk.account}: ${why(c)}` };
    if (c.out.trim()) env.CLAUDE_CONFIG_DIR = c.out.trim();
  }
  const head = await run(["git", "-C", ROOT, "rev-parse", "--short=12", "HEAD"], childEnv(), { timeoutMs: 10_000 });
  const input = { repo: p.repo, head: head.code === 0 ? head.out.trim() : "", issues: gh.issues,
    notes: notes.map((n) => ({ key: String(n.key), role: (n.role as string | null) ?? null, text: String(n.text ?? "") })) };

  const argv = ["claude", "-p", "--model", pk.model, ...(pk.effort ? ["--effort", pk.effort] : []), "--setting-sources", "user",
    "--permission-mode", "default", "--allowedTools", TOOLS, "--disallowedTools", denied(store.root), "--output-format", "json"];
  const snap = mkdtempSync(join(tmpdir(), "ds-feedback-"));
  let r: Run;
  try {
    const tree = await run(["bash", "-c", 'set -o pipefail; git -C "$1" archive --format=tar HEAD | tar -x -C "$2"', "bash", ROOT, snap], childEnv(), { timeoutMs: 120_000 });
    if (tree.code !== 0) return { failed: `snapshot of the checkout: ${why(tree)}` };
    r = await run(argv, env, { cwd: snap, stdin: buildPrompt(input), timeoutMs: draftS() * 1000 });
  } finally { rmSync(snap, { recursive: true, force: true }); }
  if (r.code !== 0) return { failed: `claude: ${why(r)}` };
  let answer: string;
  try {
    const o = JSON.parse(r.out) as { result?: unknown; is_error?: boolean };
    if (o.is_error || typeof o.result !== "string") return { failed: `claude: ${redact(String(o.result ?? "no result").slice(0, 300))}` };
    answer = o.result;
  } catch { return { failed: "claude: the output is not JSON" }; }

  let verdicts: Checked[];
  try { verdicts = parseAnswer(answer, input); } catch (e) { return { failed: String((e as Error).message) }; }
  for (const v of verdicts) {
    if (v.verdict !== "issue" && v.verdict !== "add-to") continue;
    v.key = draftKey(v.verdict, v.notes, v.verdict === "add-to" ? v.issue : null);
    v.leak = await leakCheck(`${v.verdict === "issue" ? `${v.title}\n\n` : ""}${finalBody(v.body, v.area, v.kind, v.key)}`);
  }
  const w = writeVerdicts(store, input.notes.map((n) => n.key), verdicts, { repo: p.repo, head: input.head, model: pk.model, account: pk.account, at: now });
  return { done: true, result: w };
}

const feedbackDraft: Fulfiller = {
  name: "feedback-draft",
  kinds: ["feedback.draft"],
  run: () => [],
  exec(a, x) {
    const p = payloadOf<"feedback.draft">(a);
    if (!p.repo || !Array.isArray(p.keys) || !p.keys.length) return { failed: "a draft pass needs a repo and note keys" };
    return { background: draft(x, p) };
  },
};
export default feedbackDraft;
