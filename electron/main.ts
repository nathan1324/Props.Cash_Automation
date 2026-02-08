import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { ProcessManager } from './processManager';
import { Scheduler } from './scheduler';
import { DbQuery } from './dbQuery';

const PROJECT_ROOT = app.isPackaged
  ? path.resolve(process.resourcesPath, '..')
  : path.resolve(__dirname, '..', '..');

// Load .env from project root so DATABASE_URL is available
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const STORAGE_STATE_PATH = path.join(PROJECT_ROOT, 'automation', 'storageState.json');

let mainWindow: BrowserWindow | null = null;
const processManager = new ProcessManager(PROJECT_ROOT);
const scheduler = new Scheduler(PROJECT_ROOT);
const dbQuery = new DbQuery();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 750,
    minWidth: 700,
    minHeight: 550,
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(
    path.resolve(PROJECT_ROOT, 'electron', 'renderer', 'index.html')
  );

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

function getAuthStatus(): 'missing' | 'valid' | 'expired' {
  if (!fs.existsSync(STORAGE_STATE_PATH)) return 'missing';
  try {
    const stat = fs.statSync(STORAGE_STATE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return 'expired';
    return 'valid';
  } catch {
    return 'missing';
  }
}

function getLastRun(): Record<string, unknown> | null {
  const logDir = path.join(PROJECT_ROOT, 'logs');
  if (!fs.existsSync(logDir)) return null;
  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('run_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(logDir, files[0]), 'utf-8'));
  } catch {
    return null;
  }
}

function getLastScrape(): Record<string, unknown> | null {
  const logDir = path.join(PROJECT_ROOT, 'logs');
  if (!fs.existsSync(logDir)) return null;
  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('scrape_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(logDir, files[0]), 'utf-8'));
  } catch {
    return null;
  }
}

// ── IPC Handlers ────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle('get-status', async () => {
    const scheduleInfo = await scheduler.getScheduleInfo();
    return {
      authStatus: getAuthStatus(),
      lastRun: getLastRun(),
      lastScrape: getLastScrape(),
      isRunning: processManager.isRunning(),
      runningType: processManager.getRunningType(),
      schedule: scheduleInfo,
    };
  });

  ipcMain.handle('init-auth', async () => {
    if (processManager.isRunning()) {
      return { success: false, error: 'A process is already running' };
    }
    processManager.spawn('init-auth', ['automation/authInit.ts'], (line) => {
      mainWindow?.webContents.send('console-output', line);
    });
    return { success: true };
  });

  ipcMain.handle('run-automation', async () => {
    if (processManager.isRunning()) {
      return { success: false, error: 'A process is already running' };
    }
    processManager.spawn(
      'run',
      ['automation/runner.ts', '--headless=false'],
      (line) => {
        mainWindow?.webContents.send('console-output', line);
      }
    );
    return { success: true };
  });

  ipcMain.handle('run-scrape', async () => {
    if (processManager.isRunning()) {
      return { success: false, error: 'A process is already running' };
    }
    processManager.spawn(
      'scrape',
      ['automation/scrapeCli.ts', '--headless=false'],
      (line) => {
        mainWindow?.webContents.send('console-output', line);
      }
    );
    return { success: true };
  });

  ipcMain.handle('schedule-enable', async (_e, time: string) => {
    return scheduler.enable(time);
  });

  ipcMain.handle('schedule-disable', async () => {
    return scheduler.disable();
  });

  ipcMain.handle('schedule-update-time', async (_e, time: string) => {
    return scheduler.updateTime(time);
  });

  ipcMain.handle('get-schedule', async () => {
    return scheduler.getScheduleInfo();
  });

  // ── Data Browser handlers ──────────────────────────────────────────

  ipcMain.handle('db-status', async () => {
    if (!dbQuery.isConfigured()) {
      return { configured: false, connected: false };
    }
    const connected = await dbQuery.testConnection();
    return { configured: true, connected };
  });

  ipcMain.handle('query-dates', async () => {
    try {
      return { success: true, dates: await dbQuery.getAvailableDates() };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), dates: [] };
    }
  });

  ipcMain.handle('query-props-for-date', async (_e, dateIso: string) => {
    try {
      return { success: true, props: await dbQuery.getPropsForDate(dateIso) };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), props: [] };
    }
  });

  ipcMain.handle('query-prop-rows', async (_e, opts: {
    dateIso: string;
    propKey?: string;
    playerSearch?: string;
    orderBy?: string;
    limit?: number;
  }) => {
    try {
      const rows = await dbQuery.queryPropRows(opts);
      return { success: true, rows, count: rows.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), rows: [], count: 0 };
    }
  });
}

// ── Process completion → notify renderer ────────────────────────────

processManager.onDone((type, code) => {
  mainWindow?.webContents.send('process-done', type, code);
});

// ── App Lifecycle ───────────────────────────────────────────────────

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  processManager.killActive();
  dbQuery.close().catch(() => {});
  app.quit();
});
