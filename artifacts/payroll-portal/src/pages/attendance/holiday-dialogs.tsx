import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { adminPatch, adminPost } from './api';
import { formatRange, KIND_HELP, KIND_LABELS } from './holiday-helpers';
import { leaveKeys, type AcademicYear, type CalendarTemplate, type Holiday, type HolidayKind, type ImportResult } from './leave-api';
import { errorText, useCampuses, useRefresh } from './use-attendance';

const ALL_CAMPUSES = 'all';

/** Add a new academic year, or (when `year` is given) edit the name and dates of an existing one. */
export function YearDialog({ open, onClose, onCreated, year }: { open: boolean; onClose(): void; onCreated(id: number): void; year?: AcademicYear }) {
  const { toast } = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState(() => ({ label: year?.label ?? '', startDate: year?.startDate ?? '', endDate: year?.endDate ?? '', accrualMonth: year?.accrualFrom ? year.accrualFrom.slice(0, 7) : '' }));
  // The month leave starts being credited from, as the date the server stores: the 1st, or the year's first day if that is in the same month.
  const body = () => ({
    label: form.label, startDate: form.startDate, endDate: form.endDate,
    accrualFrom: form.accrualMonth === '' ? '' : form.accrualMonth === form.startDate.slice(0, 7) ? form.startDate : `${form.accrualMonth}-01`,
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => year
      ? adminPatch<{ year: AcademicYear }>(`/leave/calendar/years/${year.id}`, body())
      : adminPost<{ year: AcademicYear }>('/leave/calendar/years', body()),
    onSuccess: ({ year: saved }) => {
      refresh(leaveKeys.years, leaveKeys.year(saved.id));
      toast({ title: year ? 'Academic year updated' : 'Academic year added', description: saved.label });
      onCreated(saved.id);
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{year ? 'Edit academic year' : 'Add an academic year'}</DialogTitle>
          <DialogDescription>
            Your organisation decides when its academic year starts and ends; these dates need not match any official calendar.
            Leave, balances and attendance reports all follow them. Years cannot overlap.
            {year && ' Dates can only change if no holiday, leave or balance entry would fall outside the new dates.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="year-label">Year name</Label>
            <Input id="year-label" placeholder="2027-28" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="year-start">First day</Label>
              <Input id="year-start" type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="year-end">Last day</Label>
              <Input id="year-end" type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="year-accrual">Start crediting leave from (month)</Label>
            <Input id="year-accrual" type="month" min={form.startDate.slice(0, 7)} max={form.endDate.slice(0, 7)} value={form.accrualMonth} onChange={e => setForm(f => ({ ...f, accrualMonth: e.target.value }))} />
            <p className="text-xs text-muted-foreground">
              Leave is credited on the 1st of each month from this month. Leave empty to start from the first month of the year.
              If you begin using this app part-way through the year, choose that month and enter each person&apos;s opening balance on the Leave Policies page. Months before it are never credited by the system.
            </p>
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : year ? 'Save changes' : 'Add year'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Import a ready-made calendar. The first and last day start as the official ones and can be changed:
 * they become the organisation's academic year. Official dates that fall outside are skipped and listed.
 */
export function ImportDialog(props: {
  template: CalendarTemplate; existing: AcademicYear | undefined; open: boolean; onClose(): void; onImported(result: ImportResult): void;
}) {
  const { template, existing, open, onClose, onImported } = props;
  const { toast } = useToast();
  const refresh = useRefresh();
  const [dates, setDates] = useState({ startDate: template.startDate, endDate: template.endDate });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = useMutation({
    mutationFn: () => adminPost<ImportResult>('/leave/calendar/import', { templateKey: template.key, ...(existing ? {} : dates) }),
    onSuccess: r => {
      refresh(leaveKeys.years, leaveKeys.year(r.yearId));
      onImported(r);
      if (r.skipped.length === 0) {
        toast({
          title: r.holidaysAdded > 0 ? 'Calendar imported as drafts' : 'Nothing new to import',
          description: r.holidaysAdded > 0 ? `${r.holidaysAdded} dates added. Check them, then confirm.` : 'These dates were already in the calendar.',
        });
        onClose();
      } else {
        setResult(r); // stay open so the skipped dates can be read
      }
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? 'Imported, with some dates skipped' : 'Import ' + template.label + ' calendar'}</DialogTitle>
          <DialogDescription>
            {result
              ? `${result.holidaysAdded} dates were added as drafts. These official dates fall outside your academic year (${formatRange(result.yearStartDate, result.yearEndDate)}), so they were not added. Add any you need by hand.`
              : existing
                ? `Academic year ${existing.label} already exists, so it keeps your dates (${formatRange(existing.startDate, existing.endDate)}). Only missing official dates are added, as drafts.`
                : 'Choose the first and last day of your academic year. They start as the official dates; change them if your school year differs. Dates outside your year are skipped and listed. Everything is added as drafts.'}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <ul className="max-h-56 list-disc space-y-0.5 overflow-auto pl-5 text-sm">
            {result.skipped.map(s => <li key={`${s.name}-${s.startDate}`}>{formatRange(s.startDate, s.endDate)}: {s.name} ({KIND_LABELS[s.kind]})</li>)}
          </ul>
        ) : (
          <div className="space-y-4">
            {!existing && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="import-start">First day</Label>
                  <Input id="import-start" type="date" value={dates.startDate} onChange={e => setDates(d => ({ ...d, startDate: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="import-end">Last day</Label>
                  <Input id="import-end" type="date" value={dates.endDate} onChange={e => setDates(d => ({ ...d, endDate: e.target.value }))} />
                </div>
              </div>
            )}
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          </div>
        )}
        <DialogFooter>
          {result ? <Button onClick={onClose}>Done</Button> : (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={() => { setError(null); run.mutate(); }} disabled={run.isPending}>{run.isPending ? 'Importing…' : 'Import as drafts'}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface HolidayForm { name: string; kind: HolidayKind; startDate: string; endDate: string; campusId: string }

export function HolidayDialog(props: { year: AcademicYear; holiday: Holiday | null; open: boolean; onClose(): void }) {
  const { year, holiday, open, onClose } = props;
  const { toast } = useToast();
  const refresh = useRefresh();
  const campuses = useCampuses();
  const [form, setForm] = useState<HolidayForm>(() => holiday
    ? { name: holiday.name, kind: holiday.kind, startDate: holiday.startDate, endDate: holiday.endDate, campusId: holiday.campusId === null ? ALL_CAMPUSES : String(holiday.campusId) }
    : { name: '', kind: 'HOLIDAY', startDate: '', endDate: '', campusId: ALL_CAMPUSES });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, kind: form.kind, startDate: form.startDate, endDate: form.endDate || form.startDate,
        campusId: form.campusId === ALL_CAMPUSES ? null : Number(form.campusId),
      };
      return holiday
        ? adminPatch(`/leave/calendar/holidays/${holiday.id}`, body)
        : adminPost(`/leave/calendar/years/${year.id}/holidays`, body);
    },
    onSuccess: () => {
      refresh(leaveKeys.year(year.id), leaveKeys.years);
      toast({ title: holiday ? 'Holiday updated' : 'Holiday added', description: form.name });
      onClose();
    },
    onError: e => setError(errorText(e)),
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{holiday ? 'Edit holiday' : 'Add a holiday'}</DialogTitle>
          <DialogDescription>
            Academic year {year.label}.{' '}
            {holiday?.status === 'CONFIRMED'
              ? 'This date is confirmed, so a change affects new leave requests straight away. Approved leave is not changed.'
              : 'New dates stay as drafts until the Director confirms the calendar.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="holiday-name">Name</Label>
            <Input id="holiday-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="holiday-kind">Type</Label>
            <Select value={form.kind} onValueChange={v => setForm(f => ({ ...f, kind: v as HolidayKind }))}>
              <SelectTrigger id="holiday-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as HolidayKind[]).map(k => <SelectItem key={k} value={k}>{KIND_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{KIND_HELP[form.kind]}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="holiday-start">Date (or first day)</Label>
              <Input id="holiday-start" type="date" min={year.startDate} max={year.endDate} value={form.startDate}
                onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="holiday-end">Last day (leave empty for one day)</Label>
              <Input id="holiday-end" type="date" min={form.startDate || year.startDate} max={year.endDate} value={form.endDate}
                onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="holiday-campus">Applies to</Label>
            <Select value={form.campusId} onValueChange={v => setForm(f => ({ ...f, campusId: v }))}>
              <SelectTrigger id="holiday-campus"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CAMPUSES}>All campuses</SelectItem>
                {(campuses.data ?? []).map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name} only</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : holiday ? 'Save changes' : 'Add holiday'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
