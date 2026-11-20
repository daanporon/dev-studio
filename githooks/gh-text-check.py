"""githooks/gh-text-check.py — the body of githooks/gh-text-check (public-readiness U12).

Reads Claude Code's PreToolUse hook input on stdin and takes tool_input.command. It acts only on a gh or gh-axi
call that posts text:
  pr create|edit|comment|review|merge, issue create|edit|comment, release create|edit|upload (and `new`):
    --title, --body, --body-file, --subject, --notes, --notes-file, --template and their short forms;
  pr close|reopen, issue close|reopen: -c/--comment;
  gh api, any call that is not a plain GET: every -f/-F/--field/--raw-field value (-F k=@file reads the file)
    and the --input file.
Each text, each file it names, each heredoc fed to it and the rest of the call's words go through this worktree's
tests/leak-guard.sh --text; a pr title (create/edit --title/-t) or merge subject (--subject/-t) must also pass
tests/pr-title.sh, and pr create --fill/-f with no title is refused (U10).

The hook sees the command before the shell expands it, so it refuses what it cannot see: --attach, --web,
--editor, a release asset, a text read from standard input (--body-file -, --input -, -F k=@-), a text-bearing
argument that holds $(, a backtick, ${, $NAME or <(, a checked call reached through bash -c, sh -c, eval, xargs,
env, a shell's heredoc, here-string or pipe, interpreter code (python -c, node -e, a heredoc) or a command word
built at run time, a text file read by a call that another command in the same Bash call runs before (it may
still write the file), and an unreadable command. A refusal exits 2 with the reason and the kind of hit, never
the value. A program or script file that runs gh itself is not read: the hook sees only the command line.

Every other command passes, and so does a call aimed at another repo: one whose -R/--repo, PR/issue/release URL,
GH_REPO or api repos/<owner>/<name> path names a repo other than this clone's origin, or that runs in another
repo's folder. The folder is the hook's cwd moved by each cd that lasts; a cd the shell runs in a subshell of
its own (( ), $( ), a pipeline, before &) or to a folder built at run time makes it unknown, which counts as this
repo. GH_REPO is the hook's environment changed by `NAME=value gh`, export and unset in the same command.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.realpath(__file__))
TOP = os.path.dirname(HERE)
GUARD = os.path.join(TOP, "tests", "leak-guard.sh")
TITLE = os.path.join(TOP, "tests", "pr-title.sh")
FIX = "write the text to a file first, in its own command, and pass --body-file <file> (or -F field=@<file>)"
NEVER = 'Nothing ran. Fix the call and run it again; never post the text another way (.github/CONTRIBUTING.md, "Leak hooks").'
UNKNOWN = "\0unknown"   # a variable the shell fills in at run time
GH_WORD = re.compile(r"(^|[^A-Za-z0-9_.-])gh(-axi)?([^A-Za-z0-9_-]|$)")


class Unreadable(Exception):
    pass


class Word:
    def __init__(self, text, dyn, quoted, tilde, subs):
        self.text, self.dyn, self.quoted, self.tilde, self.subs = text, dyn, quoted, tilde, subs


class Op:
    def __init__(self, op):
        self.op = op


class HereDoc:
    def __init__(self, delim, strip):
        self.delim, self.strip, self.body = delim, strip, ""


OPS = ["<<<", "<<-", "&&", "||", "|&", ";;", "<<", ">>", "<(", ">(", "&>", ">&", "<&", ">|", ";", "|", "&",
       "(", ")", "<", ">", "\n"]
SEPARATORS = {"&&", "||", "|&", ";;", ";", "|", "&", "\n"}
REDIRECTS = {"<<<", ">>", "&>", ">&", "<&", ">|", "<", ">"}


def expands(s, i):
    """s[i] is '$': does the shell fill something in here?"""
    return i + 1 < len(s) and (s[i + 1].isalnum() or s[i + 1] in "_@*#?$!-{('")


def skip_dq(s, i):
    """s[i] is '"': the index past the closing quote."""
    i += 1
    while i < len(s):
        c = s[i]
        if c == "\\":
            i += 2
        elif c == '"':
            return i + 1
        elif c == "$" and s.startswith("$(", i):
            i = skip_paren(s, i + 1)
        elif c == "`":
            i = skip_tick(s, i)
        else:
            i += 1
    raise Unreadable("an open double quote")


def skip_paren(s, i):
    """s[i] is '(': the index past its matching ')'."""
    depth, i = 0, i
    while i < len(s):
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = s.find("'", i + 1)
            if j < 0:
                raise Unreadable("an open single quote")
            i = j + 1
            continue
        if c == '"':
            i = skip_dq(s, i)
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise Unreadable("an open $(")


def skip_tick(s, i):
    """s[i] is '`': the index past the closing backtick."""
    i += 1
    while i < len(s):
        if s[i] == "\\":
            i += 2
            continue
        if s[i] == "`":
            return i + 1
        i += 1
    raise Unreadable("an open backtick")


def lex_word(s, i):
    buf, dyn, quoted, tilde, subs = [], False, False, s[i] == "~", []
    n = len(s)
    while i < n:
        c = s[i]
        if c in " \t\n;&|()<>":
            break
        if c == "\\":
            if i + 1 < n and s[i + 1] != "\n":
                buf.append(s[i + 1])
            i += 2
            continue
        if c == "'":
            j = s.find("'", i + 1)
            if j < 0:
                raise Unreadable("an open single quote")
            buf.append(s[i + 1:j])
            quoted, i = True, j + 1
            continue
        if c == '"':
            quoted, i = True, i + 1
            while True:
                if i >= n:
                    raise Unreadable("an open double quote")
                d = s[i]
                if d == '"':
                    i += 1
                    break
                if d == "\\" and i + 1 < n and s[i + 1] in '$`"\\\n':
                    if s[i + 1] != "\n":
                        buf.append(s[i + 1])
                    i += 2
                elif d == "$" and s.startswith("$(", i):
                    j = skip_paren(s, i + 1)
                    subs.append(s[i + 2:j - 1])
                    buf.append(s[i:j])
                    dyn, i = True, j
                elif d == "`":
                    j = skip_tick(s, i)
                    subs.append(s[i + 1:j - 1])
                    buf.append(s[i:j])
                    dyn, i = True, j
                else:
                    if d == "$" and expands(s, i) and s[i + 1] != "'":
                        dyn = True
                    buf.append(d)
                    i += 1
            continue
        if c == "$" and i + 1 < n:
            if s[i + 1] == "'":   # $'…' decodes escapes: the text is not what it looks like
                j = i + 2
                while j < n and s[j] != "'":
                    j += 2 if s[j] == "\\" else 1
                if j >= n:
                    raise Unreadable("an open $'")
                buf.append(s[i:j + 1])
                dyn, i = True, j + 1
                continue
            if s[i + 1] == "(":
                j = skip_paren(s, i + 1)
                subs.append(s[i + 2:j - 1])
                buf.append(s[i:j])
                dyn, i = True, j
                continue
            if s[i + 1] == "{":
                j = s.find("}", i)
                if j < 0:
                    raise Unreadable("an open ${")
                buf.append(s[i:j + 1])
                dyn, i = True, j + 1
                continue
            if expands(s, i):
                dyn = True
        if c == "`":
            j = skip_tick(s, i)
            subs.append(s[i + 1:j - 1])
            buf.append(s[i:j])
            dyn, i = True, j
            continue
        buf.append(c)
        i += 1
    return Word("".join(buf), dyn, quoted, tilde, subs), i


def read_heredoc(s, i, doc):
    body = []
    while i < len(s):
        e = s.find("\n", i)
        e = len(s) if e < 0 else e
        line = s[i:e]
        if (line.lstrip("\t") if doc.strip else line) == doc.delim:
            doc.body = "\n".join(body) + ("\n" if body else "")
            return e + 1
        body.append(line)
        i = e + 1
    doc.body = "\n".join(body)
    return len(s)


def lex(s):
    toks, pending, i, n = [], [], 0, len(s)
    while i < n:
        c = s[i]
        if c in " \t":
            i += 1
            continue
        if c == "\\" and s.startswith("\\\n", i):
            i += 2
            continue
        if c == "#":
            e = s.find("\n", i)
            i = n if e < 0 else e
            continue
        if c == "\n":
            toks.append(Op("\n"))
            i += 1
            for doc in pending:
                i = read_heredoc(s, i, doc)
            pending = []
            continue
        op = next((o for o in OPS if s.startswith(o, i)), None)
        if op:
            i += len(op)
            if op in ("<<", "<<-"):
                while i < n and s[i] in " \t":
                    i += 1
                if i >= n or s[i] in "\n;&|()<>":
                    raise Unreadable("a heredoc with no end word")
                w, i = lex_word(s, i)
                doc = HereDoc(w.text, op == "<<-")
                pending.append(doc)
                toks.append(doc)
            else:
                toks.append(Op(op))
            continue
        w, i = lex_word(s, i)
        if not w.quoted and w.text.isdigit() and i < n and s[i] in "<>":
            continue   # a file descriptor: 2>&1
        toks.append(w)
    return toks


PIPES = {"|", "|&"}


def segments(toks):
    """Split into simple commands, in the order the shell starts them: (items, scoped) with items Word, HereDoc and
    (redirect op, Word); scoped when the shell runs the command in a subshell of its own (inside ( ) or <( ), part
    of a pipeline, or before &), so its cd and export do not last."""
    out, cur, stack, prev = [], [], [], None

    def end(sep):
        nonlocal cur, prev
        out.append((cur, bool(stack) or sep in PIPES or sep == "&" or prev in PIPES))
        cur, prev = [], sep

    i = 0
    while i < len(toks):
        t = toks[i]
        i += 1
        if isinstance(t, Op):
            if t.op in SEPARATORS:
                end(t.op)
            elif t.op in ("<(", ">("):
                cur.append(Word("<(…)", True, False, False, []))
                stack.append(("proc", cur, prev))
                cur, prev = [], None
            elif t.op == "(":
                end(None)
                stack.append(("sub", None, None))
            elif t.op == ")":
                end(None)
                kind, outer, before = stack.pop() if stack else ("sub", None, None)
                if kind == "proc":
                    cur, prev = outer, before
            elif t.op in REDIRECTS:
                if i < len(toks) and isinstance(toks[i], Word):
                    cur.append((t.op, toks[i]))
                    i += 1
        else:
            cur.append(t)
    end(None)
    return [(items, scoped) for items, scoped in out if items]


def norm(s):
    """host/owner/name, lowercase, from an origin URL or owner/name ('' when it is neither)."""
    s = s.strip().rstrip("/")
    if s.endswith(".git"):
        s = s[:-4]
    if "://" in s:
        s = s.split("://", 1)[1]
        s = s.split("@", 1)[-1]
    elif re.match(r"^[^/]*@[^/]*:", s):
        s = s.split("@", 1)[1].replace(":", "/", 1)
    parts = s.split("/")
    if len(parts) == 2:
        s = "github.com/" + s
    elif len(parts) != 3 or not all(parts):
        return ""
    return s.lower()


def git(cwd, *args):
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


class Ctx:
    def __init__(self, cwd):
        self.cwd = cwd
        self.refuse = []    # (reason, call index or None when no call can be named)
        self.texts = []     # (label, kind 'text'|'file', value, is_title)
        self.targets = []   # one per checked call: (kind, value)
        self.busy = False   # a command that may write files ran before the one being read
        self.shellvars = {}  # NAME=value commands: a later `export NAME` exports them
        self.exported = {}   # export / unset in this command: value, UNKNOWN or None (unset)
        self._ours = None

    def env(self):
        env = dict(os.environ)
        for k, v in self.exported.items():
            if v is None:
                env.pop(k, None)
            else:
                env[k] = v
        return env

    def ours(self):
        if self._ours is None:
            self._ours = (norm(git(TOP, "config", "--get", "remote.origin.url") or ""),
                          git(TOP, "rev-parse", "--path-format=absolute", "--git-common-dir") or "")
        return self._ours


PR_SUBS = {"create", "edit", "comment", "review", "merge", "close", "reopen"}
CHECKED = {("pr", s) for s in PR_SUBS} | {("issue", s) for s in ("create", "edit", "comment", "close", "reopen")} \
    | {("release", "create"), ("release", "edit"), ("release", "upload")}
VSHORT = {
    ("pr", "create"): "aBbFHlmprTt", ("pr", "edit"): "BbFmt", ("pr", "comment"): "bF", ("issue", "comment"): "bF",
    ("pr", "review"): "bF", ("pr", "merge"): "AbFt", ("issue", "create"): "abFlmpTt", ("issue", "edit"): "bFmt",
    ("release", "create"): "Fnt", ("release", "edit"): "Fnt", ("issue", "close"): "cr", ("pr", "close"): "c",
    ("pr", "reopen"): "c", ("issue", "reopen"): "c",
}
WEB_EDITOR = {("pr", "create"), ("pr", "comment"), ("issue", "create"), ("issue", "comment")}
API_VALUE_FLAGS = {"-H", "--header", "-q", "--jq", "-t", "--template", "-p", "--preview", "--cache"}
RELEASE_VALUE_FLAGS = {"--target", "--discussion-category", "--notes-start-tag"}
ASSETS = {("release", "create"), ("release", "upload")}


def is_checked(words):
    """(cmd, sub) when this gh argument list posts text, else None; raises Unreadable when it cannot tell."""
    if not words:
        return None
    if words[0].dyn:
        raise Unreadable("gh's command is not a plain word")
    cmd = words[0].text
    if cmd == "api":
        return ("api", "")
    if cmd not in ("pr", "issue", "release"):
        return None
    j = 1
    while j < len(words):
        w = words[j]
        j += 1
        if w.text in ("-R", "--repo"):
            j += 1
        elif w.text.startswith("-") and not w.dyn:
            continue
        else:
            if w.dyn:
                raise Unreadable("gh's subcommand is not a plain word")
            sub = "create" if w.text == "new" else w.text
            return (cmd, sub) if (cmd, sub) in CHECKED else None
    return None


def attached(a):
    """The value joined to a flag: --flag=<v> or -X<v> (-X=<v>)."""
    return a.split("=", 1)[1] if a.startswith("--") else a[2:].lstrip("=")


def part(w, val):
    """A Word for the value val read out of word w (its quoting and expansions carry over)."""
    return Word(val, w.dyn, w.quoted, val.startswith("~"), w.subs)


def gh_call(ctx, words, env, heredocs, herestrings, fresh=True):
    """words: the arguments after gh. Adds texts, refusals and the target for a checked call. fresh: no command
    that may write a file runs before this one in the same Bash call."""
    try:
        kind = is_checked(words)
    except Unreadable as e:
        ctx.refuse.append((f"{e}, so this gh call cannot be checked", None))
        return
    if kind is None:
        return
    cmd, sub = kind
    used = set()        # indexes of words read as texts or file paths
    target = None       # ('literal', value) | ('unknown', '')
    texts = []          # (label, 'text'|'file', Word)
    refuse = []         # reasons, bound to this call once its target is known

    def value(j, flag):
        if j >= len(words):
            refuse.append(f"{flag}: no plain value after it, so its text cannot be checked; {FIX}")
            return None
        used.add(j)
        return words[j]

    def add_text(label, w):
        if w is None:
            return
        if w.dyn:
            refuse.append(f"{label}: its value holds $(, a backtick, ${{ or $NAME, which the shell fills in after "
                          f"this check; {FIX}")
            return
        if w.tilde and not w.quoted:
            refuse.append(f"{label}: its value starts with ~, which the shell turns into a home folder; {FIX}")
            return
        texts.append((label, "text", w))

    def add_file(label, w):
        if w is None:
            return
        if w.dyn:
            refuse.append(f"{label}: the file name holds $(, a backtick, ${{ or $NAME, so it cannot be read here; "
                          f"name the file plainly")
            return
        if w.text in ("-", "@-"):
            refuse.append(f"{label} -: text read from standard input cannot be checked here; {FIX}")
            return
        texts.append((label, "file", w))

    if cmd == "api":
        method, fields, endpoint, api_host, ends = "", False, None, "", False
        j = 1
        while j < len(words):
            w = words[j]
            a = w.text
            j += 1
            if ends or not a.startswith("-") or a == "-":
                if endpoint is None:
                    endpoint = w
                continue
            if a == "--":
                ends = True
            elif a in ("-X", "--method"):
                m = value(j, a)
                j += 1
                method = "?" if m is None or m.dyn else m.text
            elif a.startswith("-X") or a.startswith("--method="):
                method = "?" if w.dyn else attached(a)
            elif a in ("-f", "--raw-field", "-F", "--field") or re.match(r"^(-[fF].|--(raw-)?field=)", a):
                fields = True
                if a in ("-f", "--raw-field", "-F", "--field"):
                    v = value(j, a)
                    j += 1
                    flag = a
                else:
                    used.add(j - 1)
                    flag = a.split("=", 1)[0] if a.startswith("--") else a[:2]
                    v = part(w, attached(a))
                if v is None:
                    continue
                k, _, val = v.text.partition("=")
                if flag in ("-F", "--field") and val.startswith("@"):
                    add_file(f"field {k}", part(v, val[1:] if val != "@-" else "-"))
                else:
                    add_text(f"field {k}", part(v, val))
            elif a == "--input":
                fields = True
                add_file("input", value(j, a))
                j += 1
            elif a.startswith("--input="):
                fields = True
                used.add(j - 1)
                add_file("input", part(w, attached(a)))
            elif a == "--hostname":
                h = value(j, a)
                j += 1
                api_host = "" if h is None else h.text
            elif a.startswith("--hostname="):
                api_host = attached(a)
            elif a in API_VALUE_FLAGS:
                j += 1
        m = method.upper()
        if m == "GET" or (not m and not fields):
            return   # a plain GET posts nothing
        if endpoint is not None:
            ep = endpoint.text.lstrip("/")
            mm = re.match(r"^repos/([^/{}]+)/([^/?{}]+)", ep)
            if endpoint.dyn:
                target = ("unknown", "")
            elif mm:
                target = ("literal", f"{api_host or 'github.com'}/{mm.group(1)}/{mm.group(2)}")
            elif ("{owner}" in ep or "{repo}" in ep) and env.get("GH_REPO"):
                target = env["GH_REPO"]
    else:
        vshort = VSHORT.get(kind, "")
        closing = sub in ("close", "reopen")
        fill, ends, url_target, positional = False, False, None, 0
        j = 1
        while j < len(words):
            w = words[j]
            a = w.text
            j += 1
            if ends or not a.startswith("-") or a == "-":
                positional += 1
                mm = re.match(r"^https?://([^/]+)/([^/]+)/([^/]+)/(pull|issues|releases)(/|$)", a)
                if mm:
                    url_target = ("unknown", "") if w.dyn else ("literal", "/".join(mm.group(1, 2, 3)))
                elif kind in ASSETS and positional > 2:   # after the subcommand and the tag: a file to upload
                    refuse.append(f"release asset {a}: an uploaded file needs the recorded look "
                                  f"(tests/leak-guard.allow), so roles do not upload release assets")
                continue
            if a == "--":
                ends = True
            elif a in ("--repo", "-R"):
                v = value(j, a)
                j += 1
                target = ("unknown", "") if v is None or v.dyn else ("literal", v.text)
            elif a.startswith("--repo=") or (a.startswith("-R") and len(a) > 2):
                target = ("unknown", "") if w.dyn else ("literal", attached(a))
            elif a in ("--fill", "--fill-first", "--fill-verbose"):
                fill = True
            elif a in ("--title", "--subject", "--body", "--notes"):
                add_text(a[2:], value(j, a))
                j += 1
            elif re.match(r"^--(title|subject|body|notes)=", a):
                used.add(j - 1)
                add_text(a[2:].split("=", 1)[0], part(w, attached(a)))
            elif a in ("--body-file", "--notes-file"):
                add_file(a[2:], value(j, a))
                j += 1
            elif re.match(r"^--(body-file|notes-file)=", a):
                used.add(j - 1)
                add_file(a[2:].split("=", 1)[0], part(w, attached(a)))
            elif a == "--comment":
                if closing:   # on pr review it is a switch
                    add_text("comment", value(j, a))
                    j += 1
            elif a.startswith("--comment="):
                if closing:
                    used.add(j - 1)
                    add_text("comment", part(w, attached(a)))
            elif a == "--template":
                if kind == ("pr", "create"):
                    add_file("template", value(j, a))
                j += 1
            elif a == "--attach" or a.startswith("--attach="):
                refuse.append("--attach: a picture or video needs the recorded look (tests/leak-guard.allow), "
                              "so roles do not attach files")
            elif a == "--web":
                refuse.append("--web: text written in the browser cannot be checked")
            elif a == "--editor":
                refuse.append("--editor: text written in an editor cannot be checked")
            elif cmd == "release" and a in RELEASE_VALUE_FLAGS:
                j += 1   # its value is not an asset
            elif a.startswith("--"):
                pass   # other long flags: a value, if any, is not a posted text
            else:
                c = a[1:]
                while c:
                    ch, c = c[0], c[1:]
                    if ch in vshort:
                        if c:
                            used.add(j - 1)
                            v = part(w, c.lstrip("="))
                        else:
                            v = value(j, "-" + ch)
                            j += 1
                        short_text(kind, ch, v, add_text, add_file)
                        break
                    if ch == "f" and kind == ("pr", "create"):
                        fill = True
                    if kind in WEB_EDITOR and ch in "we":
                        refuse.append("-w (--web): text written in the browser cannot be checked" if ch == "w"
                                      else "-e (--editor): text written in an editor cannot be checked")
        if kind == ("pr", "create") and fill and not any(lbl == "title" for lbl, _, _ in texts):
            refuse.append('pr create with --fill/-f and no --title: the title would come from a commit and '
                          'cannot be checked; pass --title "<type>(<scope>): <summary>"')
        if url_target:
            target = url_target
        if target is None and env.get("GH_REPO"):
            target = env["GH_REPO"]

    for n, (label, how, w) in enumerate(texts):
        if how != "file":
            continue
        if not fresh:
            refuse.append(f"{label} file {w.text}: another command runs before this gh call in the same Bash call and "
                          f"may still write the file, which is read before anything runs; run the gh call in its own "
                          f"command (a cd before it is fine)")
        path = os.path.expanduser(w.text) if w.tilde and not w.quoted else w.text
        if not os.path.isabs(path):
            if ctx.cwd is None:
                refuse.append(f"{label} file {w.text}: the folder this call runs in is not known here (a cd in a "
                              f"subshell or to a folder built at run time), so the file cannot be found; name it "
                              f"by its full path")
                continue
            path = os.path.join(ctx.cwd, path)
        texts[n] = (label, how, Word(path, w.dyn, w.quoted, False, w.subs))
    if isinstance(target, str):   # from GH_REPO
        target = ("unknown", "") if target == UNKNOWN else ("literal", target)
    ctx.targets.append(target)
    idx = len(ctx.targets) - 1
    ctx.refuse += [(r, idx) for r in refuse]
    for lbl, how, w in texts:
        ctx.texts.append((lbl, how, w.text, cmd == "pr" and lbl in ("title", "subject"), idx))
    rest = ["gh"] + [w.text for k, w in enumerate(words) if k not in used]
    ctx.texts.append(("command", "text", " ".join(rest), False, idx))
    ctx.texts += [("heredoc", "text", doc.body, False, idx) for doc in heredocs]
    ctx.texts += [("here-string", "text", w.text, False, idx) for w in herestrings]


def short_text(kind, ch, v, add_text, add_file):
    cmd = kind[0]
    if cmd == "release" and ch == "n":
        add_text("notes", v)
    elif cmd == "release" and ch == "F":
        add_file("notes-file", v)
    elif kind == ("pr", "merge") and ch == "t":
        add_text("subject", v)
    elif ch == "t":
        add_text("title", v)
    elif ch == "b":
        add_text("body", v)
    elif ch == "F":
        add_file("body-file", v)
    elif ch == "c":
        add_text("comment", v)
    elif kind == ("pr", "create") and ch == "T":
        add_file("template", v)


def refuse_through(ctx, via):
    """A gh call that posts text runs inside another command: its words are not on this command line."""
    ctx.refuse.append((f"a gh call that posts text, reached through {via}, cannot be checked; run gh directly with "
                       f"its text in a file (--body-file <file>)", None))


SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
INTERPRETERS = {"python", "python3", "node", "perl", "ruby", "bun", "deno", "php"}
SHELL_VALUE_OPTS = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}   # a shell option whose value follows
PREFIXES = {"command", "exec", "builtin", "nohup", "time"}
QUIET = {"cd", "pushd", "popd", "export", "unset", "set", "true", ":"}   # write no file (with no redirect)
# interpreter code that runs gh: gh then a posting subcommand, as shell words ("gh pr …") or list items ("gh", "pr")
POSTISH = re.compile(r"""\bgh(-axi)?['"]?\s*[,\s]\s*['"]?(pr|issue|release|api)\b""")
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def holds_checked(text):
    """Does this command text run a gh call that posts text? (Unreadable text that names gh: yes.)"""
    try:
        probe = Ctx(None)
        walk(probe, text)
    except Unreadable:
        return bool(GH_WORD.search(text))
    return bool(probe.targets or probe.refuse)


