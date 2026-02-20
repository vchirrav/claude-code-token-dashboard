# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A zero-dependency, real-time token usage dashboard for Claude Code. It reads session JSONL files from `~/.claude/projects/`, parses token usage data, and serves a live browser dashboard over SSE.

## Running the Dashboard

```bash
node server.js                                       # start on port 4000
node server.js --port 4001                           # alternate port
node server.js --path "/path/to/session.jsonl"       # pin to specific session
```

Open `http://localhost:4000` in a browser. The dashboard auto-selects the most recent session and updates live as Claude Code writes to the JSONL file.

## Architecture

Everything lives in a single file: `server.js` (~990 lines, no npm dependencies).

**Data flow:**
1. Claude Code writes exchanges to `~/.claude/projects/<project>/<sessionId>.jsonl`
2. `discoverSessions()` scans that directory and returns all `.jsonl` files sorted by mtime
3. `parseJSONL()` reads and parses the file — extracts token counts (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`) and groups assistant exchanges under their triggering user turn
4. `ensureWatcher()` uses `fs.watch()` with a 150ms debounce to detect file changes
5. On change, `broadcast()` sends an SSE `update` event to all connected browser clients
6. The browser renders left panel (session stats + context window) and right panel (paginated exchange history table)

**Key parsing rules in `parseJSONL()`:**
- Skips `tool_result`-only user messages (mid-turn tool responses)
- Skips messages containing `<local-command` / `<command-name>` tags (internal plumbing)
- Skips `isMeta` records
- Counts `compact_boundary` system events as compactions

**HTTP endpoints:**
- `GET /` — serves the embedded HTML dashboard
- `GET /events?path=<encoded-path>` — SSE stream; sends `sessions` list on connect, then `init` + live `update` events
- `GET /api/sessions` — JSON list of discovered sessions

## Hook Integration

`.claude/hooks/start-dashboard.sh` and `stop-dashboard.sh` are provided for SessionStart/SessionEnd auto-launch. `.claude/settings.json` wires them up.

`stop-dashboard.sh` is cross-platform: uses PowerShell on Windows (`$OSTYPE == msys*`), `lsof`/`kill` on macOS/Linux.

When used in another project, set `CLAUDE_DASHBOARD_DIR` to the path of this cloned repo so the start hook can locate `server.js`.
