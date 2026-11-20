# Contributing

## PR titles

A pull request is squash merged, so its title is the only message that reaches `main`. It follows
[conventional commits](https://www.conventionalcommits.org/):

```
<type>(<scope>)!: <summary>
```

- **type** is one of `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **scope** is optional: the area, lowercase `a-z`, `0-9` and `-` (for example `board`, `loop`, `review-unit`,
  `focus-squad`).
- **`!`** is optional: it marks a breaking change.
- **summary** starts lowercase, and the whole title is at most 72 characters, on one line.

For example: `feat(board): show idle Builders`, `fix: keep the receipt on a base merge`,
`refactor(loop)!: drop the old picker`.

Only the PR title needs this, not the commits on the branch: squash merging throws those messages away.

Check a title with `tests/pr-title.sh "<title>"`. It exits 0 for a good title and otherwise prints the format and
the types. The `pr-title` workflow runs it on every PR into `main`. In a Claude session in this repo,
`githooks/gh-text-check` runs it before a `gh pr create` or `gh pr edit` with a title, or a `gh pr merge` with a
subject, and refuses `gh pr create --fill` with no title (see "Leak hooks").

## Leak hooks

Every commit and push runs `tests/leak-guard.sh`, which keeps private words, personal addresses, host names and
home paths out of the repo. The hooks are in `githooks/`, and the repo turns them on itself: `bun install` and
every Claude session in the repo run `githooks/setup.sh`, which sets the clone's `core.hooksPath` to `githooks`.
To turn them on by hand, run `sh githooks/setup.sh`.

The guard also checks each word of your own private list, one per line, in
`~/.config/dev-studio/leak-words.txt` (or `$XDG_CONFIG_HOME/dev-studio/leak-words.txt`, or the file
`DS_LEAK_WORDS` names). The list is never committed. With no list, every commit and push is refused.

When a hook refuses a commit or push, fix it: take the file or the line out, or amend or rebase the commit or
message. **Never retry with `--no-verify` or a `core.hooksPath` override.** On a false positive, change the
made-up value that trips the guard; don't widen its allow lists.

A branch from before the hooks has no `githooks/pre-commit`, so nothing checks it. `setup.sh` warns about this.
Merge `main` into the branch before you commit.

In a Claude session in this repo, the same guard checks what a `gh` (or `gh-axi`) call would post to GitHub before
it runs: the `PreToolUse` hook in `.claude/settings.json` runs `githooks/gh-text-check` on every Bash command. It
reads each title, body, comment, notes and `gh api` field, and every file passed with `--body-file`,
`--notes-file`, `--template`, `-F field=@file` or `--input`. It refuses `--attach`, `--web` and `--editor`, text
from standard input, and a text the shell fills in later (`$(…)`, backticks, `${…}`, `$NAME`), because it cannot
see those. It also refuses a `gh` call run through `bash -c`, `sh -c`, `eval`, `xargs`, `env`, a heredoc or pipe into a
shell, `python -c` or `node -e`, a release asset, and a body file read by a `gh` call that comes after another
command in the same Bash call (that command may still be writing the file). So write the text to a file in its
own command first, then pass it with `--body-file <file>` in a command of its own (a `cd` before it is fine). **A text it refuses is fixed,
never posted another way:** change the text and run the call again.
