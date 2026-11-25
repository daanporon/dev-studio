// registry.ts — which terminal backends a squad can start on, and which worktree tools each one can use
// (orca-backend-alternatives U9; conventions/backend.md, "A backend per squad").
//
// A squad's backend, the machine it runs on and its worktree tool are chosen once, at spawn
// (`chooseSquadBackend`, called by spawn-squad), and written on its `squads` row (`backend`,
// `backend_host`, `worktree_provider`, migration 0054); a later change is refused. The project picks what
// its new squads start on with the limits keys `default_backend` and `worktree_provider`;
// `spawn-squad --backend <name>` (and the board's Start squad dialog) override the backend for one squad.
//
// An entry with no adapter is not built yet: spawn refuses it with a line that says so, never falls back
// to `orca`. An entry with a `bin` is refused when that binary is not on PATH (`find`, when set, looks
// instead: herdr's pinned install, bin/backend/herdr-bin.ts). `orca` (Orca with Runs) is today's path: its worktrees
// are made by Orca's own worker starts, so its only tool is `orca`.
// One rule says which backend a project's squads use (U30, `squadBackendRule`): the project's `default_backend`
// and nothing else. `--backend` and a squad wish's `backend` field stay, and are only refused when they name another.
// Providers (the first is the backend's default): `orca` (Orca makes the worktree), `git`, `treehouse`.
// This module reads nothing but PATH (and herdr's install folder), so the board and the CLI can import it.
import { herdrBin } from "./herdr-bin.ts";
import { existsSync } from "node:fs";

