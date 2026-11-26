// codex.ts — Codex's account kind (KTD16): a login folder is a CODEX_HOME (~/.codex for the system row,
// `default`). The login command (`ds account add --agent codex`, U11) is `codex login --device-auth`: it prints a
// URL and a one-time code, waits for the approval and writes `auth.json` in the folder. The login id is
// `auth.json`'s `tokens.account_id` (Codex's `TokenData`, codex-rs/login/src/token_data.rs: the ChatGPT account
// id); nothing else is read from that file. An API-key login has no id.
import { join } from "node:path";
import { jsonField } from "./claude.ts";
import type { AccountKind, Env } from "./index.ts";

const URL_RE = /https:\/\/auth\.openai\.com\/[^\s\x1b]+/;
const CODE_RE = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;
const ANSI = /\x1b\[[0-9;]*m/g;

/** The device login screen: the URL to open and the one-time code (on a line of its own). */
export function readDeviceScreen(screen: string): { url?: string; device_code?: string; prompt: boolean } {
  const lines = screen.replace(ANSI, "").split("\n").map((l) => l.trim());
  const url = lines.map((l) => l.match(URL_RE)?.[0]).find(Boolean);
  const code = lines.find((l) => CODE_RE.test(l));
  return { ...(url ? { url } : {}), ...(url && code ? { device_code: code } : {}), prompt: false };
}

export const codex: AccountKind = {
  agent: "codex",
  systemId: "default",
  multi: true,
  envVar: "CODEX_HOME",
  systemDir: (env: Env) => env.CODEX_HOME || join(env.HOME || "", ".codex"),
  // The same provider config, hooks and skills as the system login, and its sessions stay under
  // ~/.codex/sessions for the rollout observer; auth.json and the sqlite state stay per folder.
  links: ["config.toml", "hooks.json", "skills", "prompts", "plugins", "rules", "sessions"],
  credentialsFile: "auth.json",
  loginId: (folder) => jsonField(join(folder, "auth.json"), ["tokens", "account_id"]),
  login: {
    command: ["codex", "login", "--device-auth"],
    flow: "device",
    read: readDeviceScreen,
  },
  keyEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  command: (model, effort) => ["codex", "-c", "disable_paste_burst=true", "--dangerously-bypass-approvals-and-sandbox",
    "--model", model, ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : [])],
  usage: true,
  resets: true,
};
