import { expect, test } from "bun:test";
import { scan } from "../../bin/backend/orca.ts";

/** The quadratic scan this replaced, kept as the reference for small inputs. */
function oldScan(text: string): { vals: any[]; bad: boolean } {
  const t = text.trim();
  if (t === "") return { vals: [], bad: false };
  try { return { vals: [JSON.parse(t)], bad: false }; } catch { /* stream */ }
  const out: any[] = [];
  let i = 0;
  while (i < t.length) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (i >= t.length) break;
    let end = -1;
    for (let j = t.length; j > i; j--) {
      try { out.push(JSON.parse(t.slice(i, j))); end = j; break; } catch { /* shorter */ }
    }
    if (end < 0) return { vals: out, bad: true };
    i = end;
  }
  return { vals: out, bad: false };
}

const cases = [
  "", "  \n", '{"a":1}', '{"a":1}\n{"b":[1,2]}\n', '{"a":1} {"b":2}   [3]', '{"a":1}\nstray',
  '{"a":1}\n{"b":', '{"a":"x\\"}{y"}\n{"c":"\\\\"}', '"s" "t\\"u"', "1 2 3", "true false null",
  '{"a":1} 7 "x" null', "[1,2]3", "{a}", '{"a":1}\n{a}\n{"b":2}', '{"a":"unterminated}', '[[],{}] [] {}',
  "-1.5e3 0", '{"a":1}}', "nul",
];
test("scan matches the old scan on small inputs", () => {
  for (const c of cases) expect({ c, r: scan(c) }).toEqual({ c, r: oldScan(c) });
});

test("scan reads ten 500KB documents in one pass", () => {
  const doc = JSON.stringify({ result: { workers: Array.from({ length: 5000 }, (_, i) => ({ dispatchId: `d${i}`, note: "x".repeat(80), q: '"{}' })) } });
  expect(doc.length).toBeGreaterThan(450_000);
  const text = Array(10).fill(doc).join("\n");
  const t0 = performance.now();
  const s = scan(text);
  expect(performance.now() - t0).toBeLessThan(200);
  expect(s.bad).toBe(false);
  expect(s.vals.length).toBe(10);
});
