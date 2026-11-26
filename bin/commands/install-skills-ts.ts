// ds install-skills-ts — the role skills every squad agent invokes (U262): what bin/host/install-skills.sh
// runs. compound-engineering once per owner of each Claude account's real plugins/, no-mistakes, the
// optional lavish, the user-skill links per account, the Muse copies and the Codex wiring; --check reads
// only. Same flags, output and writes as the shell version it replaced.
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, writeErr, writeOut } from "../lib/shared";
import { accountSkillsCheck, accountSkillsScan, claudeSkillAccounts, ROLE_OPTIONAL_USER_SKILLS, ROLE_USER_SKILLS } from "../lib/account-skills";
import {
  MUSE_CE_SKILLS, MUSE_DS_SKILL, accountOwner, agentsInUse, canon, capture, exists, inherit, isDir, isFile,
  isLink, museSkillOn, restoreBunEnv, roleUses, versionSort, which, type RoleUse,
} from "../lib/install";

export const help = `[--muse-only|--codex-only] [--check] [--verbose] — install or check the role skills (install-skills.sh)`;

const CE_MARKETPLACE = "EveryInc/compound-engineering-plugin";
const CE_PLUGIN = "compound-engineering@compound-engineering-plugin";
const NM_INSTALLER = "https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh";
// The required then the optional user skills: the ones linked into each account.
const USER_SKILLS = [...ROLE_USER_SKILLS, ...ROLE_OPTIONAL_USER_SKILLS];

const out = (s = "") => writeOut(s + "\n");
const err = (s: string) => writeErr(s + "\n");
const stripNl = (s: string) => s.replace(/\n+$/, "");
const HOME = () => process.env.HOME ?? "";

type State = { verbose: boolean; accountsBroken: boolean; installFailed: boolean };

/** "role (primary), …, role (fallback), …" for one agent. */
function rolesFor(uses: RoleUse[], agent: string): string {
  const of = (kind: string) => uses.filter((u) => u.agent === agent && u.kind === kind).map((u) => `${u.role} (${kind})`);
  return [...of("primary"), ...of("fallback")].join(", ");
}

