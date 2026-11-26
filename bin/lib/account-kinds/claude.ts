// claude.ts — Claude's account kind (KTD16): a login folder is a CLAUDE_CONFIG_DIR; the system login runs with
// it unset (~/.claude, its .claude.json in $HOME); the login id is `.claude.json` oauthAccount.accountUuid.
// The login command lands with `ds account add` (U5).
import { readFileSync } from "node:fs";
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
  login: null,
  usage: true,
  resets: true,
};
