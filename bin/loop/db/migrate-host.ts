// migrate-host.ts — import each project's existing state into loop.db once.
// The migrated mark is written last, so a crash can be safely retried. A final pass
// recovers writes made by agents during the initial import. Later installs retain
// stored state, while an explicit reconcile mark permits recovery of file writes
// from a changed checkout. Runtime files move to loop/ without deleting their source.
// Historical imports and pinned-revision recovery remain supported until the JSON
// compatibility backend is retired.
//
// DS_SWITCH_CRASH=<step> (tests only) dies after that step: json, markers, config, boards, import, mark-tmp.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportedMs, reimportSquad, writtenElsewhere } from "./export-json.ts";
import { importConfig } from "./import-config.ts";
import { importJson } from "./import-json.ts";
import { importMarkers } from "./import-markers.ts";
import { discoverProjects } from "../settings/projects.ts";
import { giveUpQueued } from "../messages/replay.ts";
import { now, open, stateRoot, type Row, type Store } from "../core/store.ts";
import { RECONCILE } from "./reconcile-mark.ts";
import { migrateSettings } from "../settings/settings-migrate.ts";

type Squad = { project: string; topic: string };

function crash(step: string): void {
  if (process.env.DS_SWITCH_CRASH === step) { console.error(`migrate: crash injected after ${step}`); process.exit(9); }
}

// A project's board-serve.want (`<label>\t<topic>\t<port>`) -> its services wish, as `ds want board`
// makes it. A wish this install made (want_by) follows the file, for what a rollback's board.sh did: a
// file that went is a stop, another port is taken, a wish given up is asked again. Any other wish is left alone, so an install never
// undoes a later `ds want board --stop`. A file that says nothing usable changes nothing.
function importBoardWants(store: Store, root: string): number {
  let n = 0;
  const id = (project: string, topic: string) => ["board", project, topic].filter(Boolean).join("/");
  const wants = new Map<string, { topic: string; port: number } | null>();
  for (const project of discoverProjects(root)) {
    let line: string;
    try { line = readFileSync(join(root, project, "board-serve.want"), "utf8"); } catch { continue; }
    const [, topic = "", port] = line.split("\n")[0].split("\t");
    if (/^\d{1,5}$/.test(port ?? "")) wants.set(project, { topic, port: Number(port) });
    else { wants.set(project, null); console.error(`migrate: skipped ${project}/board-serve.want: no port`); }
  }
  const mine = store.db.query("SELECT project, topic FROM services WHERE name = 'board' AND want = 'running' AND want_by = 'install'").all() as Squad[];
  for (const s of mine) {
    const w = wants.get(s.project);
    if (w === null || (w && w.topic === (s.topic ?? ""))) continue;
    store.want("service", id(s.project, s.topic), "stopped", { by: "install" });
    n++;
  }
  for (const [project, w] of wants) {
    if (!w) continue;
    const row = store.db.query("SELECT want, want_by, want_result, port FROM services WHERE name = 'board' AND project = ? AND topic = ?").get(project, w.topic) as Row | null;
    const met = row?.want === "running" && Number(row.port) === w.port && !String(row.want_result ?? "").startsWith("failed");
    if (row && (row.want_by !== "install" || met)) continue;
    store.want("service", id(project, w.topic), "running", { payload: { port: w.port }, fill: { port: w.port }, by: "install" });
    n++;
  }
  return n;
}

const squadFile = (root: string, s: Squad) => join(root, s.project, "squads", `${s.topic}.json`);
function squadsOnDisk(root: string): Squad[] {
  return discoverProjects(root).flatMap((project) => {
    try { return readdirSync(join(root, project, "squads")).filter((f) => f.endsWith(".json")).sort().map((f) => ({ project, topic: f.slice(0, -5) })); } catch { return []; }
  });
}

// The first run, in one transaction. Each file counts as exported as it stood before it was read.
function importAll(store: Store, root: string, at: (step: string) => void): Row {
  return store.tx(() => {
    const out: Row = {};
    const seen = squadsOnDisk(root).map((s) => ({ ...s, ms: statSync(squadFile(root, s), { throwIfNoEntry: false })?.mtimeMs }));
    out.json = importJson(store, root); at("json");
    out.markers = importMarkers(store, root); at("markers");
    out.config = importConfig(store, root); at("config");
    out.boards = importBoardWants(store, root); at("boards");
    for (const s of seen) if (s.ms !== undefined) exportedMs(store, s.project, s.topic, squadFile(root, s), Math.floor(s.ms));
    store.event("host_migrated", { payload: out });
    return out;
  });
}

