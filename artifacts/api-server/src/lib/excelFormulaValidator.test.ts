import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import type { WorkSheet } from 'xlsx';
import { parseExcelBuffer } from './excelParser';
import { findFormulaDiscrepancies } from './excelFormulaValidator';

function sheet(cells: WorkSheet): WorkSheet {
  return { '!ref': 'A1:F2', ...cells };
}

test('accepts correct arithmetic and multiple references', () => {
  const findings = findFormulaDiscrepancies(sheet({
    A2: { t: 'n', v: 10 }, B2: { t: 'n', v: 20 }, C2: { t: 'n', v: 30 },
    D2: { t: 'n', f: 'A2+B2+C2', v: 60 },
  }));
  assert.deepEqual(findings, []);
});

test('reports a stale cached formula result', () => {
  const findings = findFormulaDiscrepancies(sheet({
    A2: { t: 'n', v: 10 }, B2: { t: 'n', v: 20 }, C2: { t: 'n', v: 30 },
    D2: { t: 'n', f: 'SUM(A2:C2)', v: 59 },
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].cell, 'D2');
  assert.equal(findings[0].expectedValue, 60);
});

test('evaluates dependencies using calculated rather than stale cached values', () => {
  const findings = findFormulaDiscrepancies(sheet({
    A2: { t: 'n', v: 100 }, B2: { t: 'n', v: 50 },
    D2: { t: 'n', f: 'A2+B2', v: 140 },
    E2: { t: 'n', f: 'D2*12%', v: 16.8 },
  }));
  assert.deepEqual(findings.map(finding => [finding.cell, finding.expectedValue]), [['D2', 150], ['E2', 18]]);
});

test('ignores currency-scale floating point differences', () => {
  const findings = findFormulaDiscrepancies(sheet({
    A2: { t: 'n', v: 10.001 }, B2: { t: 'n', v: 20.004 },
    D2: { t: 'n', f: 'A2+B2', v: 30.01 },
  }));
  assert.deepEqual(findings, []);
});

test('does not inspect hardcoded inputs', () => {
  const findings = findFormulaDiscrepancies(sheet({ A2: { t: 'n', v: 999 } }));
  assert.deepEqual(findings, []);
});

test('skips unsupported functions instead of reporting false discrepancies', () => {
  const findings = findFormulaDiscrepancies(sheet({
    A2: { t: 'n', v: 10 },
    D2: { t: 'n', f: 'MEDIAN(A2:C2)', v: 999 },
  }));
  assert.deepEqual(findings, []);
});

function serializedPayrollWorkbook(totalValue: number, doubledValue: number): Buffer {
  const worksheet: WorkSheet = {
    A1: { t: 's', v: 'Employee ID' },
    B1: { t: 's', v: 'Employee Name' },
    C1: { t: 's', v: 'Value 1' },
    D1: { t: 's', v: 'Value 2' },
    E1: { t: 's', v: 'Total' },
    F1: { t: 's', v: 'Doubled' },
    A2: { t: 's', v: 'TEST123' },
    B2: { t: 's', v: 'Synthetic Employee' },
    C2: { t: 'n', v: 100 },
    D2: { t: 'n', v: 200 },
    E2: { t: 'n', f: 'C2+D2', v: totalValue },
    F2: { t: 'n', f: 'E2*2', v: doubledValue },
    '!ref': 'A1:F2',
  };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Payroll');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('serialized workbook retains stale cached values through the production parser', () => {
  const parsed = parseExcelBuffer(serializedPayrollWorkbook(250, 500), 'Payroll');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rowNumbers[0], 2);
  assert.deepEqual(
    parsed.formulaDiscrepancies.map(finding => ({
      cell: finding.cell,
      excelValue: finding.excelValue,
      expectedValue: finding.expectedValue,
      rowIndex: finding.rowIndex,
    })),
    [
      { cell: 'E2', excelValue: 250, expectedValue: 300, rowIndex: 2 },
      { cell: 'F2', excelValue: 500, expectedValue: 600, rowIndex: 2 },
    ],
  );
});

test('serialized workbook with correct cached results produces no findings', () => {
  const parsed = parseExcelBuffer(serializedPayrollWorkbook(300, 600), 'Payroll');
  assert.deepEqual(parsed.formulaDiscrepancies, []);
});
