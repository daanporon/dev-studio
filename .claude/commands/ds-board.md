---
description: Render the squad overview board (text, live --watch, or a live web page via --serve)
argument-hint: [<project>] [--watch [seconds]] [--serve [port]] [--stop]
allowed-tools: Bash(~/.dev-studio/bin/board/board.sh:*), Bash(~/.dev-studio/bin/ds services:*)
---
Run `~/.dev-studio/bin/board/board.sh` for the Studio's glanceable overview. By default it
prints text once; `--watch` (optionally `--watch 10`) live-refreshes in the terminal.

Which scope to show:
- If `$ARGUMENTS` names a project, pass it: `~/.dev-studio/bin/board/board.sh $ARGUMENTS`.
- Else if **you are a project's Studio** (your prompt says "You are the Studio for
  project '<label>'"), default to that project: `~/.dev-studio/bin/board/board.sh <label>`.
- Else if **you are a squad role agent** (your spec names a squad state file
  `state/<label>/squads/<topic>.json`), scope to **your own squad**:
  `~/.dev-studio/bin/board/board.sh <label> --topic <topic>`.
- Else (no context) run it with no project to show every project.

**Live page → `--serve`.** `--serve` means "keep this board running": it writes the wish (a
`services` row in loop.db, `bin/ds want board`, with your `DS_BIND`/`DS_BOARD_HOSTS`), waits up to
15 s for the loop to start it and prints the URL — or exits 1 when it failed (a port in use), and then
`~/.dev-studio/bin/ds services` shows the row and why. The loop starts the
server as its child (log in `state/<label>/board-serve.log`), pings it every tick and restarts it if it
died or stopped answering — so it outlives the Studio session that asked. More than three restarts in
ten minutes raise one Studio alert and leave it failed until the next `--serve`. It serves on
`127.0.0.1` (the host's own browser) and the Tailscale IP (your laptop) only — never every interface.
With no project it serves every project; `/ds-up` does not start one. End it with `--stop`.

```sh
~/.dev-studio/bin/board/board.sh <project> --serve        # prints the URL to open on your laptop
~/.dev-studio/bin/board/board.sh <project> --stop         # the loop stops it and stops keeping it alive
```

Without Tailscale it serves on `127.0.0.1` only (there's no file-based page — browsers
block it from loading the board data). `DS_BIND` overrides the addresses (space-separated).

The page polls every 5s and updates in place. It can **answer a question**: pick an option
(the suggestion is pre-selected) or type your own, and Send files it for the loop, which types it
into the asking agent's terminal on its next tick — that agent replies and resolves it as `/ds-q`
does; an answer that never lands puts the question back on the board. **Restart Lead / Restart squad /
Suspend / Resume / Archive squad** (in a squad's detail) and **Start squad / Reload all** (header, on a
project board) file a request the loop writes out for the Studio (`state/<label>/requests/_studio/`); the
Studio's watch tick shows it as `↻ request` and runs the `/ds-…` command, then deletes the file.
The board lists them under "Waiting for the Studio" until then. Chat, pokes, settings, overrides and
account switches are requests the loop does itself; the rest only **copy** a command. The board has no login: anyone who can reach it (localhost, your tailnet) can do this.
Needs `bun` on the host (every board view does) and a running loop (`bin/loop/loop.sh`). Re-running
`--serve` is safe: one board per scope, never a second.
