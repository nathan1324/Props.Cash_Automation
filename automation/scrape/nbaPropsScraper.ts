/**
 * Core NBA Props Scraper
 *
 * Main export: scrapeNbaPropsForDate(page, dateISO, options?)
 *
 * Uses multi-strategy locators to discover the Props dropdown, iterate every
 * option, extract table data (handling virtualised/lazy tables), and write
 * structured JSON + CSV output.
 */

import { Locator, Page } from 'playwright';
import {
  PropRow,
  PropScrapeResult,
  ScrapeSession,
  ScrapeOptions,
  normalizePropKey,
  makeRowSignature,
  parseLine,
  parseOdds,
  parseNumber,
  ensureScrapeDir,
  writePropJson,
  writePropCsv,
  writeAllPropsJson,
  saveDebugArtifacts,
} from './helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TABLE_REFRESH_MS = 15_000;
const DEFAULT_NAVIGATION_MS = 30_000;
const SCROLL_INTERVAL_MS = 600;
const MAX_SCROLL_ATTEMPTS = 120;
const STABLE_SCROLL_THRESHOLD = 3; // consecutive no-new-row scrolls before we stop
const SCRAPE_RETRY_COUNT = 3;

// ---------------------------------------------------------------------------
// Types for internal use
// ---------------------------------------------------------------------------

export interface PropOption {
  label: string;
  key: string;
}

export interface DiscoverDiagnostics {
  strategy: string;
  optionCount: number;
  options: PropOption[];
  headers: string[];
  sampleRows: string[][];
}

// ---------------------------------------------------------------------------
// 1) Discover prop dropdown options
// ---------------------------------------------------------------------------

/**
 * Multi-strategy discovery of the "Props" dropdown and its options.
 *
 * Returns the list of selectable prop types (e.g. Pts, Ast, Reb …).
 */
