/**
 * PayslipDocument — react-pdf Document component for generating professional salary slips.
 *
 * Same component is used for both:
 *   - In-browser preview (via PDFViewer)
 *   - PDF download (via pdf().toBlob())
 *
 * Design: A4 portrait, professional typography, two-column salary table.
 * Font: Noto Sans (supports ₹ Indian Rupee Sign U+20B9)
 */
import { Document, Page, View, Text, Image, StyleSheet, Font } from '@react-pdf/renderer';
import { amountInWords, formatINRAmount } from '../amountInWords';

// ── Font registration ─────────────────────────────────────────────────────────
// Noto Sans fonts are served from the app's public directory (with ₹ glyph)
const BASE = window.location.origin;
Font.register({
  family: 'NotoSans',
  fonts: [
    { src: `${BASE}/fonts/NotoSans-Regular.ttf`, fontWeight: 'normal',  fontStyle: 'normal' },
    { src: `${BASE}/fonts/NotoSans-Regular.ttf`, fontWeight: 'normal',  fontStyle: 'italic' },
    { src: `${BASE}/fonts/NotoSans-Bold.ttf`,    fontWeight: 'bold',    fontStyle: 'normal' },
    { src: `${BASE}/fonts/NotoSans-Bold.ttf`,    fontWeight: 'bold',    fontStyle: 'italic' },
  ],
});

Font.registerHyphenationCallback(word => [word]); // disable hyphenation

// ── Types ─────────────────────────────────────────────────────────────────────
export interface PayslipRecord {
  id: number;
  employeeCode: string;
  employeeName: string;
  mobileNumber?: string | null;
  email?: string | null;
  designation?: string | null;
  branch?: string | null;
  joiningDate?: string | null;
  basic?: string | null;
  da?: string | null;
  hra?: string | null;
  otherEarnings?: string | null;
  grossSalary?: string | null;
  pfEmployee?: string | null;
  pfEmployer?: string | null;
  esiEmployee?: string | null;
  esiEmployer?: string | null;
  pt?: string | null;
  otherDeductions?: string | null;
  netSalary?: string | null;
  additionalComponents?: Record<string, string> | null;
}

export interface PayslipRun {
  payrollMonth: number;
  payrollYear: number;
}

export interface PayslipCompany {
  companyName: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  logoDataUrl?: string | null; // base64 or blob URL fetched client-side
}

// ── Helper: label formatting ──────────────────────────────────────────────────
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function toLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

const hasValue = (v: string | null | undefined): v is string =>
  v !== null && v !== undefined && v.trim() !== '' && v.trim() !== '0' && v.trim() !== '0.00';

// ── Build earnings/deductions rows ────────────────────────────────────────────
function buildRows(record: PayslipRecord) {
  const earnings: Array<{ label: string; amount: string }> = [];
  const deductions: Array<{ label: string; amount: string }> = [];

  // Standard earnings (only if value exists in record)
  if (record.basic !== null && record.basic !== undefined)        earnings.push({ label: 'Basic', amount: record.basic });
  if (record.da !== null && record.da !== undefined)              earnings.push({ label: 'DA', amount: record.da });
  if (record.hra !== null && record.hra !== undefined)            earnings.push({ label: 'HRA', amount: record.hra });
  if (record.otherEarnings !== null && record.otherEarnings !== undefined)
    earnings.push({ label: 'Other Earnings', amount: record.otherEarnings });

  // Additional components (unmapped Excel columns — shown as earnings by default)
  if (record.additionalComponents) {
    for (const [key, value] of Object.entries(record.additionalComponents)) {
      if (value !== null && value !== undefined) {
        earnings.push({ label: toLabel(key), amount: value });
      }
    }
  }

  // Standard deductions
  if (record.pfEmployee != null)  deductions.push({ label: 'PF - Employee (12%)',       amount: record.pfEmployee });
  if (record.pfEmployer != null)  deductions.push({ label: 'PF - Employer (12%)',         amount: record.pfEmployer });
  if (record.esiEmployee != null) deductions.push({ label: 'ESI - Employee (0.75%)',     amount: record.esiEmployee });
  if (record.esiEmployer != null) deductions.push({ label: 'ESI - Employer (3.25%)',     amount: record.esiEmployer });
  if (record.pt != null)          deductions.push({ label: 'PT',                         amount: record.pt });
  if (record.otherDeductions !== null && record.otherDeductions !== undefined)
    deductions.push({ label: 'Other Deductions', amount: record.otherDeductions });

  // Pad the shorter side so rows align
  const maxLen = Math.max(earnings.length, deductions.length);
  while (earnings.length < maxLen)   earnings.push({ label: '', amount: '' });
  while (deductions.length < maxLen) deductions.push({ label: '', amount: '' });

  return { earnings, deductions };
}

