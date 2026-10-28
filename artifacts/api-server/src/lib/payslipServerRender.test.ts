import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import {
  PayslipDocument,
  registerPayslipFonts,
} from '../../../payroll-portal/src/lib/payslip/PayslipDocument';
import { summarizePdf } from './pdfDiagnostics';

const here = path.dirname(fileURLToPath(import.meta.url));
const fontDirectory = path.resolve(here, '../../../payroll-portal/public/fonts');

test('server renderer produces a populated payslip PDF', async () => {
  const regular = path.join(fontDirectory, 'NotoSans-Regular.ttf');
  const bold = path.join(fontDirectory, 'NotoSans-Bold.ttf');
  assert.ok(existsSync(regular), `Missing test font: ${regular}`);
  assert.ok(existsSync(bold), `Missing test font: ${bold}`);
  assert.ok(readFileSync(regular).length > 100_000);
  assert.ok(readFileSync(bold).length > 100_000);
  registerPayslipFonts(regular, bold);

  const pdf = await renderToBuffer(React.createElement(PayslipDocument, {
    record: {
      id: 1, employeeCode: 'TEST001', employeeName: 'Synthetic Employee', designation: 'Test Analyst',
      basic: '20000.00', hra: '5000.00', grossSalary: '25000.00', pfEmployee: '1800.00',
      netSalary: '23200.00', additionalComponents: { incentive: '500.00' },
    },
    run: { payrollMonth: 8, payrollYear: 2100 },
    company: { companyName: 'Synthetic Payroll Company', address: 'Test address' },
  }) as React.ReactElement<any>);

  const summary = summarizePdf(pdf);
  assert.equal(summary.validPdfHeader, true);
  assert.ok(summary.pageObjectCount >= 1);
  assert.ok(summary.fontResourceCount >= 1);
  assert.ok(summary.pageContentStreamCount >= 1);
  assert.ok(summary.decodedContentBytes > 0);
  assert.ok(summary.textShowOperatorCount > 0);
  assert.equal(summary.parseError, null);
});
