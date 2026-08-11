import { index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { payrollRecordsTable } from './payrollRecords';

export const payrollWhatsAppLogsTable = pgTable('payroll_whatsapp_logs', {
  id: serial('id').primaryKey(),
  payrollRecordId: integer('payroll_record_id')
    .notNull()
    .references(() => payrollRecordsTable.id, { onDelete: 'cascade' }),
  employeeReference: text('employee_reference').notNull(),
  recipientMobile: varchar('recipient_mobile', { length: 20 }).notNull(),
  templateName: varchar('template_name', { length: 100 }).notNull(),
  messagePurpose: varchar('message_purpose', { length: 50 }).notNull(),
  metaMessageId: text('meta_message_id'),
  status: varchar('status', { length: 20 }).notNull(),
  errorCode: varchar('error_code', { length: 100 }),
  errorMessage: text('error_message'),
  dedupeKey: varchar('dedupe_key', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [
  index('payroll_whatsapp_logs_payroll_record_idx').on(table.payrollRecordId),
  index('payroll_whatsapp_logs_meta_message_idx').on(table.metaMessageId),
  index('payroll_whatsapp_logs_created_at_idx').on(table.createdAt),
  index('payroll_whatsapp_logs_status_idx').on(table.status),
  uniqueIndex('payroll_whatsapp_logs_dedupe_key_unique').on(table.dedupeKey),
]);

export type PayrollWhatsAppLog = typeof payrollWhatsAppLogsTable.$inferSelect;
