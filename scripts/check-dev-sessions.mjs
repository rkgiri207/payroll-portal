import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const table = await pool.query(
    "select to_regclass('public.sessions') as present",
  );
  let count = null;
  if (table.rows[0].present) {
    count = Number((await pool.query('select count(1) as count from sessions')).rows[0].count);
  }
  console.log(JSON.stringify({ present: Boolean(table.rows[0].present), count }));
} finally {
  await pool.end();
}
