import assert from 'node:assert/strict';
import test from 'node:test';
import { employeeDeductionMismatchWarning, sumEmployeeDeductions } from './payrollDeductions';

test('includes employer PF and ESI in workbook deduction totals', () => {
  const total = sumEmployeeDeductions({
    pfEmployee: '1800.00',
    pfEmployer: '1800.00',
    esiEmployee: '150.00',
    esiEmployer: '650.00',
    pt: '200.00',
    lop: '50.00',
    otherDeductions: '25.00',
  });

  assert.equal(total, '4675.00');
});

test('treats missing employee deductions as zero', () => {
  assert.equal(sumEmployeeDeductions({}), '0.00');
});

test('warns when the mapped Excel deduction total differs from employee deductions', () => {
  assert.match(
    employeeDeductionMismatchWarning('540.00', '150.00') ?? '',
    /do not match mapped deductions/,
  );
  assert.equal(employeeDeductionMismatchWarning('150.00', '150.00'), null);
  assert.equal(employeeDeductionMismatchWarning(null, '150.00'), null);
});
