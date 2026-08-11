import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import * as XLSX from 'xlsx';

const baseUrl = 'http://127.0.0.1:5056/api';
const email = 'dev.admin@payroll-portal.invalid';
const password = `Dev-${crypto.randomUUID()}-A9!`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const passwordHash = await bcrypt.hash(password, 10);
await pool.query(
  `insert into users (name, email, password_hash, role, is_active)
   values ('Synthetic DEV Admin', $1, $2, 'ADMIN', true)
   on conflict (email) do update set password_hash = excluded.password_hash,
     name = excluded.name, is_active = true`,
  [email, passwordHash],
);

const server = spawn(process.execPath, ['artifacts/api-server/dist/index.mjs'], {
  env: {
    ...process.env,
    PORT: '5056',
    APP_BASE_URL: 'http://127.0.0.1:5056',
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverDiagnostics = '';
server.stderr.on('data', (chunk) => { serverDiagnostics += chunk.toString(); });

let cookie = '';
async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('Cookie', cookie);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = response.headers.get('content-type')?.includes('json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return { response, body };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await api('/healthz');
      if (result.body.status === 'ok') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('API did not become healthy');
}

try {
  await waitForHealth();
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  cookie = (login.response.headers.getSetCookie?.()[0] ?? login.response.headers.get('set-cookie'))?.split(';')[0] ?? '';
  assert.ok(cookie, 'Login did not return a session cookie');
  assert.equal(login.body.email, email);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const currentUser = await api('/auth/me');
  assert.equal(currentUser.body.email, email);

  const settings = await api('/company-settings', {
    method: 'PATCH',
    body: JSON.stringify({
      companyName: 'Payroll Portal DEV Test Company',
      address: 'Synthetic DEV Address',
      email: 'company@payroll-portal.invalid',
    }),
  });
  assert.equal(settings.body.companyName, 'Payroll Portal DEV Test Company');

  const logo = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const logoRequest = await api('/storage/uploads/request-url', {
    method: 'POST',
    body: JSON.stringify({ name: 'dev-test-logo.png', size: logo.length, contentType: 'image/png' }),
  });
  assert.match(logoRequest.body.objectPath, /^\/objects\/company-assets\//);
  const logoUpload = await fetch(logoRequest.body.uploadURL, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: logo,
  });
  assert.equal(logoUpload.ok, true, `Logo upload failed (${logoUpload.status})`);
  await api('/company-settings', {
    method: 'PATCH',
    body: JSON.stringify({ logoPath: logoRequest.body.objectPath }),
  });
  const logoRead = await api(logoRequest.body.objectPath.replace('/objects/', '/storage/objects/'));
  assert.ok(logoRead.body.length > 0, 'Stored logo was empty');
  const payslipLogo = await api('/company-settings/logo');
  assert.ok(payslipLogo.body.length > 0, 'Payslip logo proxy was empty');

  const rows = [
    { 'Employee ID': 'TEST001', 'Employee Name': 'Test Employee One', Mobile: '9876543210', Basic: 30000, HRA: 10000, Gross: 40000, PF: 3600, LOP: 500, Net: 35900 },
    { 'Employee ID': 'TEST002', 'Employee Name': 'Test Employee Two', Mobile: '12345', Basic: 25000, HRA: 8000, Gross: 33000, PF: 3000, LOP: 0, Net: 30000 },
    { 'Employee ID': 'TEST003', 'Employee Name': 'Test Employee Three', Mobile: '', Basic: 20000, HRA: 7000, Gross: 27000, PF: 2400, LOP: 250, Net: 24350 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Payroll');
  const excel = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const excelType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const uploadRequest = await api('/payroll/request-upload-url', {
    method: 'POST',
    body: JSON.stringify({ name: 'synthetic-dev-payroll.xlsx', size: excel.length, contentType: excelType }),
  });
  assert.match(uploadRequest.body.objectPath, /^\/objects\/payroll-files\//);
  const excelUpload = await fetch(uploadRequest.body.uploadURL, {
    method: 'PUT',
    headers: { 'Content-Type': excelType },
    body: excel,
  });
  assert.equal(excelUpload.ok, true, `Payroll upload failed (${excelUpload.status})`);

  const parsed = await api('/payroll/parse-excel', {
    method: 'POST',
    body: JSON.stringify({ objectPath: uploadRequest.body.objectPath }),
  });
  assert.equal(parsed.body.rowCount, 3);
  const mapping = {
    employeeId: 'Employee ID', employeeName: 'Employee Name', mobile: 'Mobile',
    basic: 'Basic', hra: 'HRA', grossSalary: 'Gross', pfEmployee: 'PF', lop: 'LOP', netSalary: 'Net',
  };
  const validation = await api('/payroll/validate', {
    method: 'POST',
    body: JSON.stringify({ objectPath: uploadRequest.body.objectPath, sheetName: 'Payroll', columnMapping: mapping, payrollMonth: 8, payrollYear: 2100 }),
  });
  assert.equal(validation.body.summary.total, 3);
  assert.equal(validation.body.summary.validMobileCount, 1);
  assert.equal(validation.body.summary.invalidMobileCount, 1);
  assert.equal(validation.body.summary.missingMobileCount, 1);
  assert.equal(validation.body.summary.withErrors, 0);
  assert.equal(validation.body.summary.totalDeductions, '9750.00');

  const imported = await api('/payroll/import', {
    method: 'POST',
    body: JSON.stringify({ objectPath: uploadRequest.body.objectPath, fileName: 'synthetic-dev-payroll.xlsx', sheetName: 'Payroll', columnMapping: mapping, payrollMonth: 8, payrollYear: 2100, confirmedWithWarnings: true }),
  });
  assert.equal(imported.body.employeeCount, 3);
  const history = await api('/payroll-runs?limit=100');
  const run = history.body.runs.find((item) => item.id === imported.body.payrollRunId);
  assert.ok(run, 'Imported payroll run missing from history');
  assert.match(run.fileStoragePath, /^\/objects\/payroll-files\//);
  const detail = await api(`/payroll-runs/${run.id}`);
  assert.equal(detail.body.records.length, 3);
  assert.equal(detail.body.records.find((record) => record.employeeCode === 'TEST001').lop, '500.00');

  console.log(JSON.stringify({
    health: true,
    database: true,
    login: true,
    companySettings: true,
    logoStorage: true,
    payrollStorage: true,
    mobileValidation: true,
    payrollImport: true,
    payrollHistory: true,
    payrollRunId: run.id,
  }));
} catch (error) {
  if (serverDiagnostics) {
    console.error(serverDiagnostics.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[DATABASE_URL REDACTED]'));
  }
  throw error;
} finally {
  server.kill();
  await pool.end();
}
