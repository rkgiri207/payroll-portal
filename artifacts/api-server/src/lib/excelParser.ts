/**
 * Excel parsing utilities using SheetJS (xlsx)
 */
import * as XLSX from 'xlsx';
import { findFormulaDiscrepancies, type FormulaDiscrepancy } from './excelFormulaValidator';

export interface ParsedSheet {
  sheets: string[];
  selectedSheet: string;
  headers: string[];
  rowCount: number;
  rows: Record<string, unknown>[];
  rowNumbers: number[];
  formulaDiscrepancies: FormulaDiscrepancy[];
}

/**
 * Parse an Excel buffer and return sheet names + data for the selected sheet.
 */
export function parseExcelBuffer(
  buffer: Buffer,
  sheetName?: string,
): ParsedSheet {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheets = workbook.SheetNames;

  if (sheets.length === 0) {
    throw new Error('Excel file contains no worksheets');
  }

  const selectedSheet = sheetName && sheets.includes(sheetName)
    ? sheetName
    : sheets[0];

  const worksheet = workbook.Sheets[selectedSheet];
  if (!worksheet) {
    throw new Error(`Worksheet "${selectedSheet}" not found`);
  }

  // Get the range to find real headers
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');

  // Read headers from first row
  const headers: string[] = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    const value = cell ? String(cell.v ?? '').trim() : '';
    if (value) {
      headers.push(value);
    }
  }

  // Read all data rows as objects
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    raw: false,       // Convert all values to strings
    defval: '',       // Default value for empty cells
    blankrows: false, // Skip completely empty rows
  });
  const rowNumbers = rows.map((row, index) => {
    const sourceRow = (row as Record<string, unknown> & { __rowNum__?: number }).__rowNum__;
    return typeof sourceRow === 'number' ? sourceRow + 1 : index + 2;
  });

  return {
    sheets,
    selectedSheet,
    headers,
    rowCount: rows.length,
    rows,
    rowNumbers,
    formulaDiscrepancies: findFormulaDiscrepancies(worksheet),
  };
}

/**
 * Normalize a salary string to a decimal string suitable for database storage.
 * Handles: "25000", "25,000", "25000.00", "₹25,000.50", " 25 000 "
 * Returns null if the value cannot be parsed.
 */
export function normalizeSalaryValue(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  const str = String(raw)
    .replace(/[₹$€£¥,\s]/g, '') // Remove currency symbols, commas, spaces
    .trim();

  if (str === '' || str === '-') return null;

  const num = parseFloat(str);
  if (isNaN(num)) return null;

  // Return as decimal string with 2 decimal places — no float arithmetic
  return num.toFixed(2);
}

/**
 * Add two decimal strings safely using integer arithmetic.
 */
export function addDecimals(a: string | null, b: string | null): string {
  const av = Math.round(parseFloat(a ?? '0') * 100);
  const bv = Math.round(parseFloat(b ?? '0') * 100);
  return ((av + bv) / 100).toFixed(2);
}
