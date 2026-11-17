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
 * The workbook includes employer PF and ESI in total deductions and subtracts
 * them from net pay, so they are included here.
 */
export function sumEmployeeDeductions(amounts: EmployeeDeductionAmounts): string {
  return [
    amounts.pfEmployee,
    amounts.esiEmployee,
    amounts.pfEmployer,
    amounts.esiEmployer,
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

  return `Excel total deductions (${reportedTotal}) do not match mapped deductions (${calculatedTotal}).`;
}
