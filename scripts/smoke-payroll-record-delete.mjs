import assert from 'node:assert/strict';
import pg from 'pg';

const baseUrl = process.env.APP_BASE_URL.replace(/\/$/, '');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let insertedId;

try {
  const runResult = await pool.query(
    `select id from payroll_runs order by upload_timestamp desc, id desc limit 1`,
  );
  assert.equal(runResult.rowCount, 1, 'A synthetic payroll run is required');
  const runId = runResult.rows[0].id;
  const inserted = await pool.query(
    `insert into payroll_records (payroll_run_id, employee_code, employee_name, gross_salary, net_salary)
     values ($1, 'TESTDELETE', 'Temporary Delete Test', 0, 0) returning id`,
    [runId],
  );
  insertedId = inserted.rows[0].id;

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.DEV_ADMIN_EMAIL, password: process.env.DEV_ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const deleted = await fetch(`${baseUrl}/api/payroll-runs/${runId}/records/${insertedId}`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(deleted.status, 200);

  const recordCheck = await pool.query('select id from payroll_records where id = $1', [insertedId]);
  assert.equal(recordCheck.rowCount, 0);
  insertedId = undefined;
  const totals = await pool.query(
    `select r.employee_count,
      (select count(*)::int from payroll_records pr where pr.payroll_run_id = r.id) as actual_count
     from payroll_runs r where r.id = $1`, [runId],
  );
  assert.equal(totals.rows[0].employee_count, totals.rows[0].actual_count);

  const list = await fetch(`${baseUrl}/api/payroll-runs?limit=100`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const runs = (await list.json()).runs;
  for (let index = 1; index < runs.length; index++) {
    assert(new Date(runs[index - 1].uploadTimestamp) >= new Date(runs[index].uploadTimestamp));
  }
  console.log(JSON.stringify({ deleteSyntheticRecord: true, totalsRecalculated: true, uploadOrderDescending: true }));
} finally {
  if (insertedId) await pool.query('delete from payroll_records where id = $1', [insertedId]);
  await pool.end();
}
