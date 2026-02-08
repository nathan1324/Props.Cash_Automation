/**
 * Database query module for the Electron main process.
 *
 * Self-contained pg pool — reads DATABASE_URL from process.env
 * (loaded via dotenv in main.ts).
 */

import pg from 'pg';

const { Pool } = pg;

export interface DateSummary {
  dateIso: string;
  propsCount: number;
  rowsCount: number;
  scrapedAt: string;
}

export interface PropRowRecord {
  id: string;
  dateIso: string;
  propKey: string;
  propLabel: string;
  playerName: string;
  team: string | null;
  status: string | null;
  line: number | null;
  oddsOver: number | null;
  oddsUnder: number | null;
  projection: number | null;
  diff: number | null;
  dvp: string | null;
  hitRates: Record<string, number | null> | null;
}

export class DbQuery {
  private pool: pg.Pool | null = null;

  // ── Connection ──────────────────────────────────────────────────────

  isConfigured(): boolean {
    return !!process.env.DATABASE_URL;
  }

  private getPool(): pg.Pool {
    if (!this.pool) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL not set');
      }
      this.pool = new Pool({
        connectionString,
        ssl: (connectionString.includes('supabase.co') || connectionString.includes('supabase.com'))
          ? { rejectUnauthorized: false }
          : undefined,
        max: 3,
        idleTimeoutMillis: 30_000,
      });
    }
    return this.pool;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getPool().query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────

  /** List dates that have scraped data, most recent first. */
  async getAvailableDates(limit: number = 30): Promise<DateSummary[]> {
    const result = await this.getPool().query<{
      date_iso: string;
      props_count: string;
      rows_count: string;
      scraped_at: string;
    }>(
      `SELECT
         pr.date_iso::text AS date_iso,
         COUNT(DISTINCT pr.prop_key) AS props_count,
         COUNT(*)                    AS rows_count,
         MAX(sr.finished_at)         AS scraped_at
       FROM prop_rows pr
       JOIN scrape_runs sr ON sr.id = pr.run_id
       WHERE pr.sport = 'nba'
       GROUP BY pr.date_iso
       ORDER BY pr.date_iso DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(r => ({
      dateIso: r.date_iso,
      propsCount: parseInt(r.props_count, 10),
      rowsCount: parseInt(r.rows_count, 10),
      scrapedAt: r.scraped_at,
    }));
  }

  /** List distinct prop keys for a given date. */
  async getPropsForDate(dateIso: string): Promise<Array<{ key: string; label: string; count: number }>> {
    const result = await this.getPool().query<{
      prop_key: string;
      prop_label: string;
      cnt: string;
    }>(
      `SELECT prop_key, prop_label, COUNT(*) AS cnt
       FROM prop_rows
       WHERE sport = 'nba' AND date_iso = $1::date
       GROUP BY prop_key, prop_label
       ORDER BY prop_label`,
      [dateIso]
    );

    return result.rows.map(r => ({
      key: r.prop_key,
      label: r.prop_label,
      count: parseInt(r.cnt, 10),
    }));
  }

  /** Query prop rows with optional filters. */
  async queryPropRows(opts: {
    dateIso: string;
    propKey?: string;
    playerSearch?: string;
    orderBy?: string;
    limit?: number;
  }): Promise<PropRowRecord[]> {
    const conditions: string[] = ["sport = 'nba'", 'date_iso = $1::date'];
    const params: unknown[] = [opts.dateIso];
    let paramIdx = 2;

    if (opts.propKey) {
      conditions.push(`prop_key = $${paramIdx}`);
      params.push(opts.propKey);
      paramIdx++;
    }

    if (opts.playerSearch) {
      conditions.push(`player_name ILIKE $${paramIdx}`);
      params.push(`%${opts.playerSearch}%`);
      paramIdx++;
    }

    // Validate orderBy to prevent injection
    const allowedOrder: Record<string, string> = {
      player: 'player_name ASC',
      line: 'line DESC NULLS LAST',
      diff: 'diff DESC NULLS LAST',
      projection: 'projection DESC NULLS LAST',
      dvp: 'dvp ASC NULLS LAST',
    };
    const orderClause = allowedOrder[opts.orderBy ?? 'player'] ?? 'player_name ASC';
    const limit = Math.min(opts.limit ?? 500, 2000);

    const sql = `
      SELECT id, date_iso::text AS date_iso, prop_key, prop_label,
             player_name, team, status, line,
             odds_over, odds_under, projection, diff, dvp,
             hit_rates
      FROM prop_rows
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderClause}
      LIMIT ${limit}`;

    const result = await this.getPool().query<{
      id: string;
      date_iso: string;
      prop_key: string;
      prop_label: string;
      player_name: string;
      team: string | null;
      status: string | null;
      line: string | null;
      odds_over: number | null;
      odds_under: number | null;
      projection: string | null;
      diff: string | null;
      dvp: string | null;
      hit_rates: Record<string, number | null> | null;
    }>(sql, params);

    return result.rows.map(r => ({
      id: r.id,
      dateIso: r.date_iso,
      propKey: r.prop_key,
      propLabel: r.prop_label,
      playerName: r.player_name,
      team: r.team,
      status: r.status,
      line: r.line != null ? parseFloat(r.line) : null,
      oddsOver: r.odds_over,
      oddsUnder: r.odds_under,
      projection: r.projection != null ? parseFloat(r.projection) : null,
      diff: r.diff != null ? parseFloat(r.diff) : null,
      dvp: r.dvp,
      hitRates: r.hit_rates,
    }));
  }
}
