import assert from 'node:assert/strict';
import pg from 'pg';

const employeeCode = process.argv[2];
assert(/^TEST\d{3}$/.test(employeeCode ?? ''), 'A synthetic employee code such as TEST001 is required');

const appBaseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '');
const email = process.env.DEV_ADMIN_EMAIL;
const password = process.env.DEV_ADMIN_PASSWORD;
assert(appBaseUrl && email && password && process.env.DATABASE_URL, 'Required DEV environment values are missing');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const record = await pool.query(
    'select id from payroll_records where employee_code = $1 order by id desc limit 1',
    [employeeCode],
  );
  assert.equal(record.rowCount, 1, `${employeeCode} payroll record was not found`);

  const login = await fetch(`${appBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200, 'DEV administrator login failed');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Login did not return a session cookie');

  const response = await fetch(`${appBaseUrl}/api/payroll-records/${record.rows[0].id}/share-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ forceNew: true }),
  });
  const result = await response.json();
  assert.equal(response.status, 201, result.error ?? 'Share link creation failed');
  console.log(result.url);
} finally {
  await pool.end();
}
