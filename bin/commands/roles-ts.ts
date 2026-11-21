// ds roles-ts — view and configure the squad role roster (U263): what bin/commands/roles.sh runs. The default
// roster is conventions/roles.conf; a project's own rows (U267: one per edited role) are its roles.conf rows in
// loop.db, changed through bin/loop/settings/settings.ts (U256), which checks the row against the model catalog.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dsLabel, run as runCmd, writeErr, writeOut } from "../lib/shared";
import { awkRow, confLines, readFields, rosterLines } from "../lib/operator";
import { ownText } from "../lib/settings-rows.ts";
import { reset, rm, set } from "../loop/settings/settings.ts";
import { changeSettings } from "../loop/settings/settings-migrate.ts";
import { resolveBackUp, returnOf, type BackUp } from "../loop/settings/roster.ts";

export const help = `list [--json] [<project>] | set <project> <role> <agent> <model> … | rm | reset — view or configure the role roster (roles.sh)`;

const USAGE = "usage: roles.sh list [--json] [<project>] | reset <project> <role> | set <project> <role> <agent> <model> [always|ondemand|elevate] [effort] [fallbacks] [plan] [up|stay] | rm <project> <role>\n";
const DEFAULT = (): string => join(ROOT, "conventions", "roles.conf");
const text = (f: string): string => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
/** The project's own roster rows as conf text; "" without a project. */
const ownRoster = (proj: string): string => (proj ? ownText(dsLabel(proj), "roles.conf") : "");
/** The project's effective roster as conf text (U267): its own rows over the default's, per role. */
const effectiveText = (proj: string): string => rosterLines(ownRoster(proj), text(DEFAULT())).map((l) => l + "\n").join("");
const pad = (s: string, n: number): string => s.padEnd(n);

/** `read -r name agent model spawn effort fb plan return _` of one roster line. */
const row = (l: string): string[] => readFields(l, 9);

/** awk's norm(): the role's row as `name agent model spawn effort fb plan return` with `-` for an empty effort, fallbacks, plan or return. */
function norm(role: string, conf: string): string {
  const f = awkRow(conf, role);
  if (!f) return "";
  const d = (v: string | undefined): string => (v === undefined || v === "" ? "-" : v);
  return [f[0], f[1] ?? "", f[2] ?? "", f[3] ?? "", d(f[4]), d(f[5]), d(f[6]), d(f[7])].join(" ");
}

/** A conf text's rows as name -> value (the words after the name). */
const rowMap = (conf: string): Map<string, string> =>
  new Map(confLines(conf).map((l): [string, string] => { const f = l.split(/[ \t]+/).filter((w) => w !== ""); return [f[0] ?? "", f.slice(1).join(" ")]; }));

/** configurable-role-elevation U1: the resolved move-back-up of a role (roster.ts resolveBackUp) for the
 *  project's own rows over the default's; with an empty `own`, the default's alone. */
const backUp = (role: string, own: string, dflt: string): BackUp => resolveBackUp(role, rowMap(own), rowMap(dflt));

/** The `back up` cell: `up`/`stay`, with where an inherited value came from; `-` where it never applies. */
function backUpCell(role: string, spawn: string, b: BackUp): string {
  if (role === "studio" || spawn === "elevate") return "-";
  return b.from === "row" ? b.value : `${b.value} (${b.from ?? "default"})`;
}

