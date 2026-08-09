import { pgTable, text, serial, timestamp, date, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const employeeStatusEnum = pgEnum("employee_status", ["ACTIVE", "INACTIVE"]);

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  employeeCode: text("employee_code").notNull().unique(),
  employeeName: text("employee_name").notNull(),
  mobileNumber: text("mobile_number"), // Nullable — flag warning for WhatsApp later
  email: text("email"),               // Nullable — not every employee has email
  designation: text("designation"),
  branch: text("branch"),
  joiningDate: date("joining_date", { mode: "string" }),
  status: employeeStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;