// What was written after the import or the rollback, each squad in its own right.
function importChanged(store: Store, root: string): { reimported: string[]; closed: string[]; boards: number; givenUp: string[] } {
  return store.tx(() => {
    const out = { reimported: [] as string[], closed: [] as string[], boards: 0, givenUp: [] as string[] };
    for (const s of squadsOnDisk(root).filter((x) => writtenElsewhere(store, x.project, x.topic, squadFile(root, x)))) {
      if (reimportSquad(store, root, s.project, s.topic, (m) => console.error(`migrate: skipped ${m}`))) out.reimported.push(`${s.project}/${s.topic}`);
    }
    const live = store.db.query("SELECT project, topic FROM squads WHERE exported_ms IS NOT NULL AND COALESCE(status, '') != 'closed'").all() as Squad[];
    for (const s of live.filter((x) => !existsSync(squadFile(root, x)))) {
      store.db.run("UPDATE squads SET status = 'closed' WHERE project = ? AND topic = ?", [s.project, s.topic]);
      store.event("squad_reimported", { project: s.project, squad: s.topic, payload: { closed: "its file went while the sweep ran" } });
      out.closed.push(`${s.project}/${s.topic}`);
    }
    out.boards = importBoardWants(store, root);
    const exit = store.db.query("SELECT max(at) AS at FROM events WHERE kind = 'loop_exit'").get() as { at: number | null };
    if (exit.at != null) out.givenUp = giveUpQueued(store, exit.at).map((q) => `${q.project}/${q.squad ?? "-"}: ${q.what}`);
    return out;
  });
}

// `at` is called after each named step: the crash injection, or a test's write under the migration.
export function migrate(root: string, at: (step: string) => void = crash): void {
  const mark = join(root, ".loop-migrated");
  mkdirSync(root, { recursive: true });
  migrateLoopFiles(root);
  const store = open(root);
  const again = (out: ReturnType<typeof importChanged>) => out.reimported.length || out.closed.length || out.boards || out.givenUp.length ? `imported again ${JSON.stringify(out)}` : "nothing to import";
  if (existsSync(mark)) {
    console.log(`migrate: on the loop already; ${again(importChanged(store, root))}`);
  } else {
    const out = importAll(store, root, at);
    at("import");
    writeFileSync(`${mark}.tmp`, `${new Date(now() * 1000).toISOString()}\n`);
    at("mark-tmp");
    renameSync(`${mark}.tmp`, mark);
    console.log(`migrate: imported ${JSON.stringify(out)}; wrote ${mark}`);
    // From here every script writes through the store, so a write under the import is seen now, or in the
    // pass bin/host/install.sh runs after the swap of the crontab lines, or in the loop's own.
    console.log(`migrate: written during the import: ${again(importChanged(store, root))}`);
  }
  // The settings cut-over (U256): once, outside every transaction, after the config rows exist.
  const settings = migrateSettings(store, root);
  if (settings?.length) console.log(`migrate: settings cut over: ${JSON.stringify(settings)}`);
  rmSync(join(root, RECONCILE), { force: true });
  store.close();
}

// Runtime files used by the loop survive removal of the old marker directories.
// Copy only absent destinations; a rerun must keep newer loop data and the host backup source.
export function migrateLoopFiles(root: string): void {
  for (const project of discoverProjects(root)) {
    for (const name of ["limited.json", "squad-spent.tsv"]) {
      const from = join(root, project, "sweep", name), to = join(root, project, "loop", name);
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(join(root, project, "loop"), { recursive: true });
      const tmp = `${to}.${process.pid}.tmp`;
      try {
        copyFileSync(from, tmp);
        // Publish a complete file atomically without replacing a concurrent loop write.
        try { linkSync(tmp, to); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      } finally { rmSync(tmp, { force: true }); }
    }
  }
}

// A changed checkout's first act: recover file writes before any action uses the rows.
export function reconcile(root: string): boolean {
  if (!existsSync(join(root, RECONCILE))) return true;
  const store = open(root);
  try {
    console.log(`loop: looked for writes the rows lack: ${JSON.stringify(importChanged(store, root))}`);
    rmSync(join(root, RECONCILE), { force: true });
  } finally { store.close(); }
  return true;
}

if (import.meta.main) migrate(stateRoot());
