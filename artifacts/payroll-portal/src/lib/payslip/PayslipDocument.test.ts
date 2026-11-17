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
  netSalary: '16490.00',
  pfEmployee: '1200.00',
  pfEmployer: '1200.00',
  esiEmployee: '90.00',
  esiEmployer: '390.00',
  pt: '150.00',
};

test('separates employer contributions from employee deductions', () => {
  const rows = buildPayslipRows(record);

  assert.deepEqual(rows.deductions.map(item => item.label), [
    'PF - Employee (12%)',
    'ESI - Employee (0.75%)',
    'PT',
  ]);
  assert.deepEqual(rows.employerContributions.map(item => item.label), [
    'PF - Employer (12%)',
    'ESI - Employer (3.25%)',
  ]);
  assert.equal(employeeDeductionTotal(record), '1440.00');
});
