import { addDecimals } from './excelParser';

export type EmployeeDeductionAmounts = {
  pfEmployee?: string | null;
  pfEmployer?: string | null;
  esiEmployee?: string | null;
  esiEmployer?: string | null;
  pt?: string | null;
  lop?: string | null;
  otherDeductions?: string | null;
};

/**
 * Employer PF and ESI are employer costs, not deductions from an employee's
 * pay. Keep them out of all employee-deduction totals.
 */
export function sumEmployeeDeductions(amounts: EmployeeDeductionAmounts): string {
  return [
    amounts.pfEmployee,
    amounts.esiEmployee,
    amounts.pt,
    amounts.lop,
    amounts.otherDeductions,
  ].reduce<string>((total, amount) => addDecimals(total, amount ?? null), '0.00');
}

export function employeeDeductionMismatchWarning(
  reportedTotal: string | null,
  calculatedTotal: string,
): string | null {
  if (reportedTotal === null || reportedTotal === calculatedTotal) return null;

  return `Excel total deductions (${reportedTotal}) do not match mapped employee deductions (${calculatedTotal}). Employer PF/ESI are excluded from employee deductions.`;
}