export async function discoverPropOptions(
  page: Page,
  opts?: { debug?: boolean; dateISO?: string }
): Promise<{ options: PropOption[]; diagnostics: DiscoverDiagnostics }> {
  let strategy = 'none';
  let options: PropOption[] = [];
  let dropdownTrigger: Locator | null = null;

  // ── Strategy A: <select> element ──────────────────────────────────
  const selectEl = page.locator('select').filter({ has: page.locator('option') });
  const selectCount = await selectEl.count();
  if (selectCount > 0) {
    for (let i = 0; i < selectCount; i++) {
      const sel = selectEl.nth(i);
      const optEls = sel.locator('option');
      const optCount = await optEls.count();
      if (optCount >= 3) {
        // Likely the props dropdown
        const optTexts: string[] = [];
        for (let j = 0; j < optCount; j++) {
          const t = (await optEls.nth(j).innerText()).trim();
          if (t) optTexts.push(t);
        }
        // Heuristic: contains some prop-like words
        const looksLikeProps = optTexts.some(
          t => /pts|ast|reb|stl|blk|3pm|points|assists|rebounds/i.test(t)
        );
        if (looksLikeProps) {
          strategy = 'native-select';
          options = optTexts
            .filter(t => !/^(select|choose|all|--)/i.test(t))
            .map(t => ({ label: t, key: normalizePropKey(t) }));
          break;
        }
      }
    }
  }

  // ── Strategy B: Role-based combobox ───────────────────────────────
  if (options.length === 0) {
    const combo = page.getByRole('combobox');
    const comboCount = await combo.count();
    for (let i = 0; i < comboCount && options.length === 0; i++) {
      const el = combo.nth(i);
      try {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(400);
        const listbox = page.getByRole('option');
        const lbCount = await listbox.count();
        if (lbCount >= 3) {
          const texts: string[] = [];
          for (let j = 0; j < lbCount; j++) {
            texts.push((await listbox.nth(j).innerText()).trim());
          }
          const looksLikeProps = texts.some(
            t => /pts|ast|reb|stl|blk|3pm|points|assists|rebounds/i.test(t)
          );
          if (looksLikeProps) {
            strategy = 'combobox-role';
            options = texts
              .filter(t => t && !/^(select|choose|all|--)/i.test(t))
              .map(t => ({ label: t, key: normalizePropKey(t) }));
          }
        }
        // Close by pressing Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      } catch {
        // move on
      }
    }
  }

  // ── Strategy C: Button with aria-haspopup ─────────────────────────
  if (options.length === 0) {
    const ariaButtons = page.locator(
      'button[aria-haspopup="listbox"], button[aria-haspopup="menu"], button[aria-haspopup="true"]'
    );
    const abCount = await ariaButtons.count();
    for (let i = 0; i < abCount && options.length === 0; i++) {
      const btn = ariaButtons.nth(i);
      try {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(500);

        // Try multiple selectors for the opened list
        for (const listSel of [
          '[role="option"]',
          '[role="menuitem"]',
          '[role="listbox"] > *',
          'ul[role="listbox"] li',
          'li',
        ]) {
          const items = page.locator(listSel);
          const itemCount = await items.count();
          if (itemCount >= 3) {
            const texts: string[] = [];
            for (let j = 0; j < itemCount; j++) {
              texts.push((await items.nth(j).innerText()).trim());
            }
            const looksLikeProps = texts.some(
              t => /pts|ast|reb|stl|blk|3pm|points|assists|rebounds/i.test(t)
            );
            if (looksLikeProps) {
              strategy = `aria-haspopup+${listSel}`;
              options = texts
                .filter(t => t && !/^(select|choose|all|--)/i.test(t))
                .map(t => ({ label: t, key: normalizePropKey(t) }));
              break;
            }
          }
        }

        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      } catch {
        // move on
      }
    }
  }

  // ── Strategy D: Scan for label "Props" and its adjacent interactive element
  if (options.length === 0) {
    try {
      // Look for visible text "Props" or "Prop" near an interactive element
      const propsLabel = page.locator(
        'text=/Props?/i'
      );
      const plCount = await propsLabel.count();

      for (let i = 0; i < plCount && options.length === 0; i++) {
        const label = propsLabel.nth(i);
        // Try clicking the label itself or its parent
        for (const target of [label, label.locator('..'), label.locator('.. >> button'), label.locator('.. >> [role="combobox"]')]) {
          try {
            const tCount = await target.count();
            if (tCount === 0) continue;
            await target.first().click({ timeout: 2000 });
            await page.waitForTimeout(500);

            // Check if a dropdown/popover appeared
            for (const listSel of ['[role="option"]', '[role="menuitem"]', 'li']) {
              const items = page.locator(listSel);
              const itemCount = await items.count();
              if (itemCount >= 3) {
                const texts: string[] = [];
                for (let j = 0; j < itemCount; j++) {
                  texts.push((await items.nth(j).innerText()).trim());
                }
                const looksLikeProps = texts.some(
                  t => /pts|ast|reb|stl|blk|3pm|points|assists|rebounds/i.test(t)
                );
                if (looksLikeProps) {
                  strategy = `props-label-scan+${listSel}`;
                  dropdownTrigger = target.first();
                  options = texts
                    .filter(t => t && !/^(select|choose|all|--)/i.test(t))
                    .map(t => ({ label: t, key: normalizePropKey(t) }));
                  break;
                }
              }
            }
            if (options.length > 0) break;
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
          } catch {
            // next target
          }
        }
      }
    } catch {
      // Strategy D failed
    }
  }

  // ── Strategy E: Broad scan — any dropdown-like container with prop-like text
  if (options.length === 0) {
    try {
      // Find all clickable elements whose text looks prop-like
      const candidates = page.locator('button, [role="combobox"], [role="button"], [tabindex="0"]');
      const candCount = await candidates.count();
      for (let i = 0; i < candCount && options.length === 0; i++) {
        const cand = candidates.nth(i);
        const candText = (await cand.innerText().catch(() => '')).trim();
        if (/pts|points|assists|rebounds/i.test(candText)) {
          await cand.click({ timeout: 2000 });
          await page.waitForTimeout(500);

          for (const listSel of ['[role="option"]', '[role="menuitem"]', 'li']) {
            const items = page.locator(listSel);
            const itemCount = await items.count();
            if (itemCount >= 3) {
              const texts: string[] = [];
              for (let j = 0; j < itemCount; j++) {
                texts.push((await items.nth(j).innerText()).trim());
              }
              if (
                texts.some(t => /pts|ast|reb|stl|blk|3pm/i.test(t))
              ) {
                strategy = `broad-scan+${listSel}`;
                dropdownTrigger = cand;
                options = texts
                  .filter(t => t && !/^(select|choose|all|--)/i.test(t))
                  .map(t => ({ label: t, key: normalizePropKey(t) }));
                break;
              }
            }
          }
          if (options.length === 0) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
          }
        }
      }
    } catch {
      // last resort failed
    }
  }

  // Close any open popover
  try {
    await page.keyboard.press('Escape');
  } catch {
    // ignore
  }

  // Deduplicate
  const seen = new Set<string>();
  options = options.filter(o => {
    if (seen.has(o.key)) return false;
    seen.add(o.key);
    return true;
  });

  // Gather diagnostics
  const headers = await readTableHeaders(page);
  const sampleRows = await readVisibleRowTexts(page, 3);

  if (opts?.debug && opts.dateISO) {
    await saveDebugArtifacts(opts.dateISO, 'discover', page, {
      screenshot: true,
      html: true,
      prefix: 'discover',
    });
  }

  const diagnostics: DiscoverDiagnostics = {
    strategy,
    optionCount: options.length,
    options,
    headers,
    sampleRows,
  };

  return { options, diagnostics };
}

