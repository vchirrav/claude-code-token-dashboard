#!/usr/bin/env bash
##
## Claude Code SessionEnd hook — Stop Token Dashboard
##
## Cross-platform: works on Windows (Git Bash), macOS, and Linux.
## Finds the process listening on port 4000 and terminates it.
##

PORT=4000

if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* || -n "$WINDIR" ]]; then
  # ── Windows (Git Bash / MSYS2) ─────────────────────────────────────────────
  PID=$(powershell -Command "
    \$conn = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
    if (\$conn) { \$conn.OwningProcess } else { '' }
  " 2>/dev/null | tr -d '[:space:]')

  [ -z "$PID" ] && exit 0
  powershell -Command "Stop-Process -Id $PID -Force" 2>/dev/null

else
  # ── macOS / Linux ──────────────────────────────────────────────────────────
  PID=$(lsof -ti tcp:$PORT 2>/dev/null | head -1)

  [ -z "$PID" ] && exit 0
  kill "$PID" 2>/dev/null

fi

printf "  ⟩_ Token Dashboard stopped (PID %s)\n" "$PID"
