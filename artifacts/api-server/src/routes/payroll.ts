/**
 * Payroll upload workflow routes:
 *   POST /payroll/request-upload-url   — presigned URL for Excel upload
 *   POST /payroll/parse-excel          — parse Excel, return sheets + headers
 *   POST /payroll/validate             — validate rows (no Employee Master lookup)
 *   POST /payroll/import               — create payroll run + records
 *   GET  /payroll/column-mapping       — get saved column mapping
 *   PUT  /payroll/column-mapping       — save column mapping
 *
 * IMPORTANT: The payroll Excel is the source of truth. There is NO Employee Master lookup.
 * Employee information (code, name, mobile, designation, branch) is read directly from
 * the uploaded Excel and stored on each payroll record.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { db } from '@workspace/db';
import { payrollRunsTable, payrollRecordsTable, payrollColumnMappingsTable } from '@workspace/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../middlewares/requireAuth';
import { createAuditLog } from '../lib/audit';
import { ObjectStorageService } from '../lib/objectStorage';
import { parseExcelBuffer, normalizeSalaryValue, addDecimals } from '../lib/excelParser';
import { validateIndianMobile } from '../lib/mobileValidator';

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
// No Employee Master lookup. Excel is the source of truth.
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

    // Build a set of all mapped Excel column names to detect unmapped columns
    const mappedColumns = new Set(Object.values(columnMapping).filter(Boolean));
    const unmappedColumns = parsed.headers.filter(h => !mappedColumns.has(h));

    // Check for an existing payroll run for this month/year
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

    // Validate rows — no Employee Master lookup
    const seenCodes = new Set<string>();
    const seenMobiles = new Map<string, string>(); // normalized → employeeCode
    const duplicateIds: string[] = [];
    let totalGross = '0.00';
    let totalDeductions = '0.00';
    let totalNet = '0.00';
    let withWarnings = 0;
    let withErrors = 0;
    let validCount = 0;
    let validMobileCount = 0;
    let missingMobileCount = 0;
    let invalidMobileCount = 0;

    const rows = parsed.rows.map((row, idx) => {
      const rowIndex = idx + 2; // Excel row number (1-based header + 1)
      const errors: string[] = [];
      const warnings: string[] = [];

      // ── Employee identity from Excel ────────────────────────────────────────
      const employeeCode = columnMapping.employeeId
        ? String(row[columnMapping.employeeId] ?? '').trim()
        : '';
      const employeeName = columnMapping.employeeName
        ? String(row[columnMapping.employeeName] ?? '').trim()
        : '';
      const mobileRaw = columnMapping.mobile
        ? String(row[columnMapping.mobile] ?? '').trim()
        : '';
      const designation = columnMapping.designation
        ? String(row[columnMapping.designation] ?? '').trim()
        : '';
      const branch = columnMapping.branch
        ? String(row[columnMapping.branch] ?? '').trim()
        : '';

      // ── Required: Employee ID ───────────────────────────────────────────────
      if (!employeeCode) {
        errors.push('Employee ID is required');
      } else {
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

      // ── Required: Employee Name ─────────────────────────────────────────────
      if (!employeeName) {
        errors.push('Employee Name is required');
      }

      // ── Mobile number — validate & normalize ────────────────────────────────
      // Missing → warning only (non-blocking)
      // Invalid → warning only (payroll import still proceeds; WhatsApp delivery blocked)
      // Duplicate within file → warning only
      const mobileResult = validateIndianMobile(mobileRaw);
      let mobileNumber: string | null = null;
      let mobileStatus: 'valid' | 'missing' | 'invalid';

      if (!mobileRaw) {
        mobileStatus = 'missing';
        missingMobileCount++;
        warnings.push('Mobile number not provided — WhatsApp delivery will not be available.');
      } else if (mobileResult.valid) {
        mobileStatus = 'valid';
        mobileNumber = mobileResult.normalized;
        validMobileCount++;
        // Duplicate mobile within this file
        const existingOwner = seenMobiles.get(mobileResult.normalized);
        if (existingOwner) {
          warnings.push(`Mobile number ${mobileResult.normalized} is shared with employee ${existingOwner} — WhatsApp delivery may be ambiguous.`);
        } else {
          seenMobiles.set(mobileResult.normalized, employeeCode || `row ${rowIndex}`);
        }
      } else {
        mobileStatus = 'invalid';
        invalidMobileCount++;
        warnings.push(`Invalid mobile number: ${mobileResult.reason}`);
      }

      // ── Payroll salary fields ───────────────────────────────────────────────
      const grossRaw = columnMapping.grossSalary ? row[columnMapping.grossSalary] : undefined;
      const netRaw   = columnMapping.netSalary   ? row[columnMapping.netSalary]   : undefined;

      const grossSalary = normalizeSalaryValue(grossRaw);
      const netSalary   = normalizeSalaryValue(netRaw);

      if (grossRaw !== undefined && grossRaw !== '' && grossSalary === null) {
        errors.push(`Invalid gross salary value: "${grossRaw}"`);
      }
      if (netRaw !== undefined && netRaw !== '' && netSalary === null) {
        errors.push(`Invalid net salary value: "${netRaw}"`);
      }

      // Compute total deductions for preview display
      const pfEmployeeRaw  = columnMapping.pfEmployee  ? row[columnMapping.pfEmployee]  : undefined;
      const pfEmployerRaw  = columnMapping.pfEmployer  ? row[columnMapping.pfEmployer]  : undefined;
      const esiEmployeeRaw = columnMapping.esiEmployee ? row[columnMapping.esiEmployee] : undefined;
      const esiEmployerRaw = columnMapping.esiEmployer ? row[columnMapping.esiEmployer] : undefined;
      const ptRaw          = columnMapping.pt           ? row[columnMapping.pt]           : undefined;
      const otherDedRaw    = columnMapping.otherDeductions ? row[columnMapping.otherDeductions] : undefined;
      const pfEmployee  = normalizeSalaryValue(pfEmployeeRaw);
      const pfEmployer  = normalizeSalaryValue(pfEmployerRaw);
      const esiEmployee = normalizeSalaryValue(esiEmployeeRaw);
      const esiEmployer = normalizeSalaryValue(esiEmployerRaw);
      const pt          = normalizeSalaryValue(ptRaw);
      const otherDed    = normalizeSalaryValue(otherDedRaw);
      const totalDed = [pfEmployee, pfEmployer, esiEmployee, esiEmployer, pt, otherDed]
        .reduce<string>((acc, v) => addDecimals(acc, v), '0.00');

      // Running totals (valid values only)
      if (grossSalary) totalGross       = addDecimals(totalGross, grossSalary);
      if (totalDed !== '0.00') totalDeductions = addDecimals(totalDeductions, totalDed);
      if (netSalary)  totalNet          = addDecimals(totalNet, netSalary);

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
        employeeCode:  employeeCode  || null,
        employeeName:  employeeName  || null,
        mobileNumber,
        mobileStatus,
        designation:   designation   || null,
        branch:        branch        || null,
        grossSalary,
        totalDeductions: totalDed,
        netSalary,
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
        validMobileCount,
        missingMobileCount,
        invalidMobileCount,
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
// No Employee Master lookup. Employee identity is stored directly on the record.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/payroll/import', requireAuth, async (req: Request, res: Response) => {
  const { objectPath, fileName, sheetName, columnMapping, payrollMonth, payrollYear } = req.body;

  if (!objectPath || !fileName || !sheetName || !columnMapping || !payrollMonth || !payrollYear) {
    res.status(400).json({ error: 'Missing required fields for import' });
    return;
  }

  const month = parseInt(String(payrollMonth), 10);
  const year  = parseInt(String(payrollYear), 10);

  try {
    // Parse Excel again (authoritative server-side parse)
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const [buffer] = await file.download();
    const parsed = parseExcelBuffer(buffer, sheetName);

    // Known mapped column names — used to detect additional/unmapped columns
    const knownMappedCols = new Set(Object.values(columnMapping).filter(Boolean));

    // Build insert data for each row
    const recordsToInsert: Array<{
      employeeCode: string;
      employeeName: string;
      mobileNumber: string | null;
      email: string | null;
      designation: string | null;
      branch: string | null;
      joiningDate: string | null;
      basic: string | null;
      da: string | null;
      hra: string | null;
      otherEarnings: string | null;
      grossSalary: string | null;
      pfEmployee: string | null;
      pfEmployer: string | null;
      esiEmployee: string | null;
      esiEmployer: string | null;
      pt: string | null;
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
      // ── Employee identity from Excel ─────────────────────────────────────
      const employeeCode = columnMapping.employeeId
        ? String(row[columnMapping.employeeId] ?? '').trim()
        : '';
      const employeeName = columnMapping.employeeName
        ? String(row[columnMapping.employeeName] ?? '').trim()
        : '';
      // Normalize + validate mobile; only store if valid
      const mobileRaw = columnMapping.mobile
        ? String(row[columnMapping.mobile] ?? '').trim()
        : '';
      const mobileResult = validateIndianMobile(mobileRaw);
      const mobileNumber = mobileResult.valid ? mobileResult.normalized : null;
      const email = columnMapping.email
        ? String(row[columnMapping.email] ?? '').trim() || null
        : null;
      const designation = columnMapping.designation
        ? String(row[columnMapping.designation] ?? '').trim() || null
        : null;
      const branch = columnMapping.branch
        ? String(row[columnMapping.branch] ?? '').trim() || null
        : null;
      const joiningDate = columnMapping.joiningDate
        ? String(row[columnMapping.joiningDate] ?? '').trim() || null
        : null;

      if (!employeeCode) {
        importErrors.push('A row is missing Employee ID');
        continue;
      }
      if (!employeeName) {
        importErrors.push(`Employee ID "${employeeCode}": Employee Name is required`);
        continue;
      }

      const codeUpper = employeeCode.toUpperCase();
      if (seenCodes.has(codeUpper)) {
        importErrors.push(`Duplicate Employee ID "${employeeCode}" — import aborted`);
        continue;
      }
      seenCodes.add(codeUpper);

      // ── Salary fields ───────────────────────────────────────────────────
      const get = (field: string | undefined) =>
        field ? normalizeSalaryValue(row[field]) : null;

      const basic          = get(columnMapping.basic);
      const da             = get(columnMapping.da);
      const hra            = get(columnMapping.hra);
      const otherEarnings  = get(columnMapping.otherEarnings);
      const grossSalary    = get(columnMapping.grossSalary);
      const pfEmployee      = get(columnMapping.pfEmployee);
      const pfEmployer      = get(columnMapping.pfEmployer);
      const esiEmployee     = get(columnMapping.esiEmployee);
      const esiEmployer     = get(columnMapping.esiEmployer);
      const pt              = get(columnMapping.pt);
      const otherDeductions = get(columnMapping.otherDeductions);
      const netSalary      = get(columnMapping.netSalary);

      // ── Additional/unmapped columns → additionalComponents JSONB ────────
      const additionalComponents: Record<string, string> = {};
      for (const [colName, value] of Object.entries(row)) {
        if (!knownMappedCols.has(colName)) {
          const normalized = normalizeSalaryValue(value);
          if (normalized !== null) {
            additionalComponents[colName] = normalized;
          }
        }
      }

      // Running totals
      if (grossSalary)  totalGross = addDecimals(totalGross, grossSalary);
      if (netSalary)    totalNet   = addDecimals(totalNet, netSalary);
      const rowDed = [pfEmployee, pfEmployer, esiEmployee, esiEmployer, pt, otherDeductions]
        .reduce<string>((acc, v) => addDecimals(acc, v), '0.00');
      if (rowDed !== '0.00') totalDeductions = addDecimals(totalDeductions, rowDed);

      recordsToInsert.push({
        employeeCode,
        employeeName,
        mobileNumber,
        email,
        designation,
        branch,
        joiningDate,
        basic,
        da,
        hra,
        otherEarnings,
        grossSalary,
        pfEmployee,
        pfEmployer,
        esiEmployee,
        esiEmployer,
        pt,
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

    // Save the column mapping for future uploads
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
