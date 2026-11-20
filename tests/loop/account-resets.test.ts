// account-free-resets U3: accounts.tsv's 13th column (resets) reaches observed_accounts; an older file reads NULL.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountRows } from "../../bin/loop/db/import-json";
import { tempRoot } from "./temp-roots.ts";

const H12 = "agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills\tplan";
const JSON1 = '{"state":"reported","count":1,"grants":[{"id":"g","label":"One","left":1,"total":1,"use_by":1796940000,"refills":["session"],"usable_now":true}]}';
const load = (text: string) => {
  const root = tempRoot("ds-resets-");
  writeFileSync(join(root, "accounts.tsv"), text);
  return accountRows(root).filter((r) => r.table === "observed_accounts").map((r) => r.set.resets);
};

test("a 13-column row stores the resets JSON; `-` is NULL", () => {
  const row = (a: string, r: string) => `claude\t${a}\t10\t-\t5\t-\t-\t1\tL\t-\tok\tMax\t${r}`;
  expect(load(`${H12}\tresets\n${row("a", JSON1)}\n${row("b", "-")}\n`)).toEqual([JSON1, null]);
});

test("a 12-column file (from before the column) reads NULL, not an error", () => {
  expect(load(`${H12}\nclaude\ta\t10\t-\t5\t-\t-\t1\tL\t-\tok\tMax\n`)).toEqual([null]);
});
