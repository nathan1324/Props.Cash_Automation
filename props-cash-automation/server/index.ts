/**
 * Local Express server — minimal UI + API for controlling the automation.
 *
 * Endpoints:
 *   GET  /            — HTML dashboard
 *   GET  /api/status  — auth status, last run info
 *   POST /api/init-auth — launch headed auth flow
 *   POST /api/run     — trigger automation run
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { STORAGE_STATE_PATH } from '../automation/selectors';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Determine auth status by inspecting storageState.json */
function getAuthStatus(): 'missing' | 'valid' | 'expired' {
  const p = path.resolve(STORAGE_STATE_PATH);
  if (!fs.existsSync(p)) return 'missing';

  try {
    const stat = fs.statSync(p);
    // If older than 7 days, treat as likely expired
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return 'expired';
    return 'valid';
  } catch {
    return 'missing';
  }
}

/** Find the most recent run log */
function getLastRun(): Record<string, unknown> | null {
  const logDir = path.resolve('./logs');
  if (!fs.existsSync(logDir)) return null;

  const files = fs.readdirSync(logDir)
    .filter((f) => f.startsWith('run_') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  try {
    return JSON.parse(fs.readFileSync(path.join(logDir, files[0]), 'utf-8'));
  } catch {
    return null;
  }
}

// Track running processes so we can stream output and prevent concurrency
let activeProcess: { type: string; logs: string[] } | null = null;

function spawnScript(
  scriptArgs: string[],
  type: string,
  onExit: (code: number | null) => void
) {
  const logs: string[] = [];
  activeProcess = { type, logs };

  // Use tsx to run TypeScript directly
  const child = spawn('npx', ['tsx', ...scriptArgs], {
    cwd: path.resolve('.'),
    shell: true,
    env: { ...process.env },
  });

  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString();
    logs.push(line);
    process.stdout.write(`[${type}] ${line}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    logs.push(line);
    process.stderr.write(`[${type}] ${line}`);
  });

  child.on('close', (code) => {
    activeProcess = null;
    onExit(code);
  });
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.use(express.json());

app.get('/api/status', (_req, res) => {
  res.json({
    authStatus: getAuthStatus(),
    lastRun: getLastRun(),
    isRunning: activeProcess !== null,
    runningType: activeProcess?.type ?? null,
  });
});

app.post('/api/init-auth', (_req, res) => {
  if (activeProcess) {
    return res.status(409).json({ error: 'A process is already running' });
  }

  res.json({ message: 'Auth init launched — complete login in the browser window' });

  spawnScript(['automation/authInit.ts'], 'init-auth', (code) => {
    console.log(`Auth init exited with code ${code}`);
  });
});

app.post('/api/run', (_req, res) => {
  if (activeProcess) {
    return res.status(409).json({ error: 'A process is already running' });
  }

  res.json({ message: 'Automation run started' });

  spawnScript(
    ['automation/runner.ts', '--headless=false'],
    'run',
    (code) => {
      console.log(`Runner exited with code ${code}`);
    }
  );
});

app.get('/api/logs', (_req, res) => {
  res.json({
    isRunning: activeProcess !== null,
    type: activeProcess?.type ?? null,
    logs: activeProcess?.logs ?? [],
  });
});

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Props.cash Automation</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 { margin-bottom: 1.5rem; color: #58a6ff; }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .card h2 { font-size: 1rem; color: #8b949e; margin-bottom: 0.75rem; }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 12px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .status-missing   { background: #da3633; color: #fff; }
    .status-valid     { background: #238636; color: #fff; }
    .status-expired   { background: #d29922; color: #fff; }
    .btn {
      display: inline-block;
      padding: 0.6rem 1.2rem;
      border: none;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      margin-right: 0.5rem;
      margin-top: 0.5rem;
      transition: opacity 0.15s;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-blue   { background: #1f6feb; color: #fff; }
    .btn-green  { background: #238636; color: #fff; }
    .btn:hover:not(:disabled) { opacity: 0.85; }
    #log-output {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 1rem;
      font-family: "Cascadia Code", "Fira Code", monospace;
      font-size: 0.8rem;
      white-space: pre-wrap;
      max-height: 350px;
      overflow-y: auto;
      line-height: 1.5;
      color: #c9d1d9;
    }
    .meta { color: #8b949e; font-size: 0.85rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Props.cash Automation</h1>

  <div class="card">
    <h2>Auth Status</h2>
    <span id="auth-badge" class="status-badge status-missing">checking...</span>
  </div>

  <div class="card">
    <h2>Actions</h2>
    <button class="btn btn-blue" id="btn-init" onclick="initAuth()">Init Auth (Google Login)</button>
    <button class="btn btn-green" id="btn-run" onclick="runAutomation()">Run Automation</button>
  </div>

  <div class="card">
    <h2>Last Run</h2>
    <div id="last-run" class="meta">Loading...</div>
  </div>

  <div class="card">
    <h2>Live Output</h2>
    <div id="log-output">Waiting for activity...</div>
  </div>

  <script>
    let polling = null;

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const badge = document.getElementById('auth-badge');
        badge.textContent = data.authStatus;
        badge.className = 'status-badge status-' + data.authStatus;

        const btns = data.isRunning;
        document.getElementById('btn-init').disabled = btns;
        document.getElementById('btn-run').disabled = btns;

        const lr = data.lastRun;
        document.getElementById('last-run').innerHTML = lr
          ? '<strong>' + (lr.success ? 'SUCCESS' : 'FAILED') + '</strong>'
            + ' &mdash; ' + lr.timestamp
            + (lr.pageTitle ? '<br>Title: ' + lr.pageTitle : '')
            + (lr.currentUrl ? '<br>URL: ' + lr.currentUrl : '')
            + (lr.screenshotPath ? '<br>Screenshot: ' + lr.screenshotPath : '')
            + (lr.error ? '<br>Error: ' + lr.error : '')
          : 'No runs yet';

        if (btns && !polling) startPollingLogs();
        if (!btns && polling) stopPollingLogs();
      } catch { /* ignore */ }
    }

    async function initAuth() {
      await fetch('/api/init-auth', { method: 'POST' });
      document.getElementById('log-output').textContent = 'Auth init launched — complete login in the browser window...';
      startPollingLogs();
    }

    async function runAutomation() {
      await fetch('/api/run', { method: 'POST' });
      document.getElementById('log-output').textContent = 'Automation run started...';
      startPollingLogs();
    }

    function startPollingLogs() {
      if (polling) return;
      polling = setInterval(async () => {
        try {
          const res = await fetch('/api/logs');
          const data = await res.json();
          const el = document.getElementById('log-output');
          if (data.logs.length > 0) {
            el.textContent = data.logs.join('');
            el.scrollTop = el.scrollHeight;
          }
          if (!data.isRunning) {
            stopPollingLogs();
            fetchStatus();
          }
        } catch { /* ignore */ }
      }, 1000);
    }

    function stopPollingLogs() {
      if (polling) { clearInterval(polling); polling = null; }
    }

    // Poll status every 5s
    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log('');
  console.log('=== Props.cash Automation Server ===');
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log('');
  console.log('API:');
  console.log(`  GET  http://localhost:${PORT}/api/status`);
  console.log(`  POST http://localhost:${PORT}/api/init-auth`);
  console.log(`  POST http://localhost:${PORT}/api/run`);
  console.log('');
});
