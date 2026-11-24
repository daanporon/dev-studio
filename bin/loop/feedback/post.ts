// post.ts — what a reviewed feedback draft becomes on GitHub (ds-feedback-github-issues U3). Only a
// draft's own columns ever leave the host (title, body, area, label): never a note's raw text.
//
//   feedbackOn     the host-level `feedback` switch (off|on, last one written wins)
//   feedbackRepo   null while off, else the `feedback_repo` override (owner/name), else the checkout's origin
//   finalText      the title and body exactly as posted: the drafter's body with any marker lines it
//                  carried dropped, then the marker line the label workflow reads and the `ds-key` line
//   leakCheck      U2's check (feedback/leak.ts) on the final title and body together: the host word
//                  list (a missing or empty one is a hit), the kinds of hit without the matched value
//   Gh             the GitHub calls a post makes (REST through `gh api`, DS_GH for a stub): find a post by
//                  its key, create an issue, comment on one, and the reset time of a used-up budget
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { limitEnv } from "../settings/limits.ts";
import { spawn, type Out } from "../io/orca.ts";
import { leakCheck as checkText } from "./leak.ts";
import { finalBody } from "./prompt.ts";
import { RESET_GRACE_S } from "../io/github-budget.ts";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Is Feedback on: the env var, else the newest change by a person: of the project rows (`project != ''`) of
 *  `limits.conf` `feedback` that hold a value, the one whose newest `config_history` entry (same project, file,
 *  key) is latest, ties by project label. The last change from any project's Settings wins (it is host-wide).
 *  With no such project row, the default row; off when none. `observed_at` is not used: the config observer
 *  rewrites it on every sweep. */
export function feedbackOn(store: Store): boolean {
  const ev = process.env[limitEnv("feedback")]?.trim();
  if (ev) return ev === "on";
  const pick = (r: { value: string | null } | null) => String(r?.value ?? "").trim().split(/\s+/)[0] === "on";
  const r = store.db.query(`SELECT c.value FROM config c WHERE c.file = 'limits.conf' AND c.key = 'feedback' AND c.project != '' AND TRIM(COALESCE(c.value, '')) != ''
      ORDER BY COALESCE((SELECT MAX(h.at) FROM config_history h WHERE h.project = c.project AND h.file = c.file AND h.key = c.key), 0) DESC, c.project ASC LIMIT 1`)
    .get() as { value: string | null } | null;
  if (r) return pick(r);
  return pick(store.db.query("SELECT value FROM config WHERE file = 'limits.conf' AND key = 'feedback' AND project = '' AND TRIM(COALESCE(value, '')) != '' LIMIT 1")
    .get() as { value: string | null } | null);
}
/** owner/name of a github.com remote URL (`https://github.com/o/n(.git)`, `git@github.com:o/n(.git)`, `ssh://git@github.com/o/n`), else null. */
export function parseOrigin(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
let originMemo: string | null | undefined;
/** The dev-studio checkout's `origin` as owner/name, read once per process (`DS_FEEDBACK_ORIGIN` stands in for the URL in tests); null for a missing or non-GitHub origin. */
export function checkoutOrigin(): string | null {
  const stub = process.env.DS_FEEDBACK_ORIGIN;
  if (stub !== undefined) return parseOrigin(stub);
  if (originMemo === undefined) {
    const r = spawnSync("git", ["-C", ROOT, "remote", "get-url", "origin"], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 5000 });
    originMemo = r.status === 0 ? parseOrigin(String(r.stdout)) : null;
  }
  return originMemo;
}
/** The repo feedback is posted to: null while Feedback is off; else the `feedback_repo` override (env, else the
 *  default row, else the first project row by label) when it names owner/name; else the checkout's origin
 *  (null, with the board saying why, when that is missing or not GitHub). Host-level like disk_watch_paths. */
export function feedbackRepo(store: Store): string | null {
  if (!feedbackOn(store)) return null;
  const ok = (v: unknown): string | null => { const t = String(v ?? "").trim(); return REPO.test(t) ? t : null; };
  const ev = process.env[limitEnv("feedback_repo")]?.trim();
  if (ev) return ok(ev) ?? (ev === "-" ? checkoutOrigin() : null);
  const rows = store.db.query("SELECT project, value FROM config WHERE file = 'limits.conf' AND key = 'feedback_repo' ORDER BY project = '' DESC, project")
    .all() as { project: string; value: string | null }[];
  for (const r of rows) { const v = ok(r.value); if (v) return v; }
  return checkoutOrigin();
}
// The words the label workflow (.github/scripts/feedback-labels.mjs) takes in prompt.ts's marker line, and
// the hidden key line an add-to comment ends with (an issue gets it from prompt.ts finalBody).
export const WORD = /^[a-z0-9][a-z0-9-]{0,31}$/;
const keyLine = (key: string): string => `<!-- ds-key:${key} -->`;
const OURS = /^\s*<!-- ds-(feedback v1 |key:)[^\n]*-->\s*$/;

