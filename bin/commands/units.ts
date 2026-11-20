// ds units — a squad's units as the squad file has them, or with --ready the slugs
// `squad-state.sh ready-units` prints: planned, not held, not waiting, every dep satisfied and every
// ext dep done (in its live squad, or in an archived one: closed-done).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { now, open, type Row, type Store } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { squadDoc } from "../loop/db/export-json.ts";
import { slotted } from "../loop/reconcilers/ready.ts";
import { blockingForUnit, entryOf, waiting } from "../loop/messages/questions.ts";

export const help = "<project> <squad> [--ready] — the squad's units (JSON), or the slugs ready to dispatch";

// squad-state.sh ext_status: done in the live squad -> done; else done in an archive of that squad
// (<label>/archive/<squad>-<ts>.json, matched by .topic or by the file name) -> closed-done.
function extDone(store: Store, project: string, ref: string): boolean {
  const i = ref.indexOf("/"), squad = i < 0 ? ref : ref.slice(0, i), slug = i < 0 ? "" : ref.slice(i + 1);
  const live = store.db.query("SELECT status FROM units WHERE project = ? AND squad = ? AND slug = ?").get(project, squad, slug) as { status: string } | null;
  if (live?.status === "done") return true;
  const dir = join(store.root, project, "archive");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.startsWith(`${squad}-`) && f.endsWith(".json")); } catch { return false; }
  return files.some((f) => {
    try {
      const a = JSON.parse(readFileSync(join(dir, f), "utf8")) as Row;
      const topic = (a.topic as string) ?? "";
      const mine = topic === squad || (topic === "" && /^\d{8}-\d{6}\.json$/.test(f.slice(squad.length + 1)));
      return mine && ((a.units as Row[]) ?? []).some((u) => u.slug === slug && u.status === "done");
    } catch { return false; }
  });
}

export function readyUnits(store: Store, project: string, units: Row[], questions: unknown[] = [], squad = ""): string[] {
  const bySlug = new Map(units.map((u) => [u.slug as string, u]));
  // satisfied(dep, self): done; or cancelled into self, into a PR that merged, or (chased, 10 hops) into a done unit.
  const satisfied = (dep: string, self: string): boolean => {
    let t = dep;
    for (let n = 0; n <= 10; n++) {
      const hit = bySlug.get(t);
      if (!hit) return false;
      if (hit.status === "done") return true;
      if (hit.status !== "cancelled") return false;
      const into = (hit.superseded_by as string) ?? "";
      if (into === "") return false;
      if (into === self) return true;
      if (into.startsWith("PR#")) return hit.into_merged === true;
      t = into;
    }
    return false;
  };
  const t = now(), given = slotted(store, project, t);   // max_builders (U146): only the next unit is ready
  const ext = new Map<string, boolean>();
  const done = (ref: string) => { if (!ext.has(ref)) ext.set(ref, extDone(store, project, ref)); return ext.get(ref)!; };
  return units.filter((u) => u.status === "planned" && !u.hold
    && !blockingForUnit(questions, u.slug as string)
    && ((u.deps as string[]) ?? []).every((d) => satisfied(d, u.slug as string))
    && ((u.ext_deps as string[]) ?? []).every(done)
    && Number(u.wait_until ?? 0) <= t
    && (!given || given.has(`${squad}\0${u.slug}`))).map((u) => u.slug as string);
}

export async function run(args: string[]): Promise<number> {
  const { pos, flag } = parse(args, [], ["ready"]);
  if (pos.length !== 2) { console.error(`usage: ds units ${help}`); return 2; }
  const s = open();
  try {
    const doc = squadDoc(s, pos[0], pos[1]);
    if (!doc) { console.error(`ds units: no squad ${pos[0]}/${pos[1]}`); return 1; }
    const units = (doc.units as Row[]) ?? [];
    print(flag.has("ready") ? readyUnits(s, pos[0], units, waiting(s, pos[0], pos[1]).map(entryOf), pos[1]) : units);
    return 0;
  } finally { s.close(); }
}
