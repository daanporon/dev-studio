import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
function controls(target: any, pause: any = { state: "active" }, accept = true) {
  const questions: string[] = [], posts: any[] = [], toasts: string[] = [];
  const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: strings.join(""), values });
  const component = new Function("useState", "html", "confirm", "post", "setTimeout", "clearTimeout",
    `let toastTimer; ${cut("pauseLabel")} ${cut("pauseParent")} ${cut("PauseControls")} return PauseControls;`)(
    () => [false, () => {}], html, (q: string) => { questions.push(q); return accept; },
    async (...args: any[]) => { posts.push(args); return { pause: { state: "pausing", reason: "awaiting journal checkpoint" } }; }, () => 0, () => {});
  const label = target.scope === "member" ? "role " + target.role + " in p/one" : target.scope + " p";
  const view = component({ target, pause, label, toast: (t: string) => toasts.push(t), wait: () => {} });
  const buttons = view.values.filter((v: any) => v?.strings?.includes("<button"));
  return { questions, posts, toasts, buttons, view };
}
test("project, squad and every role get scoped pause confirmations and identity-preserving writes", async () => {
  const targets = [{ scope: "project", project: "p" }, { scope: "squad", project: "p", topic: "one" },
    ...["lead", "thinker", "builder", "reviewer", "tester", "researcher", "builder-task"].map((role) => ({ scope: "member", project: "p", topic: "one", role, wt: "wt-" + role }))];
  for (const target of targets) {
    const c = controls(target);
    await c.buttons[0].values.find((v: any) => typeof v === "function")();
    expect(c.questions[0]).toContain("Pause " + (target.scope === "member" ? "role " + target.role : target.scope));
    expect(c.questions[0]).toContain("checkpoint");
    expect(c.posts).toEqual([["api/pause", target]]);
  }
});
test("Resume is offered for individual pauses and descendants, and parent pause disables it", async () => {
  const target = { scope: "member", project: "p", topic: "one", wt: "wt" };
  const c = controls(target, { state: "paused", sources: [{ scope: "squad", squad: "one" }] });
  expect(c.buttons[0].strings).toContain("Resume");
  expect(c.buttons[0].values).toContain(true);
  expect(c.buttons[0].values).toContain("Resume squad one first");
  const squad = controls({ scope: "squad", project: "p", topic: "one" }, { state: "active", descendants_paused: true });
  expect(squad.buttons).toHaveLength(3);
  await squad.buttons[1].values.find((v: any) => typeof v === "function")();
  expect(squad.posts[0][0]).toBe("api/resume");
  expect(squad.questions[0]).toContain("clears all role pauses");
});
test("cancelling a scope confirmation does not write, and pending placement can be paused again", async () => {
  const c = controls({ scope: "project", project: "p" }, undefined, false);
  await c.buttons[0].values.find((v: any) => typeof v === "function")();
  expect(c.posts).toEqual([]);
  const pending = controls({ scope: "member", project: "p", wt: "wt" }, { state: "resuming" });
  expect(pending.buttons).toHaveLength(1);
  await pending.buttons[0].values.find((v: any) => typeof v === "function")();
  expect(pending.posts[0][0]).toBe("api/pause");
});

test("a failed fresh start shows Resume on a resuming role, and a healthy resume does not", async () => {
  const target = { scope: "member", project: "p", topic: "one", wt: "wt" };
  const failed = controls(target, { state: "resuming", retryable: true });
  expect(failed.buttons).toHaveLength(2);
  expect(failed.buttons[1].strings).toContain("Resume");
  await failed.buttons[1].values.find((v: any) => typeof v === "function")();
  expect(failed.posts[0][0]).toBe("api/resume");
  expect(controls(target, { state: "resuming", retryable: false }).buttons).toHaveLength(1);
});
test("a dependency selection survives inserted and removed prerequisites on a board refresh", async () => {
  const states: any[] = [], posts: any[] = [];
  let slot = 0;
  const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: strings.join(""), values });
  const component = new Function("useState", "useEffect", "html", "post", "setTimeout", "clearTimeout",
    `let toastTimer; ${cut("pauseLabel")} ${cut("prerequisiteKey")} ${cut("DependencyWait")} return DependencyWait;`)(
    (initial: any) => { const i = slot++; if (!(i in states)) states[i] = initial; return [states[i], (value: any) => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
    () => {}, html, async (...args: any[]) => { posts.push(args); return { pause: { state: "pausing" } }; }, () => 0, () => {});
  const unit = { kind: "unit", project: "p", squad: "one", slug: "prereq", label: "prereq" };
  const pr = { kind: "pr", project: "p", ref: "owner/repo#12", label: "PR12" };
  const render = (prerequisites: any[]) => { slot = 0; return component({ s: { label: "p", topic: "one" }, m: { label: "builder-task", wt: "wt", suffix: "task" }, prerequisites, toast: () => {}, close: () => {} }); };
  const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v?.strings ? [v, ...v.values.flatMap(nodes)] : [];
  const initial = nodes(render([unit, pr]));
  const option = initial.filter((v) => v.strings.includes('class="wait-option"'))[1];
  option.values.find((v: any) => typeof v === "function")();
  for (const refs of [[{ ...unit, slug: "new", label: "new" }, unit, pr], [unit]]) {
    const refreshed = nodes(render(refs));
    const selected = refreshed.filter((v) => v.strings.includes('class="wait-option"') && v.values[2] === true);
    expect(selected).toHaveLength(1);
    expect(selected[0].values).toContain("PR12");
    const send = refreshed.find((v) => v.strings.includes('class="qfoot"'))!.values.findLast((v: any) => typeof v === "function");
    await send();
    expect(posts.at(-1)[1].prerequisites).toEqual([{ kind: "pr", project: "p", ref: "owner/repo#12" }]);
  }
});
