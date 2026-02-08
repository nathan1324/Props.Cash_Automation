/**
 * CLI entry point for the NBA Props Scraper.
 *
 * Usage:
 *   npx tsx automation/scrapeCli.ts
 *   npx tsx automation/scrapeCli.ts --headless=false --debug=true
 *   npx tsx automation/scrapeCli.ts --date=2026-02-07
 *   npx tsx automation/scrapeCli.ts --discover
 *   npx tsx automation/scrapeCli.ts --limitProps=1
 *   npx tsx automation/scrapeCli.ts --prop="Ast"
 *   npx tsx automation/scrapeCli.ts --no-db
 *
 * Follows the same patterns as automation/runner.ts (lock file, arg parsing,
 * storage state, browser lifecycle).
 */

import dotenv from 'dotenv';
dotenv.config();

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import {
  SELECTORS,
  SESSION_VERIFY_TIMEOUT,
  DEFAULT_BASE_URL,
  STORAGE_STATE_PATH,
} from './selectors';
import { scrapeNbaPropsForDate } from './scrape/nbaPropsScraper';
import { ScrapeOptions, ScrapeSession } from './scrape/helpers';
import { isDbConfigured, closePool } from './db/client';
import { persistScrapeSession, PersistResult } from './db/persistScrape';

// ---------------------------------------------------------------------------
// Lock file — prevent concurrent runs
// ---------------------------------------------------------------------------

const LOCK_PATH = path.resolve('./automation/.scraper.lock');

