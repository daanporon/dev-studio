// redact.ts — secret-shaped strings out of text before it is written to loop.db (KTD3: redaction at write
// time, so loop.db never holds an unredacted copy): observed_chat, screen tails, last replies, relayed mail,
// permission cards. Only the secret becomes `[redacted]`: a `Bearer` or another scheme word, a header's or a
// flag's name and a URL's user stay. A PEM private-key block with no END line (cut text) is redacted to the end,
// and an END line whose BEGIN was cut off (a screen's top) is redacted from the start. Not covered, on purpose:
// `mysql -pSECRET` and other one-letter flags, an unquoted value with spaces around `=` (an INI file's), and a
// secret with no name or shape around it.
export const REDACTED = "[redacted]";

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
];

// A value: quoted (to its closing quote, or the line's end on a cut screen; a quote followed by a space is
// taken as the end of an outer string, not the start of a value), else up to a space or a shell
// metacharacter, so the command around a secret stays readable. The first quoted form is `\"…\"`, a string
// inside a quoted JSON body; a bare value is never the backslash that opens or closes one.
const BARE = "[^\\s\"'`;|&<>()]+";
const QUOTED = String.raw`\\{1,8}"(?!\s)(?:(?!\\{1,8}")[^"\r\n])+(?:\\{1,8}")?|"(?!\s)(?:\\.|[^"\\\r\n])+"?|'(?!\s)[^'\r\n]+'?`;
const VALUE = `${QUOTED}|(?!\\\\{1,8}["'])${BARE}`;

