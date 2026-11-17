#!/usr/bin/env bash
# Run the dashboard natively with Node (no Docker), in the background.
#
#   ./start.sh          start (or restart if the code changed) and print the URL
#   ./start.sh stop     stop it
#   ./start.sh status   say whether it's running
#
# Needs Node 18+ and either GH_TOKEN set or the GitHub CLI logged in (`gh auth login`).
# Optional settings are read from .env next to this script and from
# ~/.config/pr-comments-dashboard/env (see .env.example for what you can set).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/pr-comments-dashboard"
PIDFILE="$STATE/server.pid"
LOG="$STATE/server.log"
mkdir -p "$STATE"

# Settings: .env next to this script (a git clone), then the user config file,
# which survives plugin updates and wins if both set something.
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/pr-comments-dashboard/env"
for f in "$DIR/.env" "$CONFIG"; do
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
  fi
done
PORT="${PORT:-8787}"
URL="http://localhost:$PORT"
# Hash of the code, so a git pull or plugin update triggers a restart. (Plugin
# installs aren't git checkouts, so the commit sha isn't available there.)
VERSION="$(cat "$DIR/server.js" "$DIR/mcp.js" "$DIR/public/index.html" | shasum | cut -c1-12)"

running_pid() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && cat "$PIDFILE"
}

health() { curl -fsS --max-time 2 "$URL/healthz" 2>/dev/null; }

stop() {
  local pid
  if pid="$(running_pid)"; then
    kill "$pid"
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    echo "Stopped pr-comments-dashboard (pid $pid)."
  else
    echo "pr-comments-dashboard is not running."
  fi
  rm -f "$PIDFILE"
}

case "${1:-start}" in
  stop) stop; exit 0 ;;
  status)
    if pid="$(running_pid)"; then echo "Running at $URL (pid $pid). Log: $LOG"; else echo "Not running."; fi
    exit 0 ;;
  start) ;;
  *) echo "Usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac

if h="$(health)"; then
  if [[ "$h" == *"\"version\":\"$VERSION\""* ]]; then
    echo "Already running at $URL"
    exit 0
  fi
  if running_pid >/dev/null; then
    echo "Code changed; restarting."
    stop >/dev/null
  else
    echo "Something else (an older version or the Docker container?) is already serving $URL; leaving it alone." >&2
    echo "Stop it first, or set PORT in $CONFIG to use another port." >&2
    exit 1
  fi
elif curl -fsS --max-time 2 -o /dev/null "$URL/" 2>/dev/null; then
  echo "Port $PORT is in use by something else (maybe the Docker version: docker compose down). Set PORT in $CONFIG to use another port." >&2
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Install Node 18 or newer (e.g. brew install node) and try again." >&2
  exit 1
fi
if (( $(node -p 'process.versions.node.split(".")[0]') < 18 )); then
  echo "Node $(node --version) is too old; need 18 or newer." >&2
  exit 1
fi

if [[ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  if ! command -v gh >/dev/null; then
    echo "Set GH_TOKEN in $CONFIG, or install the GitHub CLI (brew install gh) and run: gh auth login" >&2
    exit 1
  fi
  if ! GH_TOKEN="$(gh auth token 2>/dev/null)"; then
    echo "The GitHub CLI isn't logged in. Run: gh auth login" >&2
    exit 1
  fi
  export GH_TOKEN
fi

export PORT APP_VERSION="$VERSION" REPOS_DIR="${REPOS_DIR:-$HOME}"
nohup node "$DIR/server.js" >"$LOG" 2>&1 &
echo $! >"$PIDFILE"

for _ in $(seq 50); do
  if health >/dev/null; then
    echo "pr-comments-dashboard running at $URL (log: $LOG)"
    exit 0
  fi
  if ! running_pid >/dev/null; then break; fi
  sleep 0.2
done
echo "Failed to start. Last log lines:" >&2
tail -n 20 "$LOG" >&2
rm -f "$PIDFILE"
exit 1
