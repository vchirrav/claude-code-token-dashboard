#!/usr/bin/env node
/**
 * Claude Code Token Dashboard
 * Local-only live token usage viewer for Claude Code JSONL sessions.
 *
 * Usage:
 *   node server.js
 *   node server.js --port 4001
 *   node server.js --path "/path/to/.claude/projects/.../session.jsonl"
 *
 * Then open: http://localhost:4000
 *
 * No npm install required — uses only Node.js built-in modules.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const url  = require('url');

// ─── Config ────────────────────────────────────────────────────────────────
const ARGS   = process.argv.slice(2);
const PORT   = (() => { const i = ARGS.indexOf('--port'); return i >= 0 ? parseInt(ARGS[i + 1], 10) : 4000; })();
const FORCED = (() => { const i = ARGS.indexOf('--path'); return i >= 0 ? ARGS[i + 1] : null; })();

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ─── SSE client registry ────────────────────────────────────────────────────
/** @type {Map<string, Set<http.ServerResponse>>} path → clients */
const clientsByPath = new Map();

// ─── File watchers ──────────────────────────────────────────────────────────
/** @type {Map<string, fs.FSWatcher>} */
const watchers = new Map();

// ─── Discovery ──────────────────────────────────────────────────────────────
function discoverSessions() {
  const sessions = [];
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return sessions;

  let projects;
  try { projects = fs.readdirSync(CLAUDE_PROJECTS_DIR); }
  catch (_) { return sessions; }

  for (const project of projects) {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, project);
    let stat;
    try { stat = fs.statSync(projectDir); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;

    let files;
    try { files = fs.readdirSync(projectDir); } catch (_) { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, file);
      try {
        const fstat = fs.statSync(filePath);
        sessions.push({
          path:      filePath,
          project:   project,
          sessionId: file.replace('.jsonl', ''),
          mtime:     new Date(fstat.mtime).toLocaleString(),
          mtimeRaw:  fstat.mtime.getTime(),
          size:      fstat.size,
        });
      } catch (_) {}
    }
  }

  return sessions.sort((a, b) => b.mtimeRaw - a.mtimeRaw);
}

// ─── JSONL Parser ────────────────────────────────────────────────────────────
function parseJSONL(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }); }
  catch (err) { console.error(`[dashboard] Cannot read JSONL: ${err.code} – ${filePath}`); return null; }

  const lines = raw.split('\n').filter(Boolean);

  const data = {
    sessionId:  null,
    slug:       null,
    model:      null,
    version:    null,
    exchanges:  [],
    totals: { input: 0, cacheRead: 0, cacheCreated: 0, output: 0 },
    compactCount: 0,
  };

  let pendingUser = null; // most recent real user message

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }

    // ── Compact boundary event ──────────────────────────────────────────────
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
      data.compactCount++;
      if (rec.compactMetadata?.preTokens) {
        data.compactPreTokens = rec.compactMetadata.preTokens;
      }
      continue;
    }

    // ── User messages ───────────────────────────────────────────────────────
    if (rec.type === 'user' && rec.message?.role === 'user') {
      // Skip pure meta wrappers
      if (rec.isMeta) continue;

      const msgContent = rec.message.content;

      // Skip tool result messages — these are tool call responses sent back to Claude,
      // not actual human input. When ALL content items are tool_result, this is a
      // mid-turn tool response; grouping it as a new user turn would split a single
      // user question into multiple rows.
      if (Array.isArray(msgContent) && msgContent.length > 0 &&
          msgContent.every(c => c.type === 'tool_result')) continue;

      const content = extractTextContent(msgContent);

      // Skip messages with no actual human text
      if (!content.trim()) continue;

      // Skip internal command plumbing
      if (
        content.includes('<local-command') ||
        content.includes('<command-name>') ||
        content.includes('<local-command-stdout>') ||
        content.includes('<local-command-caveat>')
      ) continue;

      pendingUser = {
        uuid:            rec.uuid,
        timestamp:       rec.timestamp,
        content:         content,
        isCompactSummary: !!rec.isCompactSummary,
      };
      continue;
    }

    // ── Assistant messages ──────────────────────────────────────────────────
    if (rec.type === 'assistant' && rec.message?.usage) {
      const msg   = rec.message;
      const usage = msg.usage;

      if (!data.sessionId && rec.sessionId) data.sessionId = rec.sessionId;
      if (!data.model     && msg.model)     data.model     = msg.model;
      if (!data.slug      && rec.slug)      data.slug      = rec.slug;
      if (!data.version   && rec.version)   data.version   = rec.version;

      const input        = usage.input_tokens                 || 0;
      const cacheRead    = usage.cache_read_input_tokens      || 0;
      const cacheCreated = usage.cache_creation_input_tokens  || 0;
      const output       = usage.output_tokens                || 0;

      const responseText = extractTextContent(msg.content);

      data.exchanges.push({
        uuid:        rec.uuid,
        requestId:   rec.requestId,
        timestamp:   rec.timestamp,
        model:       msg.model,
        input,
        cacheRead,
        cacheCreated,
        output,
        totalContext: input + cacheRead + cacheCreated,
        userMessage: pendingUser || null,
        response:    responseText,
        serviceTier: usage.service_tier,
      });

      data.totals.input        += input;
      data.totals.cacheRead    += cacheRead;
      data.totals.cacheCreated += cacheCreated;
      data.totals.output       += output;

      pendingUser = null;
      continue;
    }
  }

  return data;
}

