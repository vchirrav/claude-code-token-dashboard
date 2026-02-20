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

There is no `package.json`, no `npm install`, and no build step — `server.js` uses only Node.js built-in modules (`http`, `fs`, `path`, `os`, `url`).

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
- Counts `compact_boundary` system events as compactions; captures `compactMetadata.preTokens` when present

**HTTP endpoints:**
- `GET /` — serves the embedded HTML dashboard
- `GET /events?path=<encoded-path>` — SSE stream; sends `sessions` list on connect, then `init` (full parse) + live `update` events on file changes
- `GET /api/sessions` — JSON list of discovered sessions

**SSE event sequence for a browser connecting to `/events`:**
1. `sessions` — full list of discovered sessions (sent immediately on connect)
2. `init` — full parsed data for the requested path (sent immediately on connect)
3. `update` — full re-parse, sent each time the JSONL file changes (debounced 150ms)

**Watcher lifecycle:** `fs.FSWatcher` instances are created lazily when the first SSE client subscribes to a path and are closed automatically when the last client disconnects.

## Hook Integration

`.claude/hooks/start-dashboard.sh` and `stop-dashboard.sh` are provided for SessionStart/SessionEnd auto-launch. `.claude/settings.json` wires them up.

`stop-dashboard.sh` is cross-platform: uses PowerShell on Windows (`$OSTYPE == msys*`), `lsof`/`kill` on macOS/Linux.

**Hook port:** The hooks hardcode port `4000`. If you start the server with `--port`, update the `PORT=4000` line in both hook scripts to match.

**server.log:** The start hook writes server output to `$DASHBOARD_DIR/server.log` (repo root). This file is gitignored.

**Using hooks in another project:** Set `CLAUDE_DASHBOARD_DIR` to the path of this cloned repo so the start hook can locate `server.js`. The hook silently exits if `server.js` is not found, making it safe to copy to repos that don't always have the dashboard available.