function museCatalog(): any[] {
  const dir = process.env.MUSE_MODEL_CATALOG_DIR || join(process.env.HOME ?? "", ".local", "share", "muse", "model-catalog");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const rows: Array<{ m: string; r: string; e: string[] }> = [];
  for (const f of files) {
    let j: any;
    try { j = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const rs = j?.rows ?? [];
    if (!Array.isArray(rs)) continue;
    for (const r of rs) {
      if (r?.visibility !== "visible" || typeof r.model_id !== "string" || r.model_id.endsWith("-contributor")) continue;
      const v = r.reasoning_effort_variants ?? [];
      rows.push({ m: r.model_id, r: r.release_date ?? "", e: (Array.isArray(v) ? v : []).map((x: any) => x?.tier).filter((t: unknown) => t !== null && t !== undefined) });
    }
  }
  const fam = (m: string): string => m.replace(/-[0-9]+(\.[0-9]+)?$/, "");
  const groups = new Map<string, typeof rows>();
  for (const r of rows) { const k = fam(r.m); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
  return [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => {
    const g = groups.get(k)!;
    const last = [...g].sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0)).pop()!;
    const a = fam(last.m);
    const label = "Muse · " + a.replace(/^muse-/, "").split("-").map((w) => (/^[0-9]/.test(w) ? w : w.slice(0, 1).toUpperCase() + w.slice(1))).join(" ");
    const efforts = [...order.filter((o) => last.e.includes(o)), ...last.e.filter((e) => !order.includes(e))];
    return { agent: "muse", model: a, label, efforts, custom: false };
  });
}

