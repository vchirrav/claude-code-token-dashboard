# Claude Code Token Dashboard

A zero-dependency, real-time token usage dashboard for Claude Code. Runs locally in your browser, reads directly from Claude Code's session files, and updates live as you work.

---

## Why This Dashboard Is Essential

**1. Real-time cost visibility per exchange**
Claude Code's API costs accumulate silently. This dashboard breaks down token consumption (input, cache read, cache written, output) for every single exchange — so you can spot expensive prompts immediately rather than discovering the cost at billing time.

**2. Context window pressure monitoring**
The 200k context window fills up faster than expected when working on large codebases. The dashboard shows exactly how full your window is right now, with color-coded warnings at 60% (orange) and 80% (red), giving you time to act before Claude Code forces an unwanted compaction.

**3. Prompt cache efficiency tracking**
Claude Code uses prompt caching to reduce costs — but only if your context structure supports it. The cache hit rate metric (cache read % vs cache written %) tells you whether caching is working in your favour. A low hit rate signals that your prompts or file context are changing too much between turns, and you're paying full price every time.

---

## Prerequisites

- **Node.js 18+** — the only requirement. No `npm install` needed.
- Claude Code installed and generating session files in `~/.claude/projects/`

---

## Quick Start (Manual)

```bash
# 1. Clone this repo anywhere on your machine
git clone https://github.com/vchirrav/claude-code-token-dashboard.git
cd claude-code-token-dashboard

# 2. Start the server
node server.js

# 3. Open in your browser
#    http://localhost:4000
```

The dashboard auto-selects your most recent Claude Code session and updates live as you chat.

**Options:**
```bash
node server.js --port 4001                          # use a different port
node server.js --path "/path/to/session.jsonl"      # watch a specific session file
```

---

## Auto-start with Claude Code Hooks (Recommended)

Configure the dashboard to start automatically whenever you open a project in Claude Code and stop when you close it.

### Option A — Use hooks from this repo directly

If you open this cloned repo as your Claude Code project, the included `.claude/settings.json` already configures the hooks. Claude Code will prompt you to approve them on first launch.

### Option B — Integrate hooks into your own project

Copy the hook scripts to your project and add them to your Claude Code settings.

**Step 1: Copy the hooks**
```bash
mkdir -p /path/to/your-project/.claude/hooks
cp .claude/hooks/start-dashboard.sh /path/to/your-project/.claude/hooks/
cp .claude/hooks/stop-dashboard.sh  /path/to/your-project/.claude/hooks/
```

**Step 2: Tell the start hook where you cloned this repo**

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):
```bash
export CLAUDE_DASHBOARD_DIR="$HOME/claude-code-token-dashboard"
```
Or edit line 15 of `start-dashboard.sh` directly to set `DASHBOARD_DIR` to your clone path.

**Step 3: Add hooks to your project's `.claude/settings.json`**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/start-dashboard.sh",
            "timeout": 10,
            "statusMessage": "Starting token dashboard..."
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/stop-dashboard.sh",
            "timeout": 10,
            "statusMessage": "Stopping token dashboard..."
          }
        ]
      }
    ]
  }
}
```

---

## Dashboard Tour

| Area | What it shows |
|------|---------------|
| **Header** | Session selector dropdown (all projects, sorted by recency) · live connection status |
| **Left — Session** | Model name, project slug, exchange count, compaction count |
| **Left — Context Window** | Tokens used vs 200k limit · progress bar (green / orange / red) · breakdown by token type |
| **Left — Session Totals** | Cumulative input, output, cache hit rate, avg output per exchange |
| **Right — Exchange Table** | Paginated (10/page) · columns: User Prompt · Tokens Consumed · Final LLM Output |

---

## Platform Support

| Platform | Status |
|----------|--------|
| Windows (Git Bash) | Supported |
| macOS | Supported |
| Linux | Supported |

The stop hook auto-detects your OS and uses PowerShell on Windows or `lsof`/`kill` on macOS/Linux.

---

## How It Works

The server reads Claude Code's JSONL session files from `~/.claude/projects/` and serves a single-page dashboard on `http://localhost:4000`. It watches the active session file with `fs.watch()` and pushes updates to the browser via Server-Sent Events (SSE) — no polling, no WebSockets, no external packages.

The dashboard listens on `127.0.0.1` only and is never accessible from outside your machine.