// ── Styles ────────────────────────────────────────────────────────────────────
const BRAND = '#1a2a4a';
const ACCENT = '#2563eb';
const LIGHT_GRAY = '#f3f4f6';
const BORDER = '#d1d5db';
const TEXT_DARK = '#111827';
const TEXT_MID = '#374151';
const TEXT_MUTED = '#6b7280';

const styles = StyleSheet.create({
  page: {
    fontFamily: 'NotoSans',
    fontSize: 9,
    color: TEXT_DARK,
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 44,
    backgroundColor: '#ffffff',
  },

  // ── Header ──
  header: { alignItems: 'center', marginBottom: 14 },
  logo: { width: 56, height: 56, marginBottom: 6, objectFit: 'contain' },
  companyName: { fontSize: 15, fontWeight: 'bold', color: BRAND, textAlign: 'center', marginBottom: 2 },
  companySubLine: { fontSize: 8, color: TEXT_MUTED, textAlign: 'center' },

  // ── Title ──
  titleBox: {
    backgroundColor: BRAND,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
    alignItems: 'center',
  },
  titleText: { fontSize: 12, fontWeight: 'bold', color: '#ffffff', letterSpacing: 1 },
  titlePeriod: { fontSize: 9, color: '#c7d2fe', marginTop: 2 },

  // ── Employee details ──
  empBox: {
    border: 1,
    borderColor: BORDER,
    borderRadius: 3,
    marginBottom: 12,
    padding: 10,
    backgroundColor: LIGHT_GRAY,
  },
  empGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  empField: { width: '50%', marginBottom: 4, flexDirection: 'row' },
  empLabel: { width: 90, fontSize: 8, color: TEXT_MUTED, fontWeight: 'bold' },
  empValue: { flex: 1, fontSize: 8.5, color: TEXT_DARK },

  // ── Salary table ──
  table: { border: 1, borderColor: BORDER, borderRadius: 3, marginBottom: 12 },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: BRAND,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  tableRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: BORDER },
  tableRowAlt: { backgroundColor: '#f9fafb' },
  tableTotalRow: { flexDirection: 'row', borderTopWidth: 1.5, borderTopColor: BRAND, backgroundColor: LIGHT_GRAY },

  cellEarLabel: { flex: 2.5, padding: 5 },
  cellEarAmt:   { flex: 1.2, padding: 5, textAlign: 'right', borderLeftWidth: 0.5, borderLeftColor: BORDER },
  cellSep:      { width: 1, backgroundColor: '#9ca3af' },
  cellDedLabel: { flex: 2.5, padding: 5 },
  cellDedAmt:   { flex: 1.2, padding: 5, textAlign: 'right', borderLeftWidth: 0.5, borderLeftColor: BORDER },

  tableHeaderText: { fontSize: 8, fontWeight: 'bold', color: '#ffffff' },
  tableCellText:   { fontSize: 8.5, color: TEXT_MID },
  tableTotalText:  { fontSize: 8.5, fontWeight: 'bold', color: TEXT_DARK },

  // ── Net salary ──
  netBox: {
    border: 1.5,
    borderColor: ACCENT,
    borderRadius: 4,
    padding: 12,
    marginBottom: 12,
    alignItems: 'center',
    backgroundColor: '#eff6ff',
  },
  netLabel: { fontSize: 9, color: ACCENT, fontWeight: 'bold', letterSpacing: 0.5, marginBottom: 4 },
  netAmount: { fontSize: 18, fontWeight: 'bold', color: BRAND, marginBottom: 4 },
  netWords: { fontSize: 8, color: TEXT_MID, textAlign: 'center', fontStyle: 'italic' },

  // ── Footer ──
  footer: { borderTopWidth: 0.5, borderTopColor: BORDER, paddingTop: 8, marginTop: 4 },
  footerText: { fontSize: 7.5, color: TEXT_MUTED, textAlign: 'center' },
});

// ── Component ─────────────────────────────────────────────────────────────────
interface Props {
  record: PayslipRecord;
  run: PayslipRun;
  company: PayslipCompany;
}