// ---------------------------------------------------------------------------
// 2) Select a prop option
// ---------------------------------------------------------------------------

async function openDropdownAndSelect(page: Page, optionLabel: string): Promise<void> {
  // Strategy A: Native <select>
  const selectEls = page.locator('select');
  const selCount = await selectEls.count();
  for (let i = 0; i < selCount; i++) {
    const sel = selectEls.nth(i);
    const optEl = sel.locator('option', { hasText: optionLabel });
    if ((await optEl.count()) > 0) {
      await sel.selectOption({ label: optionLabel });
      return;
    }
  }

  // Strategy B: Click-based dropdown
  // Find any interactive element whose current text roughly matches a prop label
  // or that we previously used as a trigger
  const triggers = page.locator(
    'button[aria-haspopup], [role="combobox"], [role="button"][aria-haspopup]'
  );
  const trigCount = await triggers.count();

  for (let i = 0; i < trigCount; i++) {
    const trigger = triggers.nth(i);
    try {
      await trigger.click({ timeout: 3000 });
      await page.waitForTimeout(400);

      // Try to click the option
      const optionClicked = await clickOptionInList(page, optionLabel);
      if (optionClicked) return;

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } catch {
      continue;
    }
  }

  // Strategy C: Broad scan — any visible text that looks like a current prop label
  const allButtons = page.locator('button, [tabindex="0"], [role="button"]');
  const btnCount = await allButtons.count();
  for (let i = 0; i < btnCount; i++) {
    const btn = allButtons.nth(i);
    const txt = (await btn.innerText().catch(() => '')).trim();
    // If the button text contains a prop-like keyword, it might be the trigger
    if (/pts|ast|reb|stl|blk|3pm|points|assists|rebounds|steals|blocks|turnovers/i.test(txt)) {
      try {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(400);
        const optionClicked = await clickOptionInList(page, optionLabel);
        if (optionClicked) return;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      } catch {
        continue;
      }
    }
  }

  throw new Error(`Could not select prop option: "${optionLabel}"`);
}

/** Try to click the given option text in whatever list is currently visible. */
async function clickOptionInList(page: Page, label: string): Promise<boolean> {
  // Exact role-based match first
  const roleOption = page.getByRole('option', { name: label, exact: true });
  if ((await roleOption.count()) > 0) {
    await roleOption.first().click();
    return true;
  }

  // Looser role match
  const roleOptionLoose = page.getByRole('option', { name: label });
  if ((await roleOptionLoose.count()) > 0) {
    await roleOptionLoose.first().click();
    return true;
  }

  // menuitem
  const menuItem = page.getByRole('menuitem', { name: label });
  if ((await menuItem.count()) > 0) {
    await menuItem.first().click();
    return true;
  }

  // Generic text match in any visible list item
  for (const sel of ['[role="option"]', '[role="menuitem"]', 'li']) {
    const items = page.locator(sel);
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const txt = (await items.nth(i).innerText()).trim();
      if (txt === label || txt.includes(label)) {
        await items.nth(i).click();
        return true;
      }
    }
  }

  return false;
}

