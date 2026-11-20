// ds directory-ts — the phone book (U222): what bin/lib/directory.sh runs. Same arguments, output and exit codes.
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { stateRoot, dsLabel, dsPrefix, chomp, readJson, globJson, backend as realBackend, type Ran, writeOut as realOut, writeErr as realErr } from "../lib/shared";

export const help = `list [--project <label>] [--from <squad>] [--json] | reach|check <squad> <role[-suffix]> [--project <label>] — the phone book (directory.sh)`;

const USAGE = `usage: directory.sh list  [--project <label>] [--from <squad>] [--json]
       directory.sh reach <squad> <role[-suffix]> [--project <label>] [--from <squad>]
       directory.sh check <squad> <role[-suffix]> [--project <label>]
`;

const US = "\u001f", RS = "\u001e";

type Member = { role: string; suffix: string; wt: string };

function notRunningReason(doc: any): string {
  const st = doc && typeof doc === "object" && !Array.isArray(doc) ? doc.status : undefined;
  const s = st === null || st === undefined || st === false ? "running" : String(st);
  if (s === "closed") return "squad closed";
  if (s === "suspended") return "squad suspended";
  if (s === "failed") return "squad spawn failed";
  return "";
}

function str(v: unknown): string {
  return v === null || v === undefined || v === false ? "" : String(v);
}

function membersOf(doc: any): Member[] {
  const m = doc && typeof doc === "object" ? doc.members : undefined;
  if (!Array.isArray(m)) return [];
  return m.map((x: any) => ({ role: str(x?.role), suffix: str(x?.suffix), wt: str(x?.wt) }));
}

function runIdOf(doc: any): string {
  return doc && typeof doc === "object" ? str(doc.run_id) : "";
}

function hasWt(doc: any, wt: string): boolean {
  const m = doc && typeof doc === "object" ? doc.members : undefined;
  return Array.isArray(m) && m.some((x: any) => x?.wt === wt);
}

/** What the phone book reads and writes through: the real process (`run`), or the loop's own (U248: its Orca
 *  observer asks for a list as a function, with the backend's reads in process and the output collected). */
export type DirIo = { stateRoot: string; backend: (args: string[]) => Promise<Ran>; out: (s: string) => void; err: (s: string) => void };

export const run = (argv: string[]): Promise<number> =>
  runWith({ stateRoot: stateRoot(), backend: realBackend, out: realOut, err: realErr }, argv);

