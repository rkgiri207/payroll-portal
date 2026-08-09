import { pgTable, serial, timestamp, numeric, integer, jsonb, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { payrollRunsTable } from "./payrollRuns";

export const payrollRecordsTable = pgTable("payroll_records", {
  id: serial("id").primaryKey(),
  payrollRunId: integer("payroll_run_id")
    .notNull()
    .references(() => payrollRunsTable.id, { onDelete: "cascade" }),

  /**
   * employee_id is kept for backward compatibility with records imported
   * before the Employee Master was removed from the payroll workflow.
   * New records will have this as NULL; employee identity is stored directly.
   */
  employeeId: integer("employee_id"),

  // Employee identity — stored directly from the uploaded Excel (no master lookup)
  employeeCode: text("employee_code").notNull().default(""),
  employeeName: text("employee_name").notNull().default(""),
  mobileNumber: text("mobile_number"),
  email: text("email"),
  designation: text("designation"),
  branch: text("branch"),
  joiningDate: text("joining_date"),

  // Core earnings — imported from Excel; not calculated by the application
  basic: numeric("basic", { precision: 12, scale: 2 }),
  da: numeric("da", { precision: 12, scale: 2 }),
  hra: numeric("hra", { precision: 12, scale: 2 }),
  otherEarnings: numeric("other_earnings", { precision: 12, scale: 2 }),
  grossSalary: numeric("gross_salary", { precision: 12, scale: 2 }),

  // Core deductions — imported from Excel
  pf: numeric("pf", { precision: 12, scale: 2 }),
  esi: numeric("esi", { precision: 12, scale: 2 }),
  tds: numeric("tds", { precision: 12, scale: 2 }),
  otherDeductions: numeric("other_deductions", { precision: 12, scale: 2 }),

  // Net — imported from Excel
  netSalary: numeric("net_salary", { precision: 12, scale: 2 }),

  // Additional/unmapped Excel columns preserved for Stage 3 payslip generation
  // e.g. { "Conveyance": "1500.00", "Medical Allowance": "500.00" }
  additionalComponents: jsonb("additional_components").$type<Record<string, string>>(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPayrollRecordSchema = createInsertSchema(payrollRecordsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPayrollRecord = z.infer<typeof insertPayrollRecordSchema>;
export type PayrollRecord = typeof payrollRecordsTable.$inferSelect;
