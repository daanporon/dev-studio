// redact.test.ts — permission-prompt-needs-you U4: passwords, login headers and URL credentials are
// [redacted] with the words around them kept, and text that only mentions such a word is left alone.
// (Token and key shapes: chat-tail.test.ts.)
import { describe, expect, test } from "bun:test";
import { redact, redactDeep, redactPayload } from "../../bin/loop/core/redact.ts";

const R = "[redacted]";
// [text, redacted]; every secret in them is made up and holds "zz".
const SHAPES: [string, string][] = [
  ["curl -H 'Authorization: Basic eno6enp6eg==' https://api.example.com", `curl -H 'Authorization: Basic ${R}' https://api.example.com`],
  ['curl -H "Proxy-Authorization: Basic eno6enp6eg==" x', `curl -H "Proxy-Authorization: Basic ${R}" x`],
  ["Authorization: token zzabc123", `Authorization: token ${R}`],
  ["authorization: zzopaque123; ls", `authorization: ${R}; ls`],
  [`-H 'Authorization: Digest username="zz", response="zz99"' && ls`, `-H 'Authorization: Digest ${R}' && ls`],
  ['{"Authorization": "Basic zzzz"}', `{"Authorization": "Basic ${R}"}`],
  ["-H 'X-Api-Key: zzk123'", `-H 'X-Api-Key: ${R}'`],
  ["Api-Key: zzk123", `Api-Key: ${R}`],
  ["-H 'X-Auth-Token: zzk123' x", `-H 'X-Auth-Token: ${R}' x`],
  ["git clone https://bob:zzhunter2@example.com/r.git", `git clone https://bob:${R}@example.com/r.git`],
  ["redis://:zzhunter2@localhost:6379/0", `redis://:${R}@localhost:6379/0`],
  ["postgres://app:zz@hunter2@db.example.com/x", `postgres://app:${R}@db.example.com/x`],
  ["curl -u admin:zzhunter2 https://example.com", `curl -u admin:${R} https://example.com`],
  ["curl --user admin:zzhunter2 x", `curl --user admin:${R} x`],
  ["curl --user=admin:zzhunter2 x", `curl --user=admin:${R} x`],
  ["curl -u 'admin:zzhunter2' x", `curl -u 'admin:${R}' x`],
  ["PGPASSWORD=zzhunter2 psql -h db", `PGPASSWORD=${R} psql -h db`],
  ["export DB_PASSWD='zz hunter2'; ls", `export DB_PASSWD='${R}'; ls`],
  ["MYSQL_PWD=zzhunter2 mysqldump x", `MYSQL_PWD=${R} mysqldump x`],
  ["client_secret=zzs3&grant=x", `client_secret=${R}&grant=x`],
  ["GH_TOKEN=zzs3 gh pr list", `GH_TOKEN=${R} gh pr list`],
  ["https://example.com/a?access_token=zzs3&p=1", `https://example.com/a?access_token=${R}&p=1`],
  ["tool --password=zzhunter2 run", `tool --password=${R} run`],
  ["tool --password zzhunter2 run", `tool --password ${R} run`],
  ['tool --api-key "zzs3" run', `tool --api-key "${R}" run`],
  ["tool --apiKey zzs3", `tool --apiKey ${R}`],
  ["password: zzhunter2", `password: ${R}`],
  ["  aws_secret_access_key: zzs3/abc+d", `  aws_secret_access_key: ${R}`],
  ['{"client_secret":"zz s3","n":1}', `{"client_secret":"${R}","n":1}`],
  ["PASSWORD='zzcut", `PASSWORD='${R}`],
  ["PASSWORD='$zzliteral' x", `PASSWORD='${R}' x`],
  ["API_KEY=zzs3\nls -la", `API_KEY=${R}\nls -la`],
  // Spaced, quoted-key and typed assignments, as an Edit or Write card's new text has them.
  ['DB_PASSWORD = "zz pass"', `DB_PASSWORD = "${R}"`],
  ["password = 'zzpass'", `password = '${R}'`],
  ['{"password" : "zzpass"}', `{"password" : "${R}"}`],
  ["'password' => 'zzpass',", `'password' => '${R}',`],
  ['password := "zzpass"', `password := "${R}"`],
  ['const apiKey: string = "zzpass";', `const apiKey: string = "${R}";`],
  ["token: str | None = 'zzpass'", `token: str | None = '${R}'`],
  ['password: Optional[str] = "zzpass"', `password: Optional[str] = "${R}"`],
  ['api_key: SecretStr = "zzpass"', `api_key: SecretStr = "${R}"`],
  ["const token: Token = 'zzpass';", `const token: Token = '${R}';`],
  ['secret: Union[str, None] = "zzpass"', `secret: Union[str, None] = "${R}"`],
  ['const secrets: Map<string, string[]> | null = "zzpass";', `const secrets: Map<string, string[]> | null = "${R}";`],
  ['password: zzpass user="bob"', `password: ${R} user="bob"`],
  // A JSON body inside a double-quoted shell argument.
  [String.raw`curl -d "{\"password\":\"zzpass\"}" x`, String.raw`curl -d "{\"password\":\"[redacted]\"}" x`],
  [String.raw`curl -d "{\"password\": \"zz pass\"}" x`, String.raw`curl -d "{\"password\": \"[redacted]\"}" x`],
  [String.raw`tool --password=\"zzpass\" x`, String.raw`tool --password=\"[redacted]\" x`],
  [String.raw`{"password":"zz\"tail9","n":1}`, `{"password":"${R}","n":1}`],
  // A quoted password after -u, or the whole login quoted.
  ["curl -u admin:'zzpass' x", `curl -u admin:'${R}' x`],
  ['curl -u admin:"zz pass" x', `curl -u admin:"${R}" x`],
  ["curl -u 'admin:zz pa;ss&zz|(zz)<zz>' x", `curl -u 'admin:${R}' x`],
  ['curl --user "admin:zz pass;word" x', `curl --user "admin:${R}" x`],
  ["curl -u 'admin:$zzliteral' x", `curl -u 'admin:${R}' x`],
  ["git clone https://bob@corp.example.com:zzpass@example.com/r", `git clone https://bob@corp.example.com:${R}@example.com/r`],
];