function acquireLock(): boolean {
  try {
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
    // already gone
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  headless: boolean;
  debug: boolean;
  date: string;
  discover: boolean;
  noDb: boolean;
  limitProps?: number;
  prop?: string;
  baseUrl: string;
}

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    headless: true,
    debug: process.env.DEBUG === 'true',
    date: todayISO(),
    discover: false,
    noDb: false,
    baseUrl: process.env.BASE_URL || DEFAULT_BASE_URL,
  };

  for (const arg of args) {
    if (arg === '--discover') {
      opts.discover = true;
      continue;
    }
    if (arg === '--no-db') {
      opts.noDb = true;
      continue;
    }
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) continue;
    const key = arg.slice(0, eqIdx);
    const val = arg.slice(eqIdx + 1);

    switch (key) {
      case '--headless':
        opts.headless = val !== 'false';
        break;
      case '--debug':
        opts.debug = val === 'true';
        break;
      case '--date':
        opts.date = val;
        break;
      case '--limitProps':
        opts.limitProps = parseInt(val, 10) || undefined;
        break;
      case '--prop':
        opts.prop = val;
        break;
      case '--url':
        opts.baseUrl = val || opts.baseUrl;
        break;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Session verification (same as runner.ts)
// ---------------------------------------------------------------------------

async function verifySession(page: import('playwright').Page): Promise<boolean> {
  // Try multiple indicators — NBA may not be a role="link" on all versions
  try {
    await SELECTORS.loginIndicators.searchInput(page).waitFor({
      state: 'visible',
      timeout: SESSION_VERIFY_TIMEOUT,
    });
    return true;
  } catch {
    // fallback: try the NBA link
    try {
      await SELECTORS.loginIndicators.nbaLink(page).waitFor({
        state: 'visible',
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface ScrapeRunResult {
  success: boolean;
  timestamp: string;
  session?: ScrapeSession;
  error?: string;
  durationMs: number;
  db?: {
    status: 'success' | 'skipped' | 'error';
    runId?: string;
    rowsPersisted?: number;
    rowsInserted?: number;
    rowsUpdated?: number;
    error?: string;
  };
}

async function main(): Promise<ScrapeRunResult> {
  const opts = parseArgs();
  const storagePath = path.resolve(STORAGE_STATE_PATH);
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  console.log('=== Props.cash Scraper CLI ===');
  console.log(`Date:     ${opts.date}`);
  console.log(`Headless: ${opts.headless}`);
  console.log(`Debug:    ${opts.debug}`);
  if (opts.discover) console.log(`Mode:     DISCOVER ONLY`);
  if (opts.limitProps) console.log(`Limit:    ${opts.limitProps} props`);
  if (opts.prop) console.log(`Prop:     ${opts.prop}`);
  console.log('');

  // Pre-flight: storageState
  if (!fs.existsSync(storagePath)) {
    const msg = 'No storageState.json found — run init:auth first';
    console.error(msg);
    return { success: false, timestamp, error: msg, durationMs: Date.now() - startTime };
  }

  // Lock
  if (!acquireLock()) {
    const msg = 'Another scraper is already running (lock file exists)';
    console.error(msg);
    return { success: false, timestamp, error: msg, durationMs: Date.now() - startTime };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: opts.headless });
    const context = await browser.newContext({
      storageState: storagePath,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // Navigate to base URL
    console.log(`Navigating to ${opts.baseUrl}...`);
    await page.goto(opts.baseUrl, { waitUntil: 'domcontentloaded' });

    // Verify session
    console.log('Verifying session...');
    const valid = await verifySession(page);
    if (!valid) {
      const msg = 'Auth expired — run init:auth again';
      console.error(msg);
      return { success: false, timestamp, error: msg, durationMs: Date.now() - startTime };
    }
    console.log('Session valid.');

    // Navigate to NBA props page
    console.log('Navigating to NBA props...');
    const currentUrl = page.url();

    if (currentUrl.includes('/nba')) {
      console.log('Already on NBA page.');
    } else {
      // Try clicking the NBA nav element (may be div, link, or option in select)
      let navigated = false;

      // Strategy 1: NBA link (role="link")
      const nbaLink = SELECTORS.loginIndicators.nbaLink(page);
      if (await nbaLink.count() > 0) {
        await nbaLink.click();
        navigated = true;
      }

      // Strategy 2: NBA as a clickable div/button in the nav bar
      if (!navigated) {
        const nbaDiv = page.locator('div').filter({ hasText: /^NBA$/ }).first();
        if (await nbaDiv.count() > 0) {
          await nbaDiv.click();
          navigated = true;
        }
      }

      // Strategy 3: Select NBA from the sport selector dropdown
      if (!navigated) {
        const sportSelect = page.locator('select#inbox-select');
        if (await sportSelect.count() > 0) {
          await sportSelect.selectOption('NBA');
          navigated = true;
        }
      }

      // Strategy 4: Navigate directly via URL
      if (!navigated) {
        console.log('Fallback: navigating directly via URL');
        await page.goto(`${opts.baseUrl}/nba`, { waitUntil: 'domcontentloaded' });
      }

      await page.waitForLoadState('domcontentloaded');
    }

    // Wait for content to settle
    try {
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 10_000 });
    } catch {
      console.log('[info] Network idle timeout — proceeding anyway');
    }

    // Build scrape options
    const scrapeOpts: ScrapeOptions = {
      headless: opts.headless,
      debug: opts.debug,
      discover: opts.discover,
      limitProps: opts.limitProps,
      onlyPropLabel: opts.prop,
    };

    // Run scraper
    const session = await scrapeNbaPropsForDate(page, opts.date, scrapeOpts);

    // ── Persist to database ──────────────────────────────────────────
    let dbResult: ScrapeRunResult['db'];

    if (opts.noDb || opts.discover) {
      dbResult = { status: 'skipped' };
      if (!opts.discover) console.log('[db] Skipped (--no-db flag)');
    } else if (!isDbConfigured()) {
      dbResult = { status: 'skipped' };
      console.log('[db] Skipped (DATABASE_URL not set)');
    } else {
      try {
        console.log('\nPersisting to database...');
        const persist = await persistScrapeSession(session);
        dbResult = {
          status: 'success',
          runId: persist.runId,
          rowsPersisted: persist.rowsPersisted,
          rowsInserted: persist.rowsInserted,
          rowsUpdated: persist.rowsUpdated,
        };
      } catch (dbErr: unknown) {
        const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        console.error(`[db] Persistence failed: ${dbMsg}`);
        dbResult = { status: 'error', error: dbMsg };
      }
    }

    const durationMs = Date.now() - startTime;

    const result: ScrapeRunResult = {
      success: session.errors.length === 0,
      timestamp,
      session,
      durationMs,
      db: dbResult,
    };

    // Write run log
    const logDir = path.resolve('./logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `scrape_${timestamp}.json`);
    fs.writeFileSync(logPath, JSON.stringify(result, null, 2));
    console.log(`Run log: ${logPath}`);

    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Scraper failed: ${message}`);
    return {
      success: false,
      timestamp,
      error: message,
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (browser) await browser.close();
    await closePool().catch(() => {});
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Direct CLI execution
// ---------------------------------------------------------------------------

if (require.main === module || process.argv[1]?.includes('scrapeCli')) {
  main().then((result) => {
    if (!result.success) process.exitCode = 1;
  });
}
