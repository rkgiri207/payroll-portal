import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestPayrollColumnMapping } from './payrollColumnMapping';

const fields = [
  { key: 'pfEmployee', label: 'PF — Employee Contribution (12%)' },
  { key: 'pfEmployer', label: 'PF — Employer Contribution' },
  { key: 'esiEmployee', label: 'ESI — Employee Contribution (0.75%)' },
  { key: 'esiEmployer', label: 'ESI — Employer Contribution (3.25%)' },
];

test('maps common PF and ESI workbook aliases to the correct contribution fields', () => {
  const mapping = suggestPayrollColumnMapping(
    ['EmployeePF', 'Employer PF', 'Employee ESI', 'EmployerESI'],
    fields,
  );

  assert.deepEqual(mapping, {
    pfEmployee: 'EmployeePF',
    pfEmployer: 'Employer PF',
    esiEmployee: 'Employee ESI',
    esiEmployer: 'EmployerESI',
  });
});

test('keeps an existing saved mapping and still maps remaining fields', () => {
  const mapping = suggestPayrollColumnMapping(
    ['PF Employee (12%)', 'EmployerPF', 'EmployeeESI', 'ESI Employer (3.25%)'],
    fields,
    { pfEmployee: 'Saved PF column' },
  );

  assert.deepEqual(mapping, {
    pfEmployee: 'Saved PF column',
    pfEmployer: 'EmployerPF',
    esiEmployee: 'EmployeeESI',
    esiEmployer: 'ESI Employer (3.25%)',
  });
});

test('maps a deductions header for validation only', () => {
  const mapping = suggestPayrollColumnMapping(
    ['Deductions'],
    [{ key: 'totalDeductions', label: 'Excel Total Deductions (Validation Only)' }],
  );

  assert.deepEqual(mapping, { totalDeductions: 'Deductions' });
});
