export type PayrollMappingField = {
  key: string;
  label: string;
};

const normalizeHeader = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

// These aliases cover common payroll-workbook abbreviations while keeping the
// mapping explicit enough that employee and employer contributions cannot be
// confused with one another.
const HEADER_ALIASES: Record<string, readonly string[]> = {
  pfEmployee: [
    'employeepf',
    'employeeepf',
    'pfemployee',
    'pfemployee12',
    'employeepf12',
    'employeeprovidentfund',
  ],
  pfEmployer: [
    'employerpf',
    'employerepf',
    'pfemployer',
    'employerprovidentfund',
  ],
  esiEmployee: [
    'employeeesi',
    'esiemployee',
    'esiemployee075',
    'employeeesi075',
  ],
  esiEmployer: [
    'employeresi',
    'esiemployer',
    'esiemployer325',
    'employeresi325',
  ],
  totalDeductions: [
    'deduction',
    'deductions',
    'totaldeduction',
    'totaldeductions',
  ],
};

export function suggestPayrollColumnMapping(
  headers: string[],
  fields: readonly PayrollMappingField[],
  savedMapping?: object | null,
): Record<string, string> {
  const mapping = Object.fromEntries(
    Object.entries(savedMapping ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

  for (const field of fields) {
    if (mapping[field.key]) continue;

    const exactLabel = normalizeHeader(field.label);
    const aliases = new Set([exactLabel, ...(HEADER_ALIASES[field.key] ?? [])]);
    const match = headers.find((header) => aliases.has(normalizeHeader(header)));

    if (match) mapping[field.key] = match;
  }

  return mapping;
}
