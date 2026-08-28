import { pgTable, serial, timestamp, jsonb } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

// Stores the last successful column mapping so it can be suggested on next upload
export const payrollColumnMappingsTable = pgTable("payroll_column_mappings", {
  id: serial("id").primaryKey(),
  mapping: jsonb("mapping").$type<Record<string, string>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PayrollColumnMapping = typeof payrollColumnMappingsTable.$inferSelect;

// The mapping shape: our field name → Excel column header
export const columnMappingSchema = z.object({
  employeeId: z.string().optional(),
  employeeName: z.string().optional(),
  basic: z.string().optional(),
  da: z.string().optional(),
  hra: z.string().optional(),
  otherEarnings: z.string().optional(),
  additionalEarnings: z.string().optional(),
  grossSalary: z.string().optional(),
  pf: z.string().optional(),
  esi: z.string().optional(),
  tds: z.string().optional(),
  lop: z.string().optional(),
  otherDeductions: z.string().optional(),
  netSalary: z.string().optional(),
});

export type ColumnMapping = z.infer<typeof columnMappingSchema>;
