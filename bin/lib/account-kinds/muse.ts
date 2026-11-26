// muse.ts — Muse's account kind (KTD16): one login, in ~/.config/muse (the system row, `default`).
//
// Why one login (issue #125 U12, checked on Muse Code 1.4.25): `muse --help`, `muse login --help` and the
// install name no variable or flag for the config folder. MUSE_AUTH_PATH is read only by the launcher script
// (the header for its own downloads); the muse program does not hold that name. The program finds auth.json
// under $XDG_CONFIG_HOME/muse, else $HOME/.config/muse: a made-up key saved with `muse auth set` under a
// scratch folder landed there, through either variable, and the real login did not change (`muse login` was
// only shown its code and cancelled). HOME moves the whole home. XDG_CONFIG_HOME is not used either: every
// tool the agent runs inherits it (gh, git, `systemctl --user`, `ds`, and this file's systemDir), and linking
// the rest of ~/.config into each account folder covers only what is there at that moment: a tool configured
// later would save into one account's folder. A Muse that gets its own folder variable can switch `multi` on.
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
