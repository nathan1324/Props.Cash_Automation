/**
 * Database client — thin wrapper around node-postgres (pg).
 *
 * Reads DATABASE_URL from environment (or .env).
 * Exports a singleton pool and typed query helpers.
 */

import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Singleton pool
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Add it to .env or export it before running.'
      );
    }

    pool = new Pool({
      connectionString,
      // Supabase requires SSL in production
      ssl: (connectionString.includes('supabase.co') || connectionString.includes('supabase.com'))
        ? { rejectUnauthorized: false }
        : undefined,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Run a parameterised query and return all rows. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params);
}

/** Run a query and return the first row (or null). */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/** Check if DATABASE_URL is configured. */
export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

/** Test the connection (returns true on success). */
export async function testConnection(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Shut down the pool (call on process exit). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
