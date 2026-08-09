import { pgTable, serial, timestamp, numeric, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { payrollRunsTable } from "./payrollRuns";
import { employeesTable } from "./employees";

export const payrollRecordsTable = pgTable("payroll_records", {
  id: serial("id").primaryKey(),
  payrollRunId: integer("payroll_run_id")
    .notNull()
    .references(() => payrollRunsTable.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employeesTable.id, { onDelete: "restrict" }),

  // Core earnings — stored as numeric for precision (imported from Excel)
  basic: numeric("basic", { precision: 12, scale: 2 }),
  da: numeric("da", { precision: 12, scale: 2 }),
  hra: numeric("hra", { precision: 12, scale: 2 }),
  otherEarnings: numeric("other_earnings", { precision: 12, scale: 2 }),
  grossSalary: numeric("gross_salary", { precision: 12, scale: 2 }),

  // Core deductions
  pf: numeric("pf", { precision: 12, scale: 2 }),
  esi: numeric("esi", { precision: 12, scale: 2 }),
  tds: numeric("tds", { precision: 12, scale: 2 }),
  otherDeductions: numeric("other_deductions", { precision: 12, scale: 2 }),

  // Net
  netSalary: numeric("net_salary", { precision: 12, scale: 2 }),

  // Flexible additional components (for Stage 3 payslip generation)
  // Stored as { "Conveyance": "1500.00", "Medical Allowance": "500.00", ... }
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