/** A draft's area and kind words for the marker; an unusable one reads `other` (the workflow labels it so). */
const word = (v: unknown, dflt: string) => { const t = String(v ?? "").trim().toLowerCase(); return WORD.test(t) ? t : dflt; };

/** The title and body as they go out. An add-to comment has no title. */
export function finalText(d: Row): { title: string | null; body: string } {
  const own = String(d.body ?? "").split("\n").filter((l) => !OURS.test(l)).join("\n").replace(/\s+$/, "");
  if (d.kind === "add-to") return { title: null, body: `${own}\n\n${keyLine(String(d.key))}\n` };
  return { title: String(d.title ?? "").trim(), body: finalBody(own, word(d.area, "other"), word(d.label, "other"), String(d.key)) };
}

export type Leak = { leak: "ok" | "blocked"; why: string | null };
export type LeakCheck = (title: string | null, body: string) => Promise<Leak>;

/** The word-list check on the final text, title and body in one text. */
export const leakCheck: LeakCheck = async (title, body) => {
  const r = await checkText(`${title ?? ""}\n\n${body}`);
  return r.ok ? { leak: "ok", why: null } : { leak: "blocked", why: r.why };
};

export type Posted = { issue: number; url: string };
export type Gh = {
  /** The issue (or, with `on`, the comment on issue `on`) whose body holds `ds-key:<key>`, made at or after `since`. */
  find(repo: string, key: string, since: number, on: number | null): Promise<Posted | null | Out>;
  create(repo: string, title: string, body: string): Promise<Posted | Out>;
  comment(repo: string, issue: number, body: string): Promise<Posted | Out>;
  /** When a used-up REST budget is full again (reset + grace), or null when it is not used up or unreadable. */
  resetAt(now: number): Promise<number | null>;
};
export const isOut = (v: unknown): v is Out => !!v && typeof v === "object" && "code" in v && "err" in v;

const ghArgv = () => (process.env.DS_GH || "gh").split(/\s+/).filter(Boolean);
const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");

async function api(args: string[], input?: unknown): Promise<Out> {
  if (input === undefined) return spawn([...ghArgv(), "api", ...args], {}, 60_000);
  const dir = mkdtempSync(join(tmpdir(), "ds-feedback-"));
  try {
    const file = join(dir, "input.json");
    writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    return await spawn([...ghArgv(), "api", ...args, "--input", file], {}, 60_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function posted(r: Out, issue?: number): Posted | Out {
  if (r.code !== 0) return r;
  try {
    const j = JSON.parse(r.out);
    const n = issue ?? Number(j?.number);
    if (Number.isInteger(n) && n > 0 && typeof j?.html_url === "string") return { issue: n, url: j.html_url };
  } catch { /* below */ }
  return { code: 1, out: r.out, err: "gh api: no issue number and URL in the answer" };
}

export const gh: Gh = {
  async find(repo, key, since, on) {
    const path = on == null ? `repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&since=${iso(since)}`
      : `repos/${repo}/issues/${on}/comments?per_page=100&since=${iso(since)}`;
    const jq = `[.[] | select((.body // "") | contains(${JSON.stringify(`ds-key:${key}`)})) | {number, html_url}] | first // empty`;
    const r = await api([path, "--jq", jq]);
    if (r.code !== 0) return r;
    if (!r.out.trim()) return null;
    return posted(r, on ?? undefined);
  },
  create: async (repo, title, body) => posted(await api(["-X", "POST", `repos/${repo}/issues`], { title, body })),
  comment: async (repo, issue, body) => posted(await api(["-X", "POST", `repos/${repo}/issues/${issue}/comments`], { body }), issue),
  async resetAt(now) {
    const r = await api(["rate_limit", "--jq", ".resources.core"]);
    if (r.code !== 0) return null;
    try {
      const c = JSON.parse(r.out);
      return Number(c?.remaining) <= 0 && Number(c?.reset) > now ? Number(c.reset) + RESET_GRACE_S : null;
    } catch { return null; }
  },
};
