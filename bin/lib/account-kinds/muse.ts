// muse.ts — Muse's account kind (KTD16): its login lives in ~/.config/muse (the system row, `default`). No
// folder variable is known; U12 checks whether Muse can keep a login per folder.
import { join } from "node:path";
import type { AccountKind, Env } from "./index.ts";

export const muse: AccountKind = {
  agent: "muse",
  systemId: "default",
  multi: false,
  why: "Muse keeps one login (~/.config/muse)",
  envVar: null,
  systemDir: (env: Env) => join(env.XDG_CONFIG_HOME || join(env.HOME || "", ".config"), "muse"),
  links: [],
  credentialsFile: "auth.json",
  loginId: () => null,
  login: null,
  command: (model, effort) => ["muse", "--trust-workspace", "--yolo", "--model", model,
    ...(effort ? ["--reasoning-effort", effort] : [])],
  usage: true,
  resets: false,
};
