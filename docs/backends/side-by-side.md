# Side by side: one repo, two backends

A short run for you, the operator: bring up the same repo twice, once on `tmux` and once on `herdr`, give each one
small squad, compare them, then take both test projects down. Take `your-app` for a repo you can afford to
test on; `OWNER/your-app` is its GitHub name. Run every command in a plain host shell, in the dev-studio clone.

## Before you start

- `tmux` and the herdr release are on the host (`bun bin/backend/herdr.ts install`); see
  [trial-tmux.md](trial-tmux.md) and [trial-herdr.md](trial-herdr.md).
- Two squads need no Orca account change, but the account list and the skills install still go through Orca.
- Test projects on one GitHub repo share its pull requests and its feedback issues. Read "What the two projects
  share" before you start squads.

## 1. Bring up two projects

```sh
bin/ds up https://github.com/OWNER/your-app --label your-app-tmux  --backend tmux
bin/ds up https://github.com/OWNER/your-app --label your-app-herdr --backend herdr
```

Each project gets its own clone (`repos/<label>/`), state folder (`state/<label>/`), Studio and board entry. The
Studio's worktree comes from the project's worktree tool (`--worktree git|treehouse`; `auto` is the backend's own).
`up` ends with how to reach each Studio:

- tmux: `tmux -L ds-your-app-tmux attach -t _studio` (detach with `C-b d`, never kill the server).
- herdr: the attach command in `up`'s last lines (`HERDR_SOCKET_PATH=state/your-app-herdr/loop/herdr/herdr.sock
  HERDR_SESSION=ds-herdr-your-app-herdr <herdr bin>`).

`bin/ds up --help` lists every flag. A second `up` of the same label changes nothing.

## 2. Give each one a small squad

In each Studio terminal, one small topic, the same on both so the runs compare:

```
/ds-start-squad add a one-line note to the README about the topic
```

Approve each plan. Keep the topic tiny: a docs line, a rename. Watch both on one board (`bin/board/board.sh --serve`
shows every project).

## 3. Compare

Write down, for each project:

| Look at | Where |
|---|---|
| Time from `up` to a running Studio | `up`'s output, the board's Studio card |
| Time from approve to Builder started | the board's squad timeline |
| Terminals reachable and readable | the attach commands above |
| A crash and recover: kill the loop (`bin/loop/loop.sh --stop`), wait a minute for the watchdog | the board, `ds msg inbox` |
| Anything that needed you | the board's Needs you |

[trial.md](trial.md) holds the earlier comparison and its recommendation; add yours next to it.

## What the two projects share

Both projects point at one GitHub repo, so:

- **Pull requests.** Each project reads in full only its own units' PRs (`bin/loop/observers/github.ts`, the
  tracked-PR queue), so a squad on `your-app-tmux` is not poked about a PR from `your-app-herdr`. Both projects
  still list the repo's open PRs and see its merges, both squads open PRs into the same repo, and each may need a
  rebase when the other merges first.
- **Feedback.** Each project posts its ds-feedback and board feedback to the same repo's issues, so both projects'
  notes land in one place.
- **The loop, accounts and host load** are the host's, not the project's.

Merge or close each test PR yourself, and close the test issues, when you are done.

## 4. Take a test project down

Do this for each label (`your-app-tmux`, `your-app-herdr`). Nothing below removes the GitHub repo or its branches.

1. Close its squads: `/ds-close-squad <project> <topic>` for each, and wait for the board to show them archived.
2. List its worktrees, then remove them: `git -C repos/<label> worktree list`; for each one that is not the clone itself,
   `git -C repos/<label> worktree remove --force <path>`. An Orca project's worktrees are the `ds-<label>-…` ones
   in the Orca UI: remove them there.
3. Stop its terminals: tmux: `tmux -L ds-<label> kill-server`; herdr: stop its session with the herdr binary.
   Both only touch this project's own socket.
4. Delete its clone and state: `rm -rf repos/<label> state/<label>`. The state folder holds the project's squads,
   journals, notes and `dispatcher.json`; it is the project's whole record, so check the label twice.
5. Check: `bin/board/board.sh` no longer lists the project, and `git -C repos/<label> status` fails
   (no such folder).

The loop's own `state/loop.db` keeps the project's old rows (events, messages); they do no harm and age out.
To check the removal, run step 1's command for that label again: it starts a fresh project.
