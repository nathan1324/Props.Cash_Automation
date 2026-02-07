/**
 * PHASE 2 — Automation Runner
 *
 * Loads the saved browser state, verifies the session is still valid, then
 * executes the automation task (navigate to NBA props, screenshot, report).
 *
 * CLI flags:
 *   --headless=true|false   (default: true)
 *   --url=<base-url>        (default: https://props.cash)
 *   --debug=true|false      (default: false)
 */

import { chromium, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import {
  SELECTORS,
  SESSION_VERIFY_TIMEOUT,
  CONTENT_LOAD_TIMEOUT,
  DEFAULT_BASE_URL,
  STORAGE_STATE_PATH,
} from './selectors';

// ---------------------------------------------------------------------------
// Lock file — prevent concurrent runs
// ---------------------------------------------------------------------------

const LOCK_PATH = path.resolve('./automation/.runner.lock');

function acquireLock(): boolean {
  try {
    // wx = write-exclusive — fails if the file already exists
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // already gone — fine
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface RunOptions {
  headless: boolean;
  baseUrl: string;
  debug: boolean;
}

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  const opts: RunOptions = {
    headless: true,
    baseUrl: process.env.BASE_URL || DEFAULT_BASE_URL,
    debug: process.env.DEBUG === 'true',
  };

  for (const arg of args) {
    const [key, val] = arg.split('=');
    switch (key) {
      case '--headless':
        opts.headless = val !== 'false';
        break;
      case '--url':
        opts.baseUrl = val || opts.baseUrl;
        break;
      case '--debug':
        opts.debug = val === 'true';
        break;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Session verification
// ---------------------------------------------------------------------------

async function verifySession(page: Page): Promise<boolean> {
  try {
    await SELECTORS.loginIndicators.nbaLink(page).waitFor({
      state: 'visible',
      timeout: SESSION_VERIFY_TIMEOUT,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Automation task
// ---------------------------------------------------------------------------

export interface RunResult {
  success: boolean;
  timestamp: string;
  pageTitle?: string;
  currentUrl?: string;
  screenshotPath?: string;
  error?: string;
  durationMs?: number;
}

export async function runAutomation(
  overrides: Partial<RunOptions> = {}
): Promise<RunResult> {
  const opts = { ...parseArgs(), ...overrides };
  const storagePath = path.resolve(STORAGE_STATE_PATH);
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Pre-flight: does storageState.json exist?
  if (!fs.existsSync(storagePath)) {
    const msg = 'No storageState.json found — run init:auth first';
    console.error(msg);
    return { success: false, timestamp, error: msg };
  }

  if (!acquireLock()) {
    const msg = 'Another run is already in progress (lock file exists)';
    console.error(msg);
    return { success: false, timestamp, error: msg };
  }

  let browser;
  try {
    if (opts.debug) console.log('[debug] Options:', opts);

    browser = await chromium.launch({ headless: opts.headless });
    const context = await browser.newContext({
      storageState: storagePath,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // Navigate and verify session
    console.log(`Navigating to ${opts.baseUrl}...`);
    await page.goto(opts.baseUrl, { waitUntil: 'domcontentloaded' });

    console.log('Verifying session...');
    const valid = await verifySession(page);
    if (!valid) {
      const msg = 'Auth expired — run init:auth again';
      console.error(msg);
      return { success: false, timestamp, error: msg };
    }
    console.log('Session valid.');

    // Navigate to NBA props
    console.log('Navigating to NBA props...');
    await SELECTORS.loginIndicators.nbaLink(page).click();
    await page.waitForLoadState('domcontentloaded');

    // Wait for props content to render (look for table-like content)
    try {
      await page.waitForTimeout(CONTENT_LOAD_TIMEOUT > 5000 ? 5000 : 3000);
      // Additional wait for dynamic content
      await page.waitForLoadState('networkidle');
    } catch {
      if (opts.debug) console.log('[debug] Network idle timeout — proceeding anyway');
    }

    // Take full-page screenshot
    const screenshotDir = path.resolve('./artifacts/screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `props_${timestamp}.png`);

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const pageTitle = await page.title();
    const currentUrl = page.url();
    const durationMs = Date.now() - startTime;

    console.log('');
    console.log('=== Run Complete ===');
    console.log(`Title:      ${pageTitle}`);
    console.log(`URL:        ${currentUrl}`);
    console.log(`Screenshot: ${screenshotPath}`);
    console.log(`Duration:   ${durationMs}ms`);

    const result: RunResult = {
      success: true,
      timestamp,
      pageTitle,
      currentUrl,
      screenshotPath,
      durationMs,
    };

    // Write run log
    const logDir = path.resolve('./logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `run_${timestamp}.json`);
    fs.writeFileSync(logPath, JSON.stringify(result, null, 2));
    console.log(`Log:        ${logPath}`);

    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Run failed: ${message}`);
    return { success: false, timestamp, error: message, durationMs: Date.now() - startTime };
  } finally {
    if (browser) await browser.close();
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Direct CLI execution
// ---------------------------------------------------------------------------

if (require.main === module || process.argv[1]?.includes('runner')) {
  runAutomation().then((result) => {
    if (!result.success) process.exitCode = 1;
  });
}
