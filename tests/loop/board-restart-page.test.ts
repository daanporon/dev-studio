import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "..", "..", "web", "board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const squad = { label: "project", topic: "demo", status: "running" };
const builder = { role: "builder", wt: "wt-builder", label: "builder-work", state: "working" };
function control(accept = true) {
  const questions: string[] = [], posts: unknown[] = [], toasts: string[] = [];
  const html = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
  const component = new Function("useState", "html", "confirm", "post", "setTimeout", "clearTimeout", `let toastTimer; ${cut("RestartMember")} return RestartMember;`)(
    () => [false, () => {}], html, (q: string) => { questions.push(q); return accept; },
    async (...args: unknown[]) => { posts.push(args); return { id: 7 }; }, () => 0, () => {});
  const render = (m = builder, s = squad) => component({ s, m, toast: (t: string) => toasts.push(t) });
  return { render, questions, posts, toasts };
}

const titleOf = (r: any) => r.values.find((v: unknown) => typeof v === "string" && v.length > 0);

test("Restart is offered on every crew row and enabled on running and done squads", () => {
  const c = control();
  expect(c.render().strings.join("")).toContain(">Restart</button>");
  for (const role of ["lead", "thinker", "tester", "reviewer", "researcher"]) expect(c.render({ ...builder, role }).strings.join("")).toContain(">Restart</button>");
  for (const status of ["running", "done", "failed", "waiting-on-you"]) {
    const r = c.render(builder, { ...squad, status });
    expect(r.values).toContain(false); // disabled=${busy || !!why}
    expect(titleOf(r)).toContain("Restart this member");
  }
});

test("Restart is disabled with the reason where it cannot happen", () => {
  const c = control();
  const why = (m: any, s: any = squad) => { const r = c.render(m, s); return r.values.includes(true) ? titleOf(r) : null; };
  expect(why(builder, { ...squad, status: "suspended" })).toBe("squad is suspended: resume it first");
  expect(why(builder, { ...squad, status: "on-hold" })).toBe("squad is on-hold: resume it first");
  expect(why(builder, { ...squad, status: "closed" })).toBe("squad is closed");
  expect(why(builder, { ...squad, status: "gone" })).toBe("squad is gone");
  expect(why({ ...builder, pause: { state: "paused" } })).toBe("role is paused: use Resume role");
  expect(why({ ...builder, stop_checkpoint: { why: "restart" } })).toBe("restart already pending");
  expect(why({ ...builder, wish: { pending: [{ wish: "restart" }] } })).toBe("restart already pending");
  expect(why(builder)).toBeNull();
});

test("confirming a working Builder's restart explains the wait and posts its worktree", async () => {
  const c = control(), button = c.render();
  await button.values.find((v: unknown) => typeof v === "function")();
  expect(c.questions).toEqual(["Restart builder-work? The start waits for its turn to end."]);
  expect(c.posts).toEqual([["api/restart", { project: "project", topic: "demo", wt: "wt-builder", role: "builder" }]]);
  expect(c.toasts).toEqual(["restart requested (request #7)"]);
});

test("cancelling the confirm sends nothing", async () => {
  const c = control(false);
  await c.render().values.find((v: unknown) => typeof v === "function")();
  expect(c.posts).toEqual([]);
});

test("the request's wait and landing reach the page through the event stream", () => {
  const toastOf = new Function("mine", cut("toastOf") + "return toastOf;")(new Set([7]));
  expect(toastOf({ kind: "action_pending", payload: { kind: "run-switch", episode: "req:7", wait: "no room until 11/8/2026 16:00" } })).toBe("no room until 11/8/2026 16:00");
  expect(toastOf({ kind: "request_done", payload: { kind: "run-switch", id: 7, result: { ok: true, result: "restarted builder on sonnet on account fresh" } } })).toBe("restarted builder on sonnet on account fresh");
});

for (const role of ["lead", "thinker", "builder", "tester", "reviewer", "researcher"]) {
  test(`${role} restart posts its own role`, async () => {
    const c = control();
    await c.render({ ...builder, role }).values.find((v: unknown) => typeof v === "function")();
    expect(c.posts).toEqual([["api/restart", { project: "project", topic: "demo", wt: "wt-builder", role }]]);
  });
}

test("no worktree, or a role outside the list, gets no Restart item", () => {
  const c = control();
  expect(c.render({ ...builder, wt: "" })).toBeNull();
  expect(c.render({ ...builder, wt: undefined } as any)).toBeNull();
});

for (const state of ["active", "paused"]) {
  test(`project ${state} controls keep the target and confirmation with all labels`, async () => {
    const posts: unknown[] = [], questions: string[] = [];
    const html = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
    const component = new Function("useState", "html", "confirm", "post", "setTimeout", "clearTimeout",
      `let toastTimer; ${cut("pauseLabel")} ${cut("pauseParent")} ${cut("PauseControls")} return PauseControls;`)(
      () => [false, () => {}], html, (q: string) => { questions.push(q); return true; },
      async (...args: unknown[]) => { posts.push(args); return { pause: { state: "paused" } }; }, () => 0, () => {});
    const target = { scope: "project", project: "project" };
    const result = component({ target, pause: { state }, label: "project project", toast: () => {}, all: true });
    const button = result.values.find((v: any) => v && v.strings?.join("").includes("</button>"));
    expect(button.strings.join("")).toContain(state === "active" ? ">Pause " : ">Resume ");
    expect(button.values).toContain("all");
    await button.values.find((v: unknown) => typeof v === "function")();
    expect(posts).toEqual([[state === "active" ? "api/pause" : "api/resume", target]]);
    expect(questions[0]).toBe(state === "active"
      ? "Pause project project? Roles finish their current step and journal a checkpoint before agent terminals close. Worktrees and unfinished files stay."
      : "Resume project project? This clears all role pauses in this scope; the loop starts eligible work fresh from journals.");
  });
}

test("unregistered role has no Restart and the landing fallback is role neutral", () => {
  expect(control().render({ ...builder, role: "unknown" })).toBeNull();
  const toastOf = new Function("mine", cut("toastOf") + "return toastOf;")(new Set([7]));
  expect(toastOf({ kind: "request_done", payload: { kind: "run-switch", id: 7, result: { ok: true } } })).toBe("Restarted");
});
