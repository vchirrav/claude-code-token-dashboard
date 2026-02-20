# Claude Code Token Dashboard

A zero-dependency, real-time token usage dashboard for Claude Code. Runs locally in your browser, reads directly from Claude Code's session files, and updates live as you work.

---

## Why This Dashboard Is Essential

**1. Real-time cost visibility per exchange**
Claude Code's API costs accumulate silently. This dashboard breaks down token consumption (input, cache read, cache written, output) for every single exchange — so you can spot expensive prompts immediately rather than discovering the cost at billing time.

**2. Context window pressure monitoring**
The 200k context window fills up faster than expected when working on large codebases. The dashboard shows exactly how full your window is right now, with color-coded warnings at 60% (orange) and 80% (red), giving you time to act before Claude Code forces an unwanted compaction.

**3. Prompt cache efficiency tracking**
Claude Code uses prompt caching to reduce costs — but only if your context structure supports it. The cache hit rate metric (cache read % vs cache written %) tells you whether caching is working in your favour. A low rate signals that your prompts or file context are changing too much between turns, and you're paying full price every time.

---

## Prerequisites

**Node.js 18+** is the only requirement. No `npm install` needed.

### Windows
Install Node.js from [nodejs.org](https://nodejs.org) or via winget:
```powershell
winget install OpenJS.NodeJS
```
The hooks require **Git Bash** (installed with [Git for Windows](https://git-scm.com/download/win)). Run all shell commands in Git Bash, not CMD or PowerShell.

### macOS
```bash
brew install node
```
Or download from [nodejs.org](https://nodejs.org).

### Linux
```bash
# Debian/Ubuntu
sudo apt install nodejs

# Fedora/RHEL
sudo dnf install nodejs

# Or use nvm for version management
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 18
```

---

## Choosing a Setup Method

| | Quick Start (Manual) | Auto-start with Hooks |
|---|---|---|
| **How it starts** | You run `node server.js` once in a terminal | Starts automatically when you open a Claude Code session |
| **How it stops** | You stop it manually (`Ctrl+C`) | Stops automatically when the Claude Code session ends |
| **Works across all repos** | Yes — one running instance covers every project on your machine | No — only runs while the specific project that has the hooks configured is open |
| **Setup effort** | Clone the repo, run one command | Copy hook scripts, set an env var, edit `.claude/settings.json` |
| **Requires a terminal window** | Yes — the process must stay running | No — runs in the background, no terminal needed |
| **Best for** | Developers who want the dashboard always available regardless of which project they're in | Developers who want automatic lifecycle management tied to a specific project |

**Bottom line:** If you work across multiple repos and want the dashboard available at all times, use Quick Start. If you want zero manual steps and are happy with the dashboard only running when a particular project is active, use the hooks method.

---

## Quick Start (Manual)

The core steps are the same on all platforms. Adjust paths to match your OS conventions.

### Windows (Git Bash)
```bash
# 1. Clone this repo
git clone https://github.com/vchirrav/claude-code-token-dashboard.git "$USERPROFILE/claude-code-token-dashboard"
cd "$USERPROFILE/claude-code-token-dashboard"

# 2. Start the server
node server.js

# 3. Open http://localhost:4000 in your browser
```

### macOS
```bash
# 1. Clone this repo
git clone https://github.com/vchirrav/claude-code-token-dashboard.git ~/claude-code-token-dashboard
cd ~/claude-code-token-dashboard

# 2. Start the server
node server.js

# 3. Open http://localhost:4000 in your browser
```

### Linux
```bash
# 1. Clone this repo
git clone https://github.com/vchirrav/claude-code-token-dashboard.git ~/claude-code-token-dashboard
cd ~/claude-code-token-dashboard

# 2. Start the server
node server.js

# 3. Open http://localhost:4000 in your browser
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

Copy the hook scripts to your project and tell them where this repo lives.

**Step 1: Copy the hooks**

```bash
mkdir -p /path/to/your-project/.claude/hooks
cp .claude/hooks/start-dashboard.sh /path/to/your-project/.claude/hooks/
cp .claude/hooks/stop-dashboard.sh  /path/to/your-project/.claude/hooks/
```

**Step 2: Set `CLAUDE_DASHBOARD_DIR` to your clone path**

This environment variable tells the start hook where to find `server.js`.

#### Windows (Git Bash)
Add to `~/.bashrc`:
```bash
export CLAUDE_DASHBOARD_DIR="$USERPROFILE/claude-code-token-dashboard"
```
Then reload: `source ~/.bashrc`

#### macOS
Add to `~/.zshrc` (default shell since macOS Catalina):
```bash
export CLAUDE_DASHBOARD_DIR="$HOME/claude-code-token-dashboard"
```
Then reload: `source ~/.zshrc`

If you use bash, add to `~/.bash_profile` instead.

#### Linux
Add to `~/.bashrc`:
```bash
export CLAUDE_DASHBOARD_DIR="$HOME/claude-code-token-dashboard"
```
Then reload: `source ~/.bashrc`

---

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

| Platform | Shell required for hooks | Stop hook method |
|----------|--------------------------|-----------------|
| Windows (Git Bash) | Git Bash | PowerShell `Get-NetTCPConnection` |
| macOS | bash / zsh | `lsof` + `kill` |
| Linux | bash | `lsof` + `kill` |

The stop hook auto-detects your OS — no manual configuration needed.

---

## How It Works

The server reads Claude Code's JSONL session files from `~/.claude/projects/` and serves a single-page dashboard on `http://localhost:4000`. It watches the active session file with `fs.watch()` and pushes updates to the browser via Server-Sent Events (SSE) — no polling, no WebSockets, no external packages.

The dashboard listens on `127.0.0.1` only and is never accessible from outside your machine.
