import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const expectedBuckets = ['company-assets', 'payroll-files', 'payslips'];
const sql = await readFile(
  './supabase/migrations/202608090001_storage_buckets.sql',
  'utf8',
);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15_000,
});

const client = await pool.connect();
try {
  await client.query('begin');
  await client.query(sql);
  await client.query('commit');

  const result = await client.query(
    `select id, public from storage.buckets
     where id = any($1::text[]) order by id`,
    [expectedBuckets],
  );
  if (result.rowCount !== expectedBuckets.length) {
    throw new Error(
      `Storage verification failed: expected ${expectedBuckets.length} buckets, found ${result.rowCount}`,
    );
  }
  if (result.rows.some((bucket) => bucket.public !== false)) {
    throw new Error('Storage verification failed: an expected bucket is public');
  }
  console.log(JSON.stringify({ migrated: true, privateBucketCount: result.rowCount }));
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