function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('');
  }
  return '';
}

// ─── File watching ───────────────────────────────────────────────────────────
function ensureWatcher(filePath) {
  if (watchers.has(filePath)) return;

  let debounce = null;
  const watcher = fs.watch(filePath, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const parsed = parseJSONL(filePath);
      if (!parsed) return;
      broadcast(filePath, { type: 'update', data: parsed });
    }, 150);
  });

  watcher.on('error', () => {
    watchers.delete(filePath);
  });

  watchers.set(filePath, watcher);
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────
function addClient(filePath, res) {
  if (!clientsByPath.has(filePath)) clientsByPath.set(filePath, new Set());
  clientsByPath.get(filePath).add(res);
  ensureWatcher(filePath);
}

function removeClient(filePath, res) {
  const set = clientsByPath.get(filePath);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    clientsByPath.delete(filePath);
    const w = watchers.get(filePath);
    if (w) { w.close(); watchers.delete(filePath); }
  }
}

function broadcast(filePath, payload) {
  const set = clientsByPath.get(filePath);
  if (!set || set.size === 0) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch (_) {}
  }
}

function sendSSE(res, payload) {
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
}

// ─── HTML ────────────────────────────────────────────────────────────────────
const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code · Token Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#13151a;
  --surface:#1c1f27;
  --s2:#22252f;
  --s3:#2a2d38;
  --border:#353a47;
  --b2:#424858;
  --text:#edf0f7;
  --text2:#c8cdd8;
  --muted:#9aa0b0;
  --muted2:#6e7585;
  --accent:#10b981;
  --accent2:#34d399;
  --user:#a78bfa;
  --warn:#fbbf24;
  --danger:#f87171;
  --blue:#60a5fa;
  --cyan:#22d3ee;
  --purple:#c084fc;
}

body{
  font-family:'JetBrains Mono','Cascadia Code','Fira Code',ui-monospace,monospace;
  background:var(--bg);
  color:var(--text);
  font-size:13px;
  line-height:1.55;
  height:100vh;
  display:flex;
  flex-direction:column;
  overflow:hidden;
}

