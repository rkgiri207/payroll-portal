import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { payrollRecordsTable } from './payrollRecords';

export const payslipSharesTable = pgTable('payslip_shares', {
  id: serial('id').primaryKey(),
  payrollRecordId: integer('payroll_record_id')
    .notNull()
    .references(() => payrollRecordsTable.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  tokenCiphertext: text('token_ciphertext').notNull(),
  storagePath: text('storage_path').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked: boolean('revoked').notNull().default(false),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [
  uniqueIndex('payslip_shares_payroll_record_id_unique').on(table.payrollRecordId),
  uniqueIndex('payslip_shares_token_hash_unique').on(table.tokenHash),
  index('payslip_shares_expiry_idx').on(table.expiresAt),
]);

export type PayslipShare = typeof payslipSharesTable.$inferSelect;
