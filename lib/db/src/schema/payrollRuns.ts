import { pgTable, text, serial, timestamp, numeric, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const payrollRunStatusEnum = pgEnum("payroll_run_status", [
  "DRAFT",
  "VALIDATED",
  "IMPORTED",
  "CANCELLED",
]);

export const payrollRunsTable = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  payrollMonth: integer("payroll_month").notNull(), // 1–12
  payrollYear: integer("payroll_year").notNull(),
  originalFileName: text("original_file_name").notNull(),
  fileStoragePath: text("file_storage_path").notNull(), // Object Storage path
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  uploadTimestamp: timestamp("upload_timestamp", { withTimezone: true }).notNull().defaultNow(),
  employeeCount: integer("employee_count").notNull().default(0),
  totalGross: numeric("total_gross", { precision: 14, scale: 2 }).notNull().default("0"),
  totalDeductions: numeric("total_deductions", { precision: 14, scale: 2 }).notNull().default("0"),
  totalNet: numeric("total_net", { precision: 14, scale: 2 }).notNull().default("0"),
  status: payrollRunStatusEnum("status").notNull().default("DRAFT"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPayrollRunSchema = createInsertSchema(payrollRunsTable).omit({
  id: true,
  uploadTimestamp: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPayrollRun = z.infer<typeof insertPayrollRunSchema>;
export type PayrollRun = typeof payrollRunsTable.$inferSelect;
