/**
 * Persistence module — writes ScrapeSession data into Postgres.
 *
 * persistScrapeSession():
 *   1. INSERT into scrape_runs → get run_id
 *   2. Batch UPSERT all PropRow[] into prop_rows
 *   3. Return { runId, inserted, updated }
 */

import { query, queryOne } from './client';
import { ScrapeSession, PropRow } from '../scrape/helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistResult {
  runId: string;
  rowsPersisted: number;
  rowsInserted: number;
  rowsUpdated: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function persistScrapeSession(
  session: ScrapeSession,
  sport: string = 'nba'
): Promise<PersistResult> {
  const startTime = Date.now();

  // ── 1. Insert scrape_runs ───────────────────────────────────────────
  const runRow = await queryOne<{ id: string }>(
    `INSERT INTO scrape_runs
       (sport, date_iso, started_at, finished_at,
        props_attempted, props_succeeded, rows_total, errors)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      sport,
      session.dateISO,
      session.startedAt,
      session.finishedAt,
      session.summary.propsAttempted,
      session.summary.propsSucceeded,
      session.summary.rowsTotal,
      JSON.stringify(session.errors),
    ]
  );

  if (!runRow) {
    throw new Error('Failed to insert scrape_runs — no row returned');
  }

  const runId = runRow.id;
  console.log(`  [db] scrape_runs inserted: ${runId}`);

  // ── 2. Collect all rows from all results ────────────────────────────
  const allRows: PropRow[] = [];
  for (const result of session.results) {
    for (const row of result.rows) {
      allRows.push(row);
    }
  }

  if (allRows.length === 0) {
    console.log('  [db] No rows to persist.');
    return {
      runId,
      rowsPersisted: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // ── 3. Batch UPSERT prop_rows ───────────────────────────────────────
  // We batch in chunks to stay under Postgres parameter limits (max ~65535).
  // Each row has 17 params → batch of 500 = 8500 params (safe).
  const BATCH_SIZE = 500;
  let totalInserted = 0;
  let totalUpdated = 0;

  for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
    const batch = allRows.slice(i, i + BATCH_SIZE);
    const { inserted, updated } = await upsertBatch(runId, sport, batch);
    totalInserted += inserted;
    totalUpdated += updated;
  }

  const durationMs = Date.now() - startTime;
  console.log(
    `  [db] prop_rows persisted: ${allRows.length} total ` +
    `(${totalInserted} inserted, ${totalUpdated} updated) in ${durationMs}ms`
  );

  return {
    runId,
    rowsPersisted: allRows.length,
    rowsInserted: totalInserted,
    rowsUpdated: totalUpdated,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Batch UPSERT helper
// ---------------------------------------------------------------------------

async function upsertBatch(
  runId: string,
  sport: string,
  rows: PropRow[]
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  // Build parameterised VALUES clause
  const COLS_PER_ROW = 17;
  const valuesClauses: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const offset = i * COLS_PER_ROW;
    valuesClauses.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, ` +
      `$${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, ` +
      `$${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, ` +
      `$${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, ` +
      `$${offset + 17})`
    );
    params.push(
      runId,                                           // 1  run_id
      sport,                                           // 2  sport
      row.dateISO,                                     // 3  date_iso
      row.propKey,                                     // 4  prop_key
      row.propLabel,                                   // 5  prop_label
      row.playerName,                                  // 6  player_name
      row.team ?? null,                                // 7  team
      row.status ?? null,                              // 8  status
      row.line ?? null,                                // 9  line
      row.oddsOver ?? null,                            // 10 odds_over
      row.oddsUnder ?? null,                           // 11 odds_under
      row.projection ?? null,                          // 12 projection
      row.diff ?? null,                                // 13 diff
      row.dvp ?? null,                                 // 14 dvp
      row.hitRates ? JSON.stringify(row.hitRates) : null, // 15 hit_rates
      JSON.stringify(row.raw),                         // 16 raw
      row.rowSignature,                                // 17 row_signature
    );
  }

  // Count existing rows before upsert to determine inserted vs updated
  const sql = `
    INSERT INTO prop_rows
      (run_id, sport, date_iso, prop_key, prop_label,
       player_name, team, status, line, odds_over, odds_under,
       projection, diff, dvp, hit_rates, raw, row_signature)
    VALUES ${valuesClauses.join(', ')}
    ON CONFLICT (sport, date_iso, prop_key, player_name,
                 COALESCE(line, -999), COALESCE(odds_over, -999), COALESCE(odds_under, -999))
    DO UPDATE SET
      run_id        = EXCLUDED.run_id,
      prop_label    = EXCLUDED.prop_label,
      team          = EXCLUDED.team,
      status        = EXCLUDED.status,
      projection    = EXCLUDED.projection,
      diff          = EXCLUDED.diff,
      dvp           = EXCLUDED.dvp,
      hit_rates     = EXCLUDED.hit_rates,
      raw           = EXCLUDED.raw,
      row_signature = EXCLUDED.row_signature
    RETURNING (xmax = 0) AS was_inserted`;

  const result = await query<{ was_inserted: boolean }>(sql, params);

  let inserted = 0;
  let updated = 0;
  for (const r of result.rows) {
    if (r.was_inserted) inserted++;
    else updated++;
  }

  return { inserted, updated };
}
