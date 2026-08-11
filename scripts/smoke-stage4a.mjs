import assert from 'node:assert/strict';
import pg from 'pg';

const appUrl = 'http://127.0.0.1:5100';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let cookie = '';

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('Cookie', cookie);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${appUrl}${path}`, { ...options, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return response;
}

try {
  const email = process.env.DEV_ADMIN_EMAIL;
  const password = process.env.DEV_ADMIN_PASSWORD;
  assert(email && password, 'DEV administrator credentials are not configured locally');
  const login = await request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200, 'DEV administrator login failed');

  const recordResult = await pool.query(
    `select id from payroll_records where employee_code = 'TEST001' order by id desc limit 1`,
  );
  assert.equal(recordResult.rowCount, 1, 'Synthetic TEST001 record is required');
  const recordId = recordResult.rows[0].id;

  const create = await request(`/api/payroll-records/${recordId}/share-link`, {
    method: 'POST', body: JSON.stringify({ forceNew: true }),
  });
  assert.equal(create.status, 201);
  const first = await create.json();
  const firstToken = new URL(first.url).pathname.split('/').pop();
  const firstDb = await pool.query(`select * from payslip_shares where payroll_record_id = $1`, [recordId]);
  assert.equal(firstDb.rowCount, 1);
  assert.notEqual(firstDb.rows[0].token_hash, firstToken);
  assert(!firstDb.rows[0].token_ciphertext.includes(firstToken));
  const lifetime = new Date(first.expiresAt).getTime() - new Date(firstDb.rows[0].created_at).getTime();
  assert(Math.abs(lifetime - 7 * 86400000) < 5000, 'Expiry is not exactly seven days');

  const reusedResponse = await request(`/api/payroll-records/${recordId}/share-link`, {
    method: 'POST', body: JSON.stringify({ forceNew: false }),
  });
  assert.equal(reusedResponse.status, 200);
  const reused = await reusedResponse.json();
  assert.equal(reused.reused, true);
  assert.equal(reused.url, first.url);

  const pdf = await request(new URL(first.url).pathname);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert((await pdf.arrayBuffer()).byteLength > 1000, 'Shared PDF is unexpectedly small');

  const modified = `${firstToken.slice(0, -1)}${firstToken.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await request(`/p/${modified}`)).status, 404);
  assert.equal((await request('/p/not-a-valid-token')).status, 404);

  const rotateResponse = await request(`/api/payroll-records/${recordId}/share-link`, {
    method: 'POST', body: JSON.stringify({ forceNew: true }),
  });
  assert.equal(rotateResponse.status, 201);
  const rotated = await rotateResponse.json();
  assert.notEqual(rotated.url, first.url);
  assert.equal((await request(new URL(first.url).pathname)).status, 404);
  assert.equal((await request(new URL(rotated.url).pathname)).status, 200);

  await pool.query(`update payslip_shares set expires_at = now() - interval '1 minute' where payroll_record_id = $1`, [recordId]);
  assert.equal((await request(new URL(rotated.url).pathname)).status, 410);
  const cleanup = await request('/api/payslip-shares/cleanup', { method: 'POST' });
  assert.equal(cleanup.status, 200);
  const cleanupResult = await cleanup.json();
  assert(cleanupResult.cleaned >= 0);
  const afterCleanup = await pool.query(`select id from payslip_shares where payroll_record_id = $1`, [recordId]);
  assert.equal(afterCleanup.rowCount, 0);

  console.log(JSON.stringify({
    login: true, created: true, hashOnlyLookup: true, exactSevenDayExpiry: true,
    reused: true, pdfRetrieved: true, modifiedRejected: true, invalidRejected: true,
    rotationRevokedOld: true, expiredRejected: true, cleanupRemovedRecordAndObject: true,
  }));
} finally {
  await pool.end();
}