// `$NAME`, `${NAME}` and `$(…)` name a secret without holding it. In single quotes the shell keeps them as text.
const isRef = (v: string) => /^(?:\\*")?\$/.test(v);
/** The value with its quotes kept and what they hold replaced. */
function hide(v: string): string {
  const q = /^(?:\\+"|["'])/.exec(v)?.[0] ?? "";
  return q ? `${q}${REDACTED}${v.length > q.length && v.endsWith(q) ? q : ""}` : REDACTED;
}

// Headers whose value is a credential, whatever the scheme. Digest and AWS4 carry a list of parameters.
const HEADER = "(?:proxy-)?authorization|x-api-key|api-key|x-auth-token";
const PARAMS = `(?:[\\w-]+=(?:\\\\?"[^"\\r\\n]*"|[^\\s,"']+),?[ \\t]*)+`;
const HEADER_RE = new RegExp(
  `(?<![\\w-])((?:${HEADER})\\\\?["']?[ \\t]*:[ \\t]*\\\\?["']?)` +
  `(?:((?:digest|aws4-hmac-sha256)[ \\t]+)(${PARAMS})|([A-Za-z][\\w-]*[ \\t]+(?=[^\\s"'\\\\]))?(${BARE.replace("^", "^\\\\")}))`, "gi");

// A name that holds one of these words, unless its last part says it holds something else (`--token-file`,
// `secret_scanning`, `token.ts`).
const KEY = "(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)";
const NOT_A_SECRET = new Set(("file files path dir stdin env name names type url uri prompt ttl expiry expires expiration length len limit " +
  "count cache scanning protection bucket helper endpoint command cmd store method source policy field var ref tokenizer " +
  "ts js sh json md py yml yaml toml txt log").split(" "));
const PLAIN = /^[\\"']*(?:true|false|null|none|undefined|yes|no|str|bytes|string|number|boolean)[\\"',]*$/i;
function secretName(name: string): boolean {
  if (name === "PWD" || name === "OLDPWD" || /^--no-/i.test(name)) return false; // the shell's folders; a switch
  const last = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().split(/[-_.]+/).filter(Boolean).pop() ?? "";
  return !NOT_A_SECRET.has(last);
}
function keepValue(name: string, v: string): boolean {
  // `max_tokens: 4096` is a count.
  return isRef(v) || PLAIN.test(v) || (/tokens/i.test(name) && /^["']?\d+["',]*$/.test(v));
}
const NAME = `(?<![\\w.-])(?=[\\w.-]*?${KEY})([\\w.-]+)`;
// `NAME=value` and `--name=value`; `name: value`, `"name": "value"` (JSON); `--name value`. With spaces around the
// sign, a quoted key or a type between (`password = "x"`, `'password' => 'x'`, `apiKey: string = "x"`) only a
// quoted value counts, so prose and `token == other` stay.
// A type as an annotation writes it: `str`, `Optional[str]`, `Map<string, string>`, `str | None`.
// A bracket body nests to 5 levels and no level can run past its closer: a body that could would overlap the
// union, backtrack exponentially, and the replace would then silently stop matching.
const nested = (open: string, close: string, plain: string, depth: number): string =>
  `${open}(?:${plain}${depth > 1 ? `|${nested(open, close, plain, depth - 1)}` : ""}){0,80}${close}`;
const SQUARE = nested(String.raw`\[`, String.raw`\]`, String.raw`[\w., |]`, 5);
const ANGLE = nested("<", ">", String.raw`[\w., |\[\]]`, 5);
const TYPE_NAME = String.raw`[A-Za-z_][\w.]*(?:${SQUARE}|${ANGLE})?\??`;
const TYPES = String.raw`${TYPE_NAME}(?:[ \t]*\|[ \t]*${TYPE_NAME})*`;
const SPACED = String.raw`(?:\\*["'])?(?:(?:[ \t]*:[ \t]*${TYPES})?[ \t]*(?::=|=>|=(?!=))|[ \t]*:)[ \t]*`;
// In `name: Type = "x"` the word after the colon is the type; the spaced form hides what is assigned.
const NOT_TYPED = String.raw`(?![ \t]*${TYPES}[ \t]*=(?!=)[ \t]*["'])`;
const ASSIGNS = [
  new RegExp(`${NAME}(=(?!=))(${VALUE})`, "gi"),
  new RegExp(`${NAME}(${SPACED})(${QUOTED})`, "gi"),
  new RegExp(`${NAME}(${String.raw`\\*["']?:(?:[ \t]+|(?=\\*["']))`})${NOT_TYPED}(${VALUE})`, "gi"),
  new RegExp(`(?<![\\w.-])(?=--[\\w-]*?${KEY})(--[\\w-]+)([ \\t]+)(?!-)(${VALUE})`, "gi"),
];

// The password in `scheme://user:password@host`; the user may be an email address.
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#:"'`]*:)([^\s/?#"'`]+)(?=@)/gi;
// `-u user:password` and `--user user:password`: the whole login quoted (the password runs to the closing quote,
// spaces and all), else the password quoted or bare. `1000:1000` (docker) and `+%H:%M` (date) are no login.
const USER_PRE = String.raw`(?<!\S)(?:-u|--user)(?:[ \t]+|=)?`;
const USER = "[^\\s:\"'`$+%/=-][^\\s:\"'`/=]*:";
const USER_FLAGS = [
  new RegExp(`(${USER_PRE}")(${USER})(${String.raw`(?:\\.|[^"\\\r\n])+`})`, "g"),
  new RegExp(`(${USER_PRE}')(${USER})([^'\\r\\n]+)`, "g"),
  new RegExp(`(${USER_PRE})(${USER})(${VALUE})`, "g"),
];

export function redact(text: string): string {
  let out = text;
  for (const re of SHAPES) out = out.replace(re, REDACTED);
  out = out.replace(HEADER_RE, (all, head, listScheme, list, scheme = "", value) => {
    if (list !== undefined) return `${head}${listScheme}${REDACTED}`;
    return isRef(value) ? all : `${head}${scheme}${REDACTED}`;
  });
  out = out.replace(URL_CREDS, (all, head, pw) => (isRef(pw) ? all : `${head}${REDACTED}`));
  for (const re of USER_FLAGS) {
    out = out.replace(re, (all, flag: string, user, pw) => {
      const literal = flag.endsWith("'"); // the shell expands nothing in single quotes
      // A substitution runs, so it stays on the card; an escaped `\$(` or backtick is text.
      return (!literal && !pw.startsWith("'") && (isRef(pw) || /\$\(|`/.test(pw.replace(/\\./g, "")))) || /^\d+:\d+$/.test(user + pw) ? all : `${flag}${user}${hide(pw)}`;
    });
  }
  for (const re of ASSIGNS) {
    out = out.replace(re, (all, name, sep, value) => (!secretName(name) || keepValue(name, value) ? all : `${name}${sep}${hide(value)}`));
  }
  return out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
}

const KEY_NAME = new RegExp(KEY, "i");
const HEADER_NAME = new RegExp(`^(?:${HEADER})$`, "i");
// Is a JSON value secret by its key alone (`{"password": "x"}`, `{"Authorization": "Basic x"}`)?
const secretEntry = (k: string, v: unknown): boolean =>
  typeof v === "string" && v !== "" && !isRef(v) && (HEADER_NAME.test(k) || (KEY_NAME.test(k) && secretName(k) && !keepValue(k, v)));

/** `redact` over every string in a JSON value (keys kept), so a payload stays valid JSON; a string under a
 *  secret's key is redacted whole. */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, secretEntry(k, x) ? REDACTED : redactDeep(x)])) as T;
  return v;
}

/** A stored payload (JSON text or plain text) redacted: parsed and rebuilt when it is JSON, else as text. */
export function redactPayload(p: string | null): string | null {
  if (p == null) return null;
  try { return JSON.stringify(redactDeep(JSON.parse(p))); } catch { return redact(p); }
}
