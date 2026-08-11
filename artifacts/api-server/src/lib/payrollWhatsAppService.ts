import { db } from '@workspace/db';
import { payrollRecordsTable, payrollRunsTable, payrollWhatsAppLogsTable } from '@workspace/db/schema';
import { eq } from 'drizzle-orm';
import { monthName } from '../../../payroll-portal/src/lib/format';
import { validateIndianMobile } from './mobileValidator';
import { createPayslipShare } from './payslipSharing';
import { assertPayrollWhatsAppTemplateReady, PAYROLL_WHATSAPP_TEMPLATE, sendPayrollPayslipTemplate } from './payrollWhatsAppClient';

const PURPOSE = 'PAYSLIP_TEST';
const DEDUPE_WINDOW_MS = 60_000;

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

export async function sendTestPayrollWhatsApp(payrollRecordId: number) {
  const [row] = await db.select({ record: payrollRecordsTable, run: payrollRunsTable })
    .from(payrollRecordsTable)
    .innerJoin(payrollRunsTable, eq(payrollRecordsTable.payrollRunId, payrollRunsTable.id))
    .where(eq(payrollRecordsTable.id, payrollRecordId));
  if (!row) throw new PayrollWhatsAppError('Payroll record not found', 404, 'NOT_FOUND');

  const mobile = validateIndianMobile(row.record.mobileNumber ?? '');
  if (!mobile.valid) throw new PayrollWhatsAppError(mobile.reason, 400, 'INVALID_MOBILE');

  try {
    assertPayrollWhatsAppTemplateReady();
  } catch (error) {
    const safe = safeError(error);
    throw new PayrollWhatsAppError(safe.message, 503, 'TEMPLATE_CTA_STATIC');
  }

  const now = new Date();
  const dedupeKey = `${payrollRecordId}:${Math.floor(now.getTime() / DEDUPE_WINDOW_MS)}`;
  const [log] = await db.insert(payrollWhatsAppLogsTable).values({
    payrollRecordId,
    employeeReference: row.record.employeeCode,
    recipientMobile: mobile.e164,
    templateName: PAYROLL_WHATSAPP_TEMPLATE,
    messagePurpose: PURPOSE,
    status: 'PENDING',
    dedupeKey,
  }).onConflictDoNothing({ target: payrollWhatsAppLogsTable.dedupeKey }).returning();
  if (!log) throw new PayrollWhatsAppError('A WhatsApp send for this record is already in progress or was sent recently', 409, 'DUPLICATE_SEND');

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
    const updatedAt = new Date();
    await db.update(payrollWhatsAppLogsTable).set({ status: 'SENT', metaMessageId: sent.messageId, updatedAt })
      .where(eq(payrollWhatsAppLogsTable.id, log.id));
    return { status: 'SENT' as const, recipient: mobile.e164, template: PAYROLL_WHATSAPP_TEMPLATE, metaMessageId: sent.messageId, timestamp: updatedAt };
  } catch (error) {
    const safe = safeError(error);
    await db.update(payrollWhatsAppLogsTable).set({ status: 'FAILED', errorCode: safe.code, errorMessage: safe.message, updatedAt: new Date() })
      .where(eq(payrollWhatsAppLogsTable.id, log.id));
    throw new PayrollWhatsAppError(safe.message, 502, safe.code);
  }
}