export async function selectPropOption(page: Page, option: PropOption): Promise<void> {
  console.log(`  Selecting prop: ${option.label}`);
  await openDropdownAndSelect(page, option.label);
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// 3) Wait for table refresh
// ---------------------------------------------------------------------------

export async function waitForTableRefresh(
  page: Page,
  previousSignature: string,
  timeoutMs: number = DEFAULT_TABLE_REFRESH_MS
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  // Check if URL prop= parameter changed (quick signal)
  const startUrl = page.url();

  // Tier 1: Wait for first row signature to change
  while (Date.now() < deadline) {
    const sig = await getFirstRowSignature(page);
    if (sig && sig !== previousSignature) return sig;

    // Tier 2: Check for loading indicators
    const loading = page.locator(
      '[class*="loading"], [class*="spinner"], [class*="skeleton"], [data-loading="true"]'
    );
    const loadingCount = await loading.count().catch(() => 0);
    if (loadingCount > 0) {
      // Wait for them to disappear
      try {
        await loading.first().waitFor({ state: 'hidden', timeout: Math.min(5000, deadline - Date.now()) });
      } catch {
        // timeout — continue
      }
      const newSig = await getFirstRowSignature(page);
      if (newSig && newSig !== previousSignature) return newSig;
    }

    await page.waitForTimeout(300);
  }

  // Tier 3: networkidle fallback
  try {
    await page.waitForLoadState('networkidle', { timeout: 3000 });
  } catch {
    // ignore
  }

  // Return whatever the current signature is
  const finalSig = await getFirstRowSignature(page);
  if (finalSig && finalSig !== previousSignature) return finalSig;

  // Tiny delay as last resort
  await page.waitForTimeout(1500);
  const lastSig = await getFirstRowSignature(page);
  return lastSig || previousSignature;
}

async function getFirstRowSignature(page: Page): Promise<string> {
  try {
    const rows = getTableRowLocator(page);
    const count = await rows.count();
    if (count === 0) return '';
    const cells = await rows.first().locator('td, [role="cell"], [role="gridcell"]').allInnerTexts();
    return cells.join('|').trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 4) Table header + visible row extraction
// ---------------------------------------------------------------------------

function getTableContainerLocator(page: Page): Locator {
  return page.locator('table, [role="table"], [role="grid"]').first();
}

function getTableHeaderLocator(page: Page): Locator {
  return page.locator(
    'thead th, thead td, [role="columnheader"], table tr:first-child th'
  );
}

function getTableRowLocator(page: Page): Locator {
  return page.locator(
    'tbody tr, [role="row"]:not(:has([role="columnheader"])):not(:first-child)'
  );
}

async function readTableHeaders(page: Page): Promise<string[]> {
  try {
    // Try thead th first
    let headerLoc = page.locator('thead th, thead td');
    let count = await headerLoc.count();

    // Fallback: role="columnheader"
    if (count === 0) {
      headerLoc = page.locator('[role="columnheader"]');
      count = await headerLoc.count();
    }

    // Fallback: first row of table that looks like a header
    if (count === 0) {
      headerLoc = page.locator('table tr:first-child th, table tr:first-child td');
      count = await headerLoc.count();
    }

    // Fallback: first role="row" children
    if (count === 0) {
      headerLoc = page.locator('[role="row"]:first-child [role="cell"], [role="row"]:first-child [role="gridcell"]');
      count = await headerLoc.count();
    }

    const headers: string[] = [];
    for (let i = 0; i < count; i++) {
      headers.push((await headerLoc.nth(i).innerText()).trim());
    }
    return headers;
  } catch {
    return [];
  }
}

async function readVisibleRowTexts(page: Page, maxRows?: number): Promise<string[][]> {
  try {
    const rows = getTableRowLocator(page);
    const rowCount = await rows.count();
    const limit = maxRows ? Math.min(rowCount, maxRows) : rowCount;
    const result: string[][] = [];

    for (let i = 0; i < limit; i++) {
      const cells = rows.nth(i).locator('td, [role="cell"], [role="gridcell"]');
      const cellCount = await cells.count();
      const cellTexts: string[] = [];
      for (let j = 0; j < cellCount; j++) {
        cellTexts.push((await cells.nth(j).innerText()).trim());
      }
      if (cellTexts.length > 0) result.push(cellTexts);
    }

    return result;
  } catch {
    return [];
  }
}

export async function extractTableHeadersAndVisibleRows(
  page: Page
): Promise<{ headers: string[]; rows: string[][] }> {
  const headers = await readTableHeaders(page);
  const rows = await readVisibleRowTexts(page);
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// 5) Virtualisation handling — scroll-and-collect
// ---------------------------------------------------------------------------

export async function collectAllRowsByScrolling(
  page: Page,
  headerTexts: string[],
  propKey: string,
  propLabel: string,
  dateISO: string
): Promise<PropRow[]> {
  const context: RowContext = { propKey, propLabel, dateISO };

  // ── Fast path: Batch-read all rows via page.evaluate ──────────────
  // Most tables on props.cash are NOT virtualized (all rows in DOM).
  // Reading via a single evaluate call is 10-50x faster than individual locator calls.
  const batchRows = await page.evaluate(() => {
    const headerEls = document.querySelectorAll('thead th, thead td');
    const headers: string[] = [];
    headerEls.forEach(h => headers.push((h.textContent || '').trim()));

    const rowEls = document.querySelectorAll('tbody tr');
    const rows: string[][] = [];
    rowEls.forEach(row => {
      const cells: string[] = [];
      row.querySelectorAll('td').forEach(td => cells.push((td.textContent || '').trim()));
      if (cells.length > 0) rows.push(cells);
    });

    return { headers, rows };
  });

  if (batchRows.rows.length > 0) {
    const effectiveHeaders = batchRows.headers.length > 0 ? batchRows.headers : headerTexts;
    const seenSigs = new Set<string>();
    const result: PropRow[] = [];

    for (const cellTexts of batchRows.rows) {
      const row = normalizeRow(effectiveHeaders, cellTexts, context);
      if (!row) continue;
      if (!seenSigs.has(row.rowSignature)) {
        seenSigs.add(row.rowSignature);
        result.push(row);
      }
    }

    // If we got a reasonable number, return immediately
    if (result.length > 0) {
      return result;
    }
  }

  // ── Slow path: Scroll-and-collect for virtualized tables ──────────
  const seenSignatures = new Set<string>();
  const allRows: PropRow[] = [];
  let stableCount = 0;
  let totalAttempts = 0;

  const scrollContainer = await findScrollContainer(page);

  while (totalAttempts < MAX_SCROLL_ATTEMPTS && stableCount < STABLE_SCROLL_THRESHOLD) {
    const visibleRowTexts = await readVisibleRowTexts(page);
    let newRowsThisPass = 0;

    for (const cellTexts of visibleRowTexts) {
      const row = normalizeRow(headerTexts, cellTexts, context);
      if (!row) continue;

      if (!seenSignatures.has(row.rowSignature)) {
        seenSignatures.add(row.rowSignature);
        allRows.push(row);
        newRowsThisPass++;
      }
    }

    if (newRowsThisPass === 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }

    if (scrollContainer) {
      await scrollContainer.evaluate((el) => {
        el.scrollTop += el.clientHeight * 0.8;
      });
    } else {
      await page.mouse.wheel(0, 600);
    }

    await page.waitForTimeout(SCROLL_INTERVAL_MS);
    totalAttempts++;
  }

  // Scroll back to top
  if (scrollContainer) {
    await scrollContainer.evaluate((el) => { el.scrollTop = 0; });
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  return allRows;
}

async function findScrollContainer(page: Page): Promise<Locator | null> {
  const MARKER = 'data-scraper-scroll';

  try {
    // Strategy 1: CSS class / style-based container with table rows
    const container = page.locator(
      '[style*="overflow"][style*="auto"], [style*="overflow"][style*="scroll"], ' +
      '[class*="scroll"], [class*="virtual"], [class*="table-container"], ' +
      '[class*="tableContainer"], [class*="table-wrapper"]'
    );
    const count = await container.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const c = container.nth(i);
        const hasRows = await c.locator('tr, [role="row"]').count();
        if (hasRows > 0) return c;
      }
    }

    // Strategy 2: Walk up from the table to find the scrollable ancestor,
    // tag it with a data attribute so we can locate it.
    const tagged = await page.evaluate((marker: string) => {
      const table = document.querySelector('table, [role="table"], [role="grid"]');
      if (!table) return false;
      let el: Element | null = table.parentElement;
      while (el) {
        const style = window.getComputedStyle(el);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight
        ) {
          el.setAttribute(marker, 'true');
          return true;
        }
        el = el.parentElement;
      }
      return false;
    }, MARKER);

    if (tagged) {
      const loc = page.locator(`[${MARKER}="true"]`);
      if ((await loc.count()) > 0) return loc.first();
    }
  } catch {
    // ignore
  }

  return null;
}

// ---------------------------------------------------------------------------
// 6) Row normalisation (header text → PropRow fields)
// ---------------------------------------------------------------------------

interface RowContext {
  propKey: string;
  propLabel: string;
  dateISO: string;
}

const HEADER_MAP: Array<{ pattern: RegExp; field: string }> = [
  { pattern: /^player$|^name$/i, field: 'playerName' },
  { pattern: /^team$/i, field: 'team' },
  { pattern: /^opp|^opponent|^vs\.?$/i, field: 'opponent' },
  { pattern: /^l$|^line$|^o\/u$/i, field: 'line' },
  { pattern: /^over$|^o$|^odds?\s*over$/i, field: 'oddsOver' },
  { pattern: /^under$|^u$|^odds?\s*under$/i, field: 'oddsUnder' },
  { pattern: /^stk$|^streak$/i, field: 'streak' },
  { pattern: /^proj$|^projection$/i, field: 'projection' },
  { pattern: /^diff$|^edge$/i, field: 'diff' },
  { pattern: /^dvp$|^dvp\s*rank$/i, field: 'dvp' },
  { pattern: /^status$|^inj/i, field: 'status' },
];

const HIT_RATE_PATTERNS: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /25.?26/i, key: '25/26' },
  { pattern: /24.?25/i, key: '24/25' },
  { pattern: /h2h/i, key: 'H2H' },
  { pattern: /^l5$|last\s*5/i, key: 'L5' },
  { pattern: /^l10$|last\s*10/i, key: 'L10' },
  { pattern: /^l15$|last\s*15/i, key: 'L15' },
  { pattern: /^l20$|last\s*20/i, key: 'L20' },
  { pattern: /^l30$|last\s*30/i, key: 'L30' },
];

