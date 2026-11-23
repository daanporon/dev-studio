// registry.ts — which terminal backends a squad can start on, and which worktree tools each one can use
// (orca-backend-alternatives U9; conventions/backend.md, "A backend per squad").
//
// A squad's backend, the machine it runs on and its worktree tool are chosen once, at spawn
// (`chooseSquadBackend`, called by spawn-squad), and written on its `squads` row (`backend`,
// `backend_host`, `worktree_provider`, migration 0054); a later change is refused. The project picks what
// its new squads start on with the limits keys `default_backend` and `worktree_provider`;
// `spawn-squad --backend <name>` (and the board's Start squad dialog) override the backend for one squad.
//
// An entry with no adapter is not built yet (herdr's v2 adapter, bin/backend/herdr.ts, is not wired to
// squad starts): spawn refuses it with a line that says so, never falls back to `orca`. An entry with a
// `bin` is refused when that binary is not on PATH. `orca` (Orca with Runs) is today's path: its worktrees
// are made by Orca's own worker starts, so its only tool is `orca`.
// Providers (the first is the backend's default): `orca` (Orca makes the worktree), `git`, `treehouse`.
// This module reads nothing but PATH, so the board and the CLI can import it.

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
  providers: readonly ProviderName[];   // the worktree tools it can use; the first is its default
  about: string;
};

export const BACKENDS: Readonly<Record<BackendName, BackendEntry>> = {
  orca: { name: "orca", adapter: "bin/backend/orca.sh", bin: null, providers: ["orca"], about: "Orca with Runs (today's path)" },
  "orca-lite": { name: "orca-lite", adapter: null, bin: "orca", providers: ["orca"], about: "Orca terminals, no Runs" },
  tmux: { name: "tmux", adapter: null, bin: "tmux", providers: ["git", "treehouse"], about: "tmux sessions" },
  herdr: { name: "herdr", adapter: null, bin: "herdr", providers: ["git", "treehouse"], about: "herdr workspaces" },
};

export const isBackend = (v: unknown): v is BackendName => typeof v === "string" && (BACKEND_NAMES as readonly string[]).includes(v);
export const backendOf = (name: string): BackendEntry | null => (isBackend(name) ? BACKENDS[name] : null);
export const defaultProvider = (b: BackendName): ProviderName => BACKENDS[b].providers[0];

export type Choice = { backend: BackendName; host: string; provider: ProviderName; providerDefault: boolean };
export type Chosen = ({ ok: true } & Choice) | { ok: false; error: string };

/** The backend, host and worktree tool a new squad starts on. `flag` is `--backend` (wins), else the
 *  project's `default_backend`; the tool is the project's `worktree_provider` (`auto`, empty: the
 *  backend's default). Refused, with a line naming why: an unknown name, a tool the backend cannot use,
 *  an adapter not built yet, a binary missing on PATH. `registry` and `which` are for tests. */
export function chooseSquadBackend(o: { flag?: string; projectBackend?: string; providerSetting?: string;
  registry?: Readonly<Record<string, BackendEntry>>; which?: (bin: string) => string | null }): Chosen {
  const reg: Readonly<Record<string, BackendEntry>> = o.registry ?? BACKENDS;
  const which = o.which ?? ((bin: string) => Bun.which(bin));
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
  if (e.bin && !which(e.bin)) return { ok: false, error: `backend ${e.name} (${from}) needs '${e.bin}', which is not on PATH on this host` };
  return { ok: true, backend: e.name, host: LOCAL_HOST, provider, providerDefault: provider === e.providers[0] };
}
