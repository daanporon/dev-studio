// backend-change.ts — does a project's `default_backend` / `worktree_provider` fit this host and its roster? (U32)
// The same checks spawn-squad makes when a squad starts (`chooseSquadBackend`, `noLaunchLine`), run when the
// setting is changed, so a bad value is refused where the operator sets it, not at the next spawn.
// `ds config set`, `ds limits set` and the board's Settings page all write through bin/loop/settings/settings.ts,
// which calls this. Pure: it reads PATH (through the registry) and nothing else.
import { chooseSquadBackend } from "./registry.ts";
import { noLaunchLine } from "./launch-lines.ts";

/** Why `backend` with the worktree tool setting `provider` cannot start squads on this host, or null when it fits.
 *  Each refusal names its reason and the fix. `roster` is the project's effective roster (role -> row). */
export function backendChangeProblem(o: { project: string; backend: string; provider: string; roster: Map<string, string>;
  which?: (bin: string) => string | null }): string | null {
  const c = chooseSquadBackend({ projectBackend: o.backend, providerSetting: o.provider, which: o.which });
  if (!c.ok) {
    const why = c.error.replace(/ \(the project's default_backend\)/, "");
    return why.endsWith("not on PATH on this host") ? `${why}; install it, or pick another backend` : why;
  }
  const missing = c.backend === "orca" ? [] : noLaunchLine(o.roster);
  if (missing.length)
    return `backend ${c.backend} can start only claude, and the roster names ${missing.join(", ")}; `
      + `change those roles (ds config set ${o.project} roles.conf <role> claude <model>) or keep the backend that launches them`;
  return null;
}
