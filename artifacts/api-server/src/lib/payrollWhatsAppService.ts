import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@workspace/db';
import { payrollRecordsTable, payrollRunsTable, payrollWhatsAppLogsTable } from '@workspace/db/schema';
import { monthName } from '../../../payroll-portal/src/lib/format';
import { validateIndianMobile } from './mobileValidator';
import { createPayslipShare } from './payslipSharing';
import { assertPayrollWhatsAppTemplateReady, PAYROLL_WHATSAPP_TEMPLATE, sendPayrollPayslipTemplate } from './payrollWhatsAppClient';

const TEST_PURPOSE = 'PAYSLIP_TEST';
const BULK_PURPOSE = 'PAYSLIP_BULK';
const DEDUPE_WINDOW_MS = 60_000;
const TERMINAL_SENT_STATUSES = new Set(['SENT', 'DELIVERED', 'READ']);

export class PayrollWhatsAppError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) { super(message); }
}

function safeError(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown };
  const rawMessage = typeof candidate?.message === 'string' ? candidate.message : 'WhatsApp send failed';
  return {
    code: String(candidate?.code ?? 'SEND_FAILED').slice(0, 100),
    message: rawMessage
      .replace(/https?:\/\/\S+\/p\/[A-Za-z0-9_-]+/gi, '[secure link redacted]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .slice(0, 500),
  };
}

function assertTemplateReady() {
  try {
    assertPayrollWhatsAppTemplateReady();
  } catch (error) {
    const safe = safeError(error);
    throw new PayrollWhatsAppError(safe.message, 503, 'TEMPLATE_CTA_STATIC');
  }
}

async function payrollRows(recordIds: number[]) {
  if (recordIds.length === 0) return [];
  return db.select({ record: payrollRecordsTable, run: payrollRunsTable })
    .from(payrollRecordsTable)
    .innerJoin(payrollRunsTable, eq(payrollRecordsTable.payrollRunId, payrollRunsTable.id))
    .where(inArray(payrollRecordsTable.id, recordIds));
}

async function latestLogs(recordIds: number[]) {
  const result = new Map<number, typeof payrollWhatsAppLogsTable.$inferSelect>();
  if (recordIds.length === 0) return result;
  const rows = await db.select().from(payrollWhatsAppLogsTable)
    .where(inArray(payrollWhatsAppLogsTable.payrollRecordId, recordIds))
    .orderBy(desc(payrollWhatsAppLogsTable.createdAt), desc(payrollWhatsAppLogsTable.id));
  for (const row of rows) if (!result.has(row.payrollRecordId)) result.set(row.payrollRecordId, row);
  return result;
}

export async function previewBulkPayrollWhatsApp(recordIds: number[], override = false) {
  assertTemplateReady();
  const rows = await payrollRows(recordIds);
  const byId = new Map(rows.map(row => [row.record.id, row]));
  const logs = await latestLogs(recordIds);
  const records = recordIds.map(payrollRecordId => {
    const row = byId.get(payrollRecordId);
    if (!row) return { payrollRecordId, eligible: false, reason: 'Payroll record not found', code: 'NOT_FOUND' };
    const mobile = validateIndianMobile(row.record.mobileNumber ?? '');
    if (!mobile.valid) return { payrollRecordId, eligible: false, reason: mobile.reason, code: 'INVALID_MOBILE' };
    const latest = logs.get(payrollRecordId);
    if (latest?.status === 'PENDING') return { payrollRecordId, eligible: false, reason: 'A send is already in progress', code: 'IN_PROGRESS', status: latest.status };
    if (!override && latest && TERMINAL_SENT_STATUSES.has(latest.status)) {
      return { payrollRecordId, eligible: false, reason: `Already ${latest.status.toLowerCase()}`, code: 'ALREADY_SENT', status: latest.status };
    }
    if (!override && latest?.status === 'FAILED') {
      return { payrollRecordId, eligible: false, reason: 'Previous send failed; an explicit retry override is required', code: 'RETRY_REQUIRED', status: latest.status };
    }
    return { payrollRecordId, eligible: true, status: latest?.status ?? null };
  });
  return {
    selected: recordIds.length,
    validMobile: records.filter(record => record.code !== 'INVALID_MOBILE' && record.code !== 'NOT_FOUND').length,
    alreadySent: records.filter(record => record.code === 'ALREADY_SENT').length,
    willSend: records.filter(record => record.eligible).length,
    records,
  };
}

interface SendRecordOptions {
  dedupeKey: string;
  purpose: string;
  override?: boolean;
}

