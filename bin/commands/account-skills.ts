// ds account-skills — the account-skills check and its parts from the shell (U274: the shell lib's
// ds_account_skills_* and ds_account_plan are gone; tests and operators call these instead).
import { accountOwner } from "../lib/install";
import { accountPlan, accountSkillsCheck, accountSkillsScan, accountSkillsVerdict,
  ROLE_CE_SKILLS, ROLE_OPTIONAL_USER_SKILLS, ROLE_USER_SKILLS } from "../lib/account-skills";
import { hostBackendPath, writeErr, writeOut } from "../lib/shared";

export const help = `check [<backend>] [--tsv] | scan <config-dir> | verdict <config-dir> | owner <config-dir> | plan <backend> <agent> <account> | role-skills [ce|user|optional] — can each Claude account load the role skills (bin/lib/account-skills.ts)`;

const usage = (): number => { writeErr(`usage: ds account-skills ${help.split(" — ")[0]}\n`); return 2; };

export async function run(argv: string[]): Promise<number> {
  const [sub, ...a] = argv;
  switch (sub) {
    case "check": {
      const tsv = a.includes("--tsv");
      const rest = a.filter((x) => x !== "--tsv");
      return accountSkillsCheck(rest[0] || hostBackendPath(), tsv);
    }
    case "scan": if (!a[0]) return usage(); for (const l of accountSkillsScan(a[0])) writeOut(l + "\n"); return 0;
    case "verdict": if (!a[0]) return usage(); writeOut(accountSkillsVerdict(a[0]) + "\n"); return 0;
    case "owner": if (!a[0]) return usage(); writeOut(accountOwner(a[0]) + "\n"); return 0;
    case "plan": {
      if (a.length < 3) return usage();
      const p = await accountPlan(a[0], a[1], a[2]);
      if (p) writeOut(p + "\n");
      return 0;
    }
    case "role-skills": {
      const which = a[0] ?? "ce";
      const list = which === "ce" ? ROLE_CE_SKILLS : which === "user" ? ROLE_USER_SKILLS : which === "optional" ? ROLE_OPTIONAL_USER_SKILLS : null;
      if (!list) return usage();
      writeOut(list.join(" ") + "\n");
      return 0;
    }
    default: return usage();
  }
}
