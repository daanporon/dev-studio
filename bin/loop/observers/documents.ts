// documents.ts — the documents observer (U4): a project's plans and brainstorms (squads/*.md),
// journals/*.md, cross-squad.md and its closed squads (archive/*.json and *.md) into
// `documents` rows (path, mtime, body). A file is re-read only when its mtime or size moved; a
// vanished file drops its row.
import { join, relative } from "node:path";
import { Gate, sig } from "../core/gate.ts";
import { documentFiles, documentRow } from "../db/import-json.ts";
import type { Observer } from "../core/plugins.ts";

export function documentsObserver(): Observer {
  const gate = new Gate();
  return {
    name: "documents",
    run({ store, project, now }) {
      const files = documentFiles(store.root, project);
      // One transaction per file: a read that throws rolls back only its own row, never one the gate
      // already counts as read.
      for (const f of files) {
        store.tx(() => gate.run(f, sig(f), () => { const r = documentRow(store.root, project, f); store.upsert(r.table, r.key, r.set); }));
      }
      store.tx(() => {
        gate.keep(files, `${join(store.root, project)}/`);
        const kept = JSON.stringify(files.map((f) => relative(store.root, f)));
        store.db.run("UPDATE documents SET observed_at = ? WHERE project = ? AND path IN (SELECT value FROM json_each(?))", [now, project, kept]);
        store.db.run("DELETE FROM documents WHERE project = ? AND path NOT IN (SELECT value FROM json_each(?))", [project, kept]);
      });
    },
  };
}

export default documentsObserver();
