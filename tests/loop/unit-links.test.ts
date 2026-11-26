import { expect, test } from "bun:test";
import { linkLabel, unitLinks } from "../../bin/board/unit-links.ts";

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
