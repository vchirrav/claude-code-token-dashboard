#!/usr/bin/env bash
##
## Claude Code SessionStart hook — Auto-start Token Dashboard
##
## When used in THIS repo: works as-is (server.js is at the project root).
##
## When copied to ANOTHER project:
##   Set the CLAUDE_DASHBOARD_DIR environment variable to the path where you
##   cloned claude-code-token-dashboard, e.g. in your shell profile:
##     export CLAUDE_DASHBOARD_DIR="$HOME/claude-code-token-dashboard"
##

# Resolve dashboard directory:
#   1. Use $CLAUDE_DASHBOARD_DIR if set
#   2. Otherwise fall back to the root of whichever repo this hook lives in
#      (two levels up from .claude/hooks/)
DASHBOARD_DIR="${CLAUDE_DASHBOARD_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

SERVER="$DASHBOARD_DIR/server.js"
LOG="$DASHBOARD_DIR/server.log"
PORT=4000
URL="http://localhost:${PORT}"

# ── Silently exit if server.js is not present (safe for repos without the dashboard)
[ -f "$SERVER" ] || exit 0

# ── Check if dashboard is already running on port 4000
if node -e "
  var n = require('net').connect($PORT, '127.0.0.1');
  n.on('connect', function(){ process.exit(0); });
  n.on('error',   function(){ process.exit(1); });
" 2>/dev/null; then
  printf "\n  ⟩_ Token Dashboard (already running): %s\n\n" "$URL"
  exit 0
fi

# ── Start the server detached (survives after hook exits)
mkdir -p "$(dirname "$LOG")"
nohup node "$SERVER" >> "$LOG" 2>&1 &
disown $! 2>/dev/null || true

# Brief pause for the server to bind its port
sleep 1

# ── Announce the URL
printf "\n"
printf "  ┌──────────────────────────────────────────────┐\n"
printf "  │  ⟩_ Token Dashboard started                  │\n"
printf "  │     %s                  │\n" "$URL"
printf "  │     Open in your browser for live token data  │\n"
printf "  └──────────────────────────────────────────────┘\n"
printf "\n"
