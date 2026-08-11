import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const applicationTables = [
  'users',
  'company_settings',
  'audit_logs',
  'employees',
  'payroll_runs',
  'payroll_records',
  'payroll_column_mappings',
  'payslip_generations',
  'payslip_shares',
  'payroll_whatsapp_logs',
];

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15_000,
});

try {
  if (process.argv.includes('--require-clean')) {
    const existing = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [applicationTables],
    );
    if (existing.rowCount > 0) {
      throw new Error(
        `Clean database preflight failed: ${existing.rowCount} application table(s) already exist`,
      );
    }
  }

  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });

  const created = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = any($1::text[])
     order by table_name`,
    [applicationTables],
  );
  if (created.rowCount !== applicationTables.length) {
    throw new Error(
      `Migration verification failed: expected ${applicationTables.length} tables, found ${created.rowCount}`,
    );
  }

  console.log(JSON.stringify({ migrated: true, tableCount: created.rowCount }));
} finally {
  await pool.end();
}