def posts(words):
    """Would gh with these arguments post text?"""
    probe = Ctx(None)
    gh_call(probe, words, {}, [], [])
    return bool(probe.targets or probe.refuse)


def walk(ctx, text, scoped=False):
    """Analyse a command text: each gh call's texts and target, and each refusal, go into ctx. scoped: the text
    runs in a subshell of its own ($( ) or a backtick), so its cd and export do not last."""
    segs = segments(lex(text))
    piped_words = [t.text for seg, _ in segs for t in seg if isinstance(t, Word)]
    for seg, own in segs:
        words = [t for t in seg if isinstance(t, Word)]
        redirs = [t for t in seg if isinstance(t, tuple)]
        for w in words + [w for _, w in redirs]:
            for sub in w.subs:   # $(…) and backticks run commands of their own, before this one
                walk(ctx, sub, scoped=True)
        quiet = not redirs and not any(w.subs for w in words)
        name = command(ctx, words, seg, redirs, scoped or own, piped_words)
        if not (quiet and (name is None or name in QUIET)):
            ctx.busy = True


def command(ctx, words, seg, redirs, scoped, piped_words):
    """One simple command. Returns its command name (None for assignments only)."""
    heredocs = [t for t in seg if isinstance(t, HereDoc)]
    herestrings = [w for op, w in redirs if op == "<<<"]
    env = ctx.env()
    assigns = []
    while words and ASSIGN.match(words[0].text):
        assigns.append(words[0])
        words = words[1:]
    while words and words[0].text in PREFIXES:
        words = words[1:]
    for w in assigns:
        k, _, v = w.text.partition("=")
        v = UNKNOWN if w.dyn else v
        if words:
            env[k] = v                                          # NAME=value cmd: for cmd only
        else:
            ctx.shellvars[k] = UNKNOWN if scoped else v         # NAME=value: a later export exports it
    if not words:
        return None
    head = words[0]
    name = os.path.basename(head.text)
    args = words[1:]
    if head.dyn:
        if posts(args):
            ctx.refuse.append(("a command word built at run time runs what reads as a gh call that posts text, so it "
                               "cannot be checked; run gh directly with its text in a file (--body-file <file>)", None))
        else:
            gh_later(ctx, name, args)   # $RUN gh pr comment …: a runner the shell names
        return name
    if name in ("cd", "pushd"):
        if ctx.cwd is None:
            pass
        elif scoped:
            ctx.cwd = None   # the shell's folder after this cd depends on which subshell runs what
        elif not args:
            ctx.cwd = os.path.expanduser("~")
        elif args[0].dyn or args[0].text == "-":
            ctx.cwd = None
        else:
            a = args[0]
            path = os.path.expanduser(a.text) if a.tilde and not a.quoted else a.text
            ctx.cwd = os.path.normpath(os.path.join(ctx.cwd, path))
        return name
    if name in ("export", "unset", "declare", "typeset", "readonly", "local"):
        for w in args:
            if w.text.startswith("-"):
                continue
            k, eq, v = w.text.partition("=")
            if name == "unset":
                ctx.exported[k] = UNKNOWN if scoped else None
            elif eq:
                ctx.exported[k] = UNKNOWN if scoped or w.dyn or name != "export" else v
            elif k in ctx.shellvars:
                ctx.exported[k] = UNKNOWN if scoped or name != "export" else ctx.shellvars[k]
        return name
    if name in ("gh", "gh-axi"):
        gh_call(ctx, args, env, heredocs, herestrings, fresh=not ctx.busy)
        return name
    if name in SHELLS:
        inner, k = None, 0
        while k < len(args):
            a = args[k].text
            if re.match(r"^-[a-zA-Z]*c[a-zA-Z]*$", a):
                inner = args[k + 1] if k + 1 < len(args) else None
                break
            if not a.startswith(("-", "+")):
                break
            k += 2 if a in SHELL_VALUE_OPTS else 1
        if inner is not None:
            if inner.dyn and GH_WORD.search(inner.text):
                ctx.refuse.append((f"a command built at run time for {name} -c names gh, so it cannot be checked; "
                                   f"run gh directly with its text in a file (--body-file <file>)", None))
            elif holds_checked(inner.text):
                refuse_through(ctx, f"{name} -c")
            return name
        # no -c: a script file (a program: not read here, like any other) or its standard input as written here
        if k < len(args):
            return name
        bodies = [d.body for d in heredocs] + [w.text for w in herestrings]
        if not any(op == "<" for op, _ in redirs):
            bodies += piped_words   # a pipe can feed it any of the command's words
        if any(GH_WORD.search(b) and holds_checked(b) for b in bodies):
            refuse_through(ctx, f"{name} on its standard input")
        return name
    if name in INTERPRETERS:
        code = [d.body for d in heredocs] + [w.text for w in herestrings]
        for k, w in enumerate(args):
            if re.match(r"^-[a-zA-Z]*[ce]$", w.text) and k + 1 < len(args):
                code.append(args[k + 1].text)
        if any(POSTISH.search(c) for c in code):
            refuse_through(ctx, f"{name} code")
        return name
    if name == "eval":
        joined = " ".join(w.text for w in args)
        if holds_checked(joined) or (any(w.dyn for w in args) and GH_WORD.search(joined)):
            refuse_through(ctx, "eval")
        return name
    gh_later(ctx, name, args)
    return name


