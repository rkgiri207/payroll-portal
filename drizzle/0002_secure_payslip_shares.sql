CREATE TABLE "payslip_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "payroll_record_id" integer NOT NULL,
  "token_hash" text NOT NULL,
  "token_ciphertext" text NOT NULL,
  "storage_path" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked" boolean DEFAULT false NOT NULL,
  "revoked_at" timestamp with time zone,
  "access_count" integer DEFAULT 0 NOT NULL,
  "last_accessed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payslip_shares_payroll_record_id_payroll_records_id_fk"
    FOREIGN KEY ("payroll_record_id") REFERENCES "public"."payroll_records"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_shares_payroll_record_id_unique" ON "payslip_shares" USING btree ("payroll_record_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_shares_token_hash_unique" ON "payslip_shares" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "payslip_shares_expiry_idx" ON "payslip_shares" USING btree ("expires_at");
