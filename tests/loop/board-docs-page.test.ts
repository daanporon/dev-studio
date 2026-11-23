import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const arrow = (name: string) => `const ${name} = ${page.match(new RegExp(`const ${name} = ([^\\n]+);`))![1]};`;
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ str: strings.join("\u0000"), values });
const Docs = new Function("useState", "html", "RevokePlan", `${arrow("docAge")} ${arrow("docWhen")} ${cut("Docs")} return Docs;`)(() => [{}, () => {}], html, () => null);

// Every template node under a view, depth first.
const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === "object" && "str" in v ? [v, ...v.values.flatMap(nodes)] : [];
const groups = (view: any) => nodes(view).filter((n) => n.str.includes("data-docs")).map((n) => n.values[0]);
const render = (s: any, closed: boolean, onPlan: (p: any) => void = () => {}, atArchive = false) => Docs({ s, onPlan, closed, atArchive });
const plans = [{ name: "a-plan.md", mtime: 2 }, { name: "b-plan.md", mtime: 1 }];

test("done squad: Debrief group before Plans, and the debrief row opens the plan modal", () => {
  const opened: any[] = [];
  const view = render({ topic: "t", debrief: "# done", plans }, true, (p) => opened.push(p));
  expect(groups(view)).toEqual(["debrief", "plans"]);
  const row = nodes(view).find((n) => n.str.includes("📝 debrief"));
  row.values.find((v: any) => typeof v === "function")();
  expect(opened).toEqual([{ name: "t — debrief", markdown: "# done" }]);
});
test("done squad with nothing else still shows the box with 'no debrief'", () => {
  const view = render({ topic: "t", plans: [], lavish: [] }, true);
  expect(groups(view)).toEqual(["debrief"]);
  expect(nodes(view).some((n) => n.str.includes("nodebrief"))).toBe(true);
});
test("done squad (debrief comes at archive) says 'written at archive'; an archived one without says 'no debrief'", () => {
  const label = (view: any) => nodes(view).find((n) => n.str.includes("nodebrief")).values[0];
  expect(label(render({ topic: "t", plans: [], lavish: [] }, true, () => {}, true))).toBe("written at archive");
  expect(label(render({ topic: "t", plans: [], lavish: [] }, true))).toBe("no debrief");
});
test("running squad with no debrief and no plans renders nothing", () => {
  expect(render({ topic: "t", plans: [] }, false)).toBeNull();
});
test("running squad with plans has no debrief group", () => {
  expect(groups(render({ topic: "t", plans }, false))).toEqual(["plans"]);
});
test("archived-shaped entry: Debrief and Plans, no Review pages", () => {
  expect(groups(render({ topic: "t", debrief: "x", plans }, true))).toEqual(["debrief", "plans"]);
});