export function PayslipDocument({ record, run, company }: Props) {
  const monthYear = `${MONTH_NAMES[run.payrollMonth - 1]} ${run.payrollYear}`;
  const { earnings, deductions } = buildRows(record);
  const maxRows = earnings.length;

  const subLineParts = [company.phone, company.email, company.website].filter(Boolean);

  // Employee detail fields (only show non-empty)
  const empFields: Array<[string, string]> = [
    ['Employee ID', record.employeeCode],
    ['Employee Name', record.employeeName],
    ...(record.designation ? [['Designation', record.designation] as [string,string]] : []),
    ...(record.branch      ? [['Branch', record.branch]           as [string,string]] : []),
    ...(record.joiningDate ? [['Joining Date', record.joiningDate] as [string,string]] : []),
    ...(record.mobileNumber ? [['Mobile', record.mobileNumber]    as [string,string]] : []),
  ];

  return (
    <Document
      title={`Salary Slip — ${record.employeeCode} — ${monthYear}`}
      author={company.companyName}
      subject="Salary Slip"
    >
      <Page size="A4" orientation="portrait" style={styles.page}>

        {/* ── HEADER ── */}
        <View style={styles.header}>
          {company.logoDataUrl ? (
            <Image src={company.logoDataUrl} style={styles.logo} />
          ) : null}
          <Text style={styles.companyName}>{company.companyName}</Text>
          {company.address ? (
            <Text style={styles.companySubLine}>{company.address}</Text>
          ) : null}
          {subLineParts.length > 0 ? (
            <Text style={styles.companySubLine}>{subLineParts.join('  |  ')}</Text>
          ) : null}
        </View>

        {/* ── TITLE ── */}
        <View style={styles.titleBox}>
          <Text style={styles.titleText}>SALARY SLIP</Text>
          <Text style={styles.titlePeriod}>{monthYear}</Text>
        </View>

        {/* ── EMPLOYEE DETAILS ── */}
        <View style={styles.empBox}>
          <View style={styles.empGrid}>
            {empFields.map(([label, value]) => (
              <View key={label} style={styles.empField}>
                <Text style={styles.empLabel}>{label}</Text>
                <Text style={styles.empValue}>:  {value}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── SALARY TABLE ── */}
        <View style={styles.table}>
          {/* Header */}
          <View style={styles.tableHeaderRow}>
            <View style={styles.cellEarLabel}><Text style={styles.tableHeaderText}>EARNINGS</Text></View>
            <View style={styles.cellEarAmt}><Text style={[styles.tableHeaderText, { textAlign: 'right' }]}>AMOUNT</Text></View>
            <View style={styles.cellSep} />
            <View style={styles.cellDedLabel}><Text style={styles.tableHeaderText}>DEDUCTIONS</Text></View>
            <View style={styles.cellDedAmt}><Text style={[styles.tableHeaderText, { textAlign: 'right' }]}>AMOUNT</Text></View>
          </View>

          {/* Data rows */}
          {Array.from({ length: maxRows }).map((_, i) => {
            const ern = earnings[i];
            const ded = deductions[i];
            return (
              <View key={i} style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}>
                <View style={styles.cellEarLabel}>
                  <Text style={styles.tableCellText}>{ern?.label ?? ''}</Text>
                </View>
                <View style={styles.cellEarAmt}>
                  <Text style={styles.tableCellText}>
                    {ern?.amount ? formatINRAmount(ern.amount) : ''}
                  </Text>
                </View>
                <View style={styles.cellSep} />
                <View style={styles.cellDedLabel}>
                  <Text style={styles.tableCellText}>{ded?.label ?? ''}</Text>
                </View>
                <View style={styles.cellDedAmt}>
                  <Text style={styles.tableCellText}>
                    {ded?.amount ? formatINRAmount(ded.amount) : ''}
                  </Text>
                </View>
              </View>
            );
          })}

          {/* Totals row */}
          <View style={styles.tableTotalRow}>
            <View style={styles.cellEarLabel}><Text style={styles.tableTotalText}>TOTAL EARNINGS</Text></View>
            <View style={styles.cellEarAmt}>
              <Text style={styles.tableTotalText}>{formatINRAmount(record.grossSalary)}</Text>
            </View>
            <View style={styles.cellSep} />
            <View style={styles.cellDedLabel}><Text style={styles.tableTotalText}>TOTAL DEDUCTIONS</Text></View>
            <View style={styles.cellDedAmt}>
              {/* Sum all deduction columns */}
              <Text style={styles.tableTotalText}>
                {formatINRAmount(
                  [record.pfEmployee, record.pfEmployer, record.esiEmployee, record.esiEmployer, record.pt, record.otherDeductions]
                    .filter((v): v is string => v !== null && v !== undefined)
                    .reduce((sum, v) => sum + parseFloat(v || '0'), 0)
                    .toFixed(2)
                )}
              </Text>
            </View>
          </View>
        </View>

        {/* ── NET SALARY ── */}
        <View style={styles.netBox}>
          <Text style={styles.netLabel}>NET SALARY</Text>
          <Text style={styles.netAmount}>{formatINRAmount(record.netSalary)}</Text>
          <Text style={styles.netWords}>{amountInWords(record.netSalary)}</Text>
        </View>

        {/* ── FOOTER ── */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            This is a computer-generated salary slip and does not require a signature.
          </Text>
        </View>

      </Page>
    </Document>
  );
}

/** Sanitize a string for use in a filename */
export function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').trim();
}

/** Build the standard payslip PDF filename */
export function payslipFilename(record: PayslipRecord, run: PayslipRun): string {
  const month = MONTH_NAMES[run.payrollMonth - 1];
  return `${sanitizeFilename(record.employeeCode)}_${sanitizeFilename(record.employeeName)}_${month}_${run.payrollYear}.pdf`;
}
