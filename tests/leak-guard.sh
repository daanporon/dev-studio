#!/usr/bin/env bash
# leak-guard.sh — keeps private words off the repo. Five modes, one set of rules:
#   (no argument)              every tracked file of the checkout, as it is on disk (what tests/ci.sh runs);
#   --staged                   the staged blobs that differ from HEAD: the index git is committing, read from the
#                              inherited GIT_INDEX_FILE (`index.lock` for `git commit -a`), so a pre-commit hook sees
#                              exactly what lands in the commit;
#   --commits <rev-list args>  every blob any commit in the range adds or changes, not only the tip, so a file added
#                              then deleted inside the range still fails;
#   --messages <rev-list args> the commit messages in the range;
#   --text <file>              any text file (a PR body, a comment).
# The rules:
#   1. a `@gmail.com` address;
#   2. a `*.ts.net` host other than the example ones (`*.tail1234.ts.net`, `*.example.ts.net`);
#   3. a `/home/<name>/` or `/Users/<name>/` path whose name is not a made-up one (user, me, u, x, other, demo,
#      and the `/home/ce/`, `/home/plugins/`, `/home/projects/` folders inside a profile path);
#   4. any word of the host-local list, one per line (`#` comments and blank lines ignored; matched
#      case-insensitively as plain text). The list is `$DS_LEAK_WORDS`, else
#      `${XDG_CONFIG_HOME:-~/.config}/dev-studio/leak-words.txt`, outside every clone, so the operator's emails and
#      names never reach the repo and every clone on the machine reads one list. While that file is missing, the
#      old place `~/.dev-studio/state/leak-words.txt` is read, with one line asking for the move. In the four new
#      modes a missing or empty list is itself a hit ("no host-local word list"), never a pass; the full scan only
#      notes it, since GitHub CI has no list;
#   5. a SQLite database or WAL file (the `SQLite format 3` header or the WAL magic 377f0682/377f0683, plain or
#      inside gzip) always fails, whatever its name;
#   6. a file the guard cannot read as text after gzip decompression (a NUL in its first 8 KB, or a picture
#      extension png, jpg, jpeg, gif, webp, pdf) fails unless `tests/leak-guard.allow` lists its path with its
#      git blob hash. That line records that someone opened that exact version and checked it for rules 1-4; add
#      one only after doing that. The allow file is read from the same place as the files: the disk (full scan),
#      the index (--staged), the range's commits (--commits).
# A hit names the file (or commit) and line and its kind, never the matched value, so a log does not publish it.
# A made-up value that trips a shape is changed in place; do not widen the allow lists above for it.
# Env: LEAK_GUARD_ROOT (repo to scan; default this checkout for the full scan, the current repo for the other
# modes), DS_LEAK_WORDS, XDG_CONFIG_HOME, HOME.
# The full scan ends with a self-test: it plants each case in a temp repo and checks every mode catches it
# (LEAK_GUARD_SELFTEST=0 skips it). The self-test unsets GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE,
# GIT_OBJECT_DIRECTORY and GIT_COMMON_DIR first, so it never touches the caller's repo.
set -uo pipefail
command -v python3 > /dev/null || { echo 'FAIL leak-guard: python3 is needed'; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo 'usage: leak-guard.sh [--staged | --commits <rev-list args> | --messages <rev-list args> | --text <file>]' >&2
  exit 2
}

read -r -d '' PY << 'PYEOF' || true
import gzip, os, re, subprocess, sys, threading

mode, here, args = sys.argv[1], sys.argv[2], sys.argv[3:]
repo = os.environ.get("LEAK_GUARD_ROOT") or (here if mode == "full" else "")
ALLOW = "tests/leak-guard.allow"
PICS = {"png", "jpg", "jpeg", "gif", "webp", "pdf"}
WAL = (b"\x37\x7f\x06\x82", b"\x37\x7f\x06\x83")
email = re.compile(r"[A-Za-z0-9._%+-]+@gmail\.com", re.I)
tsnet = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net", re.I)
home = re.compile(r"/(?:home|Users)/[A-Za-z][A-Za-z0-9_-]*/")
okhost = re.compile(r"(^|\.)(tail1234|example)\.ts\.net$", re.I)
okhome = {"user", "me", "u", "x", "other", "demo", "ce", "plugins", "projects"}
hits = []
# Read the objects a push sends, never what a replace ref shows in their place.
os.environ["GIT_NO_REPLACE_OBJECTS"] = "1"

