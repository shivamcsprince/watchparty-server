import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

/**
 * Applies db/schema.sql to the database inside a single transaction:
 * either every statement succeeds or none is applied.
 * Run with: npm run db:migrate
 */
const schemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/schema.sql',
);

const client = await pool.connect();
try {
  const sql = await readFile(schemaPath, 'utf8');
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('[migrate] Schema applied successfully');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('[migrate] Failed, rolled back:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