/**
 * Parse the PLAYER cell.
 *
 * Observed format on props.cash:
 *   "Scotty Pippen Jr.\nMEM | PG\nOUT"
 *   "Kevin Durant\nHOU | PF"
 *   "Ty Jerome\nMEM | SG\nGTD"
 *
 * Line 1 = player name
 * Line 2 = TEAM | POSITION  (optional)
 * Line 3 = status tag        (optional)
 */
function parsePlayerCell(text: string): { playerName: string; team?: string; status?: string } {
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

  const result: { playerName: string; team?: string; status?: string } = {
    playerName: lines[0] || text.trim(),
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Team line: "MEM | PG", "HOU | PF", "DAL | SF"
    const teamMatch = line.match(/^([A-Z]{2,4})\s*\|\s*\w{1,3}/);
    if (teamMatch) {
      result.team = teamMatch[1];
      continue;
    }

    // Status tags: OUT, GTD, DTD, etc.
    const statusMatch = line.match(/\b(OUT|GTD|DTD|DOUBT|PROB|QUES|SUSP|INJ)\b/i);
    if (statusMatch) {
      result.status = statusMatch[1].toUpperCase();
      continue;
    }

    // Standalone team abbreviation
    if (/^[A-Z]{2,4}$/.test(line)) {
      result.team = line;
    }
  }

  // Clean up player name (remove any trailing team/status that leaked in)
  result.playerName = result.playerName
    .replace(/\s{2,}/g, ' ')
    .trim();

  return result;
}