export async function runWith(io: DirIo, argv: string[]): Promise<number> {
  const STATE_ROOT = io.stateRoot, backend = io.backend, writeOut = io.out, writeErr = io.err;
  const usage = (): number => { writeErr(USAGE); return 2; };

  const OP = argv[0] ?? "";
  const rest = argv.slice(1);
  let PROJECT = "", FROM = "", FROM_SET = false, JSON_OUT = false;
  const ARGS: string[] = [];
  for (let i = 0; i < rest.length;) {
    const a = rest[i];
    if (a === "--project") { PROJECT = rest[i + 1] ?? ""; i += 2; }
    else if (a === "--from") { FROM = rest[i + 1] ?? ""; FROM_SET = true; i += 2; }
    else if (a === "--json") { JSON_OUT = true; i++; }
    else if (a === "-h" || a === "--help") return usage();
    else { ARGS.push(a); i++; }
  }
  if (!["list", "reach", "check"].includes(OP)) return usage();

  // list --project: the backend reads start at once, beside `current`.
  const pre = new Map<string, Promise<Ran>>();
  let termsP: Promise<Ran> | null = null;
  if (OP === "list" && PROJECT) {
    termsP = backend(["wt-terminals"]);
    for (const f of globJson(join(STATE_ROOT, dsLabel(PROJECT), "squads"))) {
      const doc = readJson(f);
      if (notRunningReason(doc)) continue;
      const run = runIdOf(doc);
      if (run && !pre.has(run)) pre.set(run, backend(["worker-detail", run]));
    }
  }

  let CUR = "";
  if (!(OP === "check" && PROJECT)) CUR = chomp((await backend(["current"])).out);

  let LABEL = "";
  if (PROJECT) LABEL = dsLabel(PROJECT);
  else {
    let only = "", n = 0;
    let dirs: string[] = [];
    try { dirs = readdirSync(STATE_ROOT).sort(); } catch { /* no state root */ }
    for (const d of dirs) {
      const sq = join(STATE_ROOT, d, "squads");
      const files = globJson(sq);
      if (!files.length) continue;
      n++; only = d;
      if (CUR) {
        const docs = files.map(readJson);
        if (docs.every((x) => x !== undefined) && docs.some((x) => hasWt(x, CUR))) { LABEL = only; break; }
      }
    }
    if (!LABEL && n === 1) LABEL = only;
    if (!LABEL) { writeErr("directory: can't tell the project — pass --project <label>\n"); return 2; }
  }
  const DIR = join(STATE_ROOT, LABEL, "squads");
  const ARCH = join(STATE_ROOT, LABEL, "archive");

  if (!FROM_SET && CUR && existsSync(DIR)) {
    for (const f of globJson(DIR)) {
      if (hasWt(readJson(f), CUR)) { FROM = basename(f, ".json"); break; }
    }
    if (!FROM) {
      const nm = CUR.slice(CUR.lastIndexOf("/") + 1);
      const pfx = dsPrefix() + LABEL + "-";
      const restName = nm.startsWith(pfx) ? nm.slice(pfx.length) : nm;
      if (restName !== nm && /^(lead|thinker|builder|reviewer|tester|researcher)-/.test(restName)) {
        for (const f of globJson(DIR)) {
          const t = basename(f, ".json");
          if (restName.endsWith("-" + t) && t.length > FROM.length) FROM = t;
        }
      }
    }
  }

  // Live terminals, fetched once; a failed fetch = blind (liveness unknown), an empty success = none.
  let TERMS: string[] = [], BLIND = false, termsLoaded = false;
  const termsLoad = async () => {
    if (termsLoaded) return;
    termsLoaded = true;
    const r = await (termsP ?? backend(["wt-terminals"]));
    if (r.rc !== 0) { BLIND = true; TERMS = []; }
    else TERMS = chomp(r.out).split("\n");
  };
  const hasTerm = (wt: string) => !!wt && TERMS.includes(wt);

  // Live handles per run: "<run>\t<wt>\t<handle>" rows, newest first.
  const details: { run: string; wt: string; handle: string }[] = [];
  const seen = new Set<string>();
  const detailLoad = async (run: string) => {
    if (!run || seen.has(run)) return;
    seen.add(run);
    const r = await (pre.get(run) ?? backend(["worker-detail", run]));
    for (const line of r.out.split("\n")) {
      const f = line.split("\t");
      if (f.length >= 2) details.push({ run, wt: f[0], handle: f[1] });
    }
  };
  const termsOf = (run: string, wt: string) =>
    details.filter((d) => d.run === run && d.wt === wt).map((d) => d.handle).join(RS);

  type Row = string[];
  const row = (f: string, role: string, suf: string, wt: string, run: string, reason: string): Row => {
    const squad = basename(f, ".json");
    const name = role + (suf ? "-" + suf : "");
    let live = "no";
    if (!reason) { if (BLIND) live = "unknown"; else if (hasTerm(wt)) live = "yes"; }
    let kind: string, addr: string;
    if (role === "lead") { kind = "run"; addr = run; }
    else if (FROM && FROM === squad) { kind = "worktree"; addr = wt; }
    else { kind = "worktree-run"; addr = wt; }
    let send: string;
    if (FROM && FROM === squad) {
      send = kind === "run" ? `orch.sh send ${run} "<subject>" "<body>"` : `orch.sh send-worker ${wt} "<subject>" "<body>"`;
    } else send = `send-peer.sh ${squad} ${name} "<subject>" "<body>"`;
    return [squad, role, suf, name, wt, live, kind, addr, run, reason, send, termsOf(run, wt)];
  };

  if (OP === "list") {
    const rows: Row[] = [];
    if (existsSync(DIR)) {
      for (const f of globJson(DIR)) {
        const doc = readJson(f);
        const reason = notRunningReason(doc);
        if (!reason) { await termsLoad(); await detailLoad(runIdOf(doc)); }
        const frun = runIdOf(doc);
        for (const m of membersOf(doc)) {
          if (!m.role) continue;
          rows.push(row(f, m.role, m.suffix, m.wt, frun, reason));
        }
      }
    }
    if (JSON_OUT) {
      const objs = rows.map((r) => ({
        squad: r[0], role: r[1], suffix: r[2], name: r[3], wt: r[4],
        live: r[5] === "unknown" ? null : r[5] === "yes", kind: r[6],
        address: r[7] === "-" || r[7] === "" ? null : r[7],
        run_id: r[8], reason: r[9] === "" ? null : r[9], send: r[10],
        terminals: r[11] === "" ? [] : r[11].split(RS),
      }));
      writeOut(JSON.stringify(objs, null, 2) + "\n");
    } else {
      if (!rows.length) { writeOut(`directory: no squads for '${LABEL}'\n`); return 0; }
      let out = `PHONE BOOK — ${LABEL}${FROM ? `   (you: ${FROM})` : ""}\n`;
      for (const r of rows) {
        const [squad, , , name, wt, live, , , , reason, send] = r;
        let st: string;
        if (reason) st = `not running (${reason})`;
        else if (live === "yes") st = "live";
        else if (live === "unknown") st = "unknown (backend wt-terminals failed)";
        else st = "not running";
        out += `  ${squad.padEnd(24)} ${name.padEnd(22)} ${st}\n      wt:    ${wt}\n      reach: ${send}\n`;
      }
      writeOut(out);
    }
    return 0;
  }

  // reach | check
  if (ARGS.length !== 2) return usage();
  const [squad, want] = ARGS;
  const f = join(DIR, squad + ".json");
  if (!existsSync(f)) {
    let archived = false;
    try {
      const re = new RegExp("^" + squad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-\\d{8}-\\d{6}\\.json$");
      archived = readdirSync(ARCH).some((x) => re.test(x));
    } catch { /* no archive */ }
    writeErr(archived
      ? `directory: squad '${squad}' is closed (archived) — nothing to reach\n`
      : `directory: no squad '${squad}' in '${LABEL}'\n`);
    return 2;
  }
  const doc = readJson(f);
  const reason = notRunningReason(doc);
  if (reason) { writeErr(`directory: ${squad} — ${reason}; nothing to reach\n`); return 2; }
  if (OP !== "check") await termsLoad();
  let hit: Row | null = null;
  for (const m of membersOf(doc)) {
    if (!m.role) continue;
    if (m.role + (m.suffix ? "-" + m.suffix : "") !== want) continue;
    hit = row(f, m.role, m.suffix, m.wt, runIdOf(doc), "");
    break;
  }
  if (!hit) { writeErr(`directory: no member '${want}' in squad '${squad}'\n`); return 2; }
  if (OP === "check") return 0;
  const [, , , , wt, live, kind, addr, runId] = hit;
  if (kind !== "run" && live === "unknown") {
    writeOut(`${kind}\t${addr}\t${runId}\t${wt}\n`);
    writeErr(`directory: can't see live terminals (backend wt-terminals failed) — ${squad}/${want} liveness unknown; address printed, the send receipt judges\n`);
    return 4;
  }
  if (kind !== "run" && live !== "yes") {
    writeErr(`directory: ${squad}/${want} is not running (no live terminal) — ask your Lead\n`);
    return 3;
  }
  writeOut(`${kind}\t${addr}\t${runId}\t${wt}\n`);
  return 0;
}
