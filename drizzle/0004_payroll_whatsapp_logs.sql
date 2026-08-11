CREATE TABLE "payroll_whatsapp_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "payroll_record_id" integer NOT NULL,
  "employee_reference" text NOT NULL,
  "recipient_mobile" varchar(20) NOT NULL,
  "template_name" varchar(100) NOT NULL,
  "message_purpose" varchar(50) NOT NULL,
  "meta_message_id" text,
  "status" varchar(20) NOT NULL,
  "error_code" varchar(100),
  "error_message" text,
  "dedupe_key" varchar(100) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payroll_whatsapp_logs_payroll_record_id_payroll_records_id_fk"
    FOREIGN KEY ("payroll_record_id") REFERENCES "public"."payroll_records"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "payroll_whatsapp_logs_payroll_record_idx" ON "payroll_whatsapp_logs" USING btree ("payroll_record_id");
--> statement-breakpoint
CREATE INDEX "payroll_whatsapp_logs_meta_message_idx" ON "payroll_whatsapp_logs" USING btree ("meta_message_id");
--> statement-breakpoint
CREATE INDEX "payroll_whatsapp_logs_created_at_idx" ON "payroll_whatsapp_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "payroll_whatsapp_logs_status_idx" ON "payroll_whatsapp_logs" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_whatsapp_logs_dedupe_key_unique" ON "payroll_whatsapp_logs" USING btree ("dedupe_key");
