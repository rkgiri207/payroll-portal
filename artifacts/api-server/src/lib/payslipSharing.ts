import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { and, eq, lte, or } from 'drizzle-orm';
import { db } from '@workspace/db';
import {
  companySettingsTable,
  payrollRecordsTable,
  payrollRunsTable,
  payslipGenerationsTable,
  payslipSharesTable,
} from '@workspace/db/schema';
import {
  PayslipDocument,
  payslipFilename,
  registerPayslipFonts,
} from '../../../payroll-portal/src/lib/payslip/PayslipDocument';
import { ObjectNotFoundError, ObjectStorageService, STORAGE_BUCKETS } from './objectStorage';

const SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const storage = new ObjectStorageService();

function payslipFontPath(filename: string): string {
  const candidates = [
    path.resolve(process.cwd(), '../payroll-portal/public/fonts', filename),
    path.resolve(process.cwd(), 'artifacts/payroll-portal/public/fonts', filename),
  ];
  const fontPath = candidates.find(candidate => existsSync(candidate));
  if (!fontPath) throw new Error(`Payslip font is missing from the deployment: ${filename}`);
  return fontPath;
}

function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('SESSION_SECRET environment variable is required');
  return value;
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(`payslip-share-token\0${sessionSecret()}`, 'utf8').digest();
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}

function decryptToken(value: string): string {
  const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted share token');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function shareUrl(token: string): string {
  const base = process.env.APP_BASE_URL?.replace(/\/$/, '');
  if (!base) throw new Error('APP_BASE_URL environment variable is required');
  return `${base}/p/${token}`;
}

async function logoDataUrl(logoPath: string | null): Promise<string | null> {
  if (!logoPath) return null;
  const file = await storage.getObjectEntityFile(logoPath, STORAGE_BUCKETS.companyAssets);
  const [buffer] = await file.download();
  const extension = logoPath.toLowerCase().split('.').pop();
  const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function renderPayslip(payrollRecordId: number): Promise<{ buffer: Buffer; filename: string; runId: number }> {
  const [row] = await db
    .select({ record: payrollRecordsTable, run: payrollRunsTable })
    .from(payrollRecordsTable)
    .innerJoin(payrollRunsTable, eq(payrollRecordsTable.payrollRunId, payrollRunsTable.id))
    .where(eq(payrollRecordsTable.id, payrollRecordId));
  if (!row) throw new Error('Payroll record not found');

  const [company] = await db.select().from(companySettingsTable).limit(1);
  if (!company) throw new Error('Company settings are required before sharing a payslip');

  registerPayslipFonts(
    payslipFontPath('NotoSans-Regular.ttf'),
    payslipFontPath('NotoSans-Bold.ttf'),
  );
  const run = { payrollMonth: row.run.payrollMonth, payrollYear: row.run.payrollYear };
  const document = React.createElement(PayslipDocument, {
    record: row.record,
    run,
    company: {
      companyName: company.companyName,
      address: company.address,
      phone: company.phone,
      email: company.email,
      website: company.website,
      logoDataUrl: await logoDataUrl(company.logoPath),
    },
  });
  return {
    buffer: await renderToBuffer(document as React.ReactElement<any>),
    filename: payslipFilename(row.record, run),
    runId: row.run.id,
  };
}

export async function createPayslipShare(payrollRecordId: number, forceNew = false) {
  const now = new Date();
  const [existing] = await db.select().from(payslipSharesTable)
    .where(eq(payslipSharesTable.payrollRecordId, payrollRecordId));
  if (!forceNew && existing && !existing.revoked && existing.expiresAt > now) {
    try {
      await storage.getObjectEntityFile(existing.storagePath, STORAGE_BUCKETS.payslips);
      const token = decryptToken(existing.tokenCiphertext);
      return { url: shareUrl(token), expiresAt: existing.expiresAt, reused: true };
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }
  }

  const rendered = await renderPayslip(payrollRecordId);
  const token = randomBytes(32).toString('base64url');
  const objectName = `shares/${rendered.runId}/${payrollRecordId}/${randomUUID()}.pdf`;
  const storagePath = await storage.uploadObject(STORAGE_BUCKETS.payslips, objectName, rendered.buffer, 'application/pdf');
  const expiresAt = new Date(now.getTime() + SHARE_LIFETIME_MS);

  try {
    await db.insert(payslipSharesTable).values({
      payrollRecordId,
      tokenHash: hashShareToken(token),
      tokenCiphertext: encryptToken(token),
      storagePath,
      expiresAt,
    }).onConflictDoUpdate({
      target: payslipSharesTable.payrollRecordId,
      set: {
        tokenHash: hashShareToken(token), tokenCiphertext: encryptToken(token), storagePath,
        expiresAt, revoked: false, revokedAt: null, accessCount: 0, lastAccessedAt: null, updatedAt: now,
      },
    });
  } catch (error) {
    await storage.deleteObject(storagePath, STORAGE_BUCKETS.payslips).catch(() => undefined);
    throw error;
  }

  if (existing?.storagePath && existing.storagePath !== storagePath) {
    await storage.deleteObject(existing.storagePath, STORAGE_BUCKETS.payslips).catch(() => undefined);
  }
  await db.insert(payslipGenerationsTable).values({
    payrollRecordId, payrollRunId: rendered.runId, status: 'GENERATED', generatedAt: now,
  }).onConflictDoUpdate({
    target: payslipGenerationsTable.payrollRecordId,
    set: { status: 'GENERATED', generatedAt: now, errorMessage: null, updatedAt: now },
  });
  return { url: shareUrl(token), expiresAt, reused: false, filename: rendered.filename };
}

export async function findPayslipShare(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [share] = await db.select().from(payslipSharesTable)
    .where(eq(payslipSharesTable.tokenHash, hashShareToken(token)));
  return share ?? null;
}

export async function recordShareAccess(id: number): Promise<void> {
  const [share] = await db.select().from(payslipSharesTable).where(eq(payslipSharesTable.id, id));
  if (!share) return;
  await db.update(payslipSharesTable).set({ accessCount: share.accessCount + 1, lastAccessedAt: new Date() })
    .where(eq(payslipSharesTable.id, id));
}

export async function cleanupExpiredPayslipShares(limit = 100): Promise<number> {
  const rows = await db.select().from(payslipSharesTable)
    .where(or(lte(payslipSharesTable.expiresAt, new Date()), eq(payslipSharesTable.revoked, true)))
    .limit(Math.max(1, Math.min(limit, 500)));
  let cleaned = 0;
  for (const row of rows) {
    try {
      await storage.deleteObject(row.storagePath, STORAGE_BUCKETS.payslips);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) continue;
    }
    await db.delete(payslipSharesTable).where(and(eq(payslipSharesTable.id, row.id), eq(payslipSharesTable.storagePath, row.storagePath)));
    cleaned++;
  }
  return cleaned;
}

export { storage as payslipStorage };
