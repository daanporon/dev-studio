// codex.ts — Codex's account kind (KTD16): a login folder is a CODEX_HOME (~/.codex for the system row,
// `default`). One login until U11 fills in the login command and the login id and switches `multi` on.
import { join } from "node:path";
import type { AccountKind, Env } from "./index.ts";

export const codex: AccountKind = {
  agent: "codex",
  systemId: "default",
  multi: false,
  why: "Codex keeps one login for now (~/.codex)",
  envVar: "CODEX_HOME",
  systemDir: (env: Env) => env.CODEX_HOME || join(env.HOME || "", ".codex"),
  links: [],
  credentialsFile: "auth.json",
  loginId: () => null,
  login: null,
  usage: true,
  resets: true,
};
