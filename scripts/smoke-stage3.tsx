import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { renderToBuffer } from '../artifacts/payroll-portal/node_modules/@react-pdf/renderer/lib/react-pdf.js';
import JSZip from 'jszip';
import pg from 'pg';
import React from 'react';

const fontRoot = path.resolve('artifacts/payroll-portal/public');
const fontServer = createServer(async (request, response) => {
  const relativePath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
  const filePath = path.resolve(fontRoot, relativePath);
  if (!filePath.startsWith(fontRoot) || !(await stat(filePath).catch(() => null))) {
    response.writeHead(404).end();
    return;
  }
  createReadStream(filePath).pipe(response);
});
await new Promise<void>((resolve) => fontServer.listen(5080, '127.0.0.1', resolve));

Object.assign(globalThis, {
  React,
  window: { location: { origin: 'http://127.0.0.1:5080' } },
});
const { PayslipDocument } = await import('../artifacts/payroll-portal/src/lib/payslip/PayslipDocument');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const runResult = await pool.query(
    `select * from payroll_runs where payroll_month = 8 and payroll_year = 2100
     order by id desc limit 1`,
  );
  assert.equal(runResult.rowCount, 1, 'Synthetic payroll run was not found');
  const runRow = runResult.rows[0];
  const recordsResult = await pool.query(
    'select * from payroll_records where payroll_run_id = $1 order by employee_code',
    [runRow.id],
  );
  assert.deepEqual(recordsResult.rows.map((row) => row.employee_code), ['TEST001', 'TEST002', 'TEST003']);
  const companyResult = await pool.query('select * from company_settings order by id limit 1');
  assert.equal(companyResult.rowCount, 1);
  const companyRow = companyResult.rows[0];

  let logoDataUrl: string | null = null;
  if (companyRow.logo_path) {
    const parts = companyRow.logo_path.replace(/^\/objects\//, '').split('/');
    const bucket = parts.shift();
    const objectPath = parts.map(encodeURIComponent).join('/');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const logoResponse = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    assert.equal(logoResponse.ok, true, 'Private company logo could not be loaded');
    const logo = Buffer.from(await logoResponse.arrayBuffer());
    logoDataUrl = `data:${logoResponse.headers.get('content-type') ?? 'image/png'};base64,${logo.toString('base64')}`;
  }

  const company = {
    companyName: companyRow.company_name,
    address: companyRow.address,
    phone: companyRow.phone,
    email: companyRow.email,
    website: companyRow.website,
    logoDataUrl,
  };
  const run = { payrollMonth: runRow.payroll_month, payrollYear: runRow.payroll_year };
  const records = recordsResult.rows.map((row) => ({
    id: row.id,
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    mobileNumber: row.mobile_number,
    email: row.email,
    designation: row.designation,
    branch: row.branch,
    joiningDate: row.joining_date,
    basic: row.basic,
    da: row.da,
    hra: row.hra,
    otherEarnings: row.other_earnings,
    grossSalary: row.gross_salary,
    pfEmployee: row.pf_employee,
    pfEmployer: row.pf_employer,
    esiEmployee: row.esi_employee,
    esiEmployer: row.esi_employer,
    pt: row.pt,
    lop: row.lop,
    otherDeductions: row.other_deductions,
    netSalary: row.net_salary,
    additionalComponents: row.additional_components,
  }));

  const generated = new Map<string, Buffer>();
  for (const record of records) {
    const pdf = await renderToBuffer(
      <PayslipDocument record={record} run={run} company={company} />,
    );
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.ok(pdf.length > 1_000, `PDF for ${record.employeeCode} is unexpectedly small`);
    generated.set(`${record.employeeCode}.pdf`, pdf);
  }

  const regenerated = await renderToBuffer(
    <PayslipDocument record={records[0]} run={run} company={company} />,
  );
  assert.equal(regenerated.subarray(0, 4).toString(), '%PDF');

  const zip = new JSZip();
  for (const [name, pdf] of generated) zip.file(name, pdf);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  assert.equal(zipBuffer.subarray(0, 2).toString(), 'PK');
  const loadedZip = await JSZip.loadAsync(zipBuffer);
  assert.deepEqual(Object.keys(loadedZip.files).sort(), ['TEST001.pdf', 'TEST002.pdf', 'TEST003.pdf']);

  console.log(JSON.stringify({
    individualPdf: true,
    pdfDownloadArtifact: true,
    regeneration: true,
    bulkGenerationCount: generated.size,
    zipGeneration: true,
    companyLogoIncluded: Boolean(logoDataUrl),
  }));
} finally {
  await pool.end();
  fontServer.close();
}
