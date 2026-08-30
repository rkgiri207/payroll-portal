import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('infers a formula pattern for an incorrect hardcoded result in the same column', () => {
  const findings = findFormulaDiscrepancies({
    A2: { t: 'n', v: 100 }, B2: { t: 'n', v: 200 }, C2: { t: 'n', f: 'A2+B2', v: 300 },
    A3: { t: 'n', v: 150 }, B3: { t: 'n', v: 250 }, C3: { t: 'n', v: 350 },
    '!ref': 'A1:C3',
  });
  assert.deepEqual(findings.map(finding => ({
    cell: finding.cell,
    excelValue: finding.excelValue,
    expectedValue: finding.expectedValue,
    source: finding.source,
  })), [{ cell: 'C3', excelValue: 350, expectedValue: 400, source: 'formula-pattern' }]);
});

test('does not warn for a correct hardcoded result matching an inferred formula pattern', () => {
  const findings = findFormulaDiscrepancies({
    A2: { t: 'n', v: 100 }, B2: { t: 'n', v: 200 }, C2: { t: 'n', f: 'A2+B2', v: 300 },
    A3: { t: 'n', v: 150 }, B3: { t: 'n', v: 250 }, C3: { t: 'n', v: 400 },
    '!ref': 'A1:C3',
  });
  assert.deepEqual(findings, []);
});

test('translates absolute and relative references for multiple hardcoded employee rows', () => {
  const findings = findFormulaDiscrepancies({
    A2: { t: 'n', v: 100 }, B2: { t: 'n', v: 10 }, D1: { t: 'n', v: 2 }, C2: { t: 'n', f: '(A2+B2)*$D$1', v: 220 },
    A3: { t: 'n', v: 200 }, B3: { t: 'n', v: 20 }, C3: { t: 'n', v: 400 },
    A4: { t: 'n', v: 300 }, B4: { t: 'n', v: 30 }, C4: { t: 'n', v: 600 },
    '!ref': 'A1:D4',
  });
  assert.deepEqual(findings.map(finding => [finding.cell, finding.expectedValue]), [['C3', 440], ['C4', 660]]);
});

test('skips all-hardcoded result columns without workbook-defined calculation evidence', () => {
  const findings = findFormulaDiscrepancies({
    A1: { t: 's', v: 'Input A' }, B1: { t: 's', v: 'Input B' }, C1: { t: 's', v: 'Result' },
    A2: { t: 'n', v: 100 }, B2: { t: 'n', v: 200 }, C2: { t: 'n', v: 999 },
    A3: { t: 'n', v: 300 }, B3: { t: 'n', v: 400 }, C3: { t: 'n', v: 123 },
    '!ref': 'A1:C3',
  });
  assert.deepEqual(findings, []);
});

test('skips hardcoded cells when formula rows use conflicting patterns', () => {
  const findings = findFormulaDiscrepancies({
    A2: { t: 'n', v: 10 }, B2: { t: 'n', v: 20 }, C2: { t: 'n', f: 'A2+B2', v: 30 },
    A3: { t: 'n', v: 30 }, B3: { t: 'n', v: 10 }, C3: { t: 'n', f: 'A3-B3', v: 20 },
    A4: { t: 'n', v: 50 }, B4: { t: 'n', v: 60 }, C4: { t: 'n', v: 999 },
    '!ref': 'A1:C4',
  });
  assert.deepEqual(findings, []);
});

test('does not duplicate formula-cell discrepancies while inferring hardcoded rows', () => {
  const findings = findFormulaDiscrepancies({
    A2: { t: 'n', v: 10 }, B2: { t: 'n', v: 20 }, C2: { t: 'n', f: 'A2+B2', v: 29 },
    A3: { t: 'n', v: 30 }, B3: { t: 'n', v: 40 }, C3: { t: 'n', v: 69 },
    '!ref': 'A1:C3',
  });
  assert.deepEqual(findings.map(finding => finding.cell), ['C2', 'C3']);
});

test('all-hardcoded external fixture is skipped when it contains no calculation definition', {
  skip: !process.env.TEST_PAYSLIP_FIXTURE,
}, () => {
  const parsed = parseExcelBuffer(readFileSync(process.env.TEST_PAYSLIP_FIXTURE!), 'Sheet1');
  assert.deepEqual(parsed.formulaDiscrepancies, []);
});