/** `grep -q "^<agent>[[:space:]]*|" conventions/models.conf`. */
function agentKnown(agent: string): boolean {
  try {
    const text = readFileSync(join(ROOT, "conventions", "models.conf"), "utf8");
    const esc = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${esc}[ \\t\\n\\v\\f\\r]*\\|`, "m").test(text);
  } catch { return false; }
}

/** One verdict block per agent in use; non-zero only when a required CLI (claude, a primary codex) is missing. */
async function verifyAgents(st: State, museOnly: boolean): Promise<number> {
  let rc = 0;
  const uses = roleUses();
  out("-> per-agent verification (conventions/roles.conf + conventions/models.conf)");
  if (museOnly) out("claude: not checked (--muse-only)");
  else if (which("claude") === null) { err("install-skills: 'claude' CLI not found — install Claude Code on this host first"); rc = 1; }
  else {
    out("claude: CLI ok");
    // listed is not enough: its registered installPath must exist under each account's config dir.
    if (accountSkillsCheck() !== 0) st.accountsBroken = true;
    if (st.verbose) await inherit(["claude", "plugin", "list"], { err: "ignore" });
  }
  if (which("muse") === null) {
    err(`⚠ muse: 'muse' CLI not found — roles using it (${rolesFor(uses, "muse")}) stay on Claude; skipping Muse skill check`);
  } else {
    out("muse: CLI ok");
    const listing = stripNl((await capture(["muse", "skills", "list"])).out);
    const missing = MUSE_CE_SKILLS.split(" ").filter((s) => !museSkillOn(listing, s)).map((s) => ` ${s}`).join("");
    if (missing === "") out(`muse: ce-* skills ok (${rolesFor(uses, "muse")})`);
    else err(`⚠ muse skills missing from 'muse skills list':${missing} — re-run 'bin/host/install-skills.sh --muse-only' to refresh`);
    if (museSkillOn(listing, MUSE_DS_SKILL)) out("muse: ds skill ok");
    else err(`⚠ muse ds skill '${MUSE_DS_SKILL}' missing from 'muse skills list' — re-run 'bin/host/install-skills.sh --muse-only' to refresh`);
    if (st.verbose && listing !== "") out(listing);
  }
  const codexRoles = rolesFor(uses, "codex");
  if (codexRoles !== "") {
    if (which("codex") !== null) { if ((await inherit([join(ROOT, "bin", "host", "codex-skills.sh"), "--check"])) !== 0) rc = 1; }
    else {
      err(`⚠ codex: CLI missing — roles using it (${codexRoles}) cannot run`);
      if (uses.some((u) => u.agent === "codex" && u.kind === "primary")) rc = 1;
    }
  } else if (which("codex") !== null) out("codex: installed but not used by any role — no check");
  else out("codex: not installed, not used by any role — no check");
  // Any other agent gets a CLI check; an agent without a known skill command gets no check rather than a wrong one.
  for (const a of agentsInUse(uses)) {
    if (a === "claude" || a === "muse" || a === "codex") continue;
    const custom = agentKnown(a) ? "" : " (custom pair, not in conventions/models.conf)";
    if (which(a) !== null) out(`${a}: CLI ok${custom} — roles using it (${rolesFor(uses, a)}); no skill check defined for this agent`);
    else err(`⚠ ${a}: CLI not found${custom} — roles using it (${rolesFor(uses, a)}) have no host to run on`);
  }
  return rc;
}

/** `muse skills list`: stdout and its exit code. */
async function museList(): Promise<{ listing: string; rc: number }> {
  const r = await capture(["muse", "skills", "list"]);
  return { listing: stripNl(r.out), rc: r.rc };
}

/** The newest installed compound-engineering version's skills dir (a real directory, `sort -V`), or null. */
function museCeSkillsDir(): string | null {
  const base = join(HOME(), ".claude", "plugins", "cache", "compound-engineering-plugin", "compound-engineering");
  if (!isDir(base)) return null;
  let names: string[] = [];
  try { names = readdirSync(base).filter((n) => { try { return lstatSync(join(base, n)).isDirectory(); } catch { return false; } }); } catch { /* none */ }
  const newest = versionSort(names).pop() ?? "";
  return newest !== "" && isDir(join(base, newest, "skills")) ? join(base, newest, "skills") : null;
}

async function installMuseCeSkills(st: State): Promise<void> {
  if (which("muse") === null) { out("-> muse ce-skills: 'muse' CLI not found — skipping (Claude-only host)"); return; }
  const src = museCeSkillsDir();
  if (src === null) {
    err("install-skills: no installed compound-engineering plugin cache found — skipping Muse copy (run the full install once Claude Code is present)");
    return;
  }
  out(`-> muse ce-skills (from ${basename(dirname(src))})`);
  let installed = 0, skipped = 0, failed = 0;
  for (const skill of MUSE_CE_SKILLS.split(" ")) {
    // A failing install warns and carries on: one bad skill must not stop /ds-update before its restart step.
    if (isDir(join(src, skill))) {
      if ((await inherit(["muse", "skills", "install", join(src, skill), "--scope", "user", "--force"])) === 0) {
        out(`installed ${skill} (user scope, from ${src}/${skill})`); installed++;
      } else { err(`install-skills: 'muse skills install' failed for '${skill}' — continuing`); failed++; }
    } else { err(`install-skills: '${skill}' not in ${src} — skipping it`); skipped++; }
  }
  const { listing, rc } = await museList();
  if (rc !== 0) err(`install-skills: 'muse skills list' failed (exit ${rc}) — installs above stand, verification below re-checks`);
  else if (listing !== "" && (st.verbose || skipped > 0)) out(listing);
  out(`muse ce-skills: ${installed} installed, ${skipped} skipped${failed > 0 ? `, ${failed} failed` : ""}`);
}

/** dev-studio's ds-* wrapper skill as a Muse user skill; a stale install goes when the source is gone. */
async function installMuseDsSkill(st: State): Promise<void> {
  if (which("muse") === null) { out("-> muse ds-skill: 'muse' CLI not found — skipping (Claude-only host)"); return; }
  const src = join(ROOT, "skills", MUSE_DS_SKILL);
  if (!isFile(join(src, "SKILL.md"))) {
    const listed = (await capture(["muse", "skills", "list"])).out.split("\n").some((l) => new RegExp(`^${MUSE_DS_SKILL}([ \\t\\n\\v\\f\\r]|$)`).test(l));
    if (listed) {
      err(`install-skills: '${src}/SKILL.md' not found — uninstalling stale '${MUSE_DS_SKILL}' skill`);
      await inherit(["muse", "skills", "uninstall", MUSE_DS_SKILL]);
    } else {
      err(`install-skills: '${src}/SKILL.md' not found — skipping ds skill (re-run after pulling the skill source)`);
    }
    return;
  }
  out("-> muse ds-skill (dev-studio /ds-* wrapper)");
  let failed = false;
  if ((await inherit(["muse", "skills", "install", src, "--scope", "user", "--force"])) === 0) out(`installed ${MUSE_DS_SKILL} (user scope, from ${src})`);
  else { err(`install-skills: 'muse skills install' failed for '${MUSE_DS_SKILL}' — continuing`); failed = true; }
  const { listing, rc } = await museList();
  if (rc !== 0) err(`install-skills: 'muse skills list' failed (exit ${rc}) — ds install above stands, verification below re-checks`);
  else if (st.verbose && listing !== "") out(listing);
  out(`muse ds-skill: ${failed ? 0 : 1} installed, 0 skipped${failed ? ", 1 failed" : ""}`);
}

/** claude under a config dir's env (CLAUDE_CONFIG_DIR unset for ~/.claude, as a `system` role runs), echoed first. */
function claudeAs(cfg: string, args: string[]): Promise<number> {
  if (canon(cfg) === canon(join(HOME(), ".claude"))) {
    out(`   $ env -u CLAUDE_CONFIG_DIR claude ${args.join(" ")}`);
    return inherit(["claude", ...args], { env: { CLAUDE_CONFIG_DIR: undefined }, stdinNull: true });
  }
  out(`   $ env CLAUDE_CONFIG_DIR=${cfg} claude ${args.join(" ")}`);
  return inherit(["claude", ...args], { env: { CLAUDE_CONFIG_DIR: cfg }, stdinNull: true });
}

type Acct = { label: string; cfg: string; owner: string };
/** Every Claude account in the accounts table with its config dir and canonical owner. */
function collectAccounts(): Acct[] {
  const rows: Acct[] = [];
  for (const { account, dir, missing } of claudeSkillAccounts()) {
    if (missing) { err(`⚠ claude[${account}]: its login folder ${dir} is missing — skipped`); continue; }
    rows.push({ label: `claude[${account}]`, cfg: dir, owner: canon(accountOwner(dir)) });
  }
  return rows;
}

/** install | reinstall | ok from accountSkillsScan of the owner's registry: not installed -> install; a dangling
 *  user entry, a missing role skill or a path recorded through a profile -> reinstall. */
function ownerCeAction(owner: string): string {
  let install = false, reinstall = false;
  for (const l of accountSkillsScan(owner)) {
    const fault = l.split("\t")[1] ?? "";
    if (fault.startsWith("compound-engineering is not installed")) install = true;
    if (fault.startsWith(`${CE_PLUGIN} (user scope) is registered at a path that does not exist`)
      || fault.startsWith("compound-engineering is installed but lacks role skill")
      || fault.startsWith("compound-engineering is recorded through")) reinstall = true;
  }
  return install ? "install" : reinstall ? "reinstall" : "ok";
}

async function installCeInto(owner: string, act: string): Promise<number> {
  await claudeAs(owner, ["plugin", "marketplace", "add", CE_MARKETPLACE]); // already-added is fine
  if (act === "reinstall" && (await claudeAs(owner, ["plugin", "uninstall", CE_PLUGIN, "--scope", "user"])) !== 0) {
    err(`install-skills: uninstall under ${owner} failed — installing anyway; the check below says if the old entry stayed`);
  }
  return claudeAs(owner, ["plugin", "install", CE_PLUGIN, "--scope", "user"]);
}

/** Link each user skill <cfg>/skills lacks to ~/.claude/skills/<name>; returns " name…" for what it linked.
 *  A working entry stays, a broken link is replaced, a non-link entry is never replaced. */
function linkUserSkills(cfg: string): string {
  const dir = join(cfg, "skills");
  const home = HOME();
  if (canon(dir) === canon(join(home, ".claude", "skills"))) return "";
  if (isLink(dir) && !exists(dir)) {
    err(`⚠ install-skills: ${dir} is a broken symlink — not touched; point it at a skills dir, then re-run`);
    return "";
  }
  let linked = "";
  for (const name of USER_SKILLS) {
    if (isFile(join(dir, name, "SKILL.md"))) continue;
    if (exists(join(dir, name)) && !isLink(join(dir, name))) {
      err(`⚠ install-skills: ${dir}/${name} exists, is not a link and has no SKILL.md — not replaced; remove it and re-run`);
      continue;
    }
    const src = join(home, ".claude", "skills", name);
    if (!isFile(join(src, "SKILL.md"))) {
      err(`⚠ install-skills: ${src}/SKILL.md is missing (its installer above failed?) — can't link ${name} into ${dir}`);
      continue;
    }
    try { mkdirSync(dir, { recursive: true }); rmSync(join(dir, name), { force: true }); symlinkSync(src, join(dir, name)); linked += ` ${name}`; }
    catch { err(`⚠ install-skills: could not link ${name} into ${dir}`); }
  }
  return linked;
}

