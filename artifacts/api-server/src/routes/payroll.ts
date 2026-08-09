/**
 * Payroll upload workflow routes:
 *   POST /payroll/request-upload-url   — presigned URL for Excel upload
 *   POST /payroll/parse-excel          — parse Excel, return sheets + headers
 *   POST /payroll/validate             — validate rows against employee master
 *   POST /payroll/import               — create payroll run + records
 *   GET  /payroll/column-mapping       — get saved column mapping
 *   PUT  /payroll/column-mapping       — save column mapping
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { db } from '@workspace/db';
import { employeesTable, payrollRunsTable, payrollRecordsTable, payrollColumnMappingsTable } from '@workspace/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../middlewares/requireAuth';
import { createAuditLog } from '../lib/audit';
import { ObjectStorageService } from '../lib/objectStorage';
import { parseExcelBuffer, normalizeSalaryValue, addDecimals } from '../lib/excelParser';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ─────────────────────────────────────────────────────────────────────────────
// POST /payroll/request-upload-url
// ─────────────────────────────────────────────────────────────────────────────
router.post('/payroll/request-upload-url', requireAuth, async (req: Request, res: Response) => {
  const { name, size, contentType } = req.body;

  if (!name || !size || !contentType) {
    res.status(400).json({ error: 'name, size, and contentType are required' });
    return;
  }

  const allowedTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel',                                           // .xls
    'application/octet-stream',                                           // Some browsers send this
  ];

  if (!allowedTypes.includes(contentType)) {
    res.status(400).json({ error: 'Only Excel files (.xlsx, .xls) are allowed' });
    return;
  }

  if (size > 20 * 1024 * 1024) {
    res.status(400).json({ error: 'File size must not exceed 20MB' });
    return;
  }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
  } catch (err) {
    req.log.error({ err }, 'Error generating payroll upload URL');
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /payroll/parse-excel
// ─────────────────────────────────────────────────────────────────────────────
router.post('/payroll/parse-excel', requireAuth, async (req: Request, res: Response) => {
  const { objectPath, sheetName } = req.body;

  if (!objectPath) {
    res.status(400).json({ error: 'objectPath is required' });
    return;
  }

  try {
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const [buffer] = await file.download();

    const parsed = parseExcelBuffer(buffer, sheetName);

    res.json({
      sheets: parsed.sheets,
      selectedSheet: parsed.selectedSheet,
      headers: parsed.headers,
      rowCount: parsed.rowCount,
    });
  } catch (err: any) {
    req.log.error({ err }, 'Error parsing Excel file');
    res.status(400).json({ error: err?.message ?? 'Failed to parse Excel file' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /payroll/validate
// ─────────────────────────────────────────────────────────────────────────────
router.post('/payroll/validate', requireAuth, async (req: Request, res: Response) => {
  const { objectPath, sheetName, columnMapping, payrollMonth, payrollYear } = req.body;

  if (!objectPath || !sheetName || !columnMapping || !payrollMonth || !payrollYear) {
    res.status(400).json({ error: 'objectPath, sheetName, columnMapping, payrollMonth, payrollYear are required' });
    return;
  }

  const month = parseInt(String(payrollMonth), 10);
  const year = parseInt(String(payrollYear), 10);
  if (isNaN(month) || month < 1 || month > 12 || isNaN(year)) {
    res.status(400).json({ error: 'Invalid payroll month or year' });
    return;
  }

  try {
    // Download + parse Excel
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const [buffer] = await file.download();
    const parsed = parseExcelBuffer(buffer, sheetName);

    // Build a set of all mapped Excel column names to detect unmapped
    const mappedColumns = new Set(Object.values(columnMapping).filter(Boolean));
    const unmappedColumns = parsed.headers.filter(h => !mappedColumns.has(h));

    // Load all active employee codes from master
    const employees = await db.select({
      id: employeesTable.id,
      employeeCode: employeesTable.employeeCode,
      employeeName: employeesTable.employeeName,
      mobileNumber: employeesTable.mobileNumber,
      email: employeesTable.email,
      status: employeesTable.status,
    }).from(employeesTable);

    const employeeByCode = new Map(employees.map(e => [e.employeeCode.toUpperCase(), e]));

    // Check for existing payroll run for this month/year
    const [existingRun] = await db
      .select({ id: payrollRunsTable.id, status: payrollRunsTable.status })
      .from(payrollRunsTable)
      .where(
        and(
          eq(payrollRunsTable.payrollMonth, month),
          eq(payrollRunsTable.payrollYear, year),
        ),
      )
      .limit(1);

    const existingRunWarning = existingRun
      ? `A payroll run for ${MONTH_NAMES[month - 1]} ${year} already exists (status: ${existingRun.status}).`
      : null;

    // Validate rows
    const seenCodes = new Set<string>();
    const duplicateIds: string[] = [];
    let totalGross = '0.00';
    let totalDeductions = '0.00';
    let totalNet = '0.00';
    let withWarnings = 0;
    let withErrors = 0;
    let validCount = 0;

    const rows = parsed.rows.map((row, idx) => {
      const rowIndex = idx + 2; // Excel row number (1-based header + 1)
      const errors: string[] = [];
      const warnings: string[] = [];

      // Get mapped values
      const employeeCode = columnMapping.employeeId
        ? String(row[columnMapping.employeeId] ?? '').trim()
        : '';
      const employeeName = columnMapping.employeeName
        ? String(row[columnMapping.employeeName] ?? '').trim()
        : '';
      const grossRaw = columnMapping.grossSalary ? row[columnMapping.grossSalary] : undefined;
      const netRaw = columnMapping.netSalary ? row[columnMapping.netSalary] : undefined;

      // Required: Employee ID
      if (!employeeCode) {
        errors.push('Missing Employee ID');
      } else {
        // Duplicate within file
        const codeUpper = employeeCode.toUpperCase();
        if (seenCodes.has(codeUpper)) {
          errors.push(`Duplicate Employee ID "${employeeCode}" in this file`);
          if (!duplicateIds.includes(employeeCode)) {
            duplicateIds.push(employeeCode);
          }
        } else {
          seenCodes.add(codeUpper);
        }
      }

      // Required: Employee Name
      if (!employeeName) {
        errors.push('Missing Employee Name');
      }

      // Employee must exist in master
      let employeeDbId: number | null = null;
      if (employeeCode) {
        const matched = employeeByCode.get(employeeCode.toUpperCase());
        if (!matched) {
          errors.push(`Employee ID "${employeeCode}" not found in Employee Master`);
        } else {
          employeeDbId = matched.id;
          // Warnings for missing contact info
          if (!matched.mobileNumber) {
            warnings.push(`Employee "${employeeCode}" has no mobile number (required for WhatsApp delivery)`);
          }
          if (!matched.email) {
            warnings.push(`Employee "${employeeCode}" has no email address`);
          }
          // Warn if inactive
          if (matched.status === 'INACTIVE') {
            warnings.push(`Employee "${employeeCode}" is marked as Inactive`);
          }
        }
      }

      // Validate numeric salary values
      const grossSalary = normalizeSalaryValue(grossRaw);
      const netSalary = normalizeSalaryValue(netRaw);

      if (grossRaw !== undefined && grossRaw !== '' && grossSalary === null) {
        errors.push(`Invalid gross salary value: "${grossRaw}"`);
      }
      if (netRaw !== undefined && netRaw !== '' && netSalary === null) {
        errors.push(`Invalid net salary value: "${netRaw}"`);
      }

      // Compute deductions for display
      const pfRaw = columnMapping.pf ? row[columnMapping.pf] : undefined;
      const esiRaw = columnMapping.esi ? row[columnMapping.esi] : undefined;
      const tdsRaw = columnMapping.tds ? row[columnMapping.tds] : undefined;
      const otherDedRaw = columnMapping.otherDeductions ? row[columnMapping.otherDeductions] : undefined;
      const pf = normalizeSalaryValue(pfRaw);
      const esi = normalizeSalaryValue(esiRaw);
      const tds = normalizeSalaryValue(tdsRaw);
      const otherDed = normalizeSalaryValue(otherDedRaw);
      const totalDed = [pf, esi, tds, otherDed].reduce<string>((acc, v) => addDecimals(acc, v), '0.00');

      // Running totals (only for valid gross/net)
      if (grossSalary) totalGross = addDecimals(totalGross, grossSalary);
      if (totalDed !== '0.00') totalDeductions = addDecimals(totalDeductions, totalDed);
      if (netSalary) totalNet = addDecimals(totalNet, netSalary);

      let status: 'valid' | 'warning' | 'error' = 'valid';
      if (errors.length > 0) {
        status = 'error';
        withErrors++;
      } else if (warnings.length > 0) {
        status = 'warning';
        withWarnings++;
      } else {
        validCount++;
      }

      return {
        rowIndex,
        employeeCode: employeeCode || null,
        employeeName: employeeName || null,
        employeeDbId,
        grossSalary: grossSalary,
        totalDeductions: totalDed,
        netSalary: netSalary,
        status,
        errors,
        warnings,
      };
    });

    res.json({
      rows,
      summary: {
        total: rows.length,
        valid: validCount,
        withWarnings,
        withErrors,
        totalGross,
        totalDeductions,
        totalNet,
      },
      unmappedColumns,
      duplicateIds,
      existingRunWarning,
    });
  } catch (err: any) {
    req.log.error({ err }, 'Error validating payroll');
    res.status(500).json({ error: err?.message ?? 'Failed to validate payroll' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /payroll/import
// ─────────────────────────────────────────────────────────────────────────────
router.post('/payroll/import', requireAuth, async (req: Request, res: Response) => {
  const { objectPath, fileName, sheetName, columnMapping, payrollMonth, payrollYear } = req.body;

  if (!objectPath || !fileName || !sheetName || !columnMapping || !payrollMonth || !payrollYear) {
    res.status(400).json({ error: 'Missing required fields for import' });
    return;
  }

  const month = parseInt(String(payrollMonth), 10);
  const year = parseInt(String(payrollYear), 10);

  try {
    // Parse Excel again (authoritative server-side parse)
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const [buffer] = await file.download();
    const parsed = parseExcelBuffer(buffer, sheetName);

    // Load employee master
    const employees = await db.select().from(employeesTable);
    const employeeByCode = new Map(employees.map(e => [e.employeeCode.toUpperCase(), e]));

    // Known mapped column names for additional component detection
    const knownMappedCols = new Set(Object.values(columnMapping).filter(Boolean));

    // Build insert data for each row
    const recordsToInsert: Array<{
      employeeId: number;
      basic: string | null;
      da: string | null;
      hra: string | null;
      otherEarnings: string | null;
      grossSalary: string | null;
      pf: string | null;
      esi: string | null;
      tds: string | null;
      otherDeductions: string | null;
      netSalary: string | null;
      additionalComponents: Record<string, string>;
    }> = [];

    let totalGross = '0.00';
    let totalDeductions = '0.00';
    let totalNet = '0.00';
    const seenCodes = new Set<string>();
    const importErrors: string[] = [];

    for (const row of parsed.rows) {
      const employeeCode = columnMapping.employeeId
        ? String(row[columnMapping.employeeId] ?? '').trim()
        : '';

      if (!employeeCode) {
        importErrors.push(`Row is missing Employee ID`);
        continue;
      }

      const codeUpper = employeeCode.toUpperCase();
      if (seenCodes.has(codeUpper)) {
        importErrors.push(`Duplicate Employee ID "${employeeCode}" — import aborted`);
        continue;
      }
      seenCodes.add(codeUpper);

      const emp = employeeByCode.get(codeUpper);
      if (!emp) {
        importErrors.push(`Employee ID "${employeeCode}" not found in Employee Master`);
        continue;
      }

      const get = (field: keyof typeof columnMapping) =>
        columnMapping[field] ? normalizeSalaryValue(row[columnMapping[field]!]) : null;

      const basic = get('basic');
      const da = get('da');
      const hra = get('hra');
      const otherEarnings = get('otherEarnings');
      const grossSalary = get('grossSalary');
      const pf = get('pf');
      const esi = get('esi');
      const tds = get('tds');
      const otherDeductions = get('otherDeductions');
      const netSalary = get('netSalary');

      // Capture additional/unmapped columns
      const additionalComponents: Record<string, string> = {};
      for (const [colName, value] of Object.entries(row)) {
        if (!knownMappedCols.has(colName)) {
          const normalized = normalizeSalaryValue(value);
          if (normalized !== null) {
            additionalComponents[colName] = normalized;
          }
        }
      }

      // Totals
      if (grossSalary) totalGross = addDecimals(totalGross, grossSalary);
      if (netSalary) totalNet = addDecimals(totalNet, netSalary);
      const rowDed = [pf, esi, tds, otherDeductions].reduce<string>((acc, v) => addDecimals(acc, v), '0.00');
      if (rowDed !== '0.00') totalDeductions = addDecimals(totalDeductions, rowDed);

      recordsToInsert.push({
        employeeId: emp.id,
        basic,
        da,
        hra,
        otherEarnings,
        grossSalary,
        pf,
        esi,
        tds,
        otherDeductions,
        netSalary,
        additionalComponents,
      });
    }

    if (importErrors.length > 0) {
      res.status(422).json({
        error: 'Payroll import failed due to validation errors',
        details: importErrors,
      });
      return;
    }

    if (recordsToInsert.length === 0) {
      res.status(422).json({ error: 'No valid employee records to import' });
      return;
    }

    // Insert payroll run + records in a transaction
    const payrollRunId = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(payrollRunsTable)
        .values({
          payrollMonth: month,
          payrollYear: year,
          originalFileName: fileName,
          fileStoragePath: objectPath,
          uploadedBy: req.session.userId!,
          employeeCount: recordsToInsert.length,
          totalGross,
          totalDeductions,
          totalNet,
          status: 'IMPORTED',
        })
        .returning();

      await tx.insert(payrollRecordsTable).values(
        recordsToInsert.map(r => ({
          payrollRunId: run.id,
          ...r,
        })),
      );

      return run.id;
    });

    // Save the column mapping for future use
    const existingMapping = await db.select().from(payrollColumnMappingsTable).limit(1);
    if (existingMapping.length > 0) {
      await db.update(payrollColumnMappingsTable).set({ mapping: columnMapping });
    } else {
      await db.insert(payrollColumnMappingsTable).values({ mapping: columnMapping });
    }

    await createAuditLog({
      action: 'PAYROLL_IMPORTED',
      entityType: 'payroll_run',
      entityId: payrollRunId,
      performedBy: req.session.userId!,
      details: `Payroll run for ${MONTH_NAMES[month - 1]} ${year} imported — ${recordsToInsert.length} employees`,
    });

    res.status(201).json({
      payrollRunId,
      employeeCount: recordsToInsert.length,
      totalGross,
      totalDeductions,
      totalNet,
    });
  } catch (err: any) {
    req.log.error({ err }, 'Error importing payroll');
    res.status(500).json({ error: err?.message ?? 'Failed to import payroll' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /payroll/column-mapping
// ─────────────────────────────────────────────────────────────────────────────
router.get('/payroll/column-mapping', requireAuth, async (req: Request, res: Response) => {
  const [saved] = await db.select().from(payrollColumnMappingsTable).limit(1);
  res.json({ mapping: saved?.mapping ?? null });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /payroll/column-mapping
// ─────────────────────────────────────────────────────────────────────────────
router.put('/payroll/column-mapping', requireAuth, async (req: Request, res: Response) => {
  const { mapping } = req.body;
  if (!mapping || typeof mapping !== 'object') {
    res.status(400).json({ error: 'mapping object is required' });
    return;
  }

  const existing = await db.select().from(payrollColumnMappingsTable).limit(1);
  if (existing.length > 0) {
    await db.update(payrollColumnMappingsTable).set({ mapping });
  } else {
    await db.insert(payrollColumnMappingsTable).values({ mapping });
  }

  res.json({ mapping });
});

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default router;
