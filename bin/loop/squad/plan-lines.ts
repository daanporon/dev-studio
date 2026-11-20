// plan-lines.ts — the plan's unit-line grammar, pure (no side effects at load): `U<n> — <title> — deps: … — Tier: …`.
// `squad-state.ts` (register-plan) and the board's plan facts share it, so a plan the Thinker's approval shows
// counts the same units the Lead later registers. A bad line throws PlanLineError; register-plan turns it
// into its exit 1, planUnitFacts into null.

export type UnitText = { about?: string; done?: string; check?: string };
export type PlanUnit = { n: number; id: string; title: string; deps: string[]; ext: string[]; tier: string; held: boolean; blocks: string[]; lane: string | null; laneRule: string | null; text: UnitText };

export class PlanLineError extends Error {}
function fail(msg: string): never { throw new PlanLineError(msg); }
const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());   // ascii_downcase, as squad-state.ts

// A line that starts a unit (a bullet is allowed); the same test register-plan uses to pick them.
export const UNIT_LINE = /^\s*(?:[-*]\s+)?U[0-9]+[a-z]?\s*(?:—|--)/;

export function parsePlanLine(n: number, line: string): PlanUnit {
  const m = line.match(/^\s*(?:[-*] )?(?<id>U[0-9]+[a-z]?) (?:—|--) (?<rest>[^\n]*)$/);
  if (!m?.groups) fail(`line ${n}: malformed unit line (want \`U<n> — <title> — deps: … — Tier: …\`): ${line}`);
  const id = m.groups.id;
  const f = { title: [] as string[], deps: null as string | null, ext: null as string | null, tier: null as string | null, held: false, blocks: null as string | null, lane: null as string | null };
  for (const s of m.groups.rest.split(/ (?:—|--) /).map((x) => x.replace(/^\s+|\s+$/g, ""))) {
    if (/^deps\s*:/i.test(s)) {
      if (f.deps !== null) fail(`line ${n}: ${id} has two deps: fields`);
      f.deps = s.replace(/^deps\s*:\s*/i, "");
    } else if (/^ext[- ]?deps?\s*:/i.test(s)) {
      if (f.ext !== null) fail(`line ${n}: ${id} has two ext-deps: fields`);
      f.ext = s.replace(/^ext[- ]?deps?\s*:\s*/i, "");
    } else if (/^blocks\s*:/i.test(s)) {
      if (f.blocks !== null) fail(`line ${n}: ${id} has two blocks: fields`);
      f.blocks = s.replace(/^blocks\s*:\s*/i, "");
    } else if (/^tier\s*:/i.test(s)) {
      if (f.tier !== null) fail(`line ${n}: ${id} has two Tier: fields`);
      f.tier = s.replace(/^tier\s*:\s*/i, "");
    } else if (/^lane\s*:/i.test(s)) {
      if (f.lane !== null) fail(`line ${n}: ${id} has two Lane: fields`);
      f.lane = s.replace(/^lane\s*:\s*/i, "");
    } else if (/^\(?held\)?$/i.test(s)) f.held = true;
    else if (f.deps !== null || f.ext !== null || f.tier !== null || f.held || f.blocks !== null || f.lane !== null) fail(`line ${n}: ${id} has an unknown field after deps/Tier: ${s}`);
    else f.title.push(s);
  }
  const title = f.title.join(" — ");
  if (title === "") fail(`line ${n}: ${id} has no title`);
  if (f.tier === null) fail(`line ${n}: ${id} has no Tier: (standard|hard)`);
  const tw = lower(f.tier).match(/^([a-z]+)/)?.[1] ?? "";
  if (tw !== "standard" && tw !== "hard") fail(`line ${n}: ${id} Tier: must start with standard or hard, got: ${f.tier}`);
  // `Lane: light|normal [(rule: <id>)]`: the first word picks the lane; no field means normal (nothing stored).
  let lane: string | null = null, laneRule: string | null = null;
  if (f.lane !== null) {
    const lm = f.lane.match(/^(light|normal)(?:\s*\(\s*rule\s*:\s*([^()]*?)\s*\))?\s*$/i);
    if (!lm) fail(`line ${n}: ${id} Lane: must be light or normal, optionally followed by (rule: <id>), got: ${f.lane}`);
    lane = lower(lm[1]);
    laneRule = lm[2] ? lm[2] : null;
  }
  const dt = f.deps ?? "";
  if (/\bexternal\b/i.test(dt)) fail(`line ${n}: ${id} deps: names an external dep — record it with add-ext-dep, not in deps:`);
  const bad = [...dt.matchAll(/\b[A-TV-Z][0-9]+[a-z]?\b(?!-)/g)].map((x) => x[0]);
  if (bad.length) fail(`line ${n}: ${id} deps: ${bad.join(", ")} is not a unit id (only U<n>)`);
  const ids = [...new Set([...dt.matchAll(/\bU[0-9]+[a-z]?\b(?!-)/g)].map((x) => x[0]))];
  if (!ids.length && !/^(none\b[^\n]*)?$/i.test(dt)) fail(`line ${n}: ${id} deps: has no unit id (use none): ${dt}`);
  if (ids.includes(id)) fail(`line ${n}: ${id} lists itself as a dep`);
  // `— blocks: U109[, U105]`: this unit is fixed first and those started units wait on it (wait-on).
  const bt = f.blocks ?? "";
  const bids = [...new Set([...bt.matchAll(/\bU[0-9]+[a-z]?\b(?!-)/g)].map((x) => x[0]))];
  if (f.blocks !== null && !bids.length) fail(`line ${n}: ${id} blocks: has no unit id: ${bt}`);
  if (bids.includes(id)) fail(`line ${n}: ${id} lists itself in blocks:`);
  // `— ext-deps: <squad>/<slug>[, …]`: another squad's unit in this project (U46), recorded as ext_deps.
  const ext: string[] = [];
  if (f.ext !== null) {
    for (const r of f.ext.split(/[\s,]+/).filter((x) => x !== "" && !/^none$/i.test(x))) {
      const ok = r.includes("/") && !/\/.*\//.test(r) && !r.startsWith("/") && !r.endsWith("/") && !r.startsWith(".") && !r.includes("/.");
      if (!ok) fail(`line ${n}: ${id} ext-deps: '${r}' is not <squad>/<slug> (another project's unit is out of scope)`);
      if (!ext.includes(r)) ext.push(r);
    }
  }
  return { n, id, title, deps: ids, ext, tier: tw, held: f.held || /\(held\)/i.test(f.tier), blocks: bids, lane, laneRule, text: {} };
}

// {steps, hard, start_now} counted from a plan's unit lines; null when there are none or any line does not parse.
// start_now = units with no deps that are not held (the ready-units rule).
export function planUnitFacts(text: string): { steps: number; hard: number; start_now: number } | null {
  try {
    const us = text.split("\n").flatMap((line, i) => (UNIT_LINE.test(line) ? [parsePlanLine(i + 1, line)] : []));
    if (!us.length) return null;
    return { steps: us.length, hard: us.filter((u) => u.tier === "hard").length, start_now: us.filter((u) => !u.deps.length && !u.held).length };
  } catch (e) { if (e instanceof PlanLineError) return null; throw e; }
}