/** `jq -r '.enabledPlugins[<CE>] // false' <cfg>/settings.json` reads true. */
async function ceEnabled(cfg: string): Promise<boolean> {
  const r = await capture(["jq", "-r", "--arg", "id", CE_PLUGIN, ".enabledPlugins[$id] // false", join(cfg, "settings.json")]);
  return r.rc === 0 && stripNl(r.out) === "true";
}

/** Per account: enable the plugin where its settings.json doesn't, link the user skills, print its line. */
async function finishAccounts(st: State, accts: Acct[], ownersDone: Map<string, string>): Promise<void> {
  for (const { label, cfg, owner } of accts) {
    if (owner === "") continue;
    let notes = "";
    const res = ownersDone.get(owner) ?? "";
    if (!res.startsWith("install FAILED") && !(await ceEnabled(cfg))) {
      if ((await claudeAs(cfg, ["plugin", "enable", CE_PLUGIN, "--scope", "user"])) === 0) notes = "enabled";
      else { notes = "enable FAILED"; st.installFailed = true; }
    }
    const links = linkUserSkills(cfg);
    if (links !== "") notes = `${notes && notes + ", "}linked${links}`;
    let word: string;
    if (canon(cfg) === owner) {
      word = res;
      // "already ok" plus a change that landed reads "installed"; plus only a failure, "FAILED".
      if (word === "already ok" && notes !== "") word = notes.includes("FAILED") ? "FAILED" : "installed";
    } else {
      word = `shares ${owner}`; notes = `${res}${notes && "; " + notes}`;
    }
    out(`${label}: ${word}${notes && ` (${notes})`}`);
  }
}

