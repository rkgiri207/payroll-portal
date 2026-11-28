import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, Eye, Play, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { adminPost, adminPut } from './api';
import { accrualKeys, useMissingJoiningDates, useOpening, type AccrualSummary } from './accrual-api';
import { accrualFromText, changedEntries, entryText, isValidDaysText, joiningText, summaryLine } from './accrual-helpers';
import type { AcademicYear } from './leave-api';
import { policyKeys, useLeaveTypes } from './leave-policy-api';
import { errorText, useMe, useRefresh } from './use-attendance';

function Result({ summary }: { summary: AccrualSummary }) {
  return (
    <div className="space-y-3">
      <Alert>
        <CalendarClock className="h-4 w-4" />
        <AlertTitle>{summary.dryRun ? 'Preview for today' : 'Done'}</AlertTitle>
        <AlertDescription>{summaryLine(summary)}</AlertDescription>
      </Alert>
      {summary.lines.length > 0 && (
        <Table>
          <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Leave type</TableHead><TableHead>{summary.dryRun ? 'Would be credited' : 'Credited'}</TableHead></TableRow></TableHeader>
          <TableBody>
            {summary.lines.map(l => (
              <TableRow key={`${l.employeeId}:${l.leaveType}`}>
                <TableCell>{l.employeeName} <span className="text-xs text-muted-foreground">({l.employeeCode})</span></TableCell>
                <TableCell>{l.leaveType}</TableCell>
                <TableCell className="text-sm">{l.entries.map(entryText).join(', ')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {summary.truncated && <p className="text-xs text-muted-foreground">Only the first {summary.lines.length} lines are shown. The totals above cover everyone.</p>}
    </div>
  );
}

function MonthlyCredit({ year }: { year: AcademicYear }) {
  const me = useMe();
  const { toast } = useToast();
  const refresh = useRefresh();
  const [result, setResult] = useState<AccrualSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDirector = me.data?.role === 'DIRECTOR';

  const preview = useMutation({
    mutationFn: () => adminPost<AccrualSummary>('/leave/accrual/preview', {}),
    onSuccess: r => { setResult(r); setError(null); },
    onError: e => setError(errorText(e)),
  });
  const run = useMutation({
    mutationFn: () => adminPost<AccrualSummary>('/leave/accrual/run', {}),
    onSuccess: r => {
      setResult(r); setError(null);
      refresh(accrualKeys.missing, policyKeys.allocationsAll);
      toast({ title: 'Leave credited', description: summaryLine(r) });
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Monthly credit, {year.label}</CardTitle>
        <CardDescription>
          {accrualFromText(year)} It runs by itself every day, and only ever adds what is missing, so it is safe to run again.
          The month an employee joins earns nothing; their first credit is the next month. Set the days per month on the Policy tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { setError(null); preview.mutate(); }} disabled={preview.isPending}>
            <Eye className="mr-2 h-4 w-4" />{preview.isPending ? 'Checking…' : 'Preview what would be credited today'}
          </Button>
          <Button onClick={() => { setError(null); run.mutate(); }} disabled={!isDirector || run.isPending}>
            <Play className="mr-2 h-4 w-4" />{run.isPending ? 'Crediting…' : 'Credit now'}
          </Button>
          {!isDirector && <span className="self-center text-xs text-muted-foreground">Only the Director can credit now.</span>}
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {result && <Result summary={result} />}
      </CardContent>
    </Card>
  );
}

function MissingJoiningDates() {
  const missing = useMissingJoiningDates();
  if (missing.isLoading || missing.isError || (missing.data ?? []).length === 0) return null;
  return (
    <Alert variant="destructive">
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>{missing.data!.length} employee{missing.data!.length === 1 ? ' has' : 's have'} no joining date</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Leave cannot be credited to them, and an opening balance cannot be entered, until their joining date is on their employee
          record. Once it is there they are included automatically at the next daily run.
        </p>
        <p className="text-sm">{missing.data!.map(e => `${e.employeeName} (${e.employeeCode})`).join(', ')}</p>
      </AlertDescription>
    </Alert>
  );
}

function OpeningBalances({ year }: { year: AcademicYear }) {
  const types = useLeaveTypes();
  const balanceTypes = (types.data ?? []).filter(t => t.tracksBalance && t.isActive);
  const { toast } = useToast();
  const refresh = useRefresh();
  const [typeId, setTypeId] = useState<number | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sameFor, setSameFor] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setSearch(searchText), 300); return () => clearTimeout(t); }, [searchText]);
  useEffect(() => { if (typeId === null && balanceTypes.length > 0) setTypeId(balanceTypes[0].id); }, [typeId, balanceTypes]);
  useEffect(() => { setDrafts({}); }, [typeId, year.id]);

  const rows = useOpening(year.id, typeId, search);
  const entries = rows.data ? changedEntries(rows.data, drafts) : [];
  const invalid = Object.values(drafts).some(d => !isValidDaysText(d));

  const save = useMutation({
    mutationFn: () => adminPut<{ created: number; corrected: number }>(`/leave/opening/${year.id}/${typeId}`, { entries }),
    onSuccess: r => {
      refresh(accrualKeys.openingAll, policyKeys.allocationsAll);
      setDrafts({}); setError(null);
      toast({ title: 'Opening balances saved', description: `${r.created} added, ${r.corrected} corrected.` });
    },
    onError: e => setError(errorText(e)),
  });

  if (types.isLoading) return <Skeleton className="h-40 w-full" />;
  if (balanceTypes.length === 0) return null;
  const startText = year.accrualFrom ?? year.startDate;

  return (
    <Card>
      <CardHeader className="space-y-3 pb-2">
        <div>
          <CardTitle className="text-base">Opening balances, {year.label}</CardTitle>
          <CardDescription>
            What each person already has when you start using the app: from your own records, as at the day before leave starts being credited.
            It is dated {startText}. Corrections are kept as logged adjustments, never overwritten. Up to 2 decimals, for example 4.25.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={typeId === null ? undefined : String(typeId)} onValueChange={v => setTypeId(Number(v))}>
            <SelectTrigger className="w-52" aria-label="Leave type"><SelectValue /></SelectTrigger>
            <SelectContent>{balanceTypes.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
          </Select>
          <Input className="w-56" placeholder="Search name or code" aria-label="Search employees" value={searchText} onChange={e => setSearchText(e.target.value)} />
          <div className="ml-auto flex items-center gap-2">
            <Input className="w-28" inputMode="decimal" placeholder="Days" aria-label="Same days for everyone" value={sameFor} onChange={e => setSameFor(e.target.value)} />
            <Button variant="outline" disabled={!rows.data || sameFor.trim() === '' || !isValidDaysText(sameFor)}
              onClick={() => setDrafts(Object.fromEntries((rows.data ?? []).filter(r => r.joiningDate).map(r => [r.employeeId, sameFor.trim()])))}>
              Fill for everyone
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.isLoading && <Skeleton className="h-48 w-full" />}
        {rows.isError && <Alert variant="destructive"><AlertDescription>{errorText(rows.error)}</AlertDescription></Alert>}
        {rows.data && (rows.data.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No active employees match.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Joined</TableHead><TableHead className="w-40">Opening balance (days)</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.data.map(r => {
                const draft = drafts[r.employeeId];
                const shown = draft ?? (r.opening === null ? '' : String(r.opening));
                return (
                  <TableRow key={r.employeeId}>
                    <TableCell>{r.employeeName} <span className="text-xs text-muted-foreground">({r.employeeCode})</span></TableCell>
                    <TableCell>{r.joiningDate ? joiningText(r) : <Badge variant="destructive">Missing</Badge>}</TableCell>
                    <TableCell>
                      <Input
                        inputMode="decimal" aria-label={`Opening balance for ${r.employeeName}`} value={shown} disabled={!r.joiningDate}
                        aria-invalid={draft !== undefined && !isValidDaysText(draft)}
                        onChange={e => setDrafts(d => ({ ...d, [r.employeeId]: e.target.value }))}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ))}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex items-center justify-end gap-3">
          {invalid && <span className="text-xs text-destructive">Days must be a number with at most 2 decimals.</span>}
          <span className="text-xs text-muted-foreground">{entries.length} change{entries.length === 1 ? '' : 's'}</span>
          <Button disabled={entries.length === 0 || invalid || save.isPending} onClick={() => { setError(null); save.mutate(); }}>
            {save.isPending ? 'Saving…' : 'Save opening balances'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function AccrualTab({ year }: { year: AcademicYear }) {
  return (
    <div className="space-y-4">
      <MissingJoiningDates />
      <MonthlyCredit year={year} />
      <OpeningBalances year={year} />
    </div>
  );
}
