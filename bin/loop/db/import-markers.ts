// import-markers.ts — the sweep's marker files into `episodes` rows with source=sweep (Bun), so the
// loop never repeats a poke, alert or request the sweep already sent (R8, KTD13). The marker files
// are left in place (a rollback to the sweep reads them again). Ported from the removed sweep and
// bin/lib/accounts-refresh.sh at commit b3a2d95; every marker lives in state/<label>/sweep/:
//
//   <key>.poke      "<t> <episode> <n>"     poke_agent: n pokes this episode (-1 = the poke failed);
//                                            <key> may end in .quiet or .limit (the quiet / limit pokes)
//   <key>.park      "<t> <until> <ek>"      parked on a usage limit until <until>, episode cksum <ek>
//   <key>.switch    "<t> <episode>\n<file>" one switch request per episode; line 2 is the request file
//   <key>.req       "<t> <episode>"         one restart request per episode (handle)
//   <key>.alerted   "<episode>\n…"          one line per episode already alerted (alert)
//   <topic>.all-done "<t> <episode>"        the all-done poke of this episode
//   <topic>.<slug>.ready / .pending "<t> <episode>"  ready poke sent / deferred
//   compacted.tsv   "<wt>\t<t>"             last idle compaction per worker
//   limited.json    [{wt, who, topic, line, since, wait_until?, switching?}]
//   $STATE_ROOT/.accounts.episodes "<wt>|<notice>\t<until>\t<agent>\t<account>" (host-wide, project '')
// Every marker file is also kept verbatim in observed_markers (path, mtime, body).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { FactRow, Row, Store } from "../core/store.ts";
import { discoverProjects } from "../settings/projects.ts";
import { mtime, num } from "./import-json.ts";

export const MARKER_KINDS = ["poke", "park", "switch", "req", "alerted", "all-done", "ready", "pending"] as const;

function words(line: string): string[] {
  // "<t> <episode> <n>": the episode may hold spaces (a limit notice), so t is the first word and,
  // for .poke, n the last; the episode is what lies between.
  const sp = line.indexOf(" ");
  return sp < 0 ? [line] : [line.slice(0, sp), line.slice(sp + 1)];
}

// One marker file -> its episodes row (pure). null for a file that is not a marker.
export function markerRow(project: string, file: string, body: string, at: number): FactRow | null {
  const kind = MARKER_KINDS.find((k) => file.endsWith(`.${k}`));
  if (!kind) return null;
  const subject = file.slice(0, -(kind.length + 1));
  // <topic>.<role…>; the Studio's are studio.*; the runaway-unit alerts are unit-tokens.<topic>.<unit>.
  const seg = subject.split(".");
  const first = seg[0] === "unit-tokens" ? seg[1] : seg[0];
  const squad = first === "studio" || !first ? null : first;
  const lines = body.split("\n").filter((l) => l !== "");
  const set: Row = { squad, started_at: null, ended_at: null, count: 1, state: null, episode_key: null, source: "sweep", observed_at: at };
  const [t, rest = ""] = words(lines[0] ?? "");
  switch (kind) {
    case "poke": {
      const sp = rest.lastIndexOf(" ");
      const n = num(sp < 0 ? undefined : rest.slice(sp + 1));
      Object.assign(set, { started_at: num(t), episode_key: sp < 0 ? rest : rest.slice(0, sp), count: n, state: n === -1 ? "failed" : "poked" });
      break;
    }
    case "park": {
      const [until, ek = ""] = words(rest);
      Object.assign(set, { started_at: num(t), ended_at: num(until), episode_key: ek, state: "parked" });
      break;
    }
    case "switch":
      Object.assign(set, { started_at: num(t), episode_key: rest, state: lines[1] ? `request ${lines[1]}` : "requested" });
      break;
    case "alerted":
      Object.assign(set, { started_at: at, episode_key: lines[lines.length - 1] ?? "", count: lines.length, state: JSON.stringify(lines) });
      break;
    default: // req, all-done, ready, pending: "<t> <episode>"
      Object.assign(set, { started_at: num(t), episode_key: rest, state: kind === "pending" ? "deferred" : "sent" });
  }
  return { table: "episodes", key: { project, subject, kind }, set };
}

function read(p: string): string { try { return readFileSync(p, "utf8"); } catch { return ""; } }

export function markerRows(root: string, project: string): FactRow[] {
  const dir = join(root, project, "sweep"), rows: FactRow[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).sort(); } catch { return rows; }
  for (const f of files) {
    const p = join(dir, f), at = mtime(p);
    let body: string;
    if (f === "compacted.tsv") {
      body = read(p);
      for (const l of body.split("\n")) {
        const [wt, t] = l.split("\t");
        if (!wt) continue;
        rows.push({ table: "episodes", key: { project, subject: wt, kind: "compacted" }, set: { squad: null, started_at: num(t), ended_at: null,
          count: 1, state: "compacted", episode_key: null, source: "sweep", observed_at: at } });
      }
    } else if (f === "limited.json") {
      body = read(p);
      let list: Row[] = [];
      try { list = JSON.parse(body); } catch { /* a torn file: the loop re-derives it */ }
      for (const e of Array.isArray(list) ? list : []) {
        if (!e.wt) continue;
        rows.push({ table: "episodes", key: { project, subject: String(e.wt), kind: "limited" }, set: { squad: (e.topic as string) || null,
          started_at: num(String(e.since ?? "")), ended_at: num(String(e.wait_until ?? "")), count: 1,
          state: e.switching ? "switching" : e.wait_until ? "parked" : "limited", episode_key: (e.line as string) ?? null, source: "sweep", observed_at: at } });
      }
    } else {
      body = read(p);
      const r = markerRow(project, f, body, at);
      if (!r) continue;
      rows.push(r);
    }
    rows.push({ table: "observed_markers", key: { project, path: relative(root, p) }, set: { mtime: at, body, observed_at: at } });
  }
  return rows;
}

export function accountEpisodeRows(root: string): FactRow[] {
  const p = join(root, ".accounts.episodes");
  if (!existsSync(p)) return [];
  const at = mtime(p), body = read(p), rows: FactRow[] = [];
  for (const l of body.split("\n")) {
    const [k, until, agent, acct] = l.split("\t");
    if (!k) continue;
    const bar = k.indexOf("|");
    rows.push({ table: "episodes", key: { project: "", subject: k, kind: "account" }, set: { squad: null, started_at: null,
      ended_at: num(until), count: 1, state: `${agent ?? ""}/${acct ?? ""}`, episode_key: bar < 0 ? k : k.slice(bar + 1), source: "sweep", observed_at: at } });
  }
  rows.push({ table: "observed_markers", key: { project: "", path: ".accounts.episodes" }, set: { mtime: at, body, observed_at: at } });
  return rows;
}

export function importMarkers(store: Store, root = store.root): number {
  return store.tx(() => {
    let n = 0;
    const rows = [...accountEpisodeRows(root), ...discoverProjects(root).flatMap((p) => markerRows(root, p))];
    for (const r of rows) {
      if (r.table === "episodes" && r.key.kind === "limited" && store.get(r.table, r.key)?.source === "loop") continue;
      n += store.upsert(r.table, r.key, r.set) ? 1 : 0;
    }
    return n;
  });
}
