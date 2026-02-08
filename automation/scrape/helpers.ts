/**
 * Scraper helpers — types, file I/O, parsing, dedup, debug artifacts.
 *
 * No external deps; CSV is hand-rolled.
 */

import { Page } from 'playwright';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PropRow {
  propKey: string;
  propLabel: string;
  dateISO: string;
  playerName: string;
  team?: string;
  status?: string;
  line?: number | null;
  oddsOver?: number | null;
  oddsUnder?: number | null;
  projection?: number | null;
  diff?: number | null;
  dvp?: string | null;
  hitRates?: Record<string, number | null>;
  raw: Record<string, string>;
  rowSignature: string;
}

export interface PropScrapeResult {
  propKey: string;
  propLabel: string;
  rows: PropRow[];
  rowCount: number;
  durationMs: number;
}

export interface ScrapeSession {
  dateISO: string;
  startedAt: string;
  finishedAt: string;
  results: PropScrapeResult[];
  errors: Array<{ propKey: string; propLabel: string; error: string }>;
  summary: { propsAttempted: number; propsSucceeded: number; rowsTotal: number };
  artifactDir: string;
}

export interface ScrapeOptions {
  headless?: boolean;
  debug?: boolean;
  discover?: boolean;
  limitProps?: number;
  onlyPropLabel?: string;
  timeouts?: {
    tableRefreshMs?: number;
    navigationMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARTIFACTS_ROOT = path.resolve('./artifacts/scrapes');

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export function ensureScrapeDir(dateISO: string): string {
  const dir = path.join(ARTIFACTS_ROOT, dateISO);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureDebugDir(dateISO: string): string {
  const dir = path.join(ARTIFACTS_ROOT, dateISO, 'debug');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Prop key normalisation
// ---------------------------------------------------------------------------

export function normalizePropKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ---------------------------------------------------------------------------
// Robust number parsing
// ---------------------------------------------------------------------------

/** Parse an odds string like "-110", "+120", "EVEN", "−110" (unicode minus). */
export function parseOdds(text: string): number | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/\u2212/g, '-').replace(/[^0-9.+\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse a line/total like "25.5", "O 25.5", "U 25.5". */
export function parseLine(text: string): number | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/^[OUou]\s*/i, '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse a general number, stripping %, ranks, commas, etc. */
export function parseNumber(text: string): number | null {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/\u2212/g, '-')
    .replace(/%/g, '')
    .replace(/,/g, '')
    .replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Row signature
// ---------------------------------------------------------------------------

export function makeRowSignature(
  propKey: string,
  row: Partial<PropRow> & { raw?: Record<string, string> }
): string {
  const parts: string[] = [propKey];

  if (row.playerName) parts.push(row.playerName);
  if (row.team) parts.push(row.team);
  if (row.line != null) parts.push(String(row.line));
  if (row.oddsOver != null) parts.push(String(row.oddsOver));
  if (row.oddsUnder != null) parts.push(String(row.oddsUnder));

  // Fallback: if we barely have anything, add raw values
  if (parts.length <= 2 && row.raw) {
    const vals = Object.values(row.raw).slice(0, 5);
    parts.push(...vals);
  }

  return parts.join('|');
}

// ---------------------------------------------------------------------------
// CSV writing (hand-rolled)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function rowsToCsv(rows: PropRow[]): string {
  if (rows.length === 0) return '';

  // Collect all hitRate keys across all rows
  const allHitRateKeys = new Set<string>();
  for (const row of rows) {
    if (row.hitRates) {
      for (const k of Object.keys(row.hitRates)) allHitRateKeys.add(k);
    }
  }
  const hitRateKeys = [...allHitRateKeys].sort();

  // Stable columns first
  const stableCols = [
    'playerName', 'team', 'status', 'line',
    'oddsOver', 'oddsUnder', 'projection', 'diff', 'dvp',
  ];
  const hitCols = hitRateKeys.map(k => `hitRate_${k}`);
  const allCols = [...stableCols, ...hitCols, 'raw_json'];

  const lines: string[] = [];
  lines.push(allCols.map(csvEscape).join(','));

  for (const row of rows) {
    const vals: string[] = [];
    vals.push(csvEscape(row.playerName ?? ''));
    vals.push(csvEscape(row.team ?? ''));
    vals.push(csvEscape(row.status ?? ''));
    vals.push(csvEscape(row.line != null ? String(row.line) : ''));
    vals.push(csvEscape(row.oddsOver != null ? String(row.oddsOver) : ''));
    vals.push(csvEscape(row.oddsUnder != null ? String(row.oddsUnder) : ''));
    vals.push(csvEscape(row.projection != null ? String(row.projection) : ''));
    vals.push(csvEscape(row.diff != null ? String(row.diff) : ''));
    vals.push(csvEscape(row.dvp ?? ''));

    for (const k of hitRateKeys) {
      const v = row.hitRates?.[k];
      vals.push(csvEscape(v != null ? String(v) : ''));
    }

    vals.push(csvEscape(JSON.stringify(row.raw)));
    lines.push(vals.join(','));
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// File writers
// ---------------------------------------------------------------------------

export function writePropJson(
  dateISO: string,
  propKey: string,
  data: PropScrapeResult
): string {
  const dir = ensureScrapeDir(dateISO);
  const filePath = path.join(dir, `nba_${propKey}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  -> ${filePath}`);
  return filePath;
}

export function writePropCsv(
  dateISO: string,
  propKey: string,
  rows: PropRow[]
): string {
  const dir = ensureScrapeDir(dateISO);
  const filePath = path.join(dir, `nba_${propKey}.csv`);
  fs.writeFileSync(filePath, rowsToCsv(rows));
  console.log(`  -> ${filePath}`);
  return filePath;
}

export function writeAllPropsJson(
  dateISO: string,
  session: ScrapeSession
): string {
  const dir = ensureScrapeDir(dateISO);
  const filePath = path.join(dir, 'nba_all_props.json');
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  console.log(`  -> ${filePath}`);
  return filePath;
}

// ---------------------------------------------------------------------------
// Debug artifacts
// ---------------------------------------------------------------------------

export async function saveDebugArtifacts(
  dateISO: string,
  propKey: string,
  page: Page,
  opts: { screenshot?: boolean; html?: boolean; prefix?: string } = {}
): Promise<void> {
  const dir = ensureDebugDir(dateISO);
  const prefix = opts.prefix ? `${opts.prefix}_` : '';

  if (opts.screenshot !== false) {
    const ssPath = path.join(dir, `${prefix}nba_${propKey}.png`);
    await page.screenshot({ path: ssPath, fullPage: true });
    console.log(`  [debug] screenshot: ${ssPath}`);
  }

  if (opts.html !== false) {
    const htmlPath = path.join(dir, `${prefix}nba_${propKey}.html`);
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);
    console.log(`  [debug] html: ${htmlPath}`);
  }
}