// Text that stays as it is.
const KEPT = [
  "gh auth login --with-token < token.txt",
  "tool --token-file /run/tok run",
  "tool --token-file=/run/tok",
  "docker login --password-stdin registry.example.com",
  "psql --no-password mydb",
  "Type your password and press enter. The password is wrong.",
  "Password: ",
  "turn on secret_scanning for the repo",
  "secret_scanning: enabled",
  "git clone https://bob@example.com/r.git",
  "open http://localhost:3000/@scope/pkg",
  "name: zzvalue\nuser: bob\nauthor: someone",
  "max_tokens: 4096",
  "DS_TOKEN_CACHE=0 ls",
  "PWD=/home/user/work OLDPWD=/tmp",
  "GH_TOKEN=$(gh auth token) gh pr list",
  'curl -H "Authorization: Bearer $TOKEN" x',
  'curl -u "$USER:$PASS" x',
  'curl -u admin:"$PASS" x',
  'curl -u "admin:$PASS" x',
  String.raw`curl -d "{\"password\":\"$PASS\"}" x`,
  'if (token === "x") return;',
  'if password != "x": pass',
  'docker run -u "1000:1000" img',
  "  token = get_token(env)",
  "the password = what you typed",
  "  self.token = token",
  'curl -u "admin:`cat /tmp/pw`" x',
  'curl -u "admin:x$(cat /tmp/pw)" x',
  "ssh://git@example.com:22/r.git",
  "PGPASSWORD=\"$DB_PASS\" psql",
  "docker run -u 1000:1000 img",
  "date -u +%H:%M",
  "git push -u origin HEAD:work",
  "mysql -pzzflag",
  "if (token == other) return;",
  "interface A { token: string }",
  "grep 'password=' app.log && rm -rf ./build",
  'grep "token=" app.log; echo "done"',
  "see bin/lib/token.ts: 12 lines",
];

describe("redact: passwords, login headers and URL credentials", () => {
  test.each(SHAPES)("%s", (text, want) => {
    expect(redact(text)).toBe(want);
    expect(redact(want)).toBe(want); // a second pass changes nothing
  });
  test.each(KEPT)("left alone: %s", (text) => expect(redact(text)).toBe(text));
  test("redactDeep redacts a string under a secret's key, and keeps the others", () => {
    expect(redactDeep({ password: "zz1", env: { API_KEY: "zz2", Authorization: "Basic zz3" }, token_file: "/run/t", max_tokens: "10", pwd_ref: 3, note: "ok", secret: "" }))
      .toEqual({ password: R, env: { API_KEY: R, Authorization: R }, token_file: "/run/t", max_tokens: "10", pwd_ref: 3, note: "ok", secret: "" });
    expect(redactPayload('{"password":"zz1"}')).toBe(`{"password":"${R}"}`);
  });
  test("a long unbroken run is scanned in good time", () => {
    const text = `${"token".repeat(4000)} ${"a".repeat(100_000)} ${"-".repeat(20_000)}`;
    const t = performance.now();
    redact(text);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
