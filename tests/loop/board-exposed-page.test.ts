// The Exposed list and Open cell of web/board.html (expose-hosted-services U3, R8-R10). The components
// are cut out of the page and run with a fake `html` tag, like the other board-*-page tests; the board JSON
// they read is asserted in tests/board.sh.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const a = page.indexOf("// ---- Exposed (U3) ----"), b = page.indexOf("// ---- end Exposed ----");
const src = page.slice(a, b);
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ str: strings.join("\u0000"), values });
const fmtAge = (m: number) => m + "m";
const mk = (host: string): any => new Function("html", "fmtAge", "location", "React", `${src} return { exposedView, ExposedList, OpenCell, exposedMuted, memberLinks, memberLinkHref };`)(html, fmtAge, { hostname: host }, { useState: (v: any) => [v, () => {}] });
const text = (v: any): string => Array.isArray(v) ? v.map(text).join("") : v && typeof v === "object" && "str" in v
  ? v.str.split("\u0000").map((s: string, i: number) => s + (i < v.values.length ? text(v.values[i]) : "")).join("") : typeof v === "string" || typeof v === "number" ? String(v) : "";
const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === "object" && "str" in v ? [v, ...v.values.flatMap(nodes)] : [];
// The fake tag keeps one flat value list per template, so a `<${Comp} e=${x} />` shows up as a function
// followed by its prop value: render it in place (one prop, named in the string segment after it).
const expand = (v: any): any => {
  if (Array.isArray(v)) return v.map(expand);
  if (!(v && typeof v === "object" && "str" in v)) return v;
  const segs = v.str.split("\u0000"), vals = [...v.values];
  for (let i = 0; i < vals.length; i++) {
    if (typeof vals[i] !== "function" || !segs[i].endsWith("<")) continue;
    const prop = /^\s*(\w+)=$/.exec(segs[i + 1])?.[1];
    if (!prop) continue;
    vals[i] = expand(vals[i]({ [prop]: vals[i + 1] })); vals[i + 1] = "";
  }
  return { ...v, values: vals.map(expand) };
};
const L = mk("board.tail1234.ts.net");
const base = { id: 1, state: "open", name: "app", url: "http://localhost:3000", note: null, role: "tester", age_s: 120, status: null, reach: null, legacy: false };
const anchors = (v: any) => nodes(v).filter((n) => n.str.includes("<a "));

