import pg from 'pg';
import { config } from '../config/env.js';

/**
 * One shared connection pool for the whole server.
 * Neon requires SSL; the "?sslmode=require" part of DATABASE_URL enables it.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Neon's free database suspends when idle and needs a moment to wake up,
  // so we allow a generous time to connect.
  connectionTimeoutMillis: 15_000,
});

// Without this handler, an error on an idle pooled connection
// (e.g. Neon suspending) would crash the whole process.
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client:', err.message);
});

export async function checkDatabase() {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}