/* ── Header ─────────────────────────────────────────────────────── */
header{
  background:var(--surface);
  border-bottom:2px solid var(--border);
  padding:10px 18px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-shrink:0;
  gap:12px;
}
.logo{font-size:13px;font-weight:700;color:var(--accent);letter-spacing:.06em;white-space:nowrap}
.logo span{color:var(--text2)}
.live{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 2s infinite;flex-shrink:0}
.dot.off{background:var(--danger);animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
select.session-pick{
  background:var(--s2);
  border:1px solid var(--border);
  color:var(--text);
  font-family:inherit;
  font-size:11px;
  padding:5px 9px;
  border-radius:5px;
  cursor:pointer;
  max-width:380px;
  flex:1;
}
select.session-pick:focus{outline:1px solid var(--accent);border-color:var(--accent)}
.hdr-right{display:flex;align-items:center;gap:10px;min-width:0}
.ts{font-size:11px;color:var(--muted);white-space:nowrap}

/* ── Layout ─────────────────────────────────────────────────────── */
.main{display:grid;grid-template-columns:290px 1fr;flex:1;min-height:0}

/* ── Left panel ─────────────────────────────────────────────────── */
.left{
  border-right:1px solid var(--border);
  overflow-y:auto;
  padding:14px 12px;
  display:flex;
  flex-direction:column;
  gap:14px;
  background:var(--bg);
}
.panel-label{
  font-size:10px;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:.14em;
  color:var(--muted);
  margin-bottom:8px;
}
.card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:7px;
  padding:13px;
}
.irow{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  padding:6px 0;
  border-bottom:1px solid var(--border);
  font-size:12px;
  gap:8px;
}
.irow:last-child{border-bottom:none}
.ik{color:var(--muted);flex-shrink:0}
.iv{color:var(--text);font-weight:600;text-align:right;word-break:break-all}
.big-num{font-size:28px;font-weight:800;color:var(--text);line-height:1}
.big-sub{font-size:12px;color:var(--muted);margin-top:4px;margin-bottom:12px}
.ctx-bar{background:var(--s3);border-radius:4px;height:10px;margin-bottom:14px;overflow:hidden}
.ctx-fill{height:100%;border-radius:4px;transition:width .5s ease;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.ctx-fill.warn{background:linear-gradient(90deg,var(--warn),#f59e0b)}
.ctx-fill.danger{background:linear-gradient(90deg,var(--danger),#ef4444)}
.seg-bar{height:14px;border-radius:5px;overflow:hidden;display:flex;margin-bottom:14px;gap:1px}
.seg{height:100%;transition:width .5s ease;min-width:0}
.bar-legend{display:flex;flex-direction:column;gap:7px}
.bl-row{display:flex;align-items:center;gap:8px;font-size:12px}
.bl-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
.bl-label{flex:1;color:var(--text2)}
.bl-val{font-weight:700;color:var(--text);min-width:42px;text-align:right}
.bl-pct{font-size:11px;color:var(--muted);min-width:34px;text-align:right}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat-box{
  background:var(--s2);
  border:1px solid var(--border);
  border-radius:6px;
  padding:10px;
}
.stat-l{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px}
.stat-v{font-size:22px;font-weight:800;line-height:1}
.stat-s{font-size:11px;color:var(--muted2);margin-top:3px}
.c-input{color:var(--blue)}
.c-cread{color:var(--cyan)}
.c-cwrite{color:var(--purple)}
.c-out{color:var(--accent2)}

/* ── Right panel ────────────────────────────────────────────────── */
.right{overflow-y:auto;padding:0;background:var(--bg)}

/* ── 3-column turns table ───────────────────────────────────────── */
.turns-wrap{display:flex;flex-direction:column;min-height:0}

.col-heads{
  display:grid;
  grid-template-columns:28% 190px 1fr;
  background:var(--s3);
  border-bottom:2px solid var(--b2);
  position:sticky;
  top:0;
  z-index:5;
}
.col-head{
  padding:9px 14px;
  font-size:10px;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:.14em;
  color:var(--muted);
}
.col-head+.col-head{border-left:1px solid var(--border)}

.turn-row{
  display:grid;
  grid-template-columns:28% 190px 1fr;
  border-bottom:1px solid var(--border);
}
.turn-row:last-child{border-bottom:none}
.turn-row:nth-child(even) .tc{background-color:rgba(255,255,255,.012)}

.tc{
  padding:13px 14px;
  overflow:hidden;
  word-break:break-word;
  min-width:0;
}
.tc+.tc{border-left:1px solid var(--border)}

.tc-prompt{border-left:3px solid var(--user)}
.tc-tokens{background:var(--s2)}
.tc-output{border-left:3px solid var(--accent)}

/* turn meta */
.turn-meta{
  display:flex;
  align-items:center;
  gap:8px;
  margin-bottom:9px;
}
.turn-num{
  font-size:11px;
  font-weight:800;
  color:var(--text);
  background:var(--s3);
  border:1px solid var(--border);
  border-radius:4px;
  padding:1px 7px;
  flex-shrink:0;
}
.turn-time{font-size:11px;color:var(--muted)}
.badge-compact{
  font-size:10px;
  font-weight:700;
  padding:1px 6px;
  border-radius:3px;
  background:#451a03;
  color:#fcd34d;
  border:1px solid #b45309;
  flex-shrink:0;
}

/* text blocks */
.prompt-text{
  font-size:12px;
  line-height:1.7;
  color:var(--text);
  white-space:pre-wrap;
}
.output-text{
  font-size:12px;
  line-height:1.7;
  color:var(--text);
  white-space:pre-wrap;
}
.text-trunc{
  font-size:11px;
  color:var(--muted2);
  font-style:italic;
  margin-top:6px;
}
.no-content{
  font-size:12px;
  color:var(--muted2);
  font-style:italic;
}

/* token breakdown */
.tok-total{
  font-size:26px;
  font-weight:800;
  color:var(--text);
  line-height:1;
  margin-bottom:3px;
}
.tok-unit{font-size:11px;color:var(--muted);margin-bottom:10px}
.tok-rows{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
.tok-row{display:flex;justify-content:space-between;align-items:center;font-size:11px;gap:6px}
.tok-k{color:var(--muted);flex-shrink:0}
.tok-v{font-weight:700;text-align:right}

.mini-bar{height:6px;border-radius:3px;overflow:hidden;display:flex;gap:1px;margin-top:2px}
.mini-seg{height:100%;min-width:0}

.api-count{
  font-size:10px;
  color:var(--muted2);
  border-top:1px solid var(--border);
  padding-top:7px;
  margin-top:8px;
}

/* pagination bar */
.pager{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:7px 14px;
  background:var(--s3);
  border-bottom:1px solid var(--border);
  position:sticky;
  top:37px;
  z-index:4;
}
.pager-info{font-size:11px;color:var(--muted)}
.pager-info strong{color:var(--text2)}
.pager-btns{display:flex;gap:8px}
.pager-btn{
  background:var(--s2);
  border:1px solid var(--border);
  color:var(--text2);
  font-family:inherit;
  font-size:11px;
  padding:4px 13px;
  border-radius:4px;
  cursor:pointer;
  transition:background .15s,border-color .15s,color .15s;
}
.pager-btn:hover:not(:disabled){
  background:var(--surface);
  border-color:var(--accent);
  color:var(--accent);
}
.pager-btn:disabled{opacity:.3;cursor:default}

/* empty state */
.empty{text-align:center;color:var(--muted);padding:60px 20px}
.empty h2{color:var(--accent);font-size:16px;margin-bottom:8px;font-weight:700}
.empty p{font-size:12px;color:var(--muted2)}

/* scrollbar */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--b2)}
</style>
</head>
<body>
<header>
  <div class="logo">⟩_ <span>Claude Code</span> Token Dashboard</div>
  <div class="hdr-right">
    <select class="session-pick" id="sp" onchange="switchSession(this.value)">
      <option>Loading sessions…</option>
    </select>
    <div class="live"><div class="dot" id="dot"></div><span id="st">Connecting</span></div>
    <span class="ts" id="ts"></span>
  </div>
</header>

<div class="main">
  <div class="left" id="left">
    <div class="empty"><h2>No session</h2><p>Select a session above</p></div>
  </div>
  <div class="right" id="right">
    <div class="empty"><h2>Claude Code Token Dashboard</h2><p>Select a session to begin</p></div>
  </div>
</div>

<script>
/* ─── utils ─── */
const $ = id => document.getElementById(id);
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmt = n => n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n);

const C = { input:'#3b82f6', cread:'#06b6d4', cwrite:'#8b5cf6', output:'#10b981' };

/* ─── state ─── */
let evtSource   = null;
let activePath  = null;
let currentPage = 0;
let lastData    = null;
const PAGE_SIZE = 10;

/* ─── bootstrap ─── */
connect(null);

function connect(sessionPath) {
  if (evtSource) evtSource.close();
  activePath = sessionPath;
  const u = '/events' + (sessionPath ? '?path=' + encodeURIComponent(sessionPath) : '');
  evtSource = new EventSource(u);

  evtSource.onopen = () => {
    $('dot').className = 'dot';
    $('st').textContent = 'Live';
  };

  evtSource.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'sessions') {
      renderSessionList(msg.sessions);
    } else if (msg.type === 'init' || msg.type === 'update') {
      renderAll(msg.data);
      $('ts').textContent = new Date().toLocaleTimeString();
    }
  };

  evtSource.onerror = () => {
    $('dot').className = 'dot off';
    $('st').textContent = 'Reconnecting…';
  };
}

function switchSession(p) {
  if (p) { currentPage = 0; connect(p); }
}

function renderSessionList(sessions) {
  const sel = $('sp');
  const cur = sel.value;
  sel.innerHTML = sessions.map(s =>
    \`<option value="\${esc(s.path)}" \${s.path===cur?'selected':''}>\${s.project} / \${s.sessionId.slice(0,8)}… · \${s.mtime}</option>\`
  ).join('');
  if (!activePath && sessions.length) switchSession(sessions[0].path);
}

/* ─── render ─── */
function renderAll(d) { lastData = d; renderLeft(d); renderRight(d); }

function prevPage() { if (currentPage > 0) { currentPage--; renderRight(lastData); } }
function nextPage() {
  if (!lastData) return;
  const total = groupTurns(lastData.exchanges).length;
  if ((currentPage + 1) * PAGE_SIZE < total) { currentPage++; renderRight(lastData); }
}

function renderLeft(d) {
  if (!d) return;
  const t = d.totals;
  const LIMIT = 200000;

  const latestEx  = d.exchanges.length > 0 ? d.exchanges[d.exchanges.length - 1] : null;
  const curInput  = latestEx ? latestEx.input        : 0;
  const curCRead  = latestEx ? latestEx.cacheRead    : 0;
  const curCWrite = latestEx ? latestEx.cacheCreated : 0;
  const currentCtx = curInput + curCRead + curCWrite;
  const usedPct = Math.min(100, currentCtx / LIMIT * 100);
  const fillCls = usedPct > 80 ? 'danger' : usedPct > 60 ? 'warn' : '';

  const wi = currentCtx ? (curInput  / currentCtx * 100).toFixed(1) : 0;
  const wr = currentCtx ? (curCRead  / currentCtx * 100).toFixed(1) : 0;
  const ww = currentCtx ? (curCWrite / currentCtx * 100).toFixed(1) : 0;

  const totalCtx = t.input + t.cacheRead + t.cacheCreated;
  const cacheHit = (t.cacheRead + t.cacheCreated) > 0
    ? Math.round(t.cacheRead / (t.cacheRead + t.cacheCreated) * 100) : 0;
  const avgOut = d.exchanges.length ? Math.round(t.output / d.exchanges.length) : 0;

  $('left').innerHTML = \`
    <div>
      <div class="panel-label">Session</div>
      <div class="card">
        <div class="irow"><span class="ik">Model</span><span class="iv">\${esc(d.model||'—')}</span></div>
        <div class="irow"><span class="ik">Slug</span><span class="iv">\${esc(d.slug||'—')}</span></div>
        <div class="irow"><span class="ik">Exchanges</span><span class="iv">\${d.exchanges.length}</span></div>
        <div class="irow"><span class="ik">Compactions</span><span class="iv">\${d.compactCount}</span></div>
      </div>
    </div>

    <div>
      <div class="panel-label">Context Window</div>
      <div class="card">
        <div class="big-num">\${fmt(currentCtx)}<span style="font-size:15px;color:var(--muted);font-weight:400"> / 200k</span></div>
        <div class="big-sub">\${usedPct.toFixed(1)}% used · latest exchange</div>
        <div class="ctx-bar"><div class="ctx-fill \${fillCls}" style="width:\${usedPct}%"></div></div>

        <div class="seg-bar">
          <div class="seg" style="width:\${wi}%;background:\${C.input}"></div>
          <div class="seg" style="width:\${wr}%;background:\${C.cread}"></div>
          <div class="seg" style="width:\${ww}%;background:\${C.cwrite}"></div>
        </div>

        <div class="bar-legend">
          <div class="bl-row">
            <div class="bl-dot" style="background:\${C.input}"></div>
            <span class="bl-label">Input (uncached)</span>
            <span class="bl-val">\${fmt(curInput)}</span>
            <span class="bl-pct">\${wi}%</span>
          </div>
          <div class="bl-row">
            <div class="bl-dot" style="background:\${C.cread}"></div>
            <span class="bl-label">Cache read</span>
            <span class="bl-val">\${fmt(curCRead)}</span>
            <span class="bl-pct">\${wr}%</span>
          </div>
          <div class="bl-row">
            <div class="bl-dot" style="background:\${C.cwrite}"></div>
            <span class="bl-label">Cache written</span>
            <span class="bl-val">\${fmt(curCWrite)}</span>
            <span class="bl-pct">\${ww}%</span>
          </div>
        </div>
      </div>
    </div>

    <div>
      <div class="panel-label">Session Totals</div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-l">Total Input</div>
          <div class="stat-v c-input">\${fmt(totalCtx)}</div>
          <div class="stat-s">tokens sent</div>
        </div>
        <div class="stat-box">
          <div class="stat-l">Total Output</div>
          <div class="stat-v c-out">\${fmt(t.output)}</div>
          <div class="stat-s">tokens generated</div>
        </div>
        <div class="stat-box">
          <div class="stat-l">Cache Hit Rate</div>
          <div class="stat-v c-cread">\${cacheHit}%</div>
          <div class="stat-s">read vs written</div>
        </div>
        <div class="stat-box">
          <div class="stat-l">Avg Output</div>
          <div class="stat-v c-cwrite">\${fmt(avgOut)}</div>
          <div class="stat-s">per exchange</div>
        </div>
      </div>
    </div>
  \`;
}

/* ─── group raw exchanges into user turns ─── */
function groupTurns(exchanges) {
  const turns = [];
  let cur = null;
  for (const ex of exchanges) {
    if (ex.userMessage !== null) {
      cur = { user: ex.userMessage, exs: [ex] };
      turns.push(cur);
    } else if (cur) {
      cur.exs.push(ex);
    } else {
      cur = { user: null, exs: [ex] };
      turns.push(cur);
    }
  }
  return turns;
}

function renderRight(d) {
  if (!d || !d.exchanges.length) {
    const msg = d && d.readError
      ? '<h2>Cannot read file</h2><p>The JSONL file may be locked by Claude Code. Check the dashboard server console for details, then refresh this page.</p>'
      : '<h2>No exchanges yet</h2><p>Start chatting in Claude Code to see token data here.</p>';
    $('right').innerHTML = \`<div class="empty">\${msg}</div>\`;
    return;
  }

  const turns    = groupTurns(d.exchanges);
  const reversed = [...turns].reverse();
  const total    = turns.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (currentPage >= totalPages) currentPage = totalPages - 1;
  const pageStart = currentPage * PAGE_SIZE;
  const pageEnd   = Math.min(pageStart + PAGE_SIZE, total);
  const pageTurns = reversed.slice(pageStart, pageEnd);
  const PROMPT_LIMIT = 500;
  const OUTPUT_LIMIT = 700;

  let html = \`
    <div class="turns-wrap">
      <div class="col-heads">
        <div class="col-head">User Prompt</div>
        <div class="col-head">Tokens Consumed</div>
        <div class="col-head">Final LLM Output</div>
      </div>
      <div class="pager">
        <span class="pager-info">
          Showing <strong>\${pageStart + 1}–\${pageEnd}</strong> of <strong>\${total}</strong> turns
          &nbsp;·&nbsp; Page <strong>\${currentPage + 1}</strong> of <strong>\${totalPages}</strong>
        </span>
        <div class="pager-btns">
          <button class="pager-btn" onclick="prevPage()" \${currentPage === 0 ? 'disabled' : ''}>← Prev</button>
          <button class="pager-btn" onclick="nextPage()" \${currentPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      </div>
  \`;

  pageTurns.forEach((turn, ri) => {
    const num  = total - (pageStart + ri);
    const uc   = turn.user?.content || '';
    const isC  = turn.user?.isCompactSummary;
    const ts   = turn.user?.timestamp || turn.exs[0]?.timestamp;
    const time = ts ? new Date(ts).toLocaleTimeString() : '';

    // Aggregate tokens across all API calls in this turn
    const tok = turn.exs.reduce((acc, ex) => ({
      input:       acc.input       + ex.input,
      cacheRead:   acc.cacheRead   + ex.cacheRead,
      cacheCreated:acc.cacheCreated+ ex.cacheCreated,
      output:      acc.output      + ex.output,
    }), { input:0, cacheRead:0, cacheCreated:0, output:0 });

    const turnTotal = tok.input + tok.cacheRead + tok.cacheCreated + tok.output || 1;
    const wi = (tok.input        / turnTotal * 100).toFixed(1);
    const wr = (tok.cacheRead    / turnTotal * 100).toFixed(1);
    const ww = (tok.cacheCreated / turnTotal * 100).toFixed(1);
    const wo = (tok.output       / turnTotal * 100).toFixed(1);

    // Final response = last exchange in the turn
    const rc = turn.exs[turn.exs.length - 1].response || '';

    html += \`
      <div class="turn-row">

        <div class="tc tc-prompt">
          <div class="turn-meta">
            <span class="turn-num">#\${num}</span>
            <span class="turn-time">\${time}</span>
            \${isC ? '<span class="badge-compact">compact</span>' : ''}
          </div>
          \${uc
            ? \`<div class="prompt-text">\${esc(uc.slice(0, PROMPT_LIMIT))}</div>
               \${uc.length > PROMPT_LIMIT ? \`<div class="text-trunc">… \${(uc.length - PROMPT_LIMIT).toLocaleString()} more chars</div>\` : ''}\`
            : '<div class="no-content">No user message</div>'
          }
        </div>

        <div class="tc tc-tokens">
          <div class="tok-total">\${fmt(turnTotal)}</div>
          <div class="tok-unit">tokens total</div>
          <div class="tok-rows">
            <div class="tok-row">
              <span class="tok-k">Input</span>
              <span class="tok-v" style="color:\${C.input}">\${fmt(tok.input)}</span>
            </div>
            \${tok.cacheRead ? \`<div class="tok-row">
              <span class="tok-k">Cache read</span>
              <span class="tok-v" style="color:\${C.cread}">\${fmt(tok.cacheRead)}</span>
            </div>\` : ''}
            \${tok.cacheCreated ? \`<div class="tok-row">
              <span class="tok-k">Cache written</span>
              <span class="tok-v" style="color:\${C.cwrite}">\${fmt(tok.cacheCreated)}</span>
            </div>\` : ''}
            <div class="tok-row">
              <span class="tok-k">Output</span>
              <span class="tok-v" style="color:\${C.output}">\${fmt(tok.output)}</span>
            </div>
          </div>
          <div class="mini-bar">
            <div class="mini-seg" style="width:\${wi}%;background:\${C.input}"></div>
            <div class="mini-seg" style="width:\${wr}%;background:\${C.cread}"></div>
            <div class="mini-seg" style="width:\${ww}%;background:\${C.cwrite}"></div>
            <div class="mini-seg" style="width:\${wo}%;background:\${C.output}"></div>
          </div>
          \${turn.exs.length > 1 ? \`<div class="api-count">\${turn.exs.length} API calls in this turn</div>\` : ''}
        </div>

        <div class="tc tc-output">
          \${rc
            ? \`<div class="output-text">\${esc(rc.slice(0, OUTPUT_LIMIT))}</div>
               \${rc.length > OUTPUT_LIMIT ? \`<div class="text-trunc">… \${(rc.length - OUTPUT_LIMIT).toLocaleString()} more chars</div>\` : ''}\`
            : '<div class="no-content">No response</div>'
          }
        </div>

      </div>
    \`;
  });

  html += '</div>';
  $('right').innerHTML = html;
}
</script>
</body></html>`;

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── GET /events  (SSE) ────────────────────────────────────────────────────
  if (pathname === '/events') {
    const sessionPath = parsed.query.path || FORCED || null;

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Send session list immediately
    const sessions = discoverSessions();
    sendSSE(res, { type: 'sessions', sessions });

    // Send parsed data for requested session
    if (sessionPath) {
      const data = parseJSONL(sessionPath) || {
        sessionId: null, slug: null, model: null, version: null,
        exchanges: [], totals: { input: 0, cacheRead: 0, cacheCreated: 0, output: 0 },
        compactCount: 0, readError: true,
      };
      sendSSE(res, { type: 'init', data });
      addClient(sessionPath, res);
    }

    // Keep-alive ping
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
    }, 20000);

    req.on('close', () => {
      clearInterval(ping);
      if (sessionPath) removeClient(sessionPath, res);
    });
    return;
  }

  // ── GET /api/sessions  (JSON, optional) ───────────────────────────────────
  if (pathname === '/api/sessions') {
    const sessions = discoverSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // ── GET /  (dashboard HTML) ────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  Claude Code Token Dashboard');
  console.log(line);
  console.log(`  URL  : http://localhost:${PORT}`);
  console.log(`  Watch: ${CLAUDE_PROJECTS_DIR}`);
  if (FORCED) console.log(`  File : ${FORCED}`);
  console.log(`${line}\n`);
  console.log('  Open the URL in your browser. The dashboard will');
  console.log('  auto-select the most recent session and update live.');
  console.log(`\n${line}\n`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Try: node server.js --port 4001\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down…');
  for (const w of watchers.values()) w.close();
  server.close(() => process.exit(0));
});
