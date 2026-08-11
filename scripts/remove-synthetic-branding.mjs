import crypto from 'node:crypto';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const expectedLogoHash = crypto
  .createHash('sha256')
  .update(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ))
  .digest('hex');

try {
  const result = await pool.query(
    'select id, address, email, logo_path from company_settings order by id limit 1',
  );
  if (result.rowCount !== 1) throw new Error('Company settings are missing');
  const settings = result.rows[0];
  let syntheticLogo = false;
  let storageLocation = null;

  if (settings.logo_path?.startsWith('/objects/company-assets/')) {
    const parts = settings.logo_path.replace(/^\/objects\//, '').split('/');
    const bucket = parts.shift();
    const objectPath = parts.map(encodeURIComponent).join('/');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const objectUrl = `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`;
    const response = await fetch(objectUrl, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (response.ok) {
      const actualHash = crypto
        .createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex');
      syntheticLogo = actualHash === expectedLogoHash;
      if (syntheticLogo) storageLocation = { objectUrl, key };
    }
  }

  const clearedAddress = settings.address === 'Synthetic DEV Address';
  const clearedEmail = settings.email === 'company@payroll-portal.invalid';
  await pool.query(
    `update company_settings set
       address = case when address = 'Synthetic DEV Address' then null else address end,
       email = case when email = 'company@payroll-portal.invalid' then null else email end,
       logo_path = case when $2::boolean then null else logo_path end,
       updated_at = now()
     where id = $1`,
    [settings.id, syntheticLogo],
  );

  if (storageLocation) {
    const response = await fetch(storageLocation.objectUrl, {
      method: 'DELETE',
      headers: {
        apikey: storageLocation.key,
        Authorization: `Bearer ${storageLocation.key}`,
      },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to remove synthetic logo object (${response.status})`);
    }
  }

  console.log(JSON.stringify({ clearedAddress, clearedEmail, clearedSyntheticLogo: syntheticLogo }));
} finally {
  await pool.end();
}