async function sendRecord(payrollRecordId: number, options: SendRecordOptions) {
  const preview = await previewBulkPayrollWhatsApp([payrollRecordId], options.override);
  const eligibility = preview.records[0];
  if (!eligibility?.eligible) {
    return { payrollRecordId, status: 'SKIPPED' as const, code: eligibility?.code ?? 'NOT_FOUND', error: eligibility?.reason ?? 'Payroll record not found' };
  }
  const [row] = await payrollRows([payrollRecordId]);
  const mobile = validateIndianMobile(row.record.mobileNumber ?? '');
  if (!mobile.valid) throw new PayrollWhatsAppError(mobile.reason, 400, 'INVALID_MOBILE');

  const [log] = await db.insert(payrollWhatsAppLogsTable).values({
    payrollRecordId,
    employeeReference: row.record.employeeCode,
    recipientMobile: mobile.e164,
    templateName: PAYROLL_WHATSAPP_TEMPLATE,
    messagePurpose: options.purpose,
    status: 'PENDING',
    dedupeKey: options.dedupeKey,
  }).onConflictDoNothing().returning();
  if (!log) {
    return { payrollRecordId, status: 'SKIPPED' as const, code: 'DUPLICATE_SEND', error: 'This send request was already accepted or is in progress' };
  }

  try {
    const share = await createPayslipShare(payrollRecordId);
    const period = `${monthName(row.run.payrollMonth)} ${row.run.payrollYear}`;
    const sent = await sendPayrollPayslipTemplate({
      recipient: mobile.e164,
      employeeName: row.record.employeeName,
      period,
      employeeReference: row.record.employeeCode,
      shareUrl: share.url,
    });
    const sentAt = new Date();
    await db.update(payrollWhatsAppLogsTable).set({ status: 'SENT', metaMessageId: sent.messageId, updatedAt: sentAt })
      .where(eq(payrollWhatsAppLogsTable.id, log.id));
    return { payrollRecordId, status: 'SENT' as const, recipient: mobile.e164, metaMessageId: sent.messageId, timestamp: sentAt };
  } catch (error) {
    const safe = safeError(error);
    const failedAt = new Date();
    const definitive = (error as { definitive?: unknown })?.definitive === true;
    await db.update(payrollWhatsAppLogsTable).set({
      status: definitive ? 'FAILED' : 'PENDING',
      errorCode: safe.code,
      errorMessage: definitive ? safe.message : `Delivery outcome unknown: ${safe.message}`,
      updatedAt: failedAt,
    })
      .where(eq(payrollWhatsAppLogsTable.id, log.id));
    return definitive
      ? { payrollRecordId, status: 'FAILED' as const, code: safe.code, error: safe.message, timestamp: failedAt }
      : { payrollRecordId, status: 'PENDING' as const, code: safe.code, error: 'Meta delivery outcome is unknown; automatic retry is blocked', timestamp: failedAt };
  }
}

export async function sendBulkPayrollWhatsApp(recordIds: number[], requestId: string, override = false) {
  assertTemplateReady();
  const batchId = requestId;
  const results = [];
  for (const payrollRecordId of recordIds) {
    results.push(await sendRecord(payrollRecordId, {
      purpose: BULK_PURPOSE,
      override,
      dedupeKey: `bulk:${requestId}:${payrollRecordId}`.slice(0, 100),
    }));
  }
  return {
    batchId,
    total: recordIds.length,
    sent: results.filter(result => result.status === 'SENT').length,
    failed: results.filter(result => result.status === 'FAILED').length,
    pending: results.filter(result => result.status === 'PENDING').length,
    skipped: results.filter(result => result.status === 'SKIPPED').length,
    results,
  };
}

export async function sendTestPayrollWhatsApp(payrollRecordId: number) {
  assertTemplateReady();
  const now = new Date();
  const result = await sendRecord(payrollRecordId, {
    purpose: TEST_PURPOSE,
    override: true,
    dedupeKey: `test:${payrollRecordId}:${Math.floor(now.getTime() / DEDUPE_WINDOW_MS)}`,
  });
  if (result.status !== 'SENT') throw new PayrollWhatsAppError(result.error, result.status === 'SKIPPED' || result.status === 'PENDING' ? 409 : 502, result.code);
  return {
    status: 'SENT' as const,
    recipient: result.recipient,
    template: PAYROLL_WHATSAPP_TEMPLATE,
    metaMessageId: result.metaMessageId,
    timestamp: result.timestamp,
  };
}