async function liveCatalog(): Promise<any[]> {
  const out = [...museCatalog()];
  const r = await runCmd([join(ROOT, "bin", "lib", "codex-models.sh")]);
  for (const l of r.out.split("\n")) { if (l.trim() === "") continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function run(argv: string[]): Promise<number> {
  const usage = (): number => { writeErr(USAGE); return 2; };
  const cmd = argv[0] ?? "list";
  let args = argv.slice(1);

  if (cmd === "list") {
    let json = false;
    if (args[0] === "--json") { json = true; args = args.slice(1); }
    const proj = args[0] ?? "";
    const hasOwn = ownRoster(proj).trim() !== "";
    const conf = effectiveText(proj), own = ownRoster(proj), dflt = text(DEFAULT());
    if (json) {
      const ownModels = proj ? ownText(dsLabel(proj), "models.conf") : "";
      const models = ownModels.trim() !== "" ? ownModels : text(join(ROOT, "conventions", "models.conf"));
      const dTxt = text(DEFAULT());
      const roles = confLines(conf).map((l) => {
        const [name, agent, model, spawn, effort0, fb0, plan0, ret0] = row(l);
        const clean = (v: string): string => (v === "-" ? "" : v);
        const d = norm(name, dTxt);
        const src = norm(name, conf) === d ? "default" : "override";
        const [, da, dm, ds, de, df, dp, dr] = readFields(d, 8);
        // `return`: the row's own column 8 ("" = inherit); `back_up`: the resolved setting (roster.ts).
        return { role: name, agent, model, spawn, effort: clean(effort0), fallbacks: clean(fb0), plan: clean(plan0),
          return: returnOf(`- - - - - - ${ret0 ?? ""}`), back_up: backUp(name, own, dTxt).back_up, source: src,
          default: da === "" ? null : { agent: da, model: dm, spawn: ds, effort: clean(de), fallbacks: clean(df), plan: clean(dp),
            return: returnOf(`- - - - - - ${dr ?? ""}`), back_up: backUp(name, "", dTxt).back_up } };
      });
      const cat = confLines(models).map((l) => {
        const f = l.split("|").map((x) => x.replace(/^[ \t]+|[ \t]+$/g, ""));
        const e = f[3] ?? "";
        return { agent: f[0] ?? "", model: f[1] ?? "", label: f[2] ?? "", efforts: e === "-" || e === "" ? [] : e.split(","), custom: false };
      });
      const live = await liveCatalog();
      const usedSet = new Set<string>();
      for (const l of [...confLines(dTxt), ...confLines(conf)]) {
        const f = l.split(/[ \t]+/).filter((w) => w !== "");
        usedSet.add(`${f[1] ?? ""}:${f[2] ?? ""}`);
        for (const x of (f[5] ?? "").split(",")) { const p = x.split(":"); if ((p[1] ?? "") !== "") usedSet.add(`${p[0]}:${p[1]}`); }
      }
      const used = [...usedSet].sort(cmp).map((s) => { const p = s.split(":"); return { agent: p[0], model: p[1] ?? "" }; });
      const has = (list: any[], x: any): boolean => list.some((c) => c.agent === x.agent && c.model === x.model);
      const merged = [...cat.filter((c) => !has(live, c)), ...live];
      const catalog = [...merged, ...used.filter((u) => !has(merged, u)).map((u) => ({ agent: u.agent, model: u.model, label: `${u.agent}:${u.model} (custom)`, efforts: [], custom: true }))];
      writeOut(JSON.stringify({ project: dsLabel(proj), roles, catalog }, null, 2) + "\n");
      return 0;
    }
    const src = hasOwn ? `override for ${dsLabel(proj)}: its roles.conf rows (ds config export --project ${dsLabel(proj)}) over ${DEFAULT()}` : `repo default: ${DEFAULT()}`;
    writeOut(`ROLES (${src})\n`);
    writeOut(`${pad("role", 12)} ${pad("agent", 8)} ${pad("model", 8)} ${pad("spawn", 10)} ${pad("effort", 10)} ${pad("fallbacks", 10)} ${pad("plan", 8)} back up\n`);
    writeOut("-".repeat(86) + "\n");
    for (const l of confLines(conf)) {
      const [name, agent, model, spawn, effort, fb, plan] = row(l);
      const e = effort === "-" ? "" : effort, f = fb === "-" ? "" : fb, p = plan === "-" ? "" : plan;
      writeOut(`${pad(name, 12)} ${pad(agent, 8)} ${pad(model, 8)} ${pad(spawn, 10)} ${pad(e || "(default)", 10)} ${pad(f || "(none)", 10)} ${pad(p || "Any", 8)} ${backUpCell(name, spawn, backUp(name, own, dflt))}\n`);
    }
    return 0;
  }

  if (cmd === "set") {
    if (args.length < 4) return usage();
    const [proj, role, agent, model] = args, label = dsLabel(proj);
    let spawn = args[4] ?? "", fb = args[6] ?? "", plan = args[7] ?? "";
    const effort = args[5] ?? "", ret = args[8] ?? "";
    // An empty spawn, fallbacks or plan keeps the role's effective one (spawn: else always); an empty effort is none.
    const eff = awkRow(effectiveText(proj), role);
    spawn ||= eff?.[3] || "always";
    fb ||= eff?.[5] ?? "";
    plan ||= eff?.[6] ?? "";
    // An empty return keeps the row's own column 8 (settings.ts rosterValue), `-` clears it (inherit).
    const value = `${agent} ${model} ${spawn} ${effort || "-"} ${fb || "-"} ${plan || "-"}${ret ? ` ${ret}` : ""}`;
    if (!changeSettings("roles.sh", (s) => set(s, label, "roles.conf", role, value, "ds roles"))) return 2;
    const [, , , , e, f, p] = readFields(awkRow(effectiveText(proj), role)?.join(" ") ?? "", 7).map((v) => (v === "-" ? "" : v));
    const up = backUpCell(role, spawn, backUp(role, ownRoster(proj), text(DEFAULT())));
    writeOut(`set ${role} = ${agent}/${model} (${spawn}) effort=${e || "default"} fallbacks=${f || "none"} plan=${p || "Any"} back up=${up} for ${label}\n`);
    return 0;
  }

  if (cmd === "rm" || cmd === "reset") {
    if (args.length < 2) return usage();
    const [proj, role] = args, label = dsLabel(proj);
    // Both drop the project's row (U267): the role then follows the default row and its later changes.
    const cs = changeSettings("roles.sh", (s) => (cmd === "rm" ? rm : reset)(s, label, "roles.conf", role, "ds roles"));
    if (!cs) return 2;
    if (!cs.length) writeOut(`roles.sh: no override of ${role} for ${label}; ${cmd === "rm" ? "nothing to remove" : `${role} already runs the default`}\n`);
    else writeOut(cmd === "rm" ? `removed ${role} for ${label}\n` : `reset ${role} to the default for ${label}\n`);
    return 0;
  }
  return usage();
}