export const BACKEND_NAMES = ["orca", "orca-lite", "tmux", "herdr"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];
export const PROVIDER_NAMES = ["orca", "git", "treehouse"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
// The values of the limits key `worktree_provider`: `auto` is the backend's default.
export const PROVIDER_SETTINGS = ["auto", "git", "treehouse"] as const;

export const DEFAULT_BACKEND: BackendName = "orca";
export const LOCAL_HOST = "local";

export type BackendEntry = {
  name: BackendName;
  adapter: string | null;           // the adapter the loop starts squads through (repo-relative); null = not built yet
  bin: string | null;               // a binary that must be on PATH at spawn; null = not checked here
  find?: (bin: string) => string | null;   // where `bin` is, when not (only) on PATH
  install?: string;                 // how to install `bin`, named when it is missing
  providers: readonly ProviderName[];   // the worktree tools it can use; the first is its default
  about: string;
};

export const BACKENDS: Readonly<Record<BackendName, BackendEntry>> = {
  orca: { name: "orca", adapter: "bin/backend/orca.sh", bin: null, providers: ["orca"], about: "Orca with Runs (today's path)" },
  "orca-lite": { name: "orca-lite", adapter: "bin/backend/orca-lite.ts", bin: "orca", providers: ["orca"], about: "Orca terminals, no Runs" },
  tmux: { name: "tmux", adapter: "bin/backend/tmux.ts", bin: "tmux", providers: ["git", "treehouse"], about: "tmux sessions" },
  herdr: { name: "herdr", adapter: "bin/backend/herdr.ts", bin: "herdr", find: () => herdrBin(), install: "bun bin/backend/herdr.ts install",
    providers: ["git", "treehouse"], about: "herdr workspaces" },
};

export const isBackend = (v: unknown): v is BackendName => typeof v === "string" && (BACKEND_NAMES as readonly string[]).includes(v);
export const backendOf = (name: string): BackendEntry | null => (isBackend(name) ? BACKENDS[name] : null);
export const defaultProvider = (b: BackendName): ProviderName => BACKENDS[b].providers[0];

export type Choice = { backend: BackendName; host: string; provider: ProviderName; providerDefault: boolean };
export type Chosen = ({ ok: true } & Choice) | { ok: false; error: string };

/** The treehouse binary as the provider finds it (`treehouseBin` in bin/loop/io/providers/treehouse.ts):
 *  DS_TREEHOUSE_BIN, else on PATH. A test's `which` answers instead. */
function treehouseFound(which?: (bin: string) => string | null): boolean {
  if (which) return !!which("treehouse");
  const given = process.env.DS_TREEHOUSE_BIN;
  return given ? existsSync(given) : !!Bun.which("treehouse");
}

/** The one rule for which backend a project's squads use (U30): the project's `default_backend`, on this host
 *  (`local`). `null` when `backend`/`host` fit, else the refusal naming the project's backend and how to change it.
 *  A squad's backend and `backend_host` are read from its own row, never from the project, so a squad on another
 *  host later widens only this function. Called by spawn-squad (via `chooseSquadBackend`) and the squad wish's
 *  fulfiller (bin/loop/fulfil/squad.ts). */
export function squadBackendRule(o: { backend: string; host?: string; projectBackend?: string }): string | null {
  const project = (o.projectBackend ?? "").trim() || DEFAULT_BACKEND, host = (o.host ?? "").trim() || LOCAL_HOST;
  if (host !== LOCAL_HOST) return `host '${host}' is not supported yet: squads start on this host (${LOCAL_HOST})`;
  if (o.backend === project) return null;
  return `backend ${o.backend} is refused: this project's squads start on ${project} (its default_backend); `
    + `to change it set the project's default_backend (ds config set <project> limits.conf default_backend <name>)`;
}

/** The backend, host and worktree tool a new squad starts on. `flag` is `--backend` (it may only name the
 *  project's `default_backend`), else the project's `default_backend`; the tool is the project's `worktree_provider` (`auto`, empty: the
 *  backend's default). Refused, with a line naming why: an unknown name, a backend other than the project's
 *  `default_backend` (`squadBackendRule`), a tool the backend cannot use, an adapter not built yet, a binary missing on PATH (the
 *  backend's, or treehouse's for that tool). `registry` and `which` are for tests. */
export function chooseSquadBackend(o: { flag?: string; projectBackend?: string; providerSetting?: string;
  registry?: Readonly<Record<string, BackendEntry>>; which?: (bin: string) => string | null }): Chosen {
  const reg: Readonly<Record<string, BackendEntry>> = o.registry ?? BACKENDS;
  const flag = (o.flag ?? "").trim(), project = (o.projectBackend ?? "").trim() || DEFAULT_BACKEND;
  const name = flag || project, from = flag ? "--backend" : "the project's default_backend";
  const e = Object.hasOwn(reg, name) ? reg[name] : undefined;
  if (!e) return { ok: false, error: `backend '${name}' (${from}) is not one of ${Object.keys(reg).join(", ")}` };
  const setting = (o.providerSetting ?? "").trim() || "auto";
  if (setting !== "auto" && !(PROVIDER_NAMES as readonly string[]).includes(setting))
    return { ok: false, error: `worktree_provider '${setting}' is not one of ${PROVIDER_SETTINGS.join(", ")}` };
  const provider = (setting === "auto" ? e.providers[0] : setting) as ProviderName;
  if (!e.providers.includes(provider))
    return { ok: false, error: `backend ${e.name} cannot use worktree_provider ${provider} (the project's setting): ${e.name} uses ${e.providers.join(" or ")}; set worktree_provider auto, or pick another backend` };
  if (!e.adapter) return { ok: false, error: `backend ${e.name} (${from}) is not built yet: the loop cannot start a squad on it; start the squad on another backend` };
  const ruled = squadBackendRule({ backend: e.name, projectBackend: project });
  if (ruled) return { ok: false, error: `${ruled} (asked for by ${from})` };
  const which = o.which ?? e.find ?? ((bin: string) => Bun.which(bin));
  if (e.bin && !which(e.bin))
    return { ok: false, error: `backend ${e.name} (${from}) needs '${e.bin}', which is not on PATH on this host${e.install ? `; install it with: ${e.install}` : ""}` };
  // The tool's binary too (U16e): without it the squad's first member start would be the one to fail.
  if (provider === "treehouse" && !treehouseFound(o.which))
    return { ok: false, error: "worktree_provider treehouse needs 'treehouse' (DS_TREEHOUSE_BIN, else on PATH), which this host lacks; install treehouse (github.com/kunchenguid/treehouse) or set worktree_provider auto" };
  return { ok: true, backend: e.name, host: LOCAL_HOST, provider, providerDefault: provider === e.providers[0] };
}
