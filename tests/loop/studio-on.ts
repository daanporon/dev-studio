// studio-on.ts — U54 (project-start): a project keeps one backend for its Studio and squads, so a rig that starts
// squads off Orca on the fixture project (whose Studio runs on Orca) puts that Studio on the rig's backend too.
import type { Store } from "../../bin/loop/core/store.ts";

export function studioOn(s: Store, project: string, backend: string, at: number): void {
  const row = s.get("projects", { label: project });
  if (!row?.studio_wt) return;
  const doc = JSON.parse(String(row.doc ?? "{}"));
  if (backend === "orca") delete doc.studio_backend; else doc.studio_backend = backend;
  s.upsert("projects", { label: project }, { doc: JSON.stringify(doc), observed_at: at });
}