/** `curl -fsSL <url> | sh` under pipefail: non-zero when either side fails. */
async function curlSh(url: string): Promise<number> {
  const curl = which("curl"), sh = which("sh");
  if (curl === null || sh === null) return 127;
  const c = Bun.spawn([curl, "-fsSL", url], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const s = Bun.spawn([sh], { stdin: c.stdout, stdout: "inherit", stderr: "inherit" });
  const [crc, src] = await Promise.all([c.exited, s.exited]);
  return src !== 0 ? src : crc;
}

export async function run(argv: string[]): Promise<number> {
  restoreBunEnv();
  let museOnly = false, codexOnly = false, check = false;
  const st: State = { verbose: false, accountsBroken: false, installFailed: false };
  for (const a of argv) {
    if (a === "--muse-only") museOnly = true;
    else if (a === "--codex-only") codexOnly = true;
    else if (a === "--check") check = true;
    else if (a === "--verbose") st.verbose = true;
    else { err("usage: install-skills.sh [--muse-only|--codex-only] [--check] [--verbose]"); return 2; }
  }
  if (codexOnly) {
    if (museOnly) { err("choose --muse-only or --codex-only"); return 2; }
    return inherit([join(ROOT, "bin", "host", "codex-skills.sh"), ...(check ? ["--check"] : [])]);
  }
  if (check) {
    out(museOnly ? "== dev-studio role skills (muse-only check) ==" : "== dev-studio role skills (check) ==");
    const rc = await verifyAgents(st, museOnly);
    if (rc !== 0) return rc;
    out("== done ==");
    // --check fails when any Claude account lacks the role skills (the plain install stays exit 0).
    return st.accountsBroken ? 1 : 0;
  }
  if (museOnly) {
    out("== dev-studio role skills (muse-only refresh) ==");
    await installMuseCeSkills(st);
    await installMuseDsSkill(st);
    const rc = await verifyAgents(st, true);
    if (rc !== 0) return rc;
    out("== done ==");
    return 0;
  }

  out("== dev-studio role skills ==");
  // 1. compound-engineering into every Claude account: one install per owner of the account's real plugins/,
  // recorded through the owner's own path, never through a profile whose plugins/ is a symlink.
  if (which("claude") === null) { err("install-skills: 'claude' CLI not found — install Claude Code on this host first"); return 1; }
  out("-> compound-engineering (Claude Code plugin, per account owner)");
  const accts = collectAccounts();
  const ownersDone = new Map<string, string>();
  for (const { owner } of accts) {
    if (owner === "" || ownersDone.has(owner)) continue;
    const act = ownerCeAction(owner);
    let res = "already ok";
    if (act !== "ok") {
      if ((await installCeInto(owner, act)) !== 0) { res = "install FAILED"; st.installFailed = true; }
      // a 0 exit is not proof: re-read the owner's registry (a failed uninstall can leave the old entry)
      else if (ownerCeAction(owner) !== "ok") { res = "install FAILED (still broken after it — see the check below)"; st.installFailed = true; }
      else res = "installed";
    }
    ownersDone.set(owner, res);
  }

  // 2. no-mistakes via its official installer. Non-fatal: it exits non-zero when it won't restart its daemon
  // while a pipeline runs, and the binary still installs.
  out("-> no-mistakes (official installer)");
  if (which("curl") === null) { err(`install-skills: 'curl' not found — install no-mistakes manually: ${NM_INSTALLER}`); return 1; }
  if ((await curlSh(NM_INSTALLER)) !== 0) {
    err("install-skills: no-mistakes installer returned non-zero (often just a refused daemon restart while a pipeline runs — the binary usually installed). Re-run when idle if 'no-mistakes --version' fails.");
  }
  // 3. lavish (optional): the Thinker's visual plan review; inline review works without it.
  out("-> lavish (optional, visual plan review)");
  if (which("npx") !== null) {
    if ((await inherit(["npx", "-y", "skills", "add", "kunchenguid/lavish-axi", "--skill", "lavish", "-g"])) !== 0) {
      err("install-skills: lavish skill install skipped (optional) — Thinker falls back to inline review");
    }
  } else err("install-skills: 'npx' not found — skipping optional lavish (inline review still works)");

  // 3b. Per account: enable compound-engineering (enabled state is per config dir) and link the user skills.
  out("-> Claude accounts");
  await finishAccounts(st, accts, ownersDone);
  // 4. The Muse copies (quiet skip when muse is absent), then Codex's filesystem skills.
  await installMuseCeSkills(st);
  await installMuseDsSkill(st);
  if (which("codex") !== null && (await inherit([join(ROOT, "bin", "host", "codex-skills.sh")])) !== 0) st.installFailed = true;
  // 5. Per-agent verification: a broken account prints its block; the verdict alone keeps exit 0.
  await verifyAgents(st, false);
  out("== done ==");
  out("Verify:  bin/host/install-skills.sh --check   (lavish optional: npx -y lavish-axi --version; muse copy: muse skills list)");
  // A `claude plugin` command that failed is a failed install.
  return st.installFailed ? 1 : 0;
}

