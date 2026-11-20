# pr-comments-dashboard

Local dashboard of comments on your open and recently merged GitHub PRs, as
filterable cards (PR state, author, repo, PR, comment type, reacted/unreacted,
resolved/unresolved, comment text). Merged PRs are those merged in the last
`MERGED_DAYS` days (default 30). Replies are shown as their
own cards, since GitHub treats each one as a separate comment.

The **On my PRs** dropdown switches to **Replies to me on others' PRs**: PRs by
other people that you reviewed or commented on (open, or merged in the last
`MERGED_DAYS` days). There it shows comments posted after yours in review threads
you joined, and conversation comments that @mention you. Untick **Hide mine** to
also see your own comments there, with the reactions they got.

Two comment types are shown: inline **review** comments, and **conversation**
comments from the PR's Conversation tab. Conversation comments from bots (CI,
coverage, etc.) are left out. They have no file, line or thread, so they never
count as resolved.

## Install

### As a Claude Code plugin (easiest)

In Claude Code, run these two commands one at a time (pasting both at once
sends them as one command, which fails):

```
/plugin marketplace add dcraciun07/pr-comments-dashboard
```

```
/plugin install pr-comments-dashboard@pr-comments-dashboard
```

Then ask Claude to "open my PR comments dashboard". It starts the dashboard in
the background and opens it. You need Node 18+ and the GitHub CLI logged in
(`gh auth login`).

If you only want the skill, copy `skills/pr-comments-dashboard` into
`~/.claude/skills/`. It clones this repo the first time it runs.

### By hand

You need Node 18+ and the GitHub CLI logged in (`gh auth login`):

```sh
git clone https://github.com/dcraciun07/pr-comments-dashboard ~/.local/share/pr-comments-dashboard
~/.local/share/pr-comments-dashboard/start.sh   # start, or restart after a git pull
open http://localhost:8787
```

`start.sh stop` stops it and `start.sh status` shows whether it's running. It
runs in the background until you stop it or reboot, and only listens on
localhost. It uses your `gh` login's token unless `GH_TOKEN` is set. Optional
settings go in `~/.config/pr-comments-dashboard/env` (see `.env.example`).

### With Docker instead

```sh
cp .env.example .env
echo "GH_TOKEN=$(gh auth token)" >> .env   # or paste a token into .env
docker compose up -d --build
```

Stop with `docker compose down`.

### Using it

Data is cached for 5 minutes. Use **↻ Refresh** (or press `r`) to re-fetch from GitHub.
Filters are saved in the URL, so you can bookmark a view. By default the page
shows unreacted comments and hides your own.

## Open comments in VS Code

Each card has two VS Code links. They need the
[GitHub Pull Requests](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github)
extension:

- **Check out PR** checks out the PR branch in your local clone, through the
  extension. This switches that clone's branch, so commit or stash first. Once
  checked out, review threads show inline in the editor with a **Resolve** button.
- **Open in VS Code** opens the commented file at the comment's line, in the
  window that has that repo open.

Links assume `owner/name` is cloned at `$REPOS_DIR/name`, which defaults to your
home directory. Override individual repos with `REPO_PATHS` in `.env`. Comments on
files added by a PR only resolve once that PR is checked out. Outdated comments
open at the line where the comment was originally made.

After resolving in VS Code, click **↻ Refresh** and the **Resolved** filter picks
it up.

## Notifications

While it runs (via `start.sh` or the plugin), the dashboard checks GitHub every
minute and shows a desktop notification for each new comment it would show you,
except your own: comments on your PRs (💬) and replies to you on other people's
PRs (↩️). More than four at once become a single summary that opens the
dashboard.

On macOS, install [terminal-notifier](https://github.com/julienXX/terminal-notifier)
(`brew install terminal-notifier`) so clicking a notification opens the comment
on GitHub. Without it, notifications come from Script Editor via `osascript` and
clicking them does nothing useful. The first time, macOS may need you to allow
notifications for terminal-notifier (or Script Editor) in System Settings >
Notifications; until then it falls back to `osascript`. On Linux it uses `notify-send`. The Docker
version doesn't notify.

Each check only runs the PR searches and re-fetches the PRs that changed, so it
stays well inside GitHub's rate limits. The first run remembers the comments that
are already there without notifying; after that, what it has seen is kept in
`~/.local/state/pr-comments-dashboard/notified.json`, so restarting doesn't
repeat notifications, and comments posted while it was stopped are announced
when it starts again.

Settings (in `~/.config/pr-comments-dashboard/env`): `NOTIFY=0` turns
notifications off, `NOTIFY_INTERVAL_SECONDS` changes how often it checks
(default 60, minimum 30), and `NOTIFY_SOUND` picks the macOS sound (empty for
silent). `NOTIFY_INCLUDE_MINE=1` also notifies about your own comments, which is
an easy way to check notifications work.

## Use from Claude (MCP)

The server also serves an MCP endpoint at `http://localhost:8787/mcp`
(Streamable HTTP). It uses the same cache as the dashboard. Register it once:

```sh
claude mcp add --scope user --transport http pr-comments http://localhost:8787/mcp
```

Then ask Claude things like "show my unreacted PR comments" or "any unreacted
comments from a given reviewer on web?". The tool is called
`list_pr_comments`, with these optional arguments: `reaction`
(`unreacted`/`reacted`/`any`, default `unreacted`), `source`
(`mine`/`others`/`any`, default `mine`), `author`, `repo`, `pr`,
`state` (`open`/`merged`/`any`, default `open`), `kind`
(`review`/`conversation`/`any`, default `any`), `resolved` (`unresolved`/`resolved`/`any`), `text`, `include_mine`, `refresh`, `limit`.

The server must be running when Claude Code starts for the tool to connect.
