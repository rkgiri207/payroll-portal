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
} from '@workspace/api-client-react';
import { formatINR, monthName } from '@/lib/format';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import {
  FileDown, RefreshCw, Eye, Download, Archive, Loader2, CheckCircle2, XCircle, AlertTriangle,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = '/api';

async function fetchLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/company-settings/logo`, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
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
  await fetch(`${API_BASE}/payroll-runs/${runId}/payslip-statuses`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  });
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

  const isBusy = isGeneratingAll || isDownloadingAll;

  // ── Render ─────────────────────────────────────────────────────────────────
  const activeRuns = runsData?.runs?.filter(r => r.status !== 'CANCELLED') ?? [];

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
              setBulkProgress(null);
            }}
          >
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Choose a payroll run…" />
            </SelectTrigger>
            <SelectContent>
              {activeRuns.map(r => (
                <SelectItem key={r.id} value={r.id.toString()}>
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
                          <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                            {search ? 'No employees match your search.' : 'No employees in this run.'}
                          </TableCell>
                        </TableRow>
                      ) : filtered.map(record => {
                        const entry = statuses.get(record.id) ?? { status: 'NOT_GENERATED' as GenerationStatus };
                        const isThisGenerating = generatingId === record.id;
                        return (
                          <TableRow key={record.id}>
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
                              <div className="flex items-center justify-end gap-1">
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
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {filtered.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Showing {filtered.length} of {records.length} employees
                  </p>
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
    </div>
  );
}
