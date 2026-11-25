// whoami.ts — who is this process (U4 of orca-backend-alternatives). Every Claude terminal the loop
// starts carries its identity in its environment, set on the launch line by the backend adapter
// (claudeTab and resumeTab in bin/backend/orca.ts):
//   DS_MEMBER  <project>/<squad>/<role[-suffix]>   the member the loop started
//   DS_WT      <path>                              its worktree
//   DS_GEN     <generation id>                     the start's id, also on its members row (`gen`)
// A start Orca types itself (Codex, Muse, `--on`) and an older session carry only the Orca handle
// (ORCA_TERMINAL_HANDLE), so every reader asks here: DS_MEMBER first, then the handle. `handle` stays
// the Orca terminal handle for the calls that need Orca's own (a `--from`, worker_done, a session check).
export type Identity = {
  member: string | null;   // DS_MEMBER as set, null when unset or malformed
  wt: string | null;       // DS_WT
  gen: string | null;      // DS_GEN
  handle: string | null;   // ORCA_TERMINAL_HANDLE
  via: "member" | "handle" | null;   // what found it: DS_MEMBER, else the Orca handle, else nothing
};
export type MemberId = { project: string; squad: string; role: string; suffix: string };

/** `<project>/<squad>/<role[-suffix]>` read back; null for anything else. The role is the part
 *  before the first dash (a Builder's `builder-<unit>`), the suffix the rest. */
export function parseMember(s: string | null | undefined): MemberId | null {
  const parts = (s ?? "").split("/");
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  const [project, squad, label] = parts;
  const cut = label.indexOf("-");
  const role = cut < 0 ? label : label.slice(0, cut), suffix = cut < 0 ? "" : label.slice(cut + 1);
  return role ? { project, squad, role, suffix } : null;
}

/** The DS_MEMBER value for a member. */
export const memberLabel = (m: { project: string; squad: string; role: string; suffix?: string | null }): string =>
  `${m.project}/${m.squad}/${m.role}${m.suffix ? `-${m.suffix}` : ""}`;

export function whoAmI(env: Record<string, string | undefined> = process.env): Identity {
  const set = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  const member = parseMember(env.DS_MEMBER) ? env.DS_MEMBER!.trim() : null;
  const handle = set(env.ORCA_TERMINAL_HANDLE);
  return { member, wt: set(env.DS_WT), gen: set(env.DS_GEN), handle, via: member ? "member" : handle ? "handle" : null };
}

/** What the loop hands the backend adapter for a Claude start (actuator call(), fulfil/studio.ts): the adapter
 *  writes DS_MEMBER, DS_WT and DS_GEN from these onto the terminal's launch line (bin/backend/orca.ts
 *  claudeTab, resumeTab). Their own names, so an adapter run from inside a role terminal (a test, a script)
 *  never passes that terminal's DS_MEMBER on to a tab it opens. */
export const startIdentity = (member: string, gen: string): Record<string, string> => ({ DS_START_MEMBER: member, DS_START_GEN: gen });

/** The identity a request filed by this process carries in its payload (dsLoopFront, loopFront), so the
 *  loop's replay of it (messages/replay.ts) runs as this member and generation. Empty when unknown. */
export function filerIdentity(env: Record<string, string | undefined> = process.env): { member?: string; gen?: string; wt?: string } {
  const me = whoAmI(env);
  return { ...(me.member ? { member: me.member } : {}), ...(me.gen ? { gen: me.gen } : {}), ...(me.wt ? { wt: me.wt } : {}) };
}

/** The environment a replay of a filed request runs with: the filer's identity back. */
export function identityEnv(r: { member?: string | null; gen?: string | null; wt?: string | null }): Record<string, string> {
  const env: Record<string, string> = {};
  if (r.member && parseMember(r.member)) env.DS_MEMBER = r.member;
  if (r.gen) env.DS_GEN = r.gen;
  if (r.wt) env.DS_WT = r.wt;
  return env;
}