export function normalizeRow(
  headers: string[],
  cells: string[],
  context: RowContext
): PropRow | null {
  if (cells.length === 0) return null;

  // Build raw map
  const raw: Record<string, string> = {};
  for (let i = 0; i < Math.min(headers.length, cells.length); i++) {
    if (headers[i]) raw[headers[i]] = cells[i];
  }

  // Map known fields
  const mapped: Record<string, string> = {};
  const hitRates: Record<string, number | null> = {};

  for (let i = 0; i < headers.length && i < cells.length; i++) {
    const h = headers[i];
    const v = cells[i];

    // Check known fields
    let isKnown = false;
    for (const m of HEADER_MAP) {
      if (m.pattern.test(h)) {
        mapped[m.field] = v;
        isKnown = true;
        break;
      }
    }

    // Check hit rates
    if (!isKnown) {
      for (const hr of HIT_RATE_PATTERNS) {
        if (hr.pattern.test(h)) {
          hitRates[hr.key] = parseNumber(v);
          isKnown = true;
          break;
        }
      }
    }
  }

  // If no playerName mapped, use first non-empty cell
  if (!mapped['playerName']) {
    for (const c of cells) {
      if (c.trim() && !/^\d/.test(c.trim())) {
        mapped['playerName'] = c.trim();
        break;
      }
    }
  }

  if (!mapped['playerName']) return null;

  // Parse player cell for embedded team/status
  const playerInfo = parsePlayerCell(mapped['playerName']);

  const row: PropRow = {
    propKey: context.propKey,
    propLabel: context.propLabel,
    dateISO: context.dateISO,
    playerName: playerInfo.playerName,
    team: mapped['team'] || playerInfo.team,
    status: mapped['status'] || playerInfo.status,
    line: parseLine(mapped['line'] ?? ''),
    oddsOver: parseOdds(mapped['oddsOver'] ?? ''),
    oddsUnder: parseOdds(mapped['oddsUnder'] ?? ''),
    projection: parseNumber(mapped['projection'] ?? ''),
    diff: parseNumber(mapped['diff'] ?? ''),
    dvp: mapped['dvp'] || null,
    hitRates: Object.keys(hitRates).length > 0 ? hitRates : undefined,
    raw,
    rowSignature: '', // computed below
  };

  row.rowSignature = makeRowSignature(context.propKey, row);

  return row;
}