class ScanError(Exception):
    pass

def git(*a, data=None, ok=(0,)):
    cmd = ["git"] + (["-C", repo] if repo else []) + list(a)
    p = subprocess.run(cmd, input=data, capture_output=True)
    if p.returncode not in ok:
        err = p.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ScanError(f"git {a[0]}: {err[0] if err else 'exit ' + str(p.returncode)}")
    return p.stdout

OLD_WORDS = os.path.join(os.path.expanduser("~"), ".dev-studio", "state", "leak-words.txt")

def words_path():
    w = os.environ.get("DS_LEAK_WORDS")
    if w:
        return w
    cfg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    new = os.path.join(cfg, "dev-studio", "leak-words.txt")
    if not os.path.exists(new) and os.path.isfile(OLD_WORDS):
        print(f"leak-guard: using the old word list {OLD_WORDS}; move it to {new}", file=sys.stderr)
        return OLD_WORDS
    return new

def load_words():
    try:
        lines = open(words_path(), encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return []
    return [w.strip().lower() for w in lines if w.strip() and not w.strip().startswith("#")]

WORDS = load_words()

def parse_allow(text):
    out = set()
    for line in text.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            parts = line.split(None, 1)
            if len(parts) == 2:
                out.add((parts[0], parts[1].strip()))
    return out

# kinds_in: the kind of each rule 1-4 hit in one line of text.
def kinds_in(line):
    kinds = ["a gmail address" for _ in email.finditer(line)]
    kinds += ["a ts.net host outside the example ones" for m in tsnet.finditer(line) if not okhost.search(m.group(0))]
    kinds += ["a home path outside the made-up names" for m in home.finditer(line) if m.group(0).split("/")[2] not in okhome]
    low = line.lower()
    if any(w in low for w in WORDS):
        kinds.append("a word of the host-local list")
    return kinds

def scan_text(where, text):
    for n, line in enumerate(text.splitlines(), 1):
        for kind in kinds_in(line):
            hits.append(f"{where}:{n}: {kind}")

# named: the label a file's hits start with. A path that itself holds a private value is a hit of its own,
# and is then never printed: the label names the blob instead.
def named(path, blob):
    kinds = kinds_in(path)
    if not kinds:
        return path
    label = f"<path withheld> (blob {blob[:12]})"
    for kind in dict.fromkeys(kinds):
        hits.append(f"{label}: the path holds {kind}")
    return label

# check_file: rules 1-6 on one file's bytes. allowed() answers rule 6 (None: nothing can be allowed).
def check_file(name, data, label, allowed):
    inner, where = data, label
    if name.endswith(".gz") or data[:2] == b"\x1f\x8b":
        try:
            inner = gzip.decompress(data)
            where = label + " (inside .gz)"
        except Exception as e:
            if name.endswith(".gz"):
                hits.append(f"{label}: unreadable ({type(e).__name__})")
                return
    if inner[:16] == b"SQLite format 3\0" or inner[:4] in WAL:
        hits.append(f"{where}: a SQLite database or WAL file")
        return
    base = os.path.basename(name[:-3] if name.endswith(".gz") else name)
    ext = base.rsplit(".", 1)[1].lower() if "." in base else ""
    if b"\0" in inner[:8192] or ext in PICS:
        # A SQLite header anywhere in a file that is not text (a database inside a tar) is never allowed either.
        if b"SQLite format 3\0" in inner:
            hits.append(f"{where}: holds a SQLite database")
        elif allowed is None:
            hits.append(f"{label}: not text")
        elif not allowed():
            hits.append(f"{label}: not text and not listed in {ALLOW}")
        return
    scan_text(where, inner.decode("utf-8", "replace"))

# blobs: (sha, path, label suffix) -> reads each with one `git cat-file --batch`, yields (item, bytes or None).
def blobs(items):
    if not items:
        return
    cmd = ["git"] + (["-C", repo] if repo else []) + ["cat-file", "--batch"]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    def feed():
        try:
            p.stdin.write(b"".join(i[0].encode() + b"\n" for i in items))
        finally:
            p.stdin.close()
    t = threading.Thread(target=feed)
    t.start()
    for item in items:
        head = p.stdout.readline().split()
        if len(head) < 2:
            raise ScanError("git cat-file: short read")
        if head[1] == b"missing":
            yield item, None
            continue
        size = int(head[2])
        data = p.stdout.read(size)
        if len(data) != size:
            raise ScanError("git cat-file: short read")
        p.stdout.read(1)
        yield item, data
    t.join()
    if p.wait() != 0:
        raise ScanError(f"git cat-file: exit {p.returncode}")

def check_blobs(items, allow):
    for (sha, path, suffix), data in blobs(items):
        label = named(path, sha) + suffix
        if data is None:
            hits.append(f"{label}: unreadable (missing object)")
            continue
        check_file(path, data, label, lambda sha=sha, path=path: (sha, path) in allow)

def mode_full():
    try:
        allow = parse_allow(open(os.path.join(repo, ALLOW), "rb").read())
    except OSError:
        allow = set()
    for f in git("ls-files", "-z").split(b"\0"):
        if not f:
            continue
        name = f.decode("utf-8", "replace")
        path = os.path.join(repo, name)
        label = named(name, git("hash-object", "--", path).decode().strip()) if kinds_in(name) else name
        try:
            if os.path.islink(path):
                data = os.readlink(path).encode()  # git stores the link text, not the target
            elif os.path.isfile(path):
                data = open(path, "rb").read()
            else:
                continue
        except OSError as e:
            hits.append(f"{label}: unreadable ({type(e).__name__})")
            continue
        check_file(name, data, label, lambda path=path, name=name: (git("hash-object", "--", path).decode().strip(), name) in allow)

# raw_entries: parse `--raw -z` diff output (diff-index, or diff-tree --stdin with commit ids; combined -c
# headers too) into (commit or None, new blob sha, path) for each added or changed blob.
def raw_entries(out):
    toks = out.split(b"\0")
    commit, i = None, 0
    while i < len(toks):
        tok = toks[i].decode("utf-8", "replace")
        i += 1
        if not tok:
            continue
        if not tok.startswith(":"):
            commit = tok.strip()
            continue
        p = len(tok) - len(tok.lstrip(":"))
        fields = tok.lstrip(":").split()
        path = toks[i].decode("utf-8", "replace") if i < len(toks) else ""
        i += 1
        mode_, sha = fields[p], fields[2 * p + 1]
        if set(sha) == {"0"} or mode_ in ("160000", "000000"):
            continue
        yield commit, sha, path

def mode_staged():
    head = git("rev-parse", "--verify", "-q", "HEAD^{commit}", ok=(0, 1)).strip()
    base = head.decode() if head else git("hash-object", "-t", "tree", "--stdin", data=b"").decode().strip()
    out = git("diff-index", "--cached", "-z", "--raw", "--no-renames", "--no-abbrev", base)
    allow = parse_allow(git("cat-file", "blob", ":" + ALLOW, ok=(0, 128)))
    items = [(sha, path, "") for _, sha, path in raw_entries(out)]
    check_blobs(items, allow)
    return len(items)

def mode_commits():
    commits = git("rev-list", *args).decode().split()
    if not commits:
        return 0
    out = git("diff-tree", "--stdin", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "--root", "-c", data=("\n".join(commits) + "\n").encode())
    allow = set()
    for (_, _, _), data in blobs([(c + ":" + ALLOW, "", "") for c in commits]):
        if data is not None:
            allow |= parse_allow(data)
    seen, items = set(), []
    for commit, sha, path in raw_entries(out):
        if (sha, path) not in seen:
            seen.add((sha, path))
            items.append((sha, path, f" (commit {(commit or '?')[:12]})"))
    check_blobs(items, allow)
    return len(commits)

def mode_messages():
    out = git("-c", "log.showSignature=false", "log", "-z", "--no-color", "--format=%H%n%B", *args)
    n = 0
    for rec in out.split(b"\0"):
        rec = rec.decode("utf-8", "replace")
        if not rec.strip():
            continue
        sha, _, body = rec.partition("\n")
        n += 1
        scan_text(f"commit {sha.strip()[:12]} message", body)
    return n

def mode_text():
    if len(args) != 1:
        raise ScanError("--text takes one file")
    try:
        data = open(args[0], "rb").read()
    except OSError as e:
        raise ScanError(f"{args[0]}: unreadable ({type(e).__name__})")
    check_file(args[0], data, args[0], None)
    return 1

try:
    if mode != "full" and not WORDS:
        hits.append("no host-local word list: leak-words.txt is missing or empty (DS_LEAK_WORDS, else $XDG_CONFIG_HOME or ~/.config, then dev-studio/leak-words.txt)")
    count = {"full": mode_full, "staged": mode_staged, "commits": mode_commits, "messages": mode_messages, "text": mode_text}[mode]()
except ScanError as e:
    print(f"FAIL leak-guard: the scan itself failed ({e})")
    sys.exit(1)
if hits:
    print("FAIL leak-guard:" if mode == "full" else f"FAIL leak-guard --{mode}:")
    print("\n".join(hits))
    sys.exit(1)
if mode == "full":
    print("leak-guard: clean (generic shapes + host-local list)" if WORDS else "leak-guard: clean (generic shapes; no host-local list)")
else:
    unit = {"staged": "staged files", "commits": "commits", "messages": "messages", "text": "file"}[mode]
    print(f"leak-guard --{mode}: clean ({count} {unit}, generic shapes + host-local list)")
PYEOF

selftest() (
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR
  t="$(mktemp -d)"
  trap 'rm -rf "$t"' EXIT
  rc=0
  gr() { local r="$1"; shift; git -C "$r" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=selftest -c user.email=selftest@example.com "$@"; }
  g() { gr "$t/r" "$@"; }
  guard() { LEAK_GUARD_ROOT="${GR-$t/r}" DS_LEAK_WORDS="${SW-$t/words.txt}" LEAK_GUARD_SELFTEST=0 bash "$0" "$@" 2>&1; }
  bad() { echo "leak-guard self-test: $*"; rc=1; }
  # echoed <output>: does the output hold a planted value? A hit names the kind, never the value.
  echoed() { grep -qiE -- 'plantedword|plantedmail|plantedhost|plantedname' <<< "$1"; }
  # want_fail <case> <text the output must name> <guard args...>
  want_fail() {
    local c="$1" n="$2" out
    shift 2
    if out="$(guard "$@")"; then bad "$c passed"; return; fi
    grep -qF -- "$n" <<< "$out" || bad "$c did not name $n"
    if echoed "$out"; then bad "$c echoed a planted value"; fi
  }
  want_pass() { local c="$1" out; shift; out="$(guard "$@")" || bad "$c failed: $out"; }
  # stage_fail <case> <file> [<text>]: stage <file> alone, --staged must fail naming <text> (default the file),
  # then unstage and remove it.
  stage_fail() { g add -f -- "$2" && want_fail "$1" "${3:-$2}" --staged; g rm -q -f --cached -- "$2" > /dev/null; rm -f "$t/r/$2"; }

  git init -q "$t/r" && mkdir -p "$t/r/d" "$t/r/tests" "$t/x"
  printf '# local\n\nplantedword\n' > "$t/words.txt"
  # Full scan: each rule over tracked files, with an allowed picture and an unlisted binary.
  echo "contact plantedmail@gmail"".com now" > "$t/r/a.txt"
  echo "see http://plantedhost.tail9999.ts"".net:3000/" > "$t/r/b.txt"
  echo 'ok http://x.tail1234.ts.net/ and /home/user/x and ops@example.com' > "$t/r/fine.txt"
  echo 'a line with PlantedWord inside' | gzip -c > "$t/r/d/c.gz"
  printf 'pic\000ture' > "$t/r/pic.png"
  printf 'odd\000bytes' > "$t/r/odd.bin"
  ln -s "/home/planted""name/private/x" "$t/r/link"
  printf '%s  pic.png\n' "$(g hash-object pic.png)" > "$t/r/tests/leak-guard.allow"
  g add -A
  local_out="$(guard)" && bad "the full scan passed"
  for f in a.txt b.txt 'd/c.gz (inside .gz):1: a word' odd.bin 'link:1: a home path'; do grep -qF -- "$f" <<< "$local_out" || bad "the full scan did not name $f"; done
  grep -qF -- fine.txt <<< "$local_out" && bad "the full scan flagged fine.txt"
  grep -qF -- pic.png <<< "$local_out" && bad "the full scan flagged the allowed pic.png"
  echoed "$local_out" && bad "the full scan echoed a planted value"

  # A clean base commit, then --staged: each planted file alone must fail.
  g rm -q -f --cached a.txt b.txt d/c.gz odd.bin link > /dev/null && rm -f "$t/r/a.txt" "$t/r/b.txt" "$t/r/d/c.gz" "$t/r/odd.bin" "$t/r/link"
  g commit -q -m base
  base="$(g rev-parse HEAD)"
  want_pass "the full scan of the clean base"
  printf 'pic\000changed' > "$t/r/pic.png" && want_fail "the full scan of a changed allowed picture" "pic.png: not text and not listed" && g checkout -q -- pic.png
  want_pass "--staged with nothing staged" --staged
  echo 'plain words' > "$t/r/new.txt" && g add new.txt && want_pass "--staged of a clean file" --staged
  printf 'SQLite format 3\000rest' > "$t/r/s.sqlite" && stage_fail "--staged SQLite file" s.sqlite
  printf 'SQLite format 3\000rest' | gzip -c > "$t/r/loop.db.gz" && stage_fail "--staged gzipped loop.db" loop.db.gz "loop.db.gz (inside .gz): a SQLite"
  printf '\067\177\006\202wal frames' > "$t/r/notes.txt" && stage_fail "--staged renamed WAL file" notes.txt
  echo 'plain words' > "$t/x/in.txt" && tar -czf "$t/r/bundle.tar.gz" -C "$t/x" in.txt && stage_fail "--staged gzipped tar" bundle.tar.gz
  echo 'not really a picture' > "$t/r/new.png" && stage_fail "--staged unlisted picture" new.png
  echo "mail plantedmail@gmail"".com" > "$t/r/mail.txt" && stage_fail "--staged gmail address" mail.txt
  # A SQLite file is never allowed, not even listed, nor inside a listed archive.
  printf 'SQLite format 3\000listed' > "$t/r/listed.sqlite"
  printf 'SQLite format 3\000listed' > "$t/x/in.db" && tar -czf "$t/r/db.tar.gz" -C "$t/x" in.db
  cp "$t/r/tests/leak-guard.allow" "$t/allow.bak"
  printf '%s  listed.sqlite\n%s  db.tar.gz\n' "$(g hash-object listed.sqlite)" "$(g hash-object db.tar.gz)" >> "$t/r/tests/leak-guard.allow"
  g add tests/leak-guard.allow && stage_fail "--staged SQLite file listed in the allow file" listed.sqlite
  stage_fail "--staged listed archive holding a SQLite file" db.tar.gz "db.tar.gz (inside .gz): holds a SQLite"
  cp "$t/allow.bak" "$t/r/tests/leak-guard.allow" && g add tests/leak-guard.allow
  # The allow line binds path and hash: the same bytes at another path are not listed.
  cp "$t/r/pic.png" "$t/r/copy.png" && stage_fail "--staged of a listed picture copied to another path" copy.png "copy.png: not text and not listed"
  # The inherited GIT_INDEX_FILE is what --staged reads (git commit -a stages into index.lock).
  echo "mail plantedmail@gmail"".com" > "$t/r/alt.txt"
  cp "$t/r/.git/index" "$t/alt-index" && GIT_INDEX_FILE="$t/alt-index" g add alt.txt
  GIT_INDEX_FILE="$t/alt-index" want_fail "--staged of GIT_INDEX_FILE" alt.txt --staged
  want_pass "--staged of the default index beside an alternate one" --staged
  g commit -q -m "add new.txt"

  # --commits: a planted file added in one commit and deleted in the next still fails.
  echo "mail plantedmail@gmail"".com" > "$t/r/planted.txt" && g add planted.txt && g commit -q -m "add a file"
  g rm -q planted.txt && g commit -q -m "remove it"
  want_fail "--commits add then delete" planted.txt --commits "$base..HEAD"
  want_pass "--commits of a delete-only range" --commits HEAD~1..HEAD
  # --messages
  want_pass "--messages of clean messages" --messages "$base..HEAD"
  g commit -q --allow-empty -m "fix for the PlantedWord customer"
  want_fail "--messages list word" "commit $(g rev-parse --short=12 HEAD) message" --messages HEAD~1..HEAD
  # --text
  echo "see http://plantedhost.tail9999.ts"".net/" > "$t/body.md" && want_fail "--text ts.net host" body.md --text "$t/body.md"
  echo 'a clean body' > "$t/clean.md" && want_pass "--text of a clean body" --text "$t/clean.md"
  echo "First.Plantedmail@Gmail"".COM" > "$t/mixed.md" && want_fail "--text mixed-case gmail address" "mixed.md:1: a gmail address" --text "$t/mixed.md"
  echo "plantedhost.TAIL9999.TS"".NET" > "$t/mixed.md" && want_fail "--text mixed-case ts.net host" "mixed.md:1: a ts.net host" --text "$t/mixed.md"
  # No word list (missing, or only comments): each new mode fails on clean input.
  printf '# only a comment\n' > "$t/empty.txt"
  # An empty temp HOME and XDG_CONFIG_HOME, never the machine's real list.
  mkdir -p "$t/nohome"
  for words in "" "$t/empty.txt"; do
    for m in "--staged" "--commits HEAD~2..HEAD~1" "--messages $base..HEAD~1" "--text $t/clean.md"; do
      # shellcheck disable=SC2086 # $m is a mode and its arguments
      SW="$words" HOME="$t/nohome" XDG_CONFIG_HOME="" want_fail "${m%% *} with no list" "no host-local word list" $m
    done
  done
  # Where the list is found: ~/.config/dev-studio/, else $XDG_CONFIG_HOME/dev-studio/, else the old place with a notice.
  printf 'plantedword\n' > "$t/word.md"
  mkdir -p "$t/h1/.config/dev-studio" "$t/xdg/dev-studio" "$t/h3/.dev-studio/state"
  cp "$t/words.txt" "$t/h1/.config/dev-studio/leak-words.txt"
  SW="" HOME="$t/h1" XDG_CONFIG_HOME="" want_fail "--text list in ~/.config/dev-studio" "word.md:1: a word of the host-local list" --text "$t/word.md"
  cp "$t/words.txt" "$t/xdg/dev-studio/leak-words.txt"
  SW="" HOME="$t/nohome" XDG_CONFIG_HOME="$t/xdg" want_fail "--text list in XDG_CONFIG_HOME" "word.md:1: a word of the host-local list" --text "$t/word.md"
  cp "$t/words.txt" "$t/h3/.dev-studio/state/leak-words.txt"
  SW="" HOME="$t/h3" XDG_CONFIG_HOME="" want_fail "--text old list" "word.md:1: a word of the host-local list" --text "$t/word.md"
  SW="" HOME="$t/h3" XDG_CONFIG_HOME="" want_fail "--text old list notice" "using the old word list" --text "$t/word.md"
  mkdir -p "$t/h1/.dev-studio/state" && cp "$t/words.txt" "$t/h1/.dev-studio/state/leak-words.txt"
  out="$(SW="" HOME="$t/h1" XDG_CONFIG_HOME="" guard --text "$t/clean.md")" || bad "--text clean with both lists failed: $out"
  case "$out" in *"old word list"*) bad "the new list in place still names the old one: $out" ;; esac
  # An allow line approves one exact version: a listed picture passes --staged and --commits, a changed one fails.
  printf 'new\000pic' > "$t/r/shot.png" && g add shot.png
  printf '%s  shot.png\n' "$(g hash-object shot.png)" >> "$t/r/tests/leak-guard.allow" && g add tests/leak-guard.allow
  want_pass "--staged of a listed picture" --staged
  g commit -q -m "add a listed picture" && want_pass "--commits of a listed picture" --commits HEAD~1..HEAD
  printf 'other\000pic' > "$t/r/shot.png" && g add shot.png
  want_fail "--staged of a changed listed picture" "shot.png: not text and not listed" --staged
  g commit -q -m "change it" && want_fail "--commits of a changed listed picture" "shot.png (commit" --commits HEAD~1..HEAD
  # --commits sees a file a merge adds on its own (combined diff of a merge commit).
  g checkout -q -b side && echo 'side' > "$t/r/side.txt" && g add side.txt && g commit -q -m side
  g checkout -q - && g merge -q --no-ff --no-commit side > /dev/null 2>&1
  echo "mail plantedmail@gmail"".com" > "$t/r/evil.txt" && g add evil.txt && g commit -q -m merge
  g rev-parse -q --verify HEAD^2 > /dev/null || bad "the merge case made no merge commit"
  want_fail "--commits of a merge that adds a file" "evil.txt (commit $(g rev-parse --short=12 HEAD))" --commits HEAD^1..HEAD
  # A private value in a file name is a hit, and the name is withheld from the output.
  echo 'clean words' > "$t/r/plantedword-notes.txt" && g add plantedword-notes.txt
  want_fail "--staged of a private file name" "<path withheld> (blob" --staged
  g commit -q -m "add notes" && want_fail "--commits of a private file name" "the path holds a word" --commits HEAD~1..HEAD
  want_fail "the full scan of a private file name" "<path withheld> (blob"
  # A repo with no commits yet: --staged diffs against the empty tree, --commits reads the root commit.
  for r in r2 r3; do git init -q "$t/$r"; done
  echo "mail plantedmail@gmail"".com" > "$t/r2/root.txt" && gr "$t/r2" add root.txt
  GR="$t/r2" want_fail "--staged with no HEAD" root.txt --staged
  gr "$t/r2" commit -q -m root && GR="$t/r2" want_fail "--commits of a root commit" "root.txt (commit" --commits HEAD
  echo 'clean words' > "$t/r3/root.txt" && gr "$t/r3" add root.txt && GR="$t/r3" want_pass "--staged of a clean first commit" --staged
  gr "$t/r3" commit -q -m root && GR="$t/r3" want_pass "--commits of a clean root commit" --commits HEAD
  [ "$rc" -eq 0 ] && echo "leak-guard self-test: ok"
  exit "$rc"
)

mode=full
case "${1:-}" in
  '') ;;
  --staged) mode=staged; shift; [ $# -eq 0 ] || usage ;;
  --commits | --messages) mode="${1#--}"; shift; [ $# -gt 0 ] || usage ;;
  --text) mode=text; shift; [ $# -eq 1 ] || usage ;;
  *) usage ;;
esac
python3 -I -c "$PY" "$mode" "$HERE" "$@" || exit 1
if [ "$mode" = full ] && [ "${LEAK_GUARD_SELFTEST:-1}" != 0 ]; then selftest || exit 1; fi
