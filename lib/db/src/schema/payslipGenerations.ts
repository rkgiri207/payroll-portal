import { pgTable, serial, integer, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { payrollRecordsTable } from "./payrollRecords";
import { payrollRunsTable } from "./payrollRuns";

export const payslipGenerationsTable = pgTable("payslip_generations", {
  id: serial("id").primaryKey(),
  payrollRecordId: integer("payroll_record_id")
    .notNull()
    .references(() => payrollRecordsTable.id, { onDelete: "cascade" }),
  payrollRunId: integer("payroll_run_id")
    .notNull()
    .references(() => payrollRunsTable.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).notNull().default("NOT_GENERATED"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PayslipGeneration = typeof payslipGenerationsTable.$inferSelect;
