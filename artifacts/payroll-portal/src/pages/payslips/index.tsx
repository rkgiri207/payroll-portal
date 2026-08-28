/**
 * Payslips Page — Stage 3
 *
 * Workflow:
 *   Select Payroll Run → view employees → preview/download individual payslips
 *   → bulk generate all → download ZIP
 *
 * PDF generation: client-side via @react-pdf/renderer (same component for preview + download)
 * ZIP: jszip
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { pdf, PDFViewer } from '@react-pdf/renderer';
import JSZip from 'jszip';
import {
  useListPayrollRuns,
  useGetPayrollRun,
  useGetCompanySettings,
  sendTestPayrollWhatsApp,
} from '@workspace/api-client-react';
import { formatDateTime, formatINR, monthName } from '@/lib/format';
import {
  PayslipDocument,
  type PayslipRecord,
  type PayslipCompany,
  payslipFilename,
} from '@/lib/payslip/PayslipDocument';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  FileDown, RefreshCw, Eye, Download, Archive, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Share2, Copy, Check, MessageCircle,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type GenerationStatus = 'NOT_GENERATED' | 'GENERATED' | 'FAILED';

interface StatusEntry {
  status: GenerationStatus;
  generatedAt?: string | null;
  errorMessage?: string | null;
}

interface BulkProgress {
  current: number;
  total: number;
  failures: Array<{ employeeCode: string; employeeName: string; error: string }>;
  done: boolean;
}

interface ShareLink {
  url: string;
  expiresAt: string;
}

interface WhatsAppSendResult {
  status: 'SENT' | 'FAILED';
  recipient?: string;
  template?: string;
  metaMessageId?: string;
  timestamp?: string;
  error?: string;
  code?: string;
}

interface WhatsAppBatchPreview {
  selected: number;
  validMobile: number;
  alreadySent: number;
  willSend: number;
  records: Array<{ payrollRecordId: number; eligible: boolean; reason?: string; code?: string; status?: string | null }>;
}

interface WhatsAppBatchResult {
  batchId: string;
  total: number;
  sent: number;
  failed: number;
  pending: number;
  skipped: number;
  results: Array<{ payrollRecordId: number; status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED'; code?: string; error?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = '/api';

async function fetchLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/company-settings/logo`, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const maxDimension = 512;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

async function fetchPayslipStatuses(runId: number): Promise<Map<number, StatusEntry>> {
  try {
    const res = await fetch(`${API_BASE}/payroll-runs/${runId}/payslip-statuses`, { credentials: 'include' });
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map<number, StatusEntry>();
    for (const s of data.statuses ?? []) {
      map.set(s.payrollRecordId, { status: s.status, generatedAt: s.generatedAt, errorMessage: s.errorMessage });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function savePayslipStatuses(runId: number, updates: Array<{ payrollRecordId: number; status: GenerationStatus; errorMessage?: string | null }>) {
  const res = await fetch(`${API_BASE}/payroll-runs/${runId}/payslip-statuses`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? 'Failed to save payslip generation status');
  }
}

async function postWhatsAppBatch<T>(path: 'preview' | 'send', body: object): Promise<T> {
  const response = await fetch(`${API_BASE}/payroll-whatsapp/batch/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(payload?.error ?? 'WhatsApp batch request failed'), { code: payload?.code });
  return payload;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: GenerationStatus }) {
  if (status === 'GENERATED')     return <Badge className="bg-green-600 text-white hover:bg-green-700 gap-1"><CheckCircle2 className="h-3 w-3" />Generated</Badge>;
  if (status === 'FAILED')        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Failed</Badge>;
  return <Badge variant="secondary" className="gap-1 text-muted-foreground">Not Generated</Badge>;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PayslipsPage() {
  const [locationPath] = useLocation();
  const { toast } = useToast();

  // Parse ?runId from URL
  const searchStr = typeof window !== 'undefined' ? window.location.search : '';
  const urlRunId = new URLSearchParams(searchStr).get('runId');
  const defaultRunId = urlRunId ? parseInt(urlRunId, 10) : undefined;

  const [selectedRunId, setSelectedRunId] = useState<number | undefined>(defaultRunId);
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<Map<number, StatusEntry>>(new Map());
  const [logoDataUrl, setLogoDataUrl] = useState<string | undefined>(undefined);
  const [logoFetched, setLogoFetched] = useState(false);
  const [previewRecord, setPreviewRecord] = useState<PayslipRecord | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const [sharingId, setSharingId] = useState<number | null>(null);
  const [shareLinks, setShareLinks] = useState<Map<number, ShareLink>>(new Map());
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [whatsAppRecord, setWhatsAppRecord] = useState<PayslipRecord | null>(null);
  const [whatsAppSending, setWhatsAppSending] = useState(false);
  const [whatsAppResult, setWhatsAppResult] = useState<WhatsAppSendResult | null>(null);
  const [selectedWhatsAppIds, setSelectedWhatsAppIds] = useState<Set<number>>(new Set());
  const [whatsAppBatchOpen, setWhatsAppBatchOpen] = useState(false);
  const [whatsAppBatchLoading, setWhatsAppBatchLoading] = useState(false);
  const [whatsAppBatchPreview, setWhatsAppBatchPreview] = useState<WhatsAppBatchPreview | null>(null);
  const [whatsAppBatchResult, setWhatsAppBatchResult] = useState<WhatsAppBatchResult | null>(null);
  const [whatsAppBatchOverride, setWhatsAppBatchOverride] = useState(false);
  const [whatsAppBatchProcessed, setWhatsAppBatchProcessed] = useState(0);
  const abortRef = useRef(false);

  // ── Queries ─────────────────────────────────────────────────────────────────
  const { data: runsData } = useListPayrollRuns({ limit: 100 });
  const { data: runDetail, isLoading: runLoading } = useGetPayrollRun(
    selectedRunId ?? 0,
    { query: { enabled: !!selectedRunId, queryKey: ['payrollRun', selectedRunId] } },
  );
  const { data: companyData } = useGetCompanySettings();

  // ── Fetch logo once when company data available ──────────────────────────────
  useEffect(() => {
    if (!companyData || logoFetched) return;
    setLogoFetched(true);
    if (companyData.logoPath) {
      fetchLogoDataUrl().then(url => setLogoDataUrl(url ?? undefined));
    }
  }, [companyData, logoFetched]);

  // ── Fetch payslip statuses when run changes ───────────────────────────────
  useEffect(() => {
    if (!selectedRunId) return;
    fetchPayslipStatuses(selectedRunId).then(setStatuses);
  }, [selectedRunId]);

  // ── Build company object ───────────────────────────────────────────────────
  const company: PayslipCompany = {
    companyName: companyData?.companyName ?? 'Company',
    address: companyData?.address ?? null,
    phone: companyData?.phone ?? null,
    email: companyData?.email ?? null,
    website: companyData?.website ?? null,
    logoDataUrl: logoDataUrl ?? null,
  };

  const run = runDetail
    ? { payrollMonth: runDetail.payrollMonth, payrollYear: runDetail.payrollYear }
    : null;

  // ── Filter records ─────────────────────────────────────────────────────────
  const records: PayslipRecord[] = (runDetail?.records ?? []) as PayslipRecord[];
  const filtered = search.trim()
    ? records.filter(r =>
        r.employeeCode.toLowerCase().includes(search.toLowerCase()) ||
        r.employeeName.toLowerCase().includes(search.toLowerCase()),
      )
    : records;

  // ── Generate single PDF ────────────────────────────────────────────────────
  const generatePdf = useCallback(async (record: PayslipRecord): Promise<Blob> => {
    if (!run) throw new Error('No run selected');
    const blob = await pdf(
      <PayslipDocument record={record} run={run} company={company} />,
    ).toBlob();
    return blob;
  }, [run, company]);

  // ── Preview ────────────────────────────────────────────────────────────────
  const handlePreview = (record: PayslipRecord) => {
    setPreviewRecord(record);
    setPreviewOpen(true);
  };

  // ── Individual download ────────────────────────────────────────────────────
  const handleDownload = async (record: PayslipRecord) => {
    if (!run) return;
    setGeneratingId(record.id);
    try {
      const blob = await generatePdf(record);
      triggerDownload(blob, payslipFilename(record, run));
      const update = { status: 'GENERATED' as GenerationStatus };
      setStatuses(prev => new Map(prev).set(record.id, update));
      await savePayslipStatuses(selectedRunId!, [{ payrollRecordId: record.id, status: 'GENERATED' }]);
    } catch (err: any) {
      toast({ title: 'PDF generation failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      const update = { status: 'FAILED' as GenerationStatus, errorMessage: err?.message };
      setStatuses(prev => new Map(prev).set(record.id, update));
      await savePayslipStatuses(selectedRunId!, [{ payrollRecordId: record.id, status: 'FAILED', errorMessage: err?.message }]);
    } finally {
      setGeneratingId(null);
    }
  };

  const handleShare = async (record: PayslipRecord) => {
    const current = shareLinks.get(record.id);
    const forceNew = !!current;
    if (forceNew && !window.confirm('Create a new link? The previous link will stop working.')) return;
    setSharingId(record.id);
    try {
      const response = await fetch(`${API_BASE}/payroll-records/${record.id}/share-link`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceNew }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? 'Failed to create share link');
      setShareLinks(previous => new Map(previous).set(record.id, body));
      await navigator.clipboard.writeText(body.url);
      setCopiedId(record.id);
      setTimeout(() => setCopiedId(id => id === record.id ? null : id), 2000);
      toast({ title: body.reused ? 'Share link copied' : 'Secure share link created', description: `Expires ${new Date(body.expiresAt).toLocaleString()}` });
    } catch (error) {
      toast({ title: 'Share link failed', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSharingId(null);
    }
  };

  const copyShare = async (recordId: number) => {
    const link = shareLinks.get(recordId);
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopiedId(recordId);
    setTimeout(() => setCopiedId(id => id === recordId ? null : id), 2000);
  };

  const openWhatsAppConfirmation = (record: PayslipRecord) => {
    setWhatsAppRecord(record);
    setWhatsAppResult(null);
  };

  const handleWhatsAppSend = async () => {
    if (!whatsAppRecord) return;
    setWhatsAppSending(true);
    setWhatsAppResult(null);
    try {
      setWhatsAppResult(await sendTestPayrollWhatsApp(whatsAppRecord.id));
    } catch (error) {
      const body = (error as any)?.data;
      setWhatsAppResult({
        status: 'FAILED',
        error: body?.error ?? (error instanceof Error ? error.message : 'WhatsApp send failed'),
        code: body?.code,
      });
    } finally {
      setWhatsAppSending(false);
    }
  };

  const openWhatsAppBatch = async (ids: number[], override = false) => {
    if (ids.length === 0) return;
    setWhatsAppBatchOpen(true);
    setWhatsAppBatchLoading(true);
    setWhatsAppBatchPreview(null);
    setWhatsAppBatchResult(null);
    setWhatsAppBatchOverride(override);
    setWhatsAppBatchProcessed(0);
    try {
      setWhatsAppBatchPreview(await postWhatsAppBatch<WhatsAppBatchPreview>('preview', { recordIds: ids, override }));
    } catch (error) {
      toast({ title: 'WhatsApp validation failed', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
      setWhatsAppBatchOpen(false);
    } finally {
      setWhatsAppBatchLoading(false);
    }
  };

  const handleWhatsAppBatchSend = async () => {
    if (!whatsAppBatchPreview?.willSend) return;
    const ids = whatsAppBatchPreview.records.filter(record => record.eligible).map(record => record.payrollRecordId);
    setWhatsAppBatchLoading(true);
    setWhatsAppBatchProcessed(0);
    try {
      const requestId = crypto.randomUUID();
      const combined: WhatsAppBatchResult = { batchId: requestId, total: ids.length, sent: 0, failed: 0, pending: 0, skipped: 0, results: [] };
      for (let offset = 0; offset < ids.length; offset += 10) {
        const result = await postWhatsAppBatch<WhatsAppBatchResult>('send', {
          recordIds: ids.slice(offset, offset + 10),
          requestId,
          override: whatsAppBatchOverride,
        });
        combined.sent += result.sent;
        combined.failed += result.failed;
        combined.pending += result.pending;
        combined.skipped += result.skipped;
        combined.results.push(...result.results);
        setWhatsAppBatchProcessed(Math.min(offset + 10, ids.length));
      }
      setWhatsAppBatchResult(combined);
      setSelectedWhatsAppIds(new Set());
    } catch (error) {
      toast({ title: 'Bulk WhatsApp send failed', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setWhatsAppBatchLoading(false);
    }
  };

  // ── Generate all + ZIP ─────────────────────────────────────────────────────
  const handleGenerateAll = async (downloadZip = false) => {
    if (!run || !selectedRunId || records.length === 0) return;
    abortRef.current = false;
    if (downloadZip) setIsDownloadingAll(true);
    else setIsGeneratingAll(true);

    const progress: BulkProgress = { current: 0, total: records.length, failures: [], done: false };
    setBulkProgress({ ...progress });

    const zip = downloadZip ? new JSZip() : null;
    const batchUpdates: Array<{ payrollRecordId: number; status: GenerationStatus; errorMessage?: string | null }> = [];

    for (const record of records) {
      if (abortRef.current) break;

      try {
        const blob = await generatePdf(record);
        const filename = payslipFilename(record, run);
        if (zip) zip.file(filename, blob);

        setStatuses(prev => new Map(prev).set(record.id, { status: 'GENERATED' }));
        batchUpdates.push({ payrollRecordId: record.id, status: 'GENERATED' });
      } catch (err: any) {
        const errorMessage = err?.message ?? 'Unknown error';
        progress.failures.push({ employeeCode: record.employeeCode, employeeName: record.employeeName, error: errorMessage });
        setStatuses(prev => new Map(prev).set(record.id, { status: 'FAILED', errorMessage }));
        batchUpdates.push({ payrollRecordId: record.id, status: 'FAILED', errorMessage });
      }

      progress.current++;
      setBulkProgress({ ...progress });
      // Yield to UI thread
      await new Promise(r => setTimeout(r, 0));
    }

    // Save all status updates to server
    if (batchUpdates.length > 0) {
      await savePayslipStatuses(selectedRunId, batchUpdates);
    }

    // Download ZIP if requested
    if (zip && !abortRef.current) {
      try {
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const month = ['January','February','March','April','May','June','July','August','September','October','November','December'][run.payrollMonth - 1];
        triggerDownload(zipBlob, `${month}_${run.payrollYear}_Payslips.zip`);
      } catch (err: any) {
        toast({ title: 'ZIP generation failed', description: err?.message, variant: 'destructive' });
      }
    }

    progress.done = true;
    setBulkProgress({ ...progress });
    setIsGeneratingAll(false);
    setIsDownloadingAll(false);
  };

  const isBusy = isGeneratingAll || isDownloadingAll || whatsAppBatchLoading;
  const visibleIds = filtered.map(record => record.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedWhatsAppIds.has(id));

  // ── Render ─────────────────────────────────────────────────────────────────
  const activeRuns = [...(runsData?.runs?.filter(r => r.status !== 'CANCELLED') ?? [])]
    .sort((a, b) => new Date(b.uploadTimestamp ?? b.createdAt).getTime() - new Date(a.uploadTimestamp ?? a.createdAt).getTime());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Payslips</h1>
        <p className="text-muted-foreground mt-1">
          Generate and download salary slips for any imported payroll run.
        </p>
      </div>

      {/* Run selector */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Select Payroll Run</CardTitle>
        </CardHeader>
        <CardContent>
          <Select
            value={selectedRunId?.toString() ?? ''}
            onValueChange={v => {
              setSelectedRunId(Number(v));
              setSearch('');
              setStatuses(new Map());
              setSelectedWhatsAppIds(new Set());
              setBulkProgress(null);
            }}
          >
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Choose a payroll run…" />
            </SelectTrigger>
            <SelectContent>
              {activeRuns.map(r => (
                <SelectItem key={r.id} value={r.id.toString()}>
                  <span className="mr-2 text-xs text-muted-foreground">{formatDateTime(r.uploadTimestamp ?? r.createdAt)}</span>
                  {monthName(r.payrollMonth)} {r.payrollYear} — {r.employeeCount} employees
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Main content */}
      {selectedRunId && (
        <>
          {runLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : runDetail ? (
            <>
              {/* Bulk action bar */}
              <Card>
                <CardContent className="pt-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex-1">
                      <p className="font-medium">
                        {monthName(runDetail.payrollMonth)} {runDetail.payrollYear}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {records.length} employees · Gross: {formatINR(runDetail.totalGross)} · Net: {formatINR(runDetail.totalNet)}
                      </p>
                    </div>
                    <Button
                      onClick={() => void openWhatsAppBatch([...selectedWhatsAppIds])}
                      disabled={isBusy || selectedWhatsAppIds.size === 0}
                      variant="outline"
                    >
                      {whatsAppBatchLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-2 h-4 w-4" />}
                      Send WhatsApp Payslips ({selectedWhatsAppIds.size})
                    </Button>
                    <Button
                      onClick={() => handleGenerateAll(false)}
                      disabled={isBusy || records.length === 0}
                      variant="outline"
                    >
                      {isGeneratingAll ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating…</>
                      ) : (
                        <><RefreshCw className="mr-2 h-4 w-4" />Generate All Payslips</>
                      )}
                    </Button>
                    <Button
                      onClick={() => handleGenerateAll(true)}
                      disabled={isBusy || records.length === 0}
                    >
                      {isDownloadingAll ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Building ZIP…</>
                      ) : (
                        <><Archive className="mr-2 h-4 w-4" />Download All as ZIP</>
                      )}
                    </Button>
                  </div>

                  {/* Bulk progress */}
                  {bulkProgress && (
                    <div className="mt-4 space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          {bulkProgress.done
                            ? `Done: ${bulkProgress.current - bulkProgress.failures.length} generated, ${bulkProgress.failures.length} failed`
                            : `Processing ${bulkProgress.current} / ${bulkProgress.total}…`}
                        </span>
                        <span className="font-medium">{Math.round((bulkProgress.current / bulkProgress.total) * 100)}%</span>
                      </div>
                      <Progress value={(bulkProgress.current / bulkProgress.total) * 100} />
                      {bulkProgress.failures.length > 0 && (
                        <div className="mt-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded-md">
                          <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-1">Failures:</p>
                          {bulkProgress.failures.map((f, i) => (
                            <p key={i} className="text-xs text-red-700 dark:text-red-300">
                              {f.employeeCode} — {f.employeeName}: {f.error}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Search + table */}
              <div className="space-y-3">
                <Input
                  placeholder="Search by Employee ID or Name…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="max-w-sm"
                />

                <div className="border rounded-md overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={allVisibleSelected ? true : selectedWhatsAppIds.size > 0 && visibleIds.some(id => selectedWhatsAppIds.has(id)) ? 'indeterminate' : false}
                            onCheckedChange={checked => setSelectedWhatsAppIds(previous => {
                              const next = new Set(previous);
                              for (const id of visibleIds) checked ? next.add(id) : next.delete(id);
                              return next;
                            })}
                            aria-label="Select all visible payroll records"
                          />
                        </TableHead>
                        <TableHead>Employee ID</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Designation</TableHead>
                        <TableHead className="text-right">Net Salary</TableHead>
                        <TableHead>Payslip Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                            {search ? 'No employees match your search.' : 'No employees in this run.'}
                          </TableCell>
                        </TableRow>
                      ) : filtered.map(record => {
                        const entry = statuses.get(record.id) ?? { status: 'NOT_GENERATED' as GenerationStatus };
                        const isThisGenerating = generatingId === record.id;
                        return (
                          <TableRow key={record.id}>
                            <TableCell>
                              <Checkbox
                                checked={selectedWhatsAppIds.has(record.id)}
                                onCheckedChange={checked => setSelectedWhatsAppIds(previous => {
                                  const next = new Set(previous);
                                  checked ? next.add(record.id) : next.delete(record.id);
                                  return next;
                                })}
                                aria-label={`Select ${record.employeeName}`}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-sm">{record.employeeCode}</TableCell>
                            <TableCell className="font-medium">{record.employeeName}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {(record as any).designation || '—'}
                            </TableCell>
                            <TableCell className="text-right font-mono">{formatINR(record.netSalary)}</TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-0.5">
                                <StatusBadge status={entry.status} />
                                {entry.errorMessage && (
                                  <span className="text-xs text-red-500 max-w-[180px] truncate" title={entry.errorMessage}>
                                    {entry.errorMessage}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex flex-col items-end gap-1">
                              <div className="flex items-center justify-end gap-1">
                                {shareLinks.has(record.id) ? (
                                  <Button size="sm" variant="ghost" onClick={() => copyShare(record.id)} title={`Copy link (expires ${new Date(shareLinks.get(record.id)!.expiresAt).toLocaleString()})`}>
                                    {copiedId === record.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                                  </Button>
                                ) : null}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleShare(record)}
                                  disabled={isBusy || sharingId === record.id}
                                  title={shareLinks.has(record.id) ? 'Create new share link' : 'Create share link'}
                                >
                                  {sharingId === record.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => openWhatsAppConfirmation(record)}
                                  disabled={isBusy || whatsAppSending}
                                  title="Send test WhatsApp"
                                >
                                  <MessageCircle className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handlePreview(record)}
                                  disabled={isBusy || isThisGenerating || !run}
                                  title="Preview payslip"
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleDownload(record)}
                                  disabled={isBusy || isThisGenerating || !run}
                                  title="Download PDF"
                                >
                                  {isThisGenerating
                                    ? <Loader2 className="h-4 w-4 animate-spin" />
                                    : <FileDown className="h-4 w-4" />}
                                </Button>
                                {entry.status !== 'NOT_GENERATED' && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleDownload(record)}
                                    disabled={isBusy || isThisGenerating || !run}
                                    title="Regenerate PDF"
                                  >
                                    <RefreshCw className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                              {shareLinks.has(record.id) ? (
                                <span className="text-xs text-muted-foreground">
                                  Valid until {new Date(shareLinks.get(record.id)!.expiresAt).toLocaleDateString('en-GB')}
                                </span>
                              ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {filtered.length > 0 && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <p>Showing {filtered.length} of {records.length} employees</p>
                    <p>{selectedWhatsAppIds.size} selected</p>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </>
      )}

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl w-full h-[90vh] flex flex-col p-0 gap-0">
          <DialogHeader className="p-4 border-b shrink-0">
            <DialogTitle className="flex items-center justify-between">
              <span>
                Payslip Preview — {previewRecord?.employeeCode} · {previewRecord?.employeeName}
              </span>
              {previewRecord && run && (
                <Button
                  size="sm"
                  onClick={() => handleDownload(previewRecord)}
                  className="mr-8"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download PDF
                </Button>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {previewRecord && run ? (
              <PDFViewer width="100%" height="100%" style={{ border: 'none' }}>
                <PayslipDocument record={previewRecord} run={run} company={company} />
              </PDFViewer>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={whatsAppBatchOpen} onOpenChange={open => { if (!whatsAppBatchLoading) setWhatsAppBatchOpen(open); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send WhatsApp Payslips</DialogTitle>
            <DialogDescription>Confirm the eligible recipients before the server processes this batch.</DialogDescription>
          </DialogHeader>
          {whatsAppBatchLoading && !whatsAppBatchResult ? (
            <div className="space-y-3 py-4">
              <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Sending payslips...</div>
              <Progress value={whatsAppBatchPreview ? (whatsAppBatchProcessed / Math.max(whatsAppBatchPreview.willSend, 1)) * 100 : 5} />
              <p className="text-xs text-muted-foreground">
                {whatsAppBatchPreview ? `Processing ${whatsAppBatchProcessed} of ${whatsAppBatchPreview.willSend}` : 'Validating selected records'}
              </p>
            </div>
          ) : whatsAppBatchResult ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium">WhatsApp Payslip Summary</p>
              <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
                <span>Sent</span><strong>{whatsAppBatchResult.sent}</strong>
                <span>Failed</span><strong>{whatsAppBatchResult.failed}</strong>
                <span>Pending confirmation</span><strong>{whatsAppBatchResult.pending}</strong>
                <span>Skipped</span><strong>{whatsAppBatchResult.skipped}</strong>
              </div>
              {whatsAppBatchResult.results.filter(result => result.status !== 'SENT').map(result => {
                const record = records.find(candidate => candidate.id === result.payrollRecordId);
                return <p key={result.payrollRecordId} className="text-xs text-red-700">{record?.employeeCode ?? result.payrollRecordId}: {result.error}</p>;
              })}
            </div>
          ) : whatsAppBatchPreview ? (
            <div className="space-y-3 text-sm">
              <p className="text-base font-medium">Send payslips to {whatsAppBatchPreview.willSend} employees?</p>
              <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
                <span>Selected</span><strong>{whatsAppBatchPreview.selected}</strong>
                <span>Valid mobile numbers</span><strong>{whatsAppBatchPreview.validMobile}</strong>
                <span>Already sent</span><strong>{whatsAppBatchPreview.alreadySent}</strong>
                <span>Will actually send</span><strong>{whatsAppBatchPreview.willSend}</strong>
              </div>
              {whatsAppBatchPreview.records.some(record => !record.eligible) ? (
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-md bg-muted p-3">
                  <p className="font-medium">Not eligible</p>
                  {whatsAppBatchPreview.records.filter(record => !record.eligible).map(item => {
                    const record = records.find(candidate => candidate.id === item.payrollRecordId);
                    return <p key={item.payrollRecordId} className="text-xs">{record?.employeeCode ?? item.payrollRecordId}: {item.reason}</p>;
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWhatsAppBatchOpen(false)} disabled={whatsAppBatchLoading}>Close</Button>
            {!whatsAppBatchResult && whatsAppBatchPreview ? (
              <Button onClick={handleWhatsAppBatchSend} disabled={whatsAppBatchLoading || whatsAppBatchPreview.willSend === 0}>
                <MessageCircle className="mr-2 h-4 w-4" />Confirm Send
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!whatsAppRecord} onOpenChange={open => { if (!open && !whatsAppSending) setWhatsAppRecord(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Test WhatsApp</DialogTitle>
            <DialogDescription>Confirm this single-recipient payroll message before contacting Meta.</DialogDescription>
          </DialogHeader>
          {whatsAppRecord && run && (
            <div className="grid gap-3 text-sm">
              <div><span className="text-muted-foreground">Employee:</span> <span className="font-medium">{whatsAppRecord.employeeName} ({whatsAppRecord.employeeCode})</span></div>
              <div><span className="text-muted-foreground">Period:</span> <span className="font-medium">{monthName(run.payrollMonth)} {run.payrollYear}</span></div>
              <div><span className="text-muted-foreground">Recipient:</span> <span className="font-mono">{whatsAppRecord.mobileNumber || 'Not available'}</span></div>
              <div><span className="text-muted-foreground">Template:</span> <span className="font-mono">payslip</span></div>
              <div><span className="text-muted-foreground">Secure link:</span> <span>Stage 4A link, valid for 7 days</span></div>
            </div>
          )}
          {whatsAppResult?.status === 'SENT' && (
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900">
              <p className="font-medium">WhatsApp sent</p>
              <p>Recipient: {whatsAppResult.recipient}</p>
              <p>Template: {whatsAppResult.template}</p>
              <p className="break-all">Meta message ID: {whatsAppResult.metaMessageId}</p>
              <p>Timestamp: {whatsAppResult.timestamp ? new Date(whatsAppResult.timestamp).toLocaleString() : ''}</p>
            </div>
          )}
          {whatsAppResult?.status === 'FAILED' && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <p className="font-medium">Failed</p>
              <p>{whatsAppResult.error}</p>
              {whatsAppResult.code ? <p>Code: {whatsAppResult.code}</p> : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWhatsAppRecord(null)} disabled={whatsAppSending}>Close</Button>
            {whatsAppResult?.status !== 'SENT' && (
              <Button onClick={handleWhatsAppSend} disabled={whatsAppSending || !whatsAppRecord?.mobileNumber}>
                {whatsAppSending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending...</> : <><MessageCircle className="mr-2 h-4 w-4" />Confirm Send</>}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
