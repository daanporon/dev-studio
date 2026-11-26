import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard } from "../../bin/board/board-data.ts";
import { linkLabel, ticketLink, unitLinks } from "../../bin/board/unit-links.ts";
import { open } from "../../bin/loop/core/store.ts";

test("linkLabel: a Linear or Jira id, owner/repo#n for GitHub, else the host name", () => {
  expect(linkLabel("https://linear.app/acme/issue/ABC-1/some-title")).toBe("ABC-1");
  expect(linkLabel("https://tracker.example/issue/ABC-2")).toBe("ABC-2");
  expect(linkLabel("https://acme.atlassian.net/browse/PRJ_X-12?focused=1")).toBe("PRJ_X-12");
  expect(linkLabel("https://github.com/acme/app/issues/7")).toBe("acme/app#7");
  expect(linkLabel("https://www.github.com/acme/app/pull/8/files#top")).toBe("acme/app#8");
  expect(linkLabel("https://github.com/acme/app")).toBe("github.com");
  expect(linkLabel("https://tracker.example/acme/app/issues/7")).toBe("tracker.example");
  expect(linkLabel("https://example.org/page")).toBe("example.org");
  expect(linkLabel("https://tracker.example/issue/7")).toBe("tracker.example");
});

test("unitLinks: only http(s) URLs reach the board", () => {
  const bad = ["javascript:alert(1)", "data:text/html,x", "file:///etc/hosts", "not a url", "http://", "https:example.org", "", 7, null];
  expect(unitLinks([...bad, "HTTP://example.org/a"])).toEqual([{ url: "HTTP://example.org/a", label: "example.org" }]);
  expect(unitLinks(undefined)).toEqual([]);
  expect(unitLinks("https://example.org")).toEqual([]);
});

test("unitLinks: a URL with a login never reaches the board", () => {
  const login = ["https://user:pw@tracker.example/x", "https://user@tracker.example/x", "https://:pw@tracker.example/x"];
  expect(unitLinks(login)).toEqual([]);
  expect(unitLinks([...login, "https://tracker.example/issue/ABC-1"])).toEqual([{ url: "https://tracker.example/issue/ABC-1", label: "ABC-1" }]);
});

const TPL = "https://tracker.example/issue/{id}";

test("ticketLink: a leading [ID], else a single trailing one; # leaves the URL, not the label", () => {
  const abc = { url: "https://tracker.example/issue/ABC-12", label: "ABC-12" };
  expect(ticketLink("[ABC-12] Do the thing", TPL)).toEqual(abc);
  expect(ticketLink("Do the thing [ABC-12]", TPL)).toEqual(abc);
  expect(ticketLink("[ABC-12] `u1-x` thing [DEF-3]", TPL)).toEqual(abc);
  expect(ticketLink("[WIP] Do the thing [ABC-12]", TPL)).toEqual(abc);
  expect(ticketLink("[#12] Fix x", "https://tracker.example/issues/{id}")).toEqual({ url: "https://tracker.example/issues/12", label: "#12" });
  expect(ticketLink("[12] Fix x", "https://tracker.example/?a={id}&b={id}")!.url).toBe("https://tracker.example/?a=12&b=12");
  for (const t of ["Do [ABC-12] the thing", "Do the thing [ABC-1] [ABC-2]", "[WIP] Do the thing", "[ABC-12/..] x", "[ABC] x", "plain", null])
    expect([t, ticketLink(t, TPL)]).toEqual([t, null]);
  for (const tpl of [null, "-", "https://tracker.example/issue/", "javascript:alert({id})", "ftp://tracker.example/{id}"])
    expect([tpl, ticketLink("[ABC-12] x", tpl)]).toEqual([tpl, null]);
  expect(ticketLink("[ABC-12] x", "https://tracker.example:{id}/x")).toBeNull();
});

test("unitLinks: the ticket link comes first, and a plan link with its URL is not shown twice", () => {
  const ticket = ticketLink("[ABC-12] x", TPL);
  const plan = ["https://example.org/a", "HTTPS://TRACKER.EXAMPLE/issue/ABC-12"];
  expect(unitLinks(plan, ticket).map((l) => l.label)).toEqual(["ABC-12", "example.org"]);
  expect(unitLinks(undefined, ticket)).toEqual([ticket!]);
  const five = [1, 2, 3, 4, 5].map((n) => `https://example.org/${n}`);
  expect(unitLinks(five, ticket)).toHaveLength(6);
});

test("the board: a project's ticket_url links its [ID] titles; a project without it shows no chip", () => {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardticket-"));
  try {
    for (const p of ["p", "q"]) {
      mkdirSync(join(root, p, "squads"), { recursive: true });
      const units = [{ slug: "u1", status: "planned", deps: [], title: "[ABC-12] Do the thing" }, { slug: "u2", status: "planned", deps: [], title: "Do the thing [ABC-12]" }];
      writeFileSync(join(root, p, "squads", "a.json"), JSON.stringify({ task_id: "a", run_id: `run_${p}`, repo: `path:/r/${p}`, status: "running", members: [], units, worktrees: [] }));
    }
    const r = spawnSync(join(import.meta.dir, "../../bin/ds"), ["import"], { env: { ...process.env, DS_STATE_ROOT: root }, encoding: "utf8" });
    expect(r.status).toBe(0);
    const s = open(root);
    s.upsert("config", { project: "p", file: "limits.conf", key: "ticket_url" }, { value: TPL, observed_at: 1 });
    s.close();
    const links = (p: string) => (buildBoard(p, "", root) as any).squads[0].units.map((u: any) => u.links);
    const chip = [{ url: "https://tracker.example/issue/ABC-12", label: "ABC-12" }];
    expect(links("p")).toEqual([chip, chip]);
    expect(links("q")).toEqual([[], []]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