test("remote loopback url is opened on the page's host name", () => {
  expect(L.exposedView({ ...base, status: "up", reach: "remote" }, "board.tail1234.ts.net")).toMatchObject({ href: "http://board.tail1234.ts.net:3000/", badge: "up" });
  expect(L.exposedView({ ...base, url: "http://0.0.0.0:8080/x", status: "up", reach: "remote" }, "h")).toMatchObject({ href: "http://h:8080/x" });
  expect(L.exposedView({ ...base, url: "https://example.com/a", status: "up", reach: "remote" }, "h").href).toBe("https://example.com/a");
});
test("host-only is text with the hint, down is text with the badge, unprobed is a plain link", () => {
  expect(L.exposedView({ ...base, status: "up", reach: "host-only" }, "h")).toMatchObject({ href: null, badge: "host only", hint: expect.any(String) });
  expect(L.exposedView({ ...base, status: "down", reach: "down" }, "h")).toMatchObject({ href: null, badge: "down" });
  expect(L.exposedView(base, "h")).toMatchObject({ href: "http://localhost:3000", badge: null });
});
test("a non-http url is never a link", () => {
  for (const reach of [null, "remote", "host-only"]) expect(L.exposedView({ ...base, url: "javascript:alert(1)", reach, status: reach ? "up" : null }, "h").href).toBeNull();
  const view = expand(L.ExposedList({ items: [{ ...base, url: "javascript:alert(1)" }] }));
  expect(anchors(view)).toHaveLength(0);
  expect(text(view)).toContain("javascript:alert(1)");
});
test("legacy dev env: one entry, no badge, owned by the lead", () => {
  const view = expand(L.ExposedList({ items: [{ ...base, id: 0, name: "dev env", url: "http://localhost:21300", note: "up", role: "lead", legacy: true }] }));
  const t = text(view);
  expect(t).toContain("dev env"); expect(t).toContain("lead"); expect(t).not.toContain("ago");
  expect(anchors(view)).toHaveLength(1);
});
test("detail lists open entries as links; the rest is one muted line, never a link", () => {
  const items = [{ ...base, status: "up", reach: "remote", note: "slot 2" },
    { ...base, id: 2, name: "admin", url: "http://localhost:4000", state: "host-only", status: "up", reach: "host-only" },
    { ...base, id: 3, name: "old", url: "http://localhost:5000", state: "down", status: "down", reach: "down", down_since: 0 },
    { ...base, id: 4, name: "new", url: "http://localhost:5001", state: "checking" }];
  const view = expand(L.ExposedList({ items }));
  const t = text(view);
  expect(t).toContain("app"); expect(t).toContain("slot 2");
  expect(anchors(view)).toHaveLength(1);
  expect(t).toContain("1 down · 1 host only · 1 checking");
  expect(t).not.toContain("xrow mut");   // collapsed: the details are only in the tooltip
  expect(L.exposedMuted(items)).toBe("1 down · 1 host only · 1 checking");
  expect(L.ExposedList({ items: [] })).toBeNull();
});
test("only rest entries: no link, muted line; the box is hidden when there is nothing at all", () => {
  const down = { ...base, state: "down", status: "down", reach: "down" };
  const view = expand(L.ExposedList({ items: [down] }));
  expect(anchors(view)).toHaveLength(0); expect(text(view)).toContain("1 down");
  expect(L.ExposedList({ items: [] })).toBeNull();
});
test("the box is headed Exposed and has no not-exposed text", () => {
  const t = text(expand(L.ExposedList({ items: [{ ...base, status: "up", reach: "remote" }] })));
  expect(t).toContain("Exposed"); expect(t).toContain("pages this squad runs for you");
  expect(t).not.toContain("not exposed");
});
test("the Open cell: count, muted extras, extras alone, empty", () => {
  const cell = (x: any) => text(expand(L.OpenCell({ s: { exposed_summary: x }, onGo() {} })));
  expect(cell({ open: 1, down: 1 })).toMatch(/1.*· 1 down/);
  expect(cell({ open: 1, down: 1 })).not.toContain("not exposed");
  const only = cell({ open: 0, down: 1 });
  expect(only).toContain("· 1 down"); expect(only).not.toContain("0");
  expect(cell({ open: 0, down: 0 }).replace(/<[^>]*>/g, "").trim()).toBe("");
  expect(cell({ open: 2, down: 0 })).toContain("2");
});
test("the page wires the list and the column in, and has no Running now", () => {
  expect(page).toContain("<${ExposedList} items=${s.exposed}");
  expect(page).toContain("<${OpenCell} s=${s}");
  expect(page).not.toContain("RunningNow"); expect(page).not.toContain("Running now");
});
test("a member's links: open entries owned by its label, hrefs through exposedView", () => {
  const s = { exposed: [{ ...base, name: "stack", role: "builder-u6-x", status: "up", reach: "remote" },
    { ...base, id: 2, name: "old", role: "builder-u6-x", state: "down", status: "down", reach: "down" },
    { ...base, id: 3, name: "other", role: "tester" },
    { ...base, id: 0, name: "dev env", role: "lead", legacy: true }] };
  const own = L.memberLinks(s, { label: "builder-u6-x" });
  expect(own.map((e: any) => e.name)).toEqual(["stack"]);
  expect(L.memberLinkHref(own[0])).toBe("http://board.tail1234.ts.net:3000/");
  expect(L.memberLinks(s, { label: "lead" }).map((e: any) => e.name)).toEqual(["dev env"]);
  expect(L.memberLinks(s, { label: "thinker" })).toEqual([]);
  expect(L.memberLinks({}, { label: "lead" })).toEqual([]);
});
test("the page shows the chip, the menu items and the unit window links", () => {
  expect(page).toContain("link-chip"); expect(page).toContain("mlink-item");
  expect(page).toContain("<${MemberLinks} items=${memberLinks(s, bm)}");
});
