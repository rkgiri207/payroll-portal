import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const email = process.env.DEV_ADMIN_EMAIL;
const password = process.env.DEV_ADMIN_PASSWORD;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const allowedDevEmails = new Set([
  'dev.admin@payroll-portal.invalid',
  'admin@staschools.in',
]);
if (!email || !allowedDevEmails.has(email.toLowerCase())) {
  throw new Error('DEV_ADMIN_EMAIL is not an approved DEV administrator account');
}
if (!password || password.length < 10) {
  throw new Error('DEV_ADMIN_PASSWORD must contain at least 10 characters');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const passwordHash = await bcrypt.hash(password, 12);
try {
  const result = await pool.query(
    `insert into users (name, email, password_hash, role, is_active)
     values ('Payroll Portal DEV Administrator', $1, $2, 'ADMIN', true)
     on conflict (email) do update set
       name = excluded.name,
       password_hash = excluded.password_hash,
       role = 'ADMIN',
       is_active = true,
       updated_at = now()
     returning id, email, role, is_active, password_hash`,
    [email.toLowerCase(), passwordHash],
  );
  const admin = result.rows[0];
  assert.equal(admin.email, email.toLowerCase());
  assert.equal(admin.role, 'ADMIN');
  assert.equal(admin.is_active, true);
  assert.equal(await bcrypt.compare(password, admin.password_hash), true);

  const server = spawn(process.execPath, ['artifacts/api-server/dist/index.mjs'], {
    env: {
      ...process.env,
      PORT: '5057',
      APP_BASE_URL: 'http://127.0.0.1:5057',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  server.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:5057/api/healthz');
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(healthy, true, 'API did not become healthy');

    const login = await fetch('http://127.0.0.1:5057/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200, `DEV administrator login failed (${login.status})`);
    const body = await login.json();
    assert.equal(body.email, email.toLowerCase());
    assert.equal(body.role, 'ADMIN');
  } catch (error) {
    if (diagnostics) {
      console.error(diagnostics.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[DATABASE_URL REDACTED]'));
    }
    throw error;
  } finally {
    server.kill();
  }

  console.log(JSON.stringify({ rotated: true, hashVerified: true, loginVerified: true }));
} finally {
  await pool.end();
}
