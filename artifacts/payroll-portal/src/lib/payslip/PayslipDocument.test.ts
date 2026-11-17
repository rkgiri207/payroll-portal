import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPayslipRows,
  employeeDeductionTotal,
  type PayslipRecord,
} from './PayslipDocument';

const record: PayslipRecord = {
  id: 1,
  employeeCode: 'TEST001',
  employeeName: 'Synthetic Employee',
  grossSalary: '20000.00',
  basic: '10000.00',
  da: '2000.00',
  hra: '4000.00',
  otherEarnings: '4000.00',
  netSalary: '16490.00',
  pfEmployee: '1200.00',
  pfEmployer: '1200.00',
  esiEmployee: '90.00',
  esiEmployer: '390.00',
  pt: '150.00',
};

test('places travel and employer contributions in the main payslip table', () => {
  const rows = buildPayslipRows(record);

  assert.equal(rows.earnings[0]?.label, 'Basic');
  assert.equal(rows.earnings[3]?.label, 'Travel Allowance');
  assert.deepEqual(rows.deductions.map(item => item.label), [
    'PF - Employee (12%)',
    'ESI - Employee (0.75%)',
    'PF - Employer (12%)',
    'ESI - Employer (3.25%)',
    'PT',
  ]);
  assert.equal(employeeDeductionTotal(record), '3030.00');
});
