/**
 * PHASE 1 — Init Auth (Manual, Headed)
 *
 * Launches the user's REAL Chrome (not Playwright's bundled Chromium) with a
 * persistent profile so Google does not flag the browser as automated.
 *
 * Once the user completes Google login manually, the script detects success
 * and saves the browser state to storageState.json.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import {
  SELECTORS,
  AUTH_DETECT_TIMEOUT,
  DEFAULT_BASE_URL,
  STORAGE_STATE_PATH,
} from './selectors';

/** Persistent profile directory so Chrome looks like a real user session */
const USER_DATA_DIR = path.resolve('./automation/.chrome-profile');

export async function initAuth(): Promise<void> {
  const baseUrl = process.env.BASE_URL || DEFAULT_BASE_URL;
  const storagePath = path.resolve(STORAGE_STATE_PATH);

  // Ensure output directories exist
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('=== Props.cash Auth Init ===');
  console.log(`Target:  ${baseUrl}`);
  console.log(`Output:  ${storagePath}`);
  console.log('');

  // Use launchPersistentContext with the system Chrome.
  // This avoids Google's automation detection by:
  //   1. Using the real Chrome binary (channel: 'chrome')
  //   2. Using a persistent user-data-dir (not a temp profile)
  //   3. Disabling the "controlled by automation" infobar
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    console.log('Browser is open.  Please complete the following steps:');
    console.log('  1. Click "Continue with Google"');
    console.log('  2. Sign in with your Google account');
    console.log('  3. Complete any 2FA prompts');
    console.log('');
    console.log('Waiting for login (up to 5 minutes)...');

    // Wait for EITHER login indicator to appear
    await Promise.race([
      SELECTORS.loginIndicators.nbaLink(page).waitFor({
        state: 'visible',
        timeout: AUTH_DETECT_TIMEOUT,
      }),
      SELECTORS.loginIndicators.searchInput(page).waitFor({
        state: 'visible',
        timeout: AUTH_DETECT_TIMEOUT,
      }),
    ]);

    // Small extra wait so all cookies / tokens finish writing
    await page.waitForTimeout(2000);

    // Persist the full browser state
    await context.storageState({ path: storagePath });

    console.log('');
    console.log('Auth initialized successfully');
    console.log(`Session saved to ${storagePath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('');
    console.error(`Auth init failed: ${message}`);
    console.error('Make sure you complete the Google login within 5 minutes.');
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

// Direct CLI execution
initAuth();