def gh_later(ctx, name, args):
    """xargs, env, timeout, find -exec, …: a gh word later in the command runs gh with words this check cannot see."""
    for k, w in enumerate(args):
        if not w.quoted and not w.dyn and os.path.basename(w.text) in ("gh", "gh-axi"):
            if posts(args[k + 1:]):
                refuse_through(ctx, name)
            break


def guarded(ctx, target):
    """Is this call aimed at this clone's repo (or can we not tell)?"""
    ours, common = ctx.ours()
    if target is not None:
        kind, val = target
        if kind != "literal" or not ours:
            return True
        t = norm(val)
        return not t or t == ours
    if ctx.cwd is None or not os.path.isdir(ctx.cwd):
        return True
    theirs = git(ctx.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if theirs is None:
        return False   # not in a repo and no target: gh has no repo to post to
    if theirs == common or not ours:
        return True    # this clone, or a copy of the check that cannot tell which repo is its own
    return norm(git(ctx.cwd, "config", "--get", "remote.origin.url") or "") == ours


def say(lines):
    for line in lines:
        print(f"gh-text-check: {line}", file=sys.stderr)


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        if not GH_WORD.search(raw):
            return 0
        say(["refused — the hook input is not JSON and it names gh, so nothing can be checked; nothing ran"])
        return 2
    if data.get("tool_name") not in (None, "Bash"):
        return 0
    command = (data.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or not GH_WORD.search(command):
        return 0
    cwd = data.get("cwd") or os.getcwd()
    ctx = Ctx(cwd)
    try:
        walk(ctx, command)
    except Unreadable as e:
        say([f"refused — this command cannot be read ({e}) and it names gh, so the text it would post cannot be "
             f"checked", NEVER])
        return 2
    live = {i for i, t in enumerate(ctx.targets) if guarded(ctx, t)}
    texts = [t for t in ctx.texts if t[4] in live]
    # a call aimed at another repo drops its refusals; one no call can be named for always stands
    refuse = [r for r, i in ctx.refuse if i is None or i in live]
    if refuse:
        say([f"refused {r}" for r in dict.fromkeys(refuse)] + [NEVER])
        return 2
    if not texts:
        return 0
    if not os.path.isfile(GUARD):
        say(["refused — cannot check the text (no tests/leak-guard.sh in this worktree), so nothing ran"])
        return 2
    out, bad = [], False
    with tempfile.TemporaryDirectory(prefix="gh-text-check.") as tmp:
        for n, (label, how, val, is_title, _) in enumerate(texts):
            f = os.path.join(tmp, str(n))
            if how == "file":
                try:
                    with open(val, "rb") as src, open(f, "wb") as dst:
                        dst.write(src.read())
                except OSError:
                    say([f"refused — cannot read the {label} file {val}, so it cannot be checked; write it first, in "
                         f"its own command", NEVER])
                    return 2
            else:
                with open(f, "w", encoding="utf-8", errors="surrogateescape") as dst:
                    dst.write(val)
            if is_title:
                if not os.path.isfile(TITLE):
                    say([f"refused — cannot check the {label} (no tests/pr-title.sh in this worktree), so nothing ran"])
                    return 2
                with open(f, encoding="utf-8", errors="replace") as src:
                    title = src.read()
                r = subprocess.run(["bash", TITLE, title], capture_output=True, text=True)
                if r.returncode != 0:
                    bad = True
                    out.append(f"{label}: not a conventional-commit title")
                    out += ["  " + line.removeprefix("pr-title: ") for line in (r.stdout + r.stderr).splitlines()]
            env = dict(os.environ, LEAK_GUARD_SELFTEST="0")
            r = subprocess.run(["bash", GUARD, "--text", f], capture_output=True, text=True, cwd=TOP, env=env)
            if r.returncode != 0:
                bad = True
                for line in (r.stdout + r.stderr).splitlines():
                    if line.startswith("FAIL leak-guard") and line.endswith(":"):
                        continue
                    out.append(label + line[len(f):] if line.startswith(f + ":") else line.replace(f, label))
    if bad:
        say(["refused — the text this command would post fails the leak guard"]
            + ["  " + line for line in dict.fromkeys(out)]
            + ['fix the text (a made-up value: change it) and run the command again; never post it another way '
               '(.github/CONTRIBUTING.md, "Leak hooks").'])
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:   # never let a bug pass a command that names gh
        say([f"refused — the check failed ({type(e).__name__}), so nothing ran"])
        sys.exit(2)
