import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CalendarCheck, CalendarPlus, Check, Download, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { adminDelete, adminPost } from './api';
import { HolidayDialog, ImportDialog, YearDialog } from './holiday-dialogs';
import { formatRange, KIND_LABELS, mismatchSummary, monthName, totalWorkingDays, weekdayRange } from './holiday-helpers';
import { leaveKeys, useAcademicYears, useCalendarTemplates, useYearDetail, type CalendarTemplate, type Holiday } from './leave-api';
import { AccessMessage } from './setup';
import { errorText, useCampuses, useMe, useRefresh } from './use-attendance';

/** Pick the year that is running today, else the newest one. */
function defaultYearId(years: { id: number; startDate: string; endDate: string }[]): number | null {
  const today = new Date().toISOString().slice(0, 10);
  return (years.find(y => y.startDate <= today && today <= y.endDate) ?? years[0])?.id ?? null;
}

export default function HolidayCalendarPage() {
  const me = useMe();
  const years = useAcademicYears();
  const templates = useCalendarTemplates();
  const { toast } = useToast();
  const refresh = useRefresh();
  const campuses = useCampuses();
  const [yearId, setYearId] = useState<number | null>(null);
  const [yearDialog, setYearDialog] = useState(false);
  const [editingYear, setEditingYear] = useState(false);
  const [importing, setImporting] = useState<CalendarTemplate | null>(null);
  const [holidayDialog, setHolidayDialog] = useState<{ holiday: Holiday | null } | null>(null);
  const [removing, setRemoving] = useState<Holiday | null>(null);
  const [confirming, setConfirming] = useState(false);
  const detail = useYearDetail(yearId);

  useEffect(() => {
    if (yearId === null && years.data && years.data.length > 0) setYearId(defaultYearId(years.data));
  }, [years.data, yearId]);

  const afterChange = (id: number) => refresh(leaveKeys.year(id), leaveKeys.years);

  const remove = useMutation({
    mutationFn: (h: Holiday) => adminDelete(`/leave/calendar/holidays/${h.id}`),
    onSuccess: (_r, h) => { afterChange(h.academicYearId); toast({ title: 'Holiday removed', description: h.name }); setRemoving(null); },
    onError: e => { toast({ title: 'Could not remove', description: errorText(e), variant: 'destructive' }); setRemoving(null); },
  });

  const confirm = useMutation({
    mutationFn: (id: number) => adminPost<{ confirmed: number }>(`/leave/calendar/years/${id}/confirm`, {}),
    onSuccess: (r, id) => { afterChange(id); toast({ title: 'Calendar confirmed', description: `${r.confirmed} dates now count for leave.` }); setConfirming(false); },
    onError: e => { toast({ title: 'Could not confirm', description: errorText(e), variant: 'destructive' }); setConfirming(false); },
  });

  if (me.isLoading) return <div className="space-y-6"><Skeleton className="h-10 w-64" /><Skeleton className="h-48 w-full" /></div>;
  if (me.isError) return <AccessMessage error={me.error} />;
  if (years.isError) return <AccessMessage error={years.error} />;

  const isDirector = me.data?.role === 'DIRECTOR';
  const year = detail.data?.year ?? null;
  const campusName = (id: number | null) => (id === null ? 'All campuses' : (campuses.data?.find(c => c.id === id)?.name ?? `Campus ${id}`));
  const problems = detail.data ? mismatchSummary(detail.data.months) : [];
  const hasPrinted = detail.data?.months.some(m => m.printed !== null) ?? false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Holiday calendar</h1>
          <p className="text-sm text-muted-foreground">
            Holidays, vacations and extra weekly offs for each academic year. Only confirmed dates count for leave.
          </p>
        </div>
        <Button variant="outline" onClick={() => setYearDialog(true)}><CalendarPlus className="mr-2 h-4 w-4" />Add academic year</Button>
      </div>

      {(templates.data ?? []).map(t => {
        const present = years.data?.find(y => y.label === t.label);
        const complete = present && present.draftCount + present.confirmedCount >= t.holidayCount;
        return (
          <Card key={t.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t.title}</CardTitle>
              <CardDescription>
                Ready-made official dates ({t.holidayCount} entries). They are added as drafts; nothing counts until you confirm.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => setImporting(t)} variant={complete ? 'outline' : 'default'}>
                <Download className="mr-2 h-4 w-4" />
                {complete ? 'Import again (adds only missing dates)' : 'Import this calendar'}
              </Button>
            </CardContent>
          </Card>
        );
      })}

      {years.isLoading ? <Skeleton className="h-40 w-full" /> : (years.data ?? []).length === 0 ? (
        <Alert>
          <CalendarCheck className="h-4 w-4" />
          <AlertTitle>No academic year yet</AlertTitle>
          <AlertDescription>Import the ready-made calendar above, or add an academic year and enter its holidays yourself.</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Academic year</span>
            <Select value={yearId === null ? undefined : String(yearId)} onValueChange={v => setYearId(Number(v))}>
              <SelectTrigger className="w-48" aria-label="Academic year"><SelectValue placeholder="Choose a year" /></SelectTrigger>
              <SelectContent>
                {years.data!.map(y => <SelectItem key={y.id} value={String(y.id)}>{y.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {year && <span className="text-sm text-muted-foreground">{formatRange(year.startDate, year.endDate)}{year.accrualFrom ? ` · leave is credited from ${monthName(year.accrualFrom.slice(0, 7))}` : ''}</span>}
            {year && <Button size="sm" variant="outline" onClick={() => setEditingYear(true)}><Pencil className="mr-2 h-3.5 w-3.5" />Edit year</Button>}
          </div>

          {detail.isLoading && <Skeleton className="h-64 w-full" />}
          {detail.isError && <Alert variant="destructive"><AlertDescription>{errorText(detail.error)}</AlertDescription></Alert>}

          {detail.data && year && (
            <>
              {year.draftCount > 0 ? (
                <Alert>
                  <TriangleAlert className="h-4 w-4" />
                  <AlertTitle>{year.draftCount} date{year.draftCount === 1 ? ' is' : 's are'} still a draft</AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>Drafts do not count for leave. Compare the working days below with the official calendar, then confirm.</p>
                    {isDirector
                      ? <Button size="sm" onClick={() => setConfirming(true)}><Check className="mr-2 h-4 w-4" />Review and confirm</Button>
                      : <p className="font-medium">Only the Director can confirm the calendar.</p>}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <CalendarCheck className="h-4 w-4" />
                  <AlertTitle>Calendar confirmed</AlertTitle>
                  <AlertDescription>{year.confirmedCount} dates count for leave in {year.label}.</AlertDescription>
                </Alert>
              )}

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Working days per month</CardTitle>
                  <CardDescription>
                    Monday to Saturday, minus holidays, vacations and extra weekly offs (all campuses). Optional holidays do not reduce it.
                    {detail.data.officialDatesDiffer && ' Your academic year has different first and last days from the official calendar, so the official figures are shown for reference only.'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Month</TableHead>
                        <TableHead className="text-right">Working days</TableHead>
                        {hasPrinted && <TableHead className="text-right">Official calendar</TableHead>}
                        {hasPrinted && <TableHead className="w-24" />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.data.months.map(m => (
                        <TableRow key={m.month}>
                          <TableCell>{monthName(m.month)}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.workingDays}</TableCell>
                          {hasPrinted && <TableCell className="text-right tabular-nums">{m.printed ?? '-'}</TableCell>}
                          {hasPrinted && (
                            <TableCell>
                              {m.matches === true && <Badge variant="secondary">Matches</Badge>}
                              {m.matches === false && <Badge variant="destructive">Differs</Badge>}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                      <TableRow className="font-medium">
                        <TableCell>Total</TableCell>
                        <TableCell className="text-right tabular-nums">{totalWorkingDays(detail.data.months)}</TableCell>
                        {hasPrinted && <TableCell className="text-right tabular-nums">{detail.data.months.reduce((s, m) => s + (m.printed ?? 0), 0)}</TableCell>}
                        {hasPrinted && <TableCell />}
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                  <div>
                    <CardTitle className="text-base">Dates in {year.label}</CardTitle>
                    <CardDescription>{detail.data.holidays.length} entries.</CardDescription>
                  </div>
                  <Button size="sm" onClick={() => setHolidayDialog({ holiday: null })}><Plus className="mr-2 h-4 w-4" />Add holiday</Button>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Applies to</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-24" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.data.holidays.map(h => (
                        <TableRow key={h.id}>
                          <TableCell className="whitespace-nowrap">
                            {formatRange(h.startDate, h.endDate)}
                            <span className="ml-2 text-xs text-muted-foreground">{weekdayRange(h.startDate, h.endDate)}</span>
                          </TableCell>
                          <TableCell>{h.name}</TableCell>
                          <TableCell>{KIND_LABELS[h.kind]}</TableCell>
                          <TableCell>{campusName(h.campusId)}</TableCell>
                          <TableCell>
                            <Badge variant={h.status === 'CONFIRMED' ? 'secondary' : 'outline'}>{h.status === 'CONFIRMED' ? 'Confirmed' : 'Draft'}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="icon" variant="ghost" aria-label={`Edit ${h.name}`} onClick={() => setHolidayDialog({ holiday: h })}><Pencil className="h-4 w-4" /></Button>
                            <Button size="icon" variant="ghost" aria-label={`Remove ${h.name}`} onClick={() => setRemoving(h)}><Trash2 className="h-4 w-4" /></Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {holidayDialog && (
                <HolidayDialog key={holidayDialog.holiday?.id ?? 'new'} year={year} holiday={holidayDialog.holiday} open onClose={() => setHolidayDialog(null)} />
              )}

              <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Confirm the {year.label} calendar?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-2">
                        <p>
                          {year.draftCount} draft date{year.draftCount === 1 ? '' : 's'} will start to count for leave straight away.
                          Total working days: <strong>{totalWorkingDays(detail.data.months)}</strong>.
                        </p>
                        {problems.length > 0 ? (
                          <div className="rounded-md border border-destructive/50 p-2 text-destructive">
                            <p className="font-medium">These months differ from the official calendar:</p>
                            <ul className="list-disc pl-5">{problems.map(p => <li key={p}>{p}</li>)}</ul>
                            <p>Fix the dates first unless you are sure.</p>
                          </div>
                        ) : hasPrinted ? <p>Every month matches the official calendar.</p> : null}
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Not yet</AlertDialogCancel>
                    <AlertDialogAction onClick={() => confirm.mutate(year.id)} disabled={confirm.isPending}>Confirm calendar</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </>
      )}

      {yearDialog && <YearDialog open onClose={() => setYearDialog(false)} onCreated={setYearId} />}
      {editingYear && year && <YearDialog key={`${year.id}:${year.startDate}:${year.endDate}`} year={year} open onClose={() => setEditingYear(false)} onCreated={setYearId} />}
      {importing && (
        <ImportDialog
          template={importing} existing={years.data?.find(y => y.label === importing.label)} open
          onClose={() => setImporting(null)} onImported={r => setYearId(r.yearId)}
        />
      )}

      <AlertDialog open={removing !== null} onOpenChange={o => { if (!o) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing && formatRange(removing.startDate, removing.endDate)}.
              {removing?.status === 'CONFIRMED' ? ' This date is confirmed; removing it affects new leave requests straight away. Approved leave is not changed.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => removing && remove.mutate(removing)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
