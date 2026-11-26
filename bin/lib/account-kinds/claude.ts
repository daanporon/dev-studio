// claude.ts — Claude's account kind (KTD16): a login folder is a CLAUDE_CONFIG_DIR; the system login runs with
// it unset (~/.claude, its .claude.json in $HOME); the login id is `.claude.json` oauthAccount.accountUuid.
// The login command (`ds account add`, U5) is `claude auth login --claudeai`: with BROWSER=true it prints the
// authorize URL and waits at "Paste code here if prompted >" (the paste flow). It writes no onboarding keys, so
// afterLogin copies the system login's, else the agent's first start in the folder asks the setup questions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountKind, Env } from "./index.ts";

/** A JSON file's string field at `path`, null when the file, the field or a string is missing. */
export function jsonField(file: string, path: string[]): string | null {
  try {
    let v: unknown = JSON.parse(readFileSync(file, "utf8"));
    for (const k of path) v = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch { return null; }
}

const AUTHORIZE = /^https:\/\/claude\.(ai|com)\/\S*oauth\/authorize/;
const ONBOARDING = ["hasCompletedOnboarding", "lastOnboardingVersion"];

function readJson(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}

/** The login screen: the authorize URL (a wrapped one joined back: a URL line followed by lines with no space)
 *  and whether it waits for the pasted code. */
export function readLoginScreen(screen: string): { url?: string; prompt: boolean } {
  const lines = screen.split("\n").map((l) => l.trim());
  let url: string | undefined;
  for (let i = 0; i < lines.length && !url; i++) {
    let u = lines[i].match(/https:\/\/\S+/)?.[0];
    if (!u) continue;
    for (let j = i + 1; j < lines.length && /^\S+$/.test(lines[j]) && !/^https:/.test(lines[j]); j++) u += lines[j];
    if (AUTHORIZE.test(u)) url = u;
  }
  return { ...(url ? { url } : {}), prompt: /Paste code here/i.test(screen) };
}

export const claude: AccountKind = {
  agent: "claude",
  systemId: "system",
  multi: true,
  envVar: "CLAUDE_CONFIG_DIR",
  systemDir: (env: Env) => join(env.HOME || "", ".claude"),
  // What Orca's profiles link into ~/.claude: shared history, projects, plugins and skills; never
  // .claude.json or .credentials.json, which are the login.
  links: ["projects", "plugins", "skills", "commands", "hooks", "history.jsonl", "file-history", "paste-cache",
    "plans", "tasks", "todos", "transcripts", "shell-snapshots", "session-env", "context-mode"],
  credentialsFile: ".credentials.json",
  loginId: (folder: string, system: boolean, env: Env) =>
    jsonField(join(system ? env.DS_CLAUDE_SYSTEM_JSON_DIR || env.HOME || "" : folder, ".claude.json"), ["oauthAccount", "accountUuid"]),
  login: {
    command: ["claude", "auth", "login", "--claudeai"],
    flow: "paste",
    read: readLoginScreen,
  },
  afterLogin(folder: string, env: Env) {
    const sys = readJson(join(env.DS_CLAUDE_SYSTEM_JSON_DIR || env.HOME || "", ".claude.json"));
    const file = join(folder, ".claude.json"), mine = readJson(file);
    const keys = ONBOARDING.filter((k) => sys[k] !== undefined && mine[k] === undefined);
    if (!keys.length) return;
    for (const k of keys) mine[k] = sys[k];
    writeFileSync(file, `${JSON.stringify(mine, null, 2)}\n`, { mode: 0o600 });
  },
  usage: true,
  resets: true,
};
