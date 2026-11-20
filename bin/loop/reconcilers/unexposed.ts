// unexposed.ts — tell a member once about ports it listens on that no `ds expose` entry covers
// (exposed-cleanup U3). Per open squad of the project, the ports `unexposedPorts` keeps (listened on for
// expose_warn_min minutes, 0 = off) minus the ones already named to that member go out as one message row
// (bin/loop/messages/messages.ts) from `loop`, no reply needed; the messages reconciler pokes the member as
// for any message. "Already named" is one episodes row per member, kind `warned`, subject
// `unexposed:<member id>` (`unexposed:lead:<squad id>` for a Lead with no members row), state the JSON
// array of ports named so far, so a port is never named twice to the same member (one members row per worktree,
// kept across restarts); a new member on another worktree has a new id and is told once again. The message key `unexposed:<subject>:<ports>` makes a replay the same row.
import type { Reconciler } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { limitInt } from "../settings/limits.ts";
import { sendMessage } from "../messages/messages.ts";
import { unexposedPorts, warnBody, warnSubject, type Unexposed } from "../squad/unexposed.ts";

const unexposed: Reconciler = {
  name: "unexposed",
  run({ store, project, now }) {
    const warnMin = limitInt(store, project, "expose_warn_min", 5);
    if (warnMin <= 0) return;
    const squads = store.db.query(`SELECT topic FROM squads WHERE project = ? AND COALESCE(status, '') NOT IN ('closed', 'gone', 'done')
      AND COALESCE(want, '') != 'gone' ORDER BY id`).all(project) as { topic: string }[];
    for (const { topic: squad } of squads) {
      const by = new Map<string, Unexposed[]>();
      for (const u of unexposedPorts(store.db, project, squad, now, warnMin)) {
        const k = warnSubject(u);
        by.set(k, [...(by.get(k) ?? []), u]);
      }
      for (const [subject, items] of by) {
        const marker = store.get("episodes", { project, subject, kind: "warned" }) as Row | null;
        let named: number[] = [];
        try { named = (JSON.parse(String(marker?.state ?? "[]")) as unknown[]).map(Number); } catch { /* unreadable: none named */ }
        const fresh = items.filter((u) => !named.includes(u.port)).sort((a, b) => a.port - b.port);
        if (!fresh.length) continue;
        const { role, suffix } = fresh[0], ports = fresh.map((u) => u.port);
        store.tx(() => {
          sendMessage(store, {
            to: { project, squad, role, suffix }, from: { project, squad, role: "loop", suffix: "", member: null },
            subject: `Not exposed: port${ports.length > 1 ? "s" : ""} ${ports.join(", ")}`, body: warnBody(squad, role, fresh, warnMin),
            key: `${subject}:${ports.join(",")}`,
          }, now);
          store.upsert("episodes", { project, subject, kind: "warned" }, { squad, state: JSON.stringify([...named, ...ports].sort((a, b) => a - b)),
            started_at: marker?.started_at ?? now, source: "loop", observed_at: now });
        });
      }
    }
  },
};
export default unexposed;
