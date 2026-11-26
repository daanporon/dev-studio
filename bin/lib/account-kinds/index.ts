// account-kinds — one account kind per agent (issue #125, KTD16): how a login folder reaches the agent, its
// system row, whether it keeps more than one login, the credentials file that means "logged in" and how to
// read the login id. Everything generic over accounts (the folder scan, bin/lib/account-dirs.ts, `ds account`)
// reads the kind, so a new agent is one more file here plus its launch line's folder env and tests. These are
// account kinds, not the request kinds of bin/loop/core/kinds.ts. No other file names an agent's folder env or
// login command.
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { muse } from "./muse.ts";

export type Env = Record<string, string | undefined>;

/** The login command a new folder runs in its login terminal. `paste`: the screen shows a URL and asks for a
 *  code to paste back (Claude); `device`: a URL and a code the operator approves in a browser (Codex, Muse). */
export type KindLogin = {
  command: string[];
  flow: "paste" | "device";
  /** The login screen -> what it shows: the URL, the device code (device flow) and whether it asks for a paste. */
  read(screen: string): { url?: string; device_code?: string; prompt: boolean };
};

export type AccountKind = {
  agent: string;
  /** The id of the agent's own login (the folder the agent uses with no env set): `system` or `default`. */
  systemId: string;
  /** Whether it keeps more than one login; `why` says why not, for a refused add. */
  multi: boolean;
  why?: string;
  /** The variable that points the agent at a login folder, null when the agent has none (yet). */
  envVar: string | null;
  /** The agent's own folder, where the system row's login lives. */
  systemDir(env: Env): string;
  /** Names a new folder links into the agent's system folder (never the credentials file). */
  links: string[];
  /** The file in a folder that means "logged in". */
  credentialsFile: string;
  /** The folder's login id, or null when it has none; never a token. `system` reads the system login's. */
  loginId(folder: string, system: boolean, env: Env): string | null;
  /** The login command, null until its unit lands it (Claude U5, Codex U11, Muse U12). */
  login: KindLogin | null;
  /** The agent's own launch line, as Orca types it for a worker: an Orca tab on a non-system account runs it
   *  with the kind's env (KTD17). Absent for Claude, whose line is bin/loop/drivers/claude-launch.ts. */
  command?(model: string, effort: string): string[];
  /** What a freshly logged-in folder still needs before the agent starts in it without questions (Claude: the
   *  onboarding keys of the system login's `.claude.json`). Never touches the credentials. */
  afterLogin?(folder: string, env: Env): void;
  /** API key variables that can win over a folder's login: `ds account add` warns when one is set. */
  keyEnv?: string[];
  /** Whether usage figures and free resets can be read for an account. */
  usage: boolean;
  resets: boolean;
};

export const KINDS: readonly AccountKind[] = [claude, muse, codex];

/** The kind of `agent`; throws for an agent with no account kind. */
export function kindOf(agent: string): AccountKind {
  const k = KINDS.find((x) => x.agent === agent);
  if (!k) throw new Error(`no account kind for agent '${agent}' (bin/lib/account-kinds/)`);
  return k;
}

/** The kind of `agent`, or null. */
export const findKind = (agent: string): AccountKind | null => KINDS.find((x) => x.agent === agent) ?? null;

/** The env that points a process at `folder` for this kind ({} for the system row or a kind with no variable). */
export function kindEnv(kind: AccountKind, folder: string | null): Record<string, string> {
  return kind.envVar && folder ? { [kind.envVar]: folder } : {};
}