// ---------------------------------------------------------------------------
// 7) Main scraper
// ---------------------------------------------------------------------------

export async function scrapeNbaPropsForDate(
  page: Page,
  dateISO: string,
  options: ScrapeOptions = {}
): Promise<ScrapeSession> {
  const startedAt = new Date().toISOString();
  const tableRefreshMs = options.timeouts?.tableRefreshMs ?? DEFAULT_TABLE_REFRESH_MS;
  const artifactDir = ensureScrapeDir(dateISO);

  console.log(`\n=== NBA Props Scraper ===`);
  console.log(`Date: ${dateISO}`);
  console.log(`Artifacts: ${artifactDir}\n`);

  // ── Discover prop options ───────────────────────────────────────────
  console.log('Discovering prop dropdown options...');
  const { options: propOptions, diagnostics } = await discoverPropOptions(page, {
    debug: options.debug,
    dateISO,
  });

  console.log(`Strategy: ${diagnostics.strategy}`);
  console.log(`Found ${propOptions.length} prop options: ${propOptions.map(o => o.label).join(', ')}`);
  console.log(`Table headers: [${diagnostics.headers.join(', ')}]`);

  if (diagnostics.sampleRows.length > 0) {
    console.log(`Sample row 1: [${diagnostics.sampleRows[0].join(' | ')}]`);
  }

  // In discover-only mode, return early
  if (options.discover) {
    console.log('\n--discover mode: exiting after diagnostics.');
    return {
      dateISO,
      startedAt,
      finishedAt: new Date().toISOString(),
      results: [],
      errors: [],
      summary: { propsAttempted: 0, propsSucceeded: 0, rowsTotal: 0 },
      artifactDir,
    };
  }

  if (propOptions.length === 0) {
    console.error('ERROR: No prop options discovered. Cannot scrape.');
    return {
      dateISO,
      startedAt,
      finishedAt: new Date().toISOString(),
      results: [],
      errors: [{ propKey: 'discovery', propLabel: 'discovery', error: 'No prop options found' }],
      summary: { propsAttempted: 0, propsSucceeded: 0, rowsTotal: 0 },
      artifactDir,
    };
  }

  // ── Filter options ──────────────────────────────────────────────────
  let toScrape = [...propOptions];

  if (options.onlyPropLabel) {
    toScrape = toScrape.filter(
      o => o.label.toLowerCase() === options.onlyPropLabel!.toLowerCase()
    );
    if (toScrape.length === 0) {
      console.error(`ERROR: Prop "${options.onlyPropLabel}" not found in options.`);
      return {
        dateISO,
        startedAt,
        finishedAt: new Date().toISOString(),
        results: [],
        errors: [{ propKey: 'filter', propLabel: options.onlyPropLabel, error: 'Prop not found' }],
        summary: { propsAttempted: 0, propsSucceeded: 0, rowsTotal: 0 },
        artifactDir,
      };
    }
  }

  if (options.limitProps && options.limitProps > 0) {
    toScrape = toScrape.slice(0, options.limitProps);
  }

  // ── Scrape loop ─────────────────────────────────────────────────────
  const results: PropScrapeResult[] = [];
  const errors: Array<{ propKey: string; propLabel: string; error: string }> = [];
  let totalRows = 0;
  let previousSignature = await getFirstRowSignature(page);

  for (let i = 0; i < toScrape.length; i++) {
    const option = toScrape[i];
    const propNum = `(${i + 1}/${toScrape.length})`;
    console.log(`\nScraping: ${option.label} ${propNum}`);

    let success = false;
    for (let attempt = 1; attempt <= SCRAPE_RETRY_COUNT; attempt++) {
      try {
        const propStart = Date.now();

        // Select prop
        await selectPropOption(page, option);

        // Wait for table refresh
        const newSig = await waitForTableRefresh(page, previousSignature, tableRefreshMs);
        previousSignature = newSig;

        // Read headers
        const headers = await readTableHeaders(page);
        if (headers.length === 0) {
          throw new Error('No table headers found after selecting prop');
        }

        // Collect all rows via scrolling
        const rows = await collectAllRowsByScrolling(
          page, headers, option.key, option.label, dateISO
        );

        const durationMs = Date.now() - propStart;
        console.log(`  Collected ${rows.length} rows in ${durationMs}ms`);

        const result: PropScrapeResult = {
          propKey: option.key,
          propLabel: option.label,
          rows,
          rowCount: rows.length,
          durationMs,
        };

        // Write outputs
        writePropJson(dateISO, option.key, result);
        writePropCsv(dateISO, option.key, rows);

        if (options.debug) {
          await saveDebugArtifacts(dateISO, option.key, page, {
            screenshot: true,
            html: true,
          });
        }

        results.push(result);
        totalRows += rows.length;
        success = true;
        break; // success — no more retries
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Attempt ${attempt}/${SCRAPE_RETRY_COUNT} failed: ${message}`);

        if (options.debug) {
          await saveDebugArtifacts(dateISO, option.key, page, {
            screenshot: true,
            html: true,
            prefix: `error_attempt${attempt}`,
          }).catch(() => {});
        }

        if (attempt < SCRAPE_RETRY_COUNT) {
          console.log(`  Retrying in 2s...`);
          await page.waitForTimeout(2000);
        }
      }
    }

    if (!success) {
      errors.push({
        propKey: option.key,
        propLabel: option.label,
        error: `Failed after ${SCRAPE_RETRY_COUNT} attempts`,
      });
    }
  }

  // ── Write combined output ───────────────────────────────────────────
  const session: ScrapeSession = {
    dateISO,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    errors,
    summary: {
      propsAttempted: toScrape.length,
      propsSucceeded: results.length,
      rowsTotal: totalRows,
    },
    artifactDir,
  };

  writeAllPropsJson(dateISO, session);

  console.log(`\n=== Scrape Complete ===`);
  console.log(`Props: ${results.length}/${toScrape.length} succeeded`);
  console.log(`Rows: ${totalRows} total`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.map(e => e.propLabel).join(', ')}`);
  }
  console.log(`Artifacts: ${artifactDir}\n`);

  return session;
}
