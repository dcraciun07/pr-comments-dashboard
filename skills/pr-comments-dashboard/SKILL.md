---
name: pr-comments-dashboard
description: Start and open a local dashboard of review and conversation comments on your GitHub PRs (open and recently merged), plus replies to you on other people's PRs, filterable by reacted/unreacted, resolved, author, repo and PR. Use when the user wants to see, triage or catch up on PR comments, unreacted or unresolved review feedback, or replies to them, or asks to open, start, stop or update the PR comments dashboard.
compatibility: Requires Node 18+ and the GitHub CLI (gh) logged in. macOS or Linux.
metadata:
  useful-for: dev
---

# PR comments dashboard

Runs [pr-comments-dashboard](https://github.com/dcraciun07/pr-comments-dashboard)
locally in the background and opens it at http://localhost:8787. The server only
listens on localhost and reads GitHub with the user's own `gh` login. Nothing is
written to GitHub.

## Find the code (call it `$APP`)

- If `${CLAUDE_SKILL_DIR}/../../start.sh` exists, this skill was installed as
  part of the plugin: `$APP` is `${CLAUDE_SKILL_DIR}/../..`. Plugin updates
  bring new code, so don't git pull.
- Otherwise `$APP` is `~/.local/share/pr-comments-dashboard`. If it doesn't
  exist, clone it with
  `git clone https://github.com/dcraciun07/pr-comments-dashboard ~/.local/share/pr-comments-dashboard`.
  If it does, update it with `git -C "$APP" pull --ff-only --quiet`. If the pull
  fails (for example local changes), say so and carry on with the current code.

## Start (the default)

1. Run `bash "$APP/start.sh"`. It is safe to run repeatedly: it does nothing if
   the dashboard is already running, and restarts it if the code changed.
2. On success, open the URL it printed (`open` on macOS, `xdg-open` on Linux)
   and tell the user it's open. The first load takes a few seconds while it
   fetches from GitHub.

If `start.sh` fails, it prints the fix. Relay it in one or two plain sentences
instead of working around it. The usual cases:

- **gh not installed or not logged in**: the user runs `gh auth login`. Suggest
  they type `! gh auth login` so it runs in this session.
- **Node missing or too old**: `brew install node` on macOS.
- **Port 8787 in use**: something else is on that port. Offer to set another
  port by adding `PORT=8788` to `~/.config/pr-comments-dashboard/env`, then run
  `start.sh` again.
- **GitHub 401/403 in the log**: the `gh` token can't read the repos.
  `gh auth refresh -s repo` usually fixes it. For an org that uses SSO, the user
  may also need to authorize the token for that org on GitHub.

## Stop, status, logs

- Stop: `bash "$APP/start.sh" stop`. It otherwise runs until the user stops it
  or reboots.
- Status: `bash "$APP/start.sh" status` (also prints the log path,
  `~/.local/state/pr-comments-dashboard/server.log`).

## Settings

Optional settings go in `~/.config/pr-comments-dashboard/env`, one `KEY=value`
per line; `$APP/.env.example` lists them (port, how many days of merged PRs,
where local clones live for the "Open in VS Code" links). Run `start.sh stop`
then `start.sh` after changing them.

## Asking Claude about comments

While the dashboard is running, it also serves an MCP endpoint with a
`list_pr_comments` tool, so the user can ask things like "any unreacted
comments on my open PRs?". If the user wants that, check `claude mcp get
pr-comments`, and if it isn't set up, run:

```sh
claude mcp add --scope user --transport http pr-comments http://localhost:8787/mcp
```

Tell them it's available from their next Claude Code session, and only connects
when the dashboard is running. To answer a question about comments in the
current session without the MCP tool, read `http://localhost:8787/api/comments`
with `curl -s` and filter the JSON with `jq`.
