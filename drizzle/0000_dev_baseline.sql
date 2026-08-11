CREATE TYPE "public"."user_role" AS ENUM('ADMIN');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('DRAFT', 'VALIDATED', 'IMPORTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'ADMIN' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"logo_path" text,
	"address" text,
	"phone" text,
	"email" text,
	"website" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" integer,
	"performed_by" integer,
	"details" text,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_code" text NOT NULL,
	"employee_name" text NOT NULL,
	"mobile_number" text,
	"email" text,
	"designation" text,
	"branch" text,
	"joining_date" date,
	"status" "employee_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_employee_code_unique" UNIQUE("employee_code")
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"payroll_month" integer NOT NULL,
	"payroll_year" integer NOT NULL,
	"original_file_name" text NOT NULL,
	"file_storage_path" text NOT NULL,
	"uploaded_by" integer,
	"upload_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"total_gross" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_deductions" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_net" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" "payroll_run_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"payroll_run_id" integer NOT NULL,
	"employee_id" integer,
	"employee_code" text DEFAULT '' NOT NULL,
	"employee_name" text DEFAULT '' NOT NULL,
	"mobile_number" text,
	"email" text,
	"designation" text,
	"branch" text,
	"joining_date" text,
	"basic" numeric(12, 2),
	"da" numeric(12, 2),
	"hra" numeric(12, 2),
	"other_earnings" numeric(12, 2),
	"gross_salary" numeric(12, 2),
	"pf_employee" numeric(12, 2),
	"pf_employer" numeric(12, 2),
	"esi_employee" numeric(12, 2),
	"esi_employer" numeric(12, 2),
	"pt" numeric(12, 2),
	"other_deductions" numeric(12, 2),
	"net_salary" numeric(12, 2),
	"additional_components" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_column_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"mapping" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslip_generations" (
	"id" serial PRIMARY KEY NOT NULL,
	"payroll_record_id" integer NOT NULL,
	"payroll_run_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'NOT_GENERATED' NOT NULL,
	"generated_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_generations" ADD CONSTRAINT "payslip_generations_payroll_record_id_payroll_records_id_fk" FOREIGN KEY ("payroll_record_id") REFERENCES "public"."payroll_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_generations" ADD CONSTRAINT "payslip_generations_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;