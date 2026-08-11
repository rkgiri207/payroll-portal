import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query(
    `select exists(select 1 from payroll_records where employee_code = 'TEST001') as record_exists,
            exists(select 1 from payslip_shares) as any_share`,
  );
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucketResponse = await fetch(
    `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/bucket/payslips`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  const bucket = await bucketResponse.json();
  console.log(JSON.stringify({
    underlyingSyntheticPayrollRecordRetained: result.rows[0].record_exists,
    payslipsBucketPrivate: bucketResponse.ok && bucket.public === false,
    noResidualShareRows: !result.rows[0].any_share,
  }));
} finally {
  await pool.end();
}
