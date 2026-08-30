import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkSheet } from 'xlsx';
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
